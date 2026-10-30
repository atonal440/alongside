import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import worker, { type Env } from '../src/index';
import { purgeExpiredOAuth } from '../src/oauth';
import { sqliteD1 } from './helpers/sqliteD1';

const ORIGIN = 'https://alongside.test';
const OWNER = 'owner-token';
const REDIRECT = 'https://client.example/callback';
const GEMINI_REDIRECT = 'https://vertexaisearch.cloud.google.com/oauth-redirect';
const GEMINI_SECRET = 'gemini-secret';

const worlds: ReturnType<typeof sqliteD1>[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.sql.close(); });

function setup(extra: Partial<Env> = {}) {
  const world = sqliteD1();
  worlds.push(world);
  const env: Env = { DB: world.d1, AUTH_TOKEN: OWNER, ...extra };
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  return { env, sql: world.sql, call };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const form = (data: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(data).toString(),
});

const geminiClients = () => JSON.stringify([{
  client_id: 'gemini',
  name: 'Gemini',
  secret_sha256: createHash('sha256').update(GEMINI_SECRET).digest('hex'),
  redirect_uris: [GEMINI_REDIRECT],
}]);

type Call = ReturnType<typeof setup>['call'];

async function register(call: Call, redirect = REDIRECT) {
  const response = await call('/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test app', redirect_uris: [redirect] }),
  });
  return { response, body: await response.json<Record<string, unknown>>() };
}

async function authorize(call: Call, params: Record<string, string>, token = OWNER) {
  const base = { response_type: 'code', state: 'xyz', ...params };
  const response = await call('/oauth/authorize', form({ ...base, token }));
  const location = response.headers.get('location');
  return { response, location: location ? new URL(location) : null };
}

