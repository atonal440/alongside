# Alongside

A lightweight task manager built around conversational workflow with Claude. See `alongside-design.md` for the full design doc.

## Project structure

```
worker/          Cloudflare Worker (D1 + MCP + REST API + iframe widget)
  src/index.ts   Entry point, routing, CORS, auth
  src/db.ts      All D1 operations, recurrence logic
  src/api.ts     REST endpoints for PWA
  src/mcp.ts     MCP protocol handler (JSON-RPC)
  src/ui.ts      Serves the iframe widget at /ui/active
  schema.sql     D1 schema
pwa/             Standalone PWA (offline-first, IndexedDB)
  index.html     Single-file app — all views, sync, service worker reg
  sw.js          Service worker (cache shell, background sync)
  manifest.json  PWA manifest
```

## Running locally

```sh
cd worker
npm install
npm run db:init    # creates local D1 database from schema.sql
npm run dev        # starts wrangler dev on :8787
```

The PWA needs to be served separately (e.g. `npx serve pwa/`) or via Cloudflare Pages. Set `localStorage` keys `alongside_api` (worker URL) and `alongside_token` (bearer token) to connect it to the worker.

## Key decisions

- **nanoid v3** is used (not v4+) because v3 supports CommonJS which wrangler bundles more reliably.
- **Auth** is a single static bearer token in `wrangler.toml` vars (`AUTH_TOKEN`). The `/ui/*` routes skip auth so the iframe can be embedded.
- **Recurrence** uses a minimal RRULE parser in `db.ts` (DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL). No BYDAY support yet.
- **MCP endpoint** is at `/mcp` and expects JSON-RPC POST requests. The `get_active_tasks` tool returns a `ui` field with the iframe URL for MCP App rendering.
- **PWA sync** is local-first: writes go to IndexedDB immediately, then flush to the worker. Merge is last-write-wins on `updated_at`.

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start local worker (port 8787) |
| `npm run db:init` | Apply schema.sql to local D1 |
| `npm run deploy` | Deploy worker to Cloudflare |
| `npx tsc --noEmit` | Typecheck (from worker/) |

## Testing

No test framework yet. To smoke test locally:

```sh
# REST
curl -X POST http://localhost:8787/api/tasks \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test task"}'

# MCP
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer dev-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Widget
open http://localhost:8787/ui/active
```
