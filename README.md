# Alongside

A lightweight task manager built around conversational workflow. Tasks live in a Cloudflare Worker backed by D1, exposed through MCP tools for assistant clients and through a REST API for an offline-first PWA.

## Features

- **Offline-first PWA** — all reads and writes go to IndexedDB first; changes sync to the server when online
- **Task deferral** — hide tasks until a specific date or indefinitely (Someday)
- **Focus mode** — mark a task focused for a time window; expired focus surfaces in the Review view
- **Readiness scoring** — unblocked tasks are ranked by kickoff notes, session log, due date, and recency
- **Task dependencies** — `blocks` links gate downstream tasks from ready lists; `related` for softer relationships
- **Action log** — append-only audit trail of every create, update, complete, defer, and delete
- **Search / command palette** — `Cmd K` opens a global palette for search, inline actions, project navigation, and fast task creation
- **Review view** — end-of-day close-out screen (Current Focus / Done Today / Carry Forward / Next Suggestion)
- **Recurrence** — iCal RRULE on any task; completing it spawns the next occurrence automatically
- **Import / export** — full JSON snapshot backup and restore (with optional `dry_run`)
- **MCP integration** — 20 tools over JSON-RPC for Claude and other MCP clients
- **OAuth 2.1 / PKCE** — external MCP clients (e.g. Claude.ai) authenticate via a proper authorization code flow; no static token sharing required
- **User preferences** — per-user settings for sort order, urgency display, kickoff nudges, and session behavior

## Architecture

```text
Assistant client / MCP        PWA / browser
        |                         |
        | /mcp JSON-RPC           | /api/* REST
        v                         v
              Cloudflare Worker
        src/index.ts  routing/auth/CORS
        src/oauth.ts  OAuth 2.1 + PKCE
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

From the repo root:

```sh
npm run dev        # starts worker (:8787) and PWA (:5173); Ctrl-C stops both
npm run dev:status # optional: show tracked dev process status
npm run dev:stop   # optional: stop tracked detached dev processes
```

Run the worker and the PWA manually only when you need isolated logs or custom flags.

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
