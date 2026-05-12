import { DB } from './db';
import { handleApiRequest } from './api';
import { handleMcpRequest } from './mcp';
import { handleUiRequest } from './ui';
import { verifySignature } from './sign';
import { handleOAuthRequest } from './oauth';
import { getHarnessHtml } from './dev-harness';
import { getAppHtml } from './app-ui';
import { materializeDueDuties } from './duties';

export interface Env {
  DB: D1Database;
  AUTH_TOKEN: string;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const db = new DB(env.DB);
    const nowIso = new Date(controller.scheduledTime).toISOString();
    await materializeDueDuties(db, nowIso);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for PWA
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    if (token !== env.AUTH_TOKEN) {
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
        const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
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
      response = await handleApiRequest(request, url, db);
    } else if (url.pathname.startsWith('/mcp')) {
      response = await handleMcpRequest(request, db, env);
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
};
