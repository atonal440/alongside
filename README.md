# Alongside

A lightweight task manager built around conversational workflow with Claude. Tasks live in a Cloudflare Worker (D1 database), exposed via MCP tools for Claude and a REST API for an offline-first PWA.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Claude (MCP client)          PWA (browser)         │
│   - start_session              - IndexedDB           │
│   - add_task, complete_task    - background sync     │
│   - show_tasks widget          - offline-first       │
└────────────┬───────────────────────┬────────────────┘
             │ /mcp (JSON-RPC)       │ /api/* (REST)
             ▼                       ▼
┌─────────────────────────────────────────────────────┐
│              Cloudflare Worker                      │
│   src/index.ts  — routing, auth, CORS               │
│   src/mcp.ts    — 17 MCP tools                      │
│   src/api.ts    — REST endpoints                    │
│   src/db.ts     — D1 operations                     │
│   src/ui.ts     — iframe widget                     │
│   src/app-ui.ts — MCP App widgets                   │
└────────────────────────┬────────────────────────────┘
                         │
                    ┌────▼────┐
                    │  D1 DB  │
                    │ (SQLite)│
                    └─────────┘
```

## Quick Start

```sh
cd worker
npm install
npm run db:init    # creates local D1 database from schema.sql
npm run dev        # starts wrangler dev on :8787
```

To use the PWA, serve the `pwa/` directory separately (e.g. `npx serve pwa/`) and set these keys in `localStorage`:

```js
localStorage.setItem('alongside_api', 'http://localhost:8787')
localStorage.setItem('alongside_token', 'dev-token-change-me')
```

To connect Claude Desktop or another MCP client, point it at `http://localhost:8787/mcp` with a bearer token header.

## Project Structure

```
worker/
  src/
    index.ts     Entry point: routing, CORS, auth dispatch
    mcp.ts       MCP protocol handler — all 17 tool definitions
    api.ts       REST endpoints for the PWA
    db.ts        All D1 operations, recurrence logic, readiness scoring
    ui.ts        Iframe widget served at /ui/active (signature auth)
    app-ui.ts    MCP App widgets: task dashboard + action log badge
  schema.sql     D1 schema (tasks, projects, task_links, preferences, action_log)
  wrangler.toml  Worker config and env vars

pwa/
  index.html     Single-file app — all views, sync logic, service worker reg
  sw.js          Service worker (cache shell, background sync queue)
  manifest.json  PWA manifest

alongside-design.md   Philosophy, design decisions, and behavioral spec
docs/
  mcp-tools.md  Full reference for all 17 MCP tools
  api.md        REST API reference
```

## Auth

| Route prefix | Auth method |
|---|---|
| `/api/*`, `/mcp` | `Authorization: Bearer {AUTH_TOKEN}` header |
| `/ui/*` | URL signature params (`?t=<timestamp>&sig=<hmac>`) |
| OAuth routes | Public (OAuth 2.1 w/ PKCE flow) |

`AUTH_TOKEN` is set in `wrangler.toml` under `[vars]`. Change it before deploying.

## Configuration

All config lives in `worker/wrangler.toml`:

| Key | Description |
|---|---|
| `AUTH_TOKEN` | Bearer token for API and MCP access |
| `DB` | D1 database binding |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start local worker on port 8787 |
| `npm run db:init` | Apply schema.sql to local D1 |
| `npm run deploy` | Deploy worker to Cloudflare |
| `npx tsc --noEmit` | Type-check (run from `worker/`) |

## Smoke Testing

```sh
# REST — create a task
curl -X POST http://localhost:8787/api/tasks \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test task"}'

# MCP — list available tools
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Widget
open http://localhost:8787/ui/active
```

## Further Reading

- [`docs/mcp-tools.md`](docs/mcp-tools.md) — full reference for all 17 MCP tools
- [`docs/api.md`](docs/api.md) — REST API and UI route reference
- [`alongside-design.md`](alongside-design.md) — design philosophy and behavioral spec
