#!/usr/bin/env node
/**
 * Makes one entry for the OAUTH_CLIENTS Worker secret.
 *
 * Usage:
 *   node scripts/oauth-client.mjs <name> <redirect-uri> [client-id]
 *   node scripts/oauth-client.mjs gemini https://vertexaisearch.cloud.google.com/oauth-redirect
 *
 * Prints the client id and secret to paste into the connecting app (the secret
 * is shown once and never stored), and the JSON entry to add to the secret.
 * Only the SHA-256 hash of the secret goes in the entry.
 */
import { createHash, randomBytes } from 'node:crypto';

const [name, redirectUri, givenId] = process.argv.slice(2);
if (!name || !redirectUri) {
  console.error('Usage: node scripts/oauth-client.mjs <name> <redirect-uri> [client-id]');
  process.exit(1);
}

const clientId = givenId ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomBytes(4).toString('hex')}`;
const secret = randomBytes(32).toString('base64url');
const entry = {
  client_id: clientId,
  name,
  secret_sha256: createHash('sha256').update(secret).digest('hex'),
  redirect_uris: [redirectUri],
};

console.log(`Client ID:     ${clientId}`);
console.log(`Client secret: ${secret}`);
console.log('\nAdd this to the OAUTH_CLIENTS JSON array (a list of entries):\n');
console.log(JSON.stringify(entry, null, 2));
console.log('\nThen set the whole array: cd worker && npx wrangler secret put OAUTH_CLIENTS');
console.log('(or Cloudflare dashboard > Worker > Settings > Variables and Secrets).');
