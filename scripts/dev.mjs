import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const stateDir = path.join(root, '.dev');
const stateFile = path.join(stateDir, 'dev-env.json');

const processes = [
  {
    name: 'worker',
    color: '\x1b[35m',
    cwd: path.join(root, 'worker'),
    command: 'npm',
    args: ['run', 'dev'],
    url: 'http://127.0.0.1:8787',
  },
  {
    name: 'pwa',
    color: '\x1b[36m',
    cwd: path.join(root, 'pwa'),
    command: 'npm',
    args: ['run', 'dev', '--', '--host', '127.0.0.1'],
    url: 'http://127.0.0.1:5173',
  },
];

const command = process.argv[2] ?? 'start';

if (command === 'stop') {
  stopFromState();
} else if (command === 'status') {
  showStatus();
} else if (command === 'start') {
  startDev();
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: npm run dev | npm run dev:stop | npm run dev:status');
  process.exit(1);
}

function startDev() {
  fs.mkdirSync(stateDir, { recursive: true });

  console.log('Starting Alongside dev environment...');
  for (const proc of processes) {
    console.log(`  ${proc.name.padEnd(6)} ${proc.url}`);
  }
  console.log('Press Ctrl-C to stop both processes.\n');

  const children = processes.map(startProcess);
  writeState(children);

  let stopping = false;
  const stopAll = (reason) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nStopping dev environment${reason ? ` (${reason})` : ''}...`);
    for (const child of children) {
      if (!child.exited) child.process.kill('SIGTERM');
    }
    setTimeout(() => {
      for (const child of children) {
        if (!child.exited) child.process.kill('SIGKILL');
      }
      cleanupState();
      process.exit(0);
    }, 1500).unref();
  };

  process.on('SIGINT', () => stopAll('Ctrl-C'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));
  process.on('exit', cleanupState);

  for (const child of children) {
    child.process.on('exit', (code, signal) => {
      child.exited = true;
      if (stopping) return;
      const status = signal ? signal : `exit ${code}`;
      console.log(`\n${child.name} stopped unexpectedly (${status}).`);
      stopAll(`${child.name} stopped`);
    });
  }
}

function startProcess(proc) {
  const child = spawn(proc.command, proc.args, {
    cwd: proc.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  prefixStream(child.stdout, proc);
  prefixStream(child.stderr, proc);
  return { ...proc, process: child, exited: false };
}

function prefixStream(stream, proc) {
  const reset = '\x1b[0m';
  const prefix = `${proc.color}[${proc.name}]${reset}`;
  const lines = readline.createInterface({ input: stream });
  lines.on('line', line => {
    console.log(`${prefix} ${line}`);
  });
}

function writeState(children) {
  const state = {
    startedAt: new Date().toISOString(),
    processes: children.map(child => ({
      name: child.name,
      pid: child.process.pid,
      url: child.url,
    })),
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function readState() {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function stopFromState() {
  const state = readState();
  if (!state?.processes?.length) {
    console.log('No dev environment state found.');
    return;
  }

  for (const proc of state.processes) {
    if (!proc.pid) continue;
    try {
      process.kill(proc.pid, 'SIGTERM');
      console.log(`Stopped ${proc.name} (${proc.pid}).`);
    } catch (error) {
      if (error?.code === 'ESRCH') {
        console.log(`${proc.name} was not running (${proc.pid}).`);
      } else {
        throw error;
      }
    }
  }
  cleanupState();
}

function showStatus() {
  const state = readState();
  if (!state?.processes?.length) {
    console.log('Dev environment is not running from this runner.');
    return;
  }

  console.log(`Started: ${state.startedAt}`);
  for (const proc of state.processes) {
    const running = isRunning(proc.pid) ? 'running' : 'stopped';
    console.log(`${proc.name.padEnd(6)} ${running.padEnd(8)} pid ${proc.pid} ${proc.url}`);
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupState() {
  if (fs.existsSync(stateFile)) fs.rmSync(stateFile);
}
