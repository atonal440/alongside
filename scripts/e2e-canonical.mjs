// Browser end-to-end check of the canonical read path against a local worker + PWA.
//
//   npm run dev                      # worker :8787 (after `npm --prefix worker run db:init`) and PWA :5173
//   node scripts/e2e-canonical.mjs   # needs `playwright` resolvable (PLAYWRIGHT_MODULE=/path to override)
//
// It only talks to the local dev stack with the dev token and creates its own tasks.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const API = process.env.E2E_API ?? 'http://127.0.0.1:8787';
const APP = process.env.E2E_APP ?? 'http://127.0.0.1:5173';
const TOKEN = 'dev-token-change-me';
const run = Math.random().toString(36).slice(2, 7);
const name = label => `e2e-${run} ${label}`;

const rest = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.status === 204 ? null : res.json();
};
const serverTasks = async () => (await rest('GET', '/api/tasks/sync')).filter(t => t.title.startsWith(`e2e-${run}`));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const warnings = [];
page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
await page.addInitScript(([api, token]) => { localStorage.setItem('alongside_api', api); localStorage.setItem('alongside_token', token); }, [API, TOKEN]);

// "Offline" blocks only the API origin: the dev server has no service worker to serve the app shell offline.
const setOffline = async off => { await page.unroute(`${API}/**`).catch(() => {}); if (off) await page.route(`${API}/**`, route => route.abort('internetdisconnected')); };
const open = async () => { await page.goto(APP); await page.getByText('Log out').first().waitFor(); await page.waitForTimeout(1500); };
const seen = async text => (await page.locator('body').innerText()).toLowerCase().includes(text.toLowerCase());
const waitFor = async (what, fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(150); }
  throw new Error(`timed out waiting for ${what}`);
};
const add = async title => { await page.getByPlaceholder('Search tasks, projects, or add something new...').first().fill(title); await page.keyboard.press('Enter'); };
const step = label => console.log(`ok - ${label}`);

try {
  // 1. A task created elsewhere (REST) arrives through the canonical pull.
  const remote = await rest('POST', '/api/tasks', { title: name('from server') });
  await open();
  await waitFor('server task on screen', () => seen(remote.title));
  step('server-created task appears via canonical pull');

  // 2. Online add reaches the server exactly once and survives a reload.
  await add(name('online add'));
  await waitFor('online add on screen', () => seen(name('online add')));
  await waitFor('online add on server', async () => (await serverTasks()).some(t => t.title === name('online add')));
  await open();
  await waitFor('online add after reload', () => seen(name('online add')));
  assert.equal((await serverTasks()).filter(t => t.title === name('online add')).length, 1);
  step('online add persists, once');

  // 3. Offline add + reload while offline keeps the task; reconnecting flushes it without duplicates.
  await setOffline(true);
  await add(name('offline add'));
  await waitFor('offline add on screen', () => seen(name('offline add')));
  await page.reload();
  await page.getByText('Log out').first().waitFor();
  await waitFor('offline add after offline reload', () => seen(name('offline add')));
  assert.equal((await serverTasks()).filter(t => t.title === name('offline add')).length, 0);
  await setOffline(false);
  await open();
  await waitFor('offline add flushed', async () => (await serverTasks()).filter(t => t.title === name('offline add')).length === 1);
  await waitFor('offline add still on screen', () => seen(name('offline add')));
  assert.equal((await page.locator('body').innerText()).split(name('offline add')).length - 1 >= 1, true);
  step('offline add survives reload and flushes exactly once');

  // 4. An offline edit the server then refuses is retained for review instead of vanishing.
  const victim = (await serverTasks()).find(t => t.title === name('online add'));
  await page.evaluate(async ({ id }) => {
    const open = indexedDB.open('alongside');
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction('pending_ops', 'readwrite');
      tx.objectStore('pending_ops').put({ op: 'task.update', taskId: id, body: { title: '' }, created_at: new Date().toISOString(), attempts: 0 });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, { id: victim.id });
  await open();
  await waitFor('needs attention list', () => seen('Needs attention (1)'));
  assert.ok(await seen('Edit task title'));
  assert.ok(await seen(name('online add')), 'task keeps its server title after the refusal');
  await page.getByText('Discard').first().click();
  await waitFor('list cleared', async () => !(await seen('Needs attention')));
  step('refused edit is retained, shown, and discardable; task rolls back to server truth');

  // 5. A task deleted on the server disappears on the next refresh.
  await rest('DELETE', `/api/tasks/${remote.id}`);
  await open();
  await waitFor('deleted task gone', async () => !(await seen(remote.title)));
  step('server-side delete propagates');

  const noisy = warnings.filter(w => /diverge|canonical|Sync error|could not apply/i.test(w));
  assert.deepEqual(noisy, [], `unexpected sync warnings: ${noisy.join(' | ')}`);
  step('no sync warnings');
  console.log('PASS');
} catch (error) {
  await page.screenshot({ path: process.env.E2E_SHOT ?? 'e2e-failure.png' }).catch(() => {});
  console.error('FAIL', error);
  console.error('server tasks:', (await serverTasks().catch(() => [])).map(t => t.title));
  console.error('browser warnings:', warnings.slice(-10));
  console.error('queues:', JSON.stringify(await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('alongside'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = name => new Promise(res => { const q = db.transaction(name).objectStore(name).getAll(); q.onsuccess = () => res(q.result); });
    const out = { pending: await all('pending_ops'), retained: await all('retained_ops') };
    db.close();
    return out;
  }).catch(e => String(e))));
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const t of await serverTasks()) await rest('DELETE', `/api/tasks/${t.id}`).catch(() => {});
}
