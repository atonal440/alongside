import { DB } from './db';
import { handleApiRequest } from './api';
import { handleMcpRequest } from './mcp';
import { handleUiRequest } from './ui';

export interface Env {
  DB: D1Database;
  AUTH_TOKEN: string;
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
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Auth check (skip for OPTIONS)
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (token !== env.AUTH_TOKEN) {
      // Allow unauthenticated access to UI for iframe embedding
      if (!url.pathname.startsWith('/ui')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
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
