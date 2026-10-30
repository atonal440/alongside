import * as v from 'valibot';
import type { Env } from './index';
import { OAuthClientIdSchema, OAuthTokenBodySchema } from './wire';

// Single-owner OAuth 2.1 authorization server for MCP connectors.
// The owner proves themselves with AUTH_TOKEN on the authorize page; clients
// get their own short-lived access tokens and rotating refresh tokens instead
// of AUTH_TOKEN itself. Only SHA-256 hashes of issued tokens are stored.
//
// Two kinds of client:
//  - dynamic (RFC 7591): self-registered, stored in D1, public, PKCE required.
//  - pre-registered: the OAUTH_CLIENTS secret, for clients like Gemini that
//    cannot register themselves. Confidential: authenticated by secret.
// Auth codes live in D1, not memory, because Workers requests may hit
// different isolates.

const CODE_EXPIRY_MS = 60_000;
const ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600;
const USED_REFRESH_RETENTION_MS = 7 * 24 * 3600 * 1000; // kept so a replayed token is detected
const MAX_DYNAMIC_CLIENTS = 200;
const SCOPE_MCP = 'mcp';
const SCOPE_ADMIN = 'mcp:admin';
const SUPPORTED_SCOPES = [SCOPE_MCP, SCOPE_ADMIN] as const;
const encoder = new TextEncoder();

interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  /** SHA-256 hex of the client secret; null for public clients. */
  secretSha256: string | null;
  /** The most this client may ever be granted. */
  scopes: string[];
}

const StaticClientsSchema = v.array(v.object({
  client_id: OAuthClientIdSchema,
  name: v.optional(v.string()),
  secret_sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  redirect_uris: v.pipe(v.array(v.string()), v.minLength(1)),
  scopes: v.optional(v.array(v.picklist(SUPPORTED_SCOPES))),
}));

function randomString(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
}

async function sha256Hex(input: string): Promise<string> {
  return [...await sha256(input)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Compares digests, so neither the length nor the content of a secret leaks through timing. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers },
  });
}

function tokenJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return json(data, status, { 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers });
}

