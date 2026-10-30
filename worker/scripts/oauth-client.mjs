#!/usr/bin/env node
/**
 * Manages the OAUTH_CLIENTS Worker secret (pre-registered OAuth clients such as
 * Gemini). A Worker secret can only be replaced whole and never read back, so
 * the list lives in worker/.oauth-clients.json (gitignored; secret hashes only,
 * never the secrets themselves) and every change is pushed from there as one
 * single-line value over stdin. Nothing is ever pasted.
 *
 * Usage (from worker/, or `npm run oauth:client -- ...`):
 *   add <name> <redirect-uri> [--admin] [--id <client-id>] [--no-push]
 *   list
 *   remove <client-id> [--no-push]
 *   push
 * Any command accepts --dry-run: print the value that would be set, set nothing.
 *
 * `add` prints the client id and secret once; paste them into the connecting
 * app. The secret is not stored. --admin also lets the client be granted
 * `mcp:admin` (default: `mcp` only).
 *
 * The local file is the source of truth: `push` overwrites the deployed secret
 * with it. If clients were set some other way, add them here first.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workerDir = fileURLToPath(new URL('..', import.meta.url));
const file = process.env.OAUTH_CLIENTS_FILE ?? `${workerDir}.oauth-clients.json`;

const fail = message => { console.error(message); process.exit(1); };

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(arg => arg.startsWith('--') && arg !== '--id'));
const idFlag = argv.indexOf('--id');
const givenId = idFlag >= 0 ? argv[idFlag + 1] : undefined;
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !(idFlag >= 0 && i === idFlag + 1));
const [command, ...args] = positional;

function load() {
  if (!existsSync(file)) return [];
  try {
    const clients = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(clients)) throw new Error('not an array');
    return clients;
  } catch (cause) {
    return fail(`${file} is not a valid client list (${cause.message}). Fix or delete it.`);
  }
}

const save = clients => writeFileSync(file, `${JSON.stringify(clients, null, 2)}\n`);

function push(clients) {
  const value = JSON.stringify(clients); // one line, no pasting involved
  if (flags.has('--dry-run')) {
    console.log(`\n[dry run] would set OAUTH_CLIENTS to:\n${value}`);
    return;
  }
  const wranglerBin = createRequire(import.meta.url).resolve('wrangler/bin/wrangler.js');
  console.log(`\nSetting OAUTH_CLIENTS (${clients.length} client${clients.length === 1 ? '' : 's'}) with wrangler...`);
  execFileSync(process.execPath, [wranglerBin, 'secret', 'put', 'OAUTH_CLIENTS'], {
    cwd: workerDir, input: value, stdio: ['pipe', 'inherit', 'inherit'],
  });
}

switch (command) {
  case 'add': {
    const [name, redirectUri] = args;
    if (!name || !redirectUri) fail('Usage: add <name> <redirect-uri> [--admin] [--id <client-id>] [--no-push]');
    try { new URL(redirectUri); } catch { fail(`Not a URL: ${redirectUri}`); }
    const clients = load();
    const clientId = givenId ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomBytes(4).toString('hex')}`;
    if (clients.some(c => c.client_id === clientId)) fail(`Client ${clientId} already exists. Remove it first, or pick another --id.`);
    const secret = randomBytes(32).toString('base64url');
    clients.push({
      client_id: clientId,
      name,
      secret_sha256: createHash('sha256').update(secret).digest('hex'),
      redirect_uris: [redirectUri],
      ...(flags.has('--admin') ? { scopes: ['mcp', 'mcp:admin'] } : {}),
    });
    if (!flags.has('--dry-run')) save(clients);
    console.log(`Client ID:     ${clientId}`);
    console.log(`Client secret: ${secret}`);
    console.log('\nPaste both into the connecting app now. The secret is not stored anywhere.');
    if (flags.has('--no-push')) console.log('Not pushed. Run `push` to deploy it.');
    else push(clients);
    break;
  }
  case 'list': {
    const clients = load();
    if (clients.length === 0) console.log('No clients.');
    for (const c of clients) console.log(`${c.client_id}  ${c.name}  scopes: ${(c.scopes ?? ['mcp']).join(' ')}  redirect: ${c.redirect_uris.join(', ')}`);
    break;
  }
  case 'remove': {
    const [clientId] = args;
    if (!clientId) fail('Usage: remove <client-id> [--no-push]');
    const clients = load();
    if (!clients.some(c => c.client_id === clientId)) fail(`No client ${clientId}. Try \`list\`.`);
    const remaining = clients.filter(c => c.client_id !== clientId);
    if (!flags.has('--dry-run')) save(remaining);
    console.log(`Removed ${clientId}. Its tokens stop working once the secret is updated.`);
    if (flags.has('--no-push')) console.log('Not pushed. Run `push` to deploy it.');
    else push(remaining);
    break;
  }
  case 'push':
    push(load());
    break;
  default:
    fail('Usage: oauth-client.mjs add|list|remove|push (see the header of this file).');
}
