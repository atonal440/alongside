# Alongside

A lightweight task manager built around conversational workflow. Tasks live in a Cloudflare Worker backed by D1, exposed through MCP tools for assistant clients and through a REST API for an offline-first PWA.

## Architecture

```text
Assistant client / MCP        PWA / browser
        |                         |
        | /mcp JSON-RPC           | /api/* REST
        v                         v
              Cloudflare Worker
        src/index.ts  routing/auth/CORS
        src/mcp.ts    MCP tools
        src/api.ts    REST API
        src/db.ts     D1 operations
        src/ui.ts     iframe widget
        src/app-ui.ts MCP App widgets
                      |
                      v
                    D1 DB
```

## Quick Start

Run the worker and the PWA in separate terminals.

### Worker Backend

```sh
cd worker
npm install
npm run db:init
npm run dev
```

The worker runs at `http://127.0.0.1:8787` by default.

For local auth, `worker/.dev.vars` should provide:

```text
AUTH_TOKEN=dev-token-change-me
```

### PWA

```sh
cd pwa
npm install
npm run dev
```

Vite usually serves the app at `http://127.0.0.1:5173`.

The PWA does not proxy API requests. In the browser console for the PWA origin, set:

```js
localStorage.setItem('alongside_api', 'http://127.0.0.1:8787');
localStorage.setItem('alongside_token', 'dev-token-change-me');
```

Reload the PWA after setting those keys.

## Project Structure

```text
shared/
  schema.ts        Drizzle ORM table definitions
  types.ts         Shared row and input types

worker/
  src/index.ts     Entry point: routing, auth, CORS dispatch
  src/mcp.ts       MCP protocol handler and tools
  src/api.ts       REST endpoints for the PWA
  src/db.ts        D1 operations, recurrence, readiness scoring
  src/ui.ts        Iframe widget served at /ui/active
  src/app-ui.ts    MCP App widgets
  schema.sql       Reference/local D1 schema
  wrangler.toml    Cloudflare Worker config

pwa/
  src/App.tsx      App shell and view switcher
  src/context/     App reducer and async action creators
  src/idb/         IndexedDB modules
  src/api/         REST client and sync
  src/hooks/       App state, sync, history hooks
  src/components/  Layout, common UI, task cards, views
  src/utils/       Queueing, task-flow, design helpers, link maps
  src/sw.ts        Workbox service worker

docs/              Per-file and architecture docs
```

## Commands

| Where | Command | What it does |
|---|---|---|
| `worker/` | `npm run dev` | Start local worker on port 8787 |
| `worker/` | `npm run db:init` | Apply `schema.sql` to the local D1 database |
| `worker/` | `npm run db:generate` | Generate a Drizzle migration from schema diff |
| `worker/` | `npm run typecheck` | Type-check the worker |
| `worker/` | `wrangler deploy --dry-run` | Bundle-check worker without publishing |
| `worker/` | `npm run deploy` | Deploy worker to Cloudflare |
| `pwa/` | `npm run dev` | Start Vite dev server |
| `pwa/` | `npm run typecheck` | Type-check the PWA |
| `pwa/` | `npm run build` | Production PWA build |
| `pwa/` | `npm run preview` | Preview built PWA |

## Smoke Testing

With the worker running:

```sh
curl -X POST http://127.0.0.1:8787/api/tasks \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test task"}'

curl -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Widget route:

```text
http://127.0.0.1:8787/ui/active
```

## Agent Notes

- Claude Code reads `CLAUDE.md`.
- Codex reads `AGENTS.md`.
- Keep both files aligned when project conventions or local-dev commands change.

Per-file documentation lives in `docs/`. When adding, removing, or significantly changing exported TypeScript functions, hooks, components, classes, or module contracts, update the mirrored doc file under `docs/`.

## Further Reading

- `CLAUDE.md` and `AGENTS.md` for assistant-specific working instructions
- `docs/overview.md` for architecture and data flow
- `docs/mcp-tools.md` for MCP tool reference
- `docs/api.md` for REST API reference
- `alongside-design.md` for design philosophy and behavioral spec
