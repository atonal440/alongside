import { DB } from './db';
import { handleApiRequest } from './api';
import { checkClientGate, checkSyncReadGate } from './clientGate';
import { handleMcpRequest } from './mcp';
import { handleUiRequest } from './ui';
import { verifySignature } from './sign';
import { bearerChallenge, checkAccessToken, handleOAuthRequest, isOwnerToken, requiredScopeFor } from './oauth';
import { getHarnessHtml } from './dev-harness';
import { getAppHtml } from './app-ui';
import { handleScheduled } from './scheduled';

export interface Env {
  DB: D1Database;
  AUTH_TOKEN: string;
  /** JSON list of pre-registered OAuth clients (see docs/worker/oauth.md). Optional. */
  OAUTH_CLIENTS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for PWA
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Alongside-Client',
        },
      });
    }

    // OAuth routes bypass auth (they ARE the auth flow)
    const oauthResponse = await handleOAuthRequest(request, url, env);
    if (oauthResponse) return oauthResponse;

    // Dev harness for testing MCP App widget locally
    if (url.pathname === '/dev/app') {
      return new Response(getHarnessHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (url.pathname === '/dev/app-html') {
      return new Response(getAppHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Auth check
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    // AUTH_TOKEN opens everything. Tokens issued through OAuth only open /mcp, and /mcp/admin needs the admin scope.
    let authorized = await isOwnerToken(env, token);
    let insufficientScope = false;
    if (!authorized && token && url.pathname.startsWith('/mcp')) {
      const check = await checkAccessToken(env, token, requiredScopeFor(url.pathname));
      authorized = check === 'ok';
      insufficientScope = check === 'insufficient_scope';
    }
    if (!authorized) {
      if (url.pathname.startsWith('/ui')) {
        // UI routes use signature-based auth
        const valid = await verifySignature(url.pathname, url.searchParams, env.AUTH_TOKEN);
        if (!valid) {
          return new Response(JSON.stringify({ error: 'Invalid or missing signature' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } else {
        return new Response(JSON.stringify({ error: insufficientScope ? 'insufficient_scope' : 'Unauthorized' }), {
          status: insufficientScope ? 403 : 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': bearerChallenge(url, insufficientScope),
          },
        });
      }
    }

    const db = new DB(env.DB);

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
    };

    let response: Response;

    if (url.pathname.startsWith('/api/')) {
      response = checkClientGate(request) ?? checkSyncReadGate(request, url) ?? await handleApiRequest(request, url, db);
    } else if (url.pathname.startsWith('/mcp')) {
      response = await handleMcpRequest(request, db, env, url.pathname.replace(/\/+$/, '') === '/mcp/admin' ? 'admin' : 'default');
    } else if (url.pathname.startsWith('/ui')) {
      response = await handleUiRequest(request, url, db);
    } else {
      response = new Response(JSON.stringify({ name: 'alongside', version: '1.0.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }

    return response;
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
