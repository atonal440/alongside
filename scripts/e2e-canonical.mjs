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
  // 0. The protocol gate: a browser-origin write with no (old PWA) or too-old announcement is refused;
  //    a current announcement and a header-less script are not. Reads are never gated.
  const probe = (headers, method = 'POST') => fetch(`${API}/api/tasks`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify({ title: name('gate probe') }) });
  const old = await probe({ Origin: 'https://old.example' });
  assert.equal(old.status, 426);
  assert.equal((await old.json()).error, 'upgrade_required');
  assert.equal((await probe({ Origin: 'https://old.example', 'X-Alongside-Client': 'pwa/1' })).status, 426);
  assert.equal((await probe({ Origin: 'https://old.example' }, 'GET')).status, 200);
  assert.equal((await probe({ Origin: 'https://new.example', 'X-Alongside-Client': 'pwa/2' })).status, 201);
  assert.equal((await probe({})).status, 201);
  step('old browser writes get 426; current clients, scripts and reads pass');

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

  // 4b. Completing a task offline is queued (not lost across a reload) and reaches the server on reconnect.
  const doomed = (await serverTasks()).find(t => t.title === name('online add'));
  await open();
  await page.getByRole('button', { name: 'All Tasks' }).first().click();
  await page.getByText(name('online add')).first().click();
  await setOffline(true);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForTimeout(500);
  await page.reload();
  await page.getByText('Log out').first().waitFor();
  await page.waitForTimeout(1500);
  assert.equal((await rest('GET', `/api/tasks/${doomed.id}`)).status, 'pending');
  await setOffline(false);
  await open();
  await waitFor('completion flushed', async () => (await rest('GET', `/api/tasks/${doomed.id}`)).status === 'done');
  step('offline completion survives a reload, then flushes');

  // 4c. A create whose response is lost after the server applied it is replayed, not duplicated.
  await page.route(`${API}/api/v2/changes`, async route => { await route.fetch(); await route.abort('connectionreset'); }, { times: 1 });
  await add(name('lost response'));
  await waitFor('create reached the server', async () => (await serverTasks()).some(t => t.title === name('lost response')));
  await page.waitForTimeout(500);
  await open(); // the retry resends the identical command; the server replays its receipt
  await waitFor('lost-response create still on screen', () => seen(name('lost response')));
  await page.waitForTimeout(1500);
  assert.equal((await serverTasks()).filter(t => t.title === name('lost response')).length, 1);
  step('a create whose response was lost is replayed, not duplicated');

  // 4d. A change made elsewhere while this device was offline is a conflict to review, never a silent overwrite.
  const contested = await rest('POST', '/api/tasks', { title: name('contested') });
  await open();
  await page.getByRole('button', { name: 'All Tasks' }).first().click();
  await page.getByText(name('contested')).first().click();
  await setOffline(true);
  await page.getByRole('button', { name: /Focus this/ }).click();
  await page.waitForTimeout(500);
  await rest('PATCH', `/api/tasks/${contested.id}`, { title: name('contested elsewhere') });
  await setOffline(false);
  await open();
  await waitFor('conflict retained', () => seen('Needs attention (1)'));
  assert.ok(await seen('Focus a task'));
  assert.equal((await rest('GET', `/api/tasks/${contested.id}`)).focused_until, null);
  await page.getByText('Retry', { exact: true }).first().click();
  await waitFor('rebased focus applied', async () => (await rest('GET', `/api/tasks/${contested.id}`)).focused_until !== null);
  assert.equal((await rest('GET', `/api/tasks/${contested.id}`)).title, name('contested elsewhere'));
  step('an offline edit that raced another device is retained as a conflict; retry rebases it');

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