function oauthError(error: string, description: string, status = 400, headers: Record<string, string> = {}): Response {
  return tokenJson({ error, error_description: description }, status, headers);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Clients ──

function staticClients(env: Env): OAuthClient[] {
  if (!env.OAUTH_CLIENTS) return [];
  try {
    const parsed = v.safeParse(StaticClientsSchema, JSON.parse(env.OAUTH_CLIENTS));
    if (!parsed.success) {
      console.warn('OAUTH_CLIENTS ignored: does not match the expected shape');
      return [];
    }
    return parsed.output.map(c => ({ clientId: c.client_id, name: c.name || c.client_id, redirectUris: c.redirect_uris, secretSha256: c.secret_sha256, scopes: c.scopes ?? [SCOPE_MCP] }));
  } catch {
    console.warn('OAUTH_CLIENTS ignored: not valid JSON');
    return [];
  }
}

async function findClient(env: Env, clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const fixed = staticClients(env).find(c => c.clientId === clientId);
  if (fixed) return fixed;
  const row = await env.DB.prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?')
    .bind(clientId).first<{ client_id: string; client_name: string; redirect_uris: string }>();
  if (!row) return null;
  return { clientId: row.client_id, name: row.client_name, redirectUris: JSON.parse(row.redirect_uris) as string[], secretSha256: null, scopes: [...SUPPORTED_SCOPES] };
}

/** Dynamic clients may only redirect to https, or to a loopback address (native apps). */
function isAllowedRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function registerClient(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json<Record<string, unknown>>();
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be JSON.');
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirect)) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be 1-10 https URLs (or loopback http URLs).');
  }
  const name = (typeof body.client_name === 'string' ? body.client_name : '').slice(0, 100) || 'Unnamed client';
  // Registration is unauthenticated, so the table is bounded. Room is made by dropping the oldest clients
  // nobody ever got a token with; an approved client is never evicted, or anyone could disconnect the owner.
  await env.DB.prepare(
    'DELETE FROM oauth_clients WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_tokens) ORDER BY created_at, rowid LIMIT MAX(0, (SELECT COUNT(*) FROM oauth_clients) - ? + 1))',
  ).bind(MAX_DYNAMIC_CLIENTS).run();
  const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first<{ n: number }>())!;
  if (n >= MAX_DYNAMIC_CLIENTS) return oauthError('temporarily_unavailable', 'Too many registered clients.', 429);
  const clientId = `c_${randomString(12)}`;
  const issuedAt = Date.now();
  await env.DB.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .bind(clientId, name, JSON.stringify(uris), issuedAt).run();
  return tokenJson({
    client_id: clientId,
    client_id_issued_at: Math.floor(issuedAt / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
}

// ── Discovery ──

/** Where a client learns how to authorize for a given protected resource path (RFC 9728). */
export function protectedResourceMetadataUrl(url: URL): string {
  const mcpPath = url.pathname.replace(/\/+$/, '');
  const suffix = mcpPath === '/mcp' || mcpPath === '/mcp/admin' ? mcpPath : '';
  return `${url.origin}/.well-known/oauth-protected-resource${suffix}`;
}

function protectedResourceMetadata(url: URL, resourcePath: string): Response {
  return json({
    resource: `${url.origin}${resourcePath}`,
    authorization_servers: [url.origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [requiredScopeFor(resourcePath)],
  });
}

function authorizationServerMetadata(url: URL): Response {
  const issuer = url.origin;
  return json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  });
}

// ── Authorization endpoint ──

interface AuthorizeRequest {
  client: OAuthClient;
  scope: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

type Validated = { ok: true; request: AuthorizeRequest } | { ok: false; response: Response };

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function redirectWithError(redirectUri: string, state: string, error: string, description: string): Response {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return redirectResponse(target.toString());
}

/** What to grant for a request: unknown scopes (e.g. `offline_access`) are ignored, none means plain `mcp`. Null when the client may not have what it asked for. */
function resolveScope(client: OAuthClient, requested: string): string | null {
  const asked = requested.split(/\s+/).filter(scope => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
  const granted = [...new Set(asked.length ? asked : [SCOPE_MCP])];
  return granted.every(scope => client.scopes.includes(scope)) ? granted.join(' ') : null;
}

async function validateAuthorize(env: Env, get: (name: string) => string): Promise<Validated> {
  const client = await findClient(env, get('client_id'));
  const redirectUri = get('redirect_uri');
  // Never redirect to an unverified URI: show the problem instead.
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, response: htmlResponse(page('<h1>Cannot connect</h1><p>This app is not registered with Alongside, or its return address does not match. Remove the connection and add it again.</p>'), 400) };
  }
  const state = get('state');
  if (get('response_type') !== 'code') return { ok: false, response: redirectWithError(redirectUri, state, 'unsupported_response_type', 'Only response_type=code is supported.') };
  const scope = resolveScope(client, get('scope'));
  if (!scope) return { ok: false, response: redirectWithError(redirectUri, state, 'invalid_scope', 'This client is not allowed that scope.') };
  const codeChallenge = get('code_challenge');
  if (codeChallenge) {
    if (get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      return { ok: false, response: redirectWithError(redirectUri, state, 'invalid_request', 'code_challenge must be a valid S256 challenge.') };
    }
  } else if (!client.secretSha256) {
    return { ok: false, response: redirectWithError(redirectUri, state, 'invalid_request', 'PKCE (S256) is required for this client.') };
  }
  return { ok: true, request: { client, scope, redirectUri, state, codeChallenge } };
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alongside — Authorize</title>
<style>
  body { font-family: system-ui; background: #1a1a1a; color: #e0e0e0; display: flex;
    justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #252525; border-radius: 12px; padding: 32px; max-width: 360px; width: 100%; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 13px; color: #888; margin: 0 0 20px; }
  label { font-size: 12px; color: #888; display: block; margin-bottom: 4px; }
  input[type=password] { width: 100%; background: #1a1a1a; border: 1px solid #333; color: #e0e0e0;
    padding: 10px; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
  input:focus { border-color: #6b9fff; outline: none; }
  button { width: 100%; background: #4a7ad4; border: none; color: white; padding: 10px;
    border-radius: 6px; font-size: 14px; cursor: pointer; margin-top: 16px; }
  button:hover { background: #6b9fff; }
  .error { color: #e57373; font-size: 13px; margin-top: 8px; }
</style></head>
<body><div class="card">${body}</div></body></html>`;
}

function authorizePage(req: AuthorizeRequest, error = ''): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeAttr(value)}">`;
  const returnsTo = new URL(req.redirectUri).host;
  return page(`
  <h1>Alongside</h1>
  <p><strong>${escapeAttr(req.client.name)}</strong> wants to connect${req.scope.split(' ').includes(SCOPE_ADMIN) ? ' <strong>with the admin tools</strong>' : ''}, then return to ${escapeAttr(returnsTo)}. Enter your auth token to allow it.</p>
  <form method="POST">
    ${hidden('response_type', 'code')}
    ${hidden('client_id', req.client.clientId)}
    ${hidden('redirect_uri', req.redirectUri)}
    ${hidden('scope', req.scope)}
    ${hidden('state', req.state)}
    ${req.codeChallenge ? hidden('code_challenge', req.codeChallenge) + hidden('code_challenge_method', 'S256') : ''}
    <label>Auth Token</label>
    <input type="password" name="token" autofocus placeholder="paste your token">
    <button type="submit">Authorize</button>
    ${error ? `<div class="error">${escapeAttr(error)}</div>` : ''}
  </form>`);
}

async function handleAuthorize(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    const checked = await validateAuthorize(env, name => url.searchParams.get(name) || '');
    return checked.ok ? htmlResponse(authorizePage(checked.request)) : checked.response;
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const form = await request.formData();
  const field = (name: string) => (typeof form.get(name) === 'string' ? (form.get(name) as string) : '');
  // Everything was echoed through hidden fields, so check it all again.
  const checked = await validateAuthorize(env, field);
  if (!checked.ok) return checked.response;
  const req = checked.request;

  if (!await timingSafeEqual(field('token'), env.AUTH_TOKEN)) {
    return htmlResponse(authorizePage(req, 'Invalid token. Try again.'), 401);
  }

  const code = randomString(16);
  await env.DB.prepare('INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(code, req.client.clientId, req.redirectUri, req.codeChallenge, Date.now() + CODE_EXPIRY_MS, req.scope).run();

  const target = new URL(req.redirectUri);
  target.searchParams.set('code', code);
  if (req.state) target.searchParams.set('state', req.state);
  return redirectResponse(target.toString());
}

// ── Token endpoint ──

async function readParams(request: Request): Promise<Record<string, string> | null> {
  try {
    if ((request.headers.get('content-type') || '').includes('application/json')) {
      const body = await request.json<Record<string, unknown>>();
      return Object.fromEntries(Object.entries(body).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    }
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Accepts client_secret_basic and client_secret_post. Public clients only need to be known. */
async function authenticateClient(request: Request, env: Env, params: Record<string, string>): Promise<{ client: OAuthClient } | { error: Response }> {
  let clientId = params.client_id || '';
  let secret = params.client_secret || '';
  const authorization = request.headers.get('authorization') || '';
  if (authorization.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(authorization.slice(6).trim());
      const split = decoded.indexOf(':');
      clientId = decodeURIComponent(decoded.slice(0, split).replace(/\+/g, ' '));
      secret = decodeURIComponent(decoded.slice(split + 1).replace(/\+/g, ' '));
    } catch {
      return { error: oauthError('invalid_client', 'Malformed Basic credentials.', 401, { 'WWW-Authenticate': 'Basic realm="alongside"' }) };
    }
  }
  const client = await findClient(env, clientId);
  const failure = { error: oauthError('invalid_client', 'Client authentication failed.', 401, { 'WWW-Authenticate': 'Basic realm="alongside"' }) };
  if (!client) return failure;
  if (client.secretSha256 && !(secret && await timingSafeEqual(await sha256Hex(secret), client.secretSha256))) return failure;
  return { client };
}

/**
 * Mints an access and refresh token. With `claimHash` the refresh token being redeemed is marked used in the same
 * transaction, and the new pair is only inserted if that claim took effect, so a concurrent replay or revoke cannot
 * be undone by a request that was already in flight. Returns null when the claim failed.
 */
async function issueTokens(env: Env, clientId: string, familyId: string, scope: string, claimHash?: string): Promise<Response | null> {
  const access = `alo_at_${randomString(32)}`;
  const refresh = `alo_rt_${randomString(32)}`;
  const accessHash = await sha256Hex(access);
  const now = Date.now();
  // changes() is the claim's row count for the first insert, then the first insert's for the second.
  const insert = `INSERT INTO oauth_tokens (token_hash, kind, client_id, scope, family_id, expires_at) SELECT ?, ?, ?, ?, ?, ?${claimHash ? ' WHERE changes() > 0' : ''}`;
  const statements = [
    env.DB.prepare(insert).bind(accessHash, 'access', clientId, scope, familyId, now + ACCESS_TOKEN_TTL_S * 1000),
    env.DB.prepare(insert).bind(await sha256Hex(refresh), 'refresh', clientId, scope, familyId, now + REFRESH_TOKEN_TTL_S * 1000),
  ];
  if (claimHash) {
    statements.unshift(env.DB.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(now, claimHash));
    statements.push(env.DB.prepare("DELETE FROM oauth_tokens WHERE family_id = ? AND kind = 'access' AND token_hash != ?").bind(familyId, accessHash));
  }
  const results = await env.DB.batch(statements);
  if (claimHash && results[0]!.meta.changes !== 1) return null;
  return tokenJson({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refresh,
    scope,
  });
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  const params = await readParams(request);
  if (!params) return oauthError('invalid_request', 'Could not read the request body.');
  if (params.grant_type !== 'authorization_code' && params.grant_type !== 'refresh_token') {
    return oauthError('unsupported_grant_type', 'Supported grants: authorization_code, refresh_token.');
  }
  const body = v.safeParse(OAuthTokenBodySchema, params);
  if (!body.success) return oauthError('invalid_request', 'Missing or malformed parameters.');

  const authenticated = await authenticateClient(request, env, params);
  if ('error' in authenticated) return authenticated.error;
  const { client } = authenticated;
  const grant = body.output;

  if (grant.grant_type === 'authorization_code') {
    // Deleting returns the row, so a code can be redeemed exactly once.
    const stored = await env.DB.prepare('DELETE FROM oauth_codes WHERE code = ? RETURNING client_id, redirect_uri, code_challenge, expires_at, scope')
      .bind(grant.code).first<{ client_id: string; redirect_uri: string; code_challenge: string; expires_at: number; scope: string }>();
    const invalid = (description: string) => oauthError('invalid_grant', description);
    if (!stored || stored.client_id !== client.clientId) return invalid('Unknown or expired code');
    if (Date.now() > stored.expires_at) return invalid('Code expired');
    if (grant.redirect_uri !== stored.redirect_uri) return invalid('redirect_uri does not match the authorization request');
    if (stored.code_challenge) {
      const expected = base64Url(await sha256(grant.code_verifier ?? ''));
      if (!grant.code_verifier || !await timingSafeEqual(expected, stored.code_challenge)) return invalid('PKCE verification failed');
    }
    return (await issueTokens(env, client.clientId, randomString(8), stored.scope))!;
  }

  // refresh_token: single use. Presenting a used one means it leaked, so end the whole chain.
  const hash = await sha256Hex(grant.refresh_token);
  const row = await env.DB.prepare("SELECT client_id, family_id, scope, expires_at, used_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
    .bind(hash).first<{ client_id: string; family_id: string; scope: string; expires_at: number; used_at: number | null }>();
  if (!row || row.client_id !== client.clientId) return oauthError('invalid_grant', 'Unknown refresh token');
  const revokeFamily = () => env.DB.prepare('DELETE FROM oauth_tokens WHERE family_id = ?').bind(row.family_id).run();
  if (row.used_at !== null) {
    await revokeFamily();
    return oauthError('invalid_grant', 'Refresh token was already used');
  }
  if (Date.now() > row.expires_at) return oauthError('invalid_grant', 'Refresh token expired');
  const issued = await issueTokens(env, client.clientId, row.family_id, row.scope, hash);
  if (issued) return issued;
  // Lost the race for this refresh token: someone else redeemed or revoked it first.
  await revokeFamily();
  return oauthError('invalid_grant', 'Refresh token was already used');
}

/** RFC 7009: revoking either token of a pair ends the whole chain. Always answers 200. */
async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const params = await readParams(request);
  if (!params) return oauthError('invalid_request', 'Could not read the request body.');
  const authenticated = await authenticateClient(request, env, params);
  if ('error' in authenticated) return authenticated.error;
  if (params.token) {
    await env.DB.prepare('DELETE FROM oauth_tokens WHERE family_id IN (SELECT family_id FROM oauth_tokens WHERE token_hash = ? AND client_id = ?)')
      .bind(await sha256Hex(params.token), authenticated.client.clientId).run();
  }
  return tokenJson({});
}

// ── Resource side ──

/** `mcp:admin` for the admin endpoint, `mcp` for everything else under /mcp. */
export function requiredScopeFor(pathname: string): string {
  return pathname.replace(/\/+$/, '') === '/mcp/admin' ? SCOPE_ADMIN : SCOPE_MCP;
}

export type AccessCheck = 'ok' | 'invalid' | 'insufficient_scope';

/**
 * Checks an OAuth access token for a path under /mcp: live, its client still registered, and carrying `requiredScope`
 * (`mcp:admin` also satisfies `mcp`). Revoking a client (removing it from OAUTH_CLIENTS or D1) cuts it off at once.
 */
export async function checkAccessToken(env: Env, token: string, requiredScope: string): Promise<AccessCheck> {
  const row = await env.DB.prepare(
    "SELECT t.client_id, t.scope, c.client_id AS dynamic_client FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?",
  ).bind(await sha256Hex(token), Date.now()).first<{ client_id: string; scope: string; dynamic_client: string | null }>();
  if (!row) return 'invalid';
  if (row.dynamic_client === null && !staticClients(env).some(c => c.clientId === row.client_id)) return 'invalid';
  const held = row.scope.split(' ');
  return held.includes(requiredScope) || (requiredScope === SCOPE_MCP && held.includes(SCOPE_ADMIN)) ? 'ok' : 'insufficient_scope';
}

/** The `WWW-Authenticate` value for a refused /mcp request: where to learn how to authorize, and which scope it needs. */
export function bearerChallenge(url: URL, insufficientScope = false): string {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(url)}"`];
  if (url.pathname.startsWith('/mcp')) parts.push(`scope="${requiredScopeFor(url.pathname)}"`);
  if (insufficientScope) parts.unshift('error="insufficient_scope"');
  return `Bearer ${parts.join(', ')}`;
}

/** Compares the presented AUTH_TOKEN without leaking timing. */
export function isOwnerToken(env: Env, token: string | undefined): Promise<boolean> {
  return token ? timingSafeEqual(token, env.AUTH_TOKEN) : Promise.resolve(false);
}

/** Cron housekeeping: drops expired codes and tokens, and used refresh tokens once the replay-detection window has passed. */
export async function purgeExpiredOAuth(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)').bind(now, now - USED_REFRESH_RETENTION_MS),
  ]);
}

export async function handleOAuthRequest(request: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/.well-known/oauth-protected-resource') return protectedResourceMetadata(url, '/mcp');
  if (path === '/.well-known/oauth-protected-resource/mcp') return protectedResourceMetadata(url, '/mcp');
  if (path === '/.well-known/oauth-protected-resource/mcp/admin') return protectedResourceMetadata(url, '/mcp/admin');
  if (path === '/.well-known/oauth-authorization-server') return authorizationServerMetadata(url);

  if (path === '/oauth/register' && request.method === 'POST') return registerClient(request, env);
  if (path === '/oauth/authorize') return handleAuthorize(request, url, env);
  if (path === '/oauth/token' && request.method === 'POST') return handleToken(request, env);
  if (path === '/oauth/revoke' && request.method === 'POST') return handleRevoke(request, env);

  return null; // Not an OAuth route
}
