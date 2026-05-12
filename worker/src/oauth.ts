import type { Env } from './index';

// Minimal OAuth 2.1 authorization server for MCP.
// Uses AUTH_TOKEN as the password in a simple login form.
// Issues the AUTH_TOKEN itself as the access token so existing
// bearer auth checks work unchanged.
// Auth codes are stored in D1 (not in-memory) because Workers
// requests may hit different isolates.

const CODE_EXPIRY_MS = 60_000; // 1 minute

function randomString(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export async function handleOAuthRequest(request: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname;

  // ── Protected Resource Metadata (RFC 9728) ──
  if (path === '/.well-known/oauth-protected-resource') {
    const origin = url.origin;
    return json({
      resource: origin,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
    });
  }

  // ── Authorization Server Metadata ──
  if (path === '/.well-known/oauth-authorization-server') {
    const issuer = url.origin;
    return json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }

  // ── Dynamic Client Registration (RFC 7591) ──
  if (path === '/oauth/register' && request.method === 'POST') {
    const body = await request.json<Record<string, unknown>>();
    // Accept any registration and echo back a client_id
    const clientId = body.client_name as string || `client_${randomString(8)}`;
    return json({
      client_id: clientId,
      client_name: body.client_name || clientId,
      redirect_uris: body.redirect_uris || [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }, 201);
  }

  // ── Authorization endpoint ──
  if (path === '/oauth/authorize') {
    const clientId = url.searchParams.get('client_id') || '';
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    const codeChallenge = url.searchParams.get('code_challenge') || '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';

    if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
      return json({ error: 'unsupported code_challenge_method' }, 400);
    }

    // GET: show login form
    if (request.method === 'GET') {
      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alongside — Authorize</title>
<style>
  body { font-family: system-ui; background: #1a1a1a; color: #e0e0e0; display: flex;
    justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #252525; border-radius: 12px; padding: 32px; max-width: 360px; width: 100%; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 13px; color: #888; margin: 0 0 20px; }
  label { font-size: 12px; color: #888; display: block; margin-bottom: 4px; }
  input { width: 100%; background: #1a1a1a; border: 1px solid #333; color: #e0e0e0;
    padding: 10px; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
  input:focus { border-color: #6b9fff; outline: none; }
  button { width: 100%; background: #4a7ad4; border: none; color: white; padding: 10px;
    border-radius: 6px; font-size: 14px; cursor: pointer; margin-top: 16px; }
  button:hover { background: #6b9fff; }
  .error { color: #e57373; font-size: 13px; margin-top: 8px; display: none; }
</style></head>
<body><div class="card">
  <h1>Alongside</h1>
  <p>Enter your auth token to connect.</p>
  <form method="POST">
    <input type="hidden" name="client_id" value="${escapeAttr(clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeAttr(redirectUri)}">
    <input type="hidden" name="state" value="${escapeAttr(state)}">
    <input type="hidden" name="code_challenge" value="${escapeAttr(codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeAttr(codeChallengeMethod)}">
    <label>Auth Token</label>
    <input type="password" name="token" autofocus placeholder="paste your token">
    <button type="submit">Authorize</button>
    <div class="error" id="err"></div>
  </form>
</div></body></html>`;

      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // POST: validate token, issue code, redirect
    if (request.method === 'POST') {
      const formData = await request.formData();
      const token = formData.get('token') as string;
      const postClientId = formData.get('client_id') as string;
      const postRedirectUri = formData.get('redirect_uri') as string;
      const postState = formData.get('state') as string;
      const postCodeChallenge = formData.get('code_challenge') as string;

      if (token !== env.AUTH_TOKEN) {
        // Re-show form with error
        const errorHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alongside — Authorize</title>
<style>
  body { font-family: system-ui; background: #1a1a1a; color: #e0e0e0; display: flex;
    justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #252525; border-radius: 12px; padding: 32px; max-width: 360px; width: 100%; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 13px; color: #888; margin: 0 0 20px; }
  label { font-size: 12px; color: #888; display: block; margin-bottom: 4px; }
  input { width: 100%; background: #1a1a1a; border: 1px solid #333; color: #e0e0e0;
    padding: 10px; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
  input:focus { border-color: #6b9fff; outline: none; }
  button { width: 100%; background: #4a7ad4; border: none; color: white; padding: 10px;
    border-radius: 6px; font-size: 14px; cursor: pointer; margin-top: 16px; }
  .error { color: #e57373; font-size: 13px; margin-top: 8px; }
</style></head>
<body><div class="card">
  <h1>Alongside</h1>
  <p>Enter your auth token to connect.</p>
  <form method="POST">
    <input type="hidden" name="client_id" value="${escapeAttr(postClientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeAttr(postRedirectUri)}">
    <input type="hidden" name="state" value="${escapeAttr(postState)}">
    <input type="hidden" name="code_challenge" value="${escapeAttr(postCodeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="S256">
    <label>Auth Token</label>
    <input type="password" name="token" autofocus placeholder="paste your token">
    <button type="submit">Authorize</button>
    <div class="error">Invalid token. Try again.</div>
  </form>
</div></body></html>`;
        return new Response(errorHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // Token valid — generate auth code and store in D1
      const code = randomString(16);
      await env.DB.prepare(
        'INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(code, postClientId, postRedirectUri, postCodeChallenge || '', Date.now() + CODE_EXPIRY_MS).run();

      const redirect = new URL(postRedirectUri);
      redirect.searchParams.set('code', code);
      if (postState) redirect.searchParams.set('state', postState);

      return Response.redirect(redirect.toString(), 302);
    }
  }

  // ── Token endpoint ──
  if (path === '/oauth/token' && request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    let grantType: string, code: string, codeVerifier: string, clientId: string, redirectUri: string;

    if (contentType.includes('application/json')) {
      const body = await request.json<Record<string, string>>();
      grantType = body.grant_type || '';
      code = body.code || '';
      codeVerifier = body.code_verifier || '';
      clientId = body.client_id || '';
      redirectUri = body.redirect_uri || '';
    } else {
      const form = await request.formData();
      grantType = (form.get('grant_type') as string) || '';
      code = (form.get('code') as string) || '';
      codeVerifier = (form.get('code_verifier') as string) || '';
      clientId = (form.get('client_id') as string) || '';
      redirectUri = (form.get('redirect_uri') as string) || '';
    }

    if (grantType !== 'authorization_code') {
      return json({ error: 'unsupported_grant_type' }, 400);
    }

    // Look up and delete code atomically from D1
    const stored = await env.DB.prepare(
      'SELECT * FROM oauth_codes WHERE code = ?'
    ).bind(code).first<{ code: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }>();
    if (!stored) {
      return json({ error: 'invalid_grant', error_description: 'Unknown or expired code' }, 400);
    }

    await env.DB.prepare('DELETE FROM oauth_codes WHERE code = ?').bind(code).run();

    // Check expiry
    if (Date.now() > stored.expires_at) {
      return json({ error: 'invalid_grant', error_description: 'Code expired' }, 400);
    }

    // Verify PKCE
    if (stored.code_challenge) {
      const encoder = new TextEncoder();
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
      const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      if (expected !== stored.code_challenge) {
        return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      }
    }

    // Issue the AUTH_TOKEN as the access token
    return json({
      access_token: env.AUTH_TOKEN,
      token_type: 'Bearer',
      expires_in: 31536000, // 1 year — effectively non-expiring
    });
  }

  return null; // Not an OAuth route
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
