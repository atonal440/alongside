// Start a local worker + PWA, run the browser e2e against them, then tear both down.
// Used by CI and `npm run e2e:stack`. Expects `npm --prefix worker run db:init` to have been run and
// worker/.dev.vars to exist (copy worker/.dev.vars.example). Extra args are not forwarded.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const logDir = process.env.E2E_LOG_DIR ?? path.join(root, '.dev');
fs.mkdirSync(logDir, { recursive: true });
const WORKER = 'http://127.0.0.1:8787';
const APP = 'http://127.0.0.1:5173';

function start(name, cwd, args) {
  const log = fs.openSync(path.join(logDir, `e2e-${name}.log`), 'w');
  const child = spawn('npx', args, { cwd, stdio: ['ignore', log, log], detached: true });
  child.on('error', error => console.error(`${name} failed to start`, error));
  return child;
}
const stop = child => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };

async function ready(url, label, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${ms / 1000}s (see ${logDir}/e2e-*.log)`);
}

const worker = start('worker', path.join(root, 'worker'), ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', '8787']);
const pwa = start('pwa', path.join(root, 'pwa'), ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
let code = 1;
try {
  await Promise.all([ready(`${WORKER}/api/tasks/sync`, 'worker'), ready(APP, 'pwa')]);
  code = await new Promise(resolve => {
    const run = spawn(process.execPath, [path.join(import.meta.dirname, 'e2e-canonical.mjs')], { stdio: 'inherit', env: { ...process.env, E2E_API: WORKER, E2E_APP: APP } });
    run.on('exit', c => resolve(c ?? 1));
  });
} catch (error) {
  console.error(error.message);
} finally {
  stop(worker);
  stop(pwa);
}
process.exit(code);