async function connect(call: Call) {
  const { body: client } = await register(call);
  const { verifier, challenge } = pkce();
  const clientId = client.client_id as string;
  const { location } = await authorize(call, { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
  const response = await call('/oauth/token', form({
    grant_type: 'authorization_code', code: location!.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier,
  }));
  return { clientId, verifier, challenge, response, tokens: await response.json<Record<string, any>>() };
}

const mcpList = (call: Call, token: string) => call('/mcp', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

describe('discovery', () => {
  it('names the real resource for each MCP path and points 401s at the matching document', async () => {
    const { call } = setup();
    expect((await (await call('/.well-known/oauth-protected-resource/mcp')).json<any>()).resource).toBe(`${ORIGIN}/mcp`);
    expect((await (await call('/.well-known/oauth-protected-resource/mcp/admin')).json<any>()).resource).toBe(`${ORIGIN}/mcp/admin`);
    const denied = await call('/mcp/admin', { method: 'POST' });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/admin`);
  });

  it('advertises refresh, revocation and client authentication methods, with CORS', async () => {
    const response = await setup().call('/.well-known/oauth-authorization-server');
    const metadata = await response.json<any>();
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(metadata.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none', 'client_secret_basic', 'client_secret_post']);
  });
});

describe('dynamic registration', () => {
  it('stores the client and issues an id', async () => {
    const { call, sql } = setup();
    const { response, body } = await register(call);
    expect(response.status).toBe(201);
    expect(body.client_id).toMatch(/^c_/);
    expect(sql.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?').get(body.client_id as string)).toEqual({ redirect_uris: JSON.stringify([REDIRECT]) });
  });

  it.each([['http://evil.example/cb'], ['not a url'], ['https://x.example/cb#frag']])('rejects redirect %s', async redirect => {
    const { response, body } = await register(setup().call, redirect);
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('allows loopback http for native apps', async () => {
    expect((await register(setup().call, 'http://127.0.0.1:8123/cb')).response.status).toBe(201);
  });
});

describe('registration limits', () => {
  it('never evicts a client that has been approved, however many anonymous registrations arrive', async () => {
    const { call, sql } = setup();
    const { clientId, tokens } = await connect(call);
    for (let i = 0; i < 205; i++) await register(call);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual({ n: 200 });
    expect((await mcpList(call, tokens.access_token)).status).toBe(200);
    const refresh = await call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(refresh.status).toBe(200);
  });

  it('refuses new registrations once every slot belongs to an approved client', async () => {
    const { call, sql } = setup();
    for (let i = 0; i < 200; i++) {
      sql.prepare('INSERT INTO oauth_clients VALUES (?, ?, ?, ?)').run(`c_${i}`, 'app', '[]', i);
      sql.prepare('INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, ?, ?, NULL)').run(`h${i}`, 'refresh', `c_${i}`, 'mcp', `f${i}`, Date.now() + 1e6);
    }
    expect((await register(call)).response.status).toBe(429);
  });
});

describe('authorize', () => {
  it('shows an error page, never a redirect, for an unknown client or unregistered redirect', async () => {
    const { call } = setup();
    const { body } = await register(call);
    const query = (params: Record<string, string>) => `/oauth/authorize?${new URLSearchParams({ response_type: 'code', ...params })}`;
    const unknownClient = await call(query({ client_id: 'nope', redirect_uri: REDIRECT }));
    const wrongRedirect = await call(query({ client_id: body.client_id as string, redirect_uri: 'https://evil.example/cb' }));
    for (const response of [unknownClient, wrongRedirect]) {
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('requires PKCE S256 from public clients and reports it through the verified redirect', async () => {
    const { call } = setup();
    const { body } = await register(call);
    const { location } = await authorize(call, { client_id: body.client_id as string, redirect_uri: REDIRECT });
    expect(location!.searchParams.get('error')).toBe('invalid_request');
    expect(location!.searchParams.get('state')).toBe('xyz');
    const plain = await authorize(call, { client_id: body.client_id as string, redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' });
    expect(plain.location!.searchParams.get('error')).toBe('invalid_request');
  });

  it('renders the form with the client name, and refuses a wrong owner token', async () => {
    const { call } = setup();
    const { body } = await register(call);
    const { challenge } = pkce();
    const params = { client_id: body.client_id as string, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' };
    const page = await call(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', ...params })}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toContain('Test app');
    const wrong = await authorize(call, params, 'wrong');
    expect(wrong.response.status).toBe(401);
    expect(wrong.location).toBeNull();
  });
});

describe('token endpoint', () => {
  it('completes the flow and gives out hashed, expiring access and refresh tokens', async () => {
    const { call, sql } = setup();
    const { response, tokens } = await connect(call);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(tokens.access_token).not.toBe(OWNER);
    const stored = sql.prepare('SELECT token_hash FROM oauth_tokens').all().map(row => row.token_hash);
    expect(stored).toHaveLength(2);
    expect(stored).not.toContain(tokens.access_token);
  });

  it('opens /mcp with an issued token but not the REST API', async () => {
    const { call } = setup();
    const { tokens } = await connect(call);
    expect((await mcpList(call, tokens.access_token)).status).toBe(200);
    expect((await call('/api/tasks', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await mcpList(call, 'alo_at_unknown')).status).toBe(401);
  });

  it('still accepts the owner token everywhere', async () => {
    const { call } = setup();
    expect((await mcpList(call, OWNER)).status).toBe(200);
    expect((await call('/api/tasks', { headers: { Authorization: `Bearer ${OWNER}` } })).status).not.toBe(401);
  });

  it('redeems a code once, and only with the matching verifier and redirect', async () => {
    const { call } = setup();
    const { body } = await register(call);
    const clientId = body.client_id as string;
    const { verifier, challenge } = pkce();
    const issue = async () => (await authorize(call, { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })).location!.searchParams.get('code')!;
    const redeem = (code: string, overrides: Record<string, string> = {}) => call('/oauth/token', form({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, ...overrides,
    }));

    const code = await issue();
    expect((await redeem(code)).status).toBe(200);
    expect((await redeem(code)).status).toBe(400);
    expect((await (await redeem(await issue(), { code_verifier: pkce().verifier })).json<any>()).error_description).toContain('PKCE');
    expect((await (await redeem(await issue(), { redirect_uri: 'https://other.example/cb' })).json<any>()).error).toBe('invalid_grant');
  });

  it('refuses an expired code', async () => {
    const { call, sql } = setup();
    const { body } = await register(call);
    const { verifier, challenge } = pkce();
    const code = (await authorize(call, { client_id: body.client_id as string, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })).location!.searchParams.get('code')!;
    sql.prepare('UPDATE oauth_codes SET expires_at = 1').run();
    const response = await call('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: body.client_id as string, code_verifier: verifier }));
    expect((await response.json<any>()).error_description).toBe('Code expired');
  });

  it('rotates refresh tokens and ends the chain when an old one is replayed', async () => {
    const { call, sql } = setup();
    const { clientId, tokens } = await connect(call);
    const refresh = (token: string) => call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }));

    const next = await (await refresh(tokens.refresh_token)).json<any>();
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await mcpList(call, tokens.access_token)).status).toBe(401);
    expect((await mcpList(call, next.access_token)).status).toBe(200);

    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    expect((await mcpList(call, next.access_token)).status).toBe(401);
    expect((await refresh(next.refresh_token)).status).toBe(400);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 });
  });

  it('leaves nothing behind when the same refresh token is redeemed twice at once', async () => {
    const { call, sql } = setup();
    const { clientId, tokens } = await connect(call);
    const refresh = () => call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    const responses = await Promise.all([refresh(), refresh()]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
    // The replay revoked the chain, so the winner's tokens must not survive either.
    expect(sql.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 });
  });

  it('does not recreate tokens for a chain revoked while a refresh was in flight', async () => {
    const { call, sql, env } = setup();
    const { clientId, tokens } = await connect(call);
    // Revoke lands between the lookup and the issuance batch.
    const realBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = (async (statements: any) => {
      env.DB.batch = realBatch;
      await call('/oauth/revoke', form({ token: tokens.refresh_token, client_id: clientId }));
      return realBatch(statements);
    }) as typeof env.DB.batch;
    const response = await call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(response.status).toBe(400);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 });
  });

  it('rejects unsupported grants and unknown clients', async () => {
    const { call } = setup();
    expect((await (await call('/oauth/token', form({ grant_type: 'password' }))).json<any>()).error).toBe('unsupported_grant_type');
    const unknown = await call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nope' }));
    expect(unknown.status).toBe(401);
  });
});

describe('pre-registered client (OAUTH_CLIENTS)', () => {
  const authorizeGemini = (call: Call, pkceChallenge?: string) => authorize(call, {
    client_id: 'gemini', redirect_uri: GEMINI_REDIRECT, ...(pkceChallenge ? { code_challenge: pkceChallenge, code_challenge_method: 'S256' } : {}),
  });
  const basic = (id: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}` });
  const exchange = (call: Call, code: string, extra: RequestInit['headers'] = {}, body: Record<string, string> = {}) => call('/oauth/token', form({
    grant_type: 'authorization_code', code, redirect_uri: GEMINI_REDIRECT, ...body,
  }, extra as Record<string, string>));

  it('works with HTTP Basic client auth and no PKCE', async () => {
    const { call } = setup({ OAUTH_CLIENTS: geminiClients() });
    const { location } = await authorizeGemini(call);
    const response = await exchange(call, location!.searchParams.get('code')!, basic('gemini', GEMINI_SECRET));
    expect(response.status).toBe(200);
    expect((await mcpList(call, (await response.json<any>()).access_token)).status).toBe(200);
  });

  it('works with the secret in the body and with PKCE', async () => {
    const { call } = setup({ OAUTH_CLIENTS: geminiClients() });
    const { verifier, challenge } = pkce();
    const { location } = await authorizeGemini(call, challenge);
    const response = await exchange(call, location!.searchParams.get('code')!, {}, { client_id: 'gemini', client_secret: GEMINI_SECRET, code_verifier: verifier });
    expect(response.status).toBe(200);
  });

  it('refuses a wrong or missing secret', async () => {
    const { call } = setup({ OAUTH_CLIENTS: geminiClients() });
    const code = (await authorizeGemini(call)).location!.searchParams.get('code')!;
    const wrong = await exchange(call, code, basic('gemini', 'not-the-secret'));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toContain('Basic');
    expect((await exchange(call, code, {}, { client_id: 'gemini' })).status).toBe(401);
  });

  it('cuts a client off the moment it leaves OAUTH_CLIENTS', async () => {
    const { call, env } = setup({ OAUTH_CLIENTS: geminiClients() });
    const { location } = await authorizeGemini(call);
    const { access_token } = await (await exchange(call, location!.searchParams.get('code')!, basic('gemini', GEMINI_SECRET))).json<any>();
    expect((await mcpList(call, access_token)).status).toBe(200);
    delete env.OAUTH_CLIENTS;
    expect((await mcpList(call, access_token)).status).toBe(401);
  });

  it('ignores a malformed secret instead of failing requests', async () => {
    const { call } = setup({ OAUTH_CLIENTS: '{oops' });
    expect((await mcpList(call, OWNER)).status).toBe(200);
    expect((await authorizeGemini(call)).response.status).toBe(400);
  });
});

describe('revocation and cleanup', () => {
  it('revokes the whole chain from either token', async () => {
    const { call } = setup();
    const { clientId, tokens } = await connect(call);
    const response = await call('/oauth/revoke', form({ token: tokens.refresh_token, client_id: clientId }));
    expect(response.status).toBe(200);
    expect((await mcpList(call, tokens.access_token)).status).toBe(401);
  });

  it('does not let one client revoke another client\'s token', async () => {
    const { call } = setup();
    const { tokens } = await connect(call);
    const { body: other } = await register(call);
    await call('/oauth/revoke', form({ token: tokens.access_token, client_id: other.client_id as string }));
    expect((await mcpList(call, tokens.access_token)).status).toBe(200);
  });

  it('stops tokens working when a dynamic client is deleted', async () => {
    const { call, sql } = setup();
    const { tokens } = await connect(call);
    sql.exec('DELETE FROM oauth_clients');
    expect((await mcpList(call, tokens.access_token)).status).toBe(401);
  });

  it('purges expired codes and tokens, and used refresh tokens past the replay window', async () => {
    const { call, env, sql } = setup();
    const { clientId, tokens } = await connect(call);
    await call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    sql.prepare('INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)').run('old', 'c', REDIRECT, '', 1);

    await purgeExpiredOAuth(env.DB);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 3 }); // used refresh kept for replay detection

    await purgeExpiredOAuth(env.DB, Date.now() + 8 * 24 * 3600 * 1000);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 1 }); // the used refresh and the 1h access token went; the live refresh stays
  });
});
