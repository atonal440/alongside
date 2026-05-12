# Alongside

A lightweight task manager built around conversational workflow with assistant clients. See `alongside-design.md` for the full design doc.

Codex-specific agent instructions live in `AGENTS.md`. Keep `CLAUDE.md` and `AGENTS.md` aligned when project conventions or local-dev commands change.

## Project structure

```
shared/
  schema.ts        Drizzle ORM table definitions (single source of truth for DB schema + types)
  types.ts         Re-exports Task, Project, TaskLink, ActionLog from schema; adds PendingOp + input types
worker/            Cloudflare Worker (D1 + MCP + REST API + iframe widget)
  src/index.ts     Entry point, routing, CORS, auth
  src/db.ts        All D1 operations via Drizzle; exportAll/importAll for archive/restore
  src/api.ts       REST endpoints for PWA (incl. /api/export and /api/import)
  src/mcp.ts       MCP protocol handler (JSON-RPC)
  src/ui.ts        Serves the iframe widget at /ui/active
  schema.sql       D1 schema (reference; Drizzle schema.ts is authoritative going forward)
  drizzle.config.ts  Drizzle-kit config for generating migrations
pwa/               React + Vite + TypeScript PWA (offline-first, IndexedDB)
  src/
    App.tsx        Top-level shell: header, nav, view switcher, SW registration
    context/       AppContext (useReducer), reducer, async action creators
    idb/           IndexedDB modules (tasks, projects, links, pendingOps)
    api/           apiFetch client, sync (flushPendingOps, syncFromServer)
    hooks/         useAppState, useSync, useHistory
    components/    layout/, common/, task/, views/
    utils/         suggestQueue, linkMaps, genId
    sw.ts          Workbox service worker (injectManifest)
  vite.config.ts   Vite config with vite-plugin-pwa and @shared alias
```

## Running locally

For day-to-day local development, use the repo-level runner:

```sh
npm run dev
```

This starts the worker at `http://127.0.0.1:8787` and the PWA at `http://127.0.0.1:5173`, prefixes both logs in one terminal, and shuts both processes down with `Ctrl-C`.

If a dev process gets detached, use:

```sh
npm run dev:status
npm run dev:stop
```

The runner keeps only transient process state in `.dev/`.

Use Node.js 22 or newer for local installs and Cloudflare tooling.

Run services manually only when you need isolated logs or flags:

```sh
# Worker
cd worker
npm install
npm run db:init    # creates local D1 database from schema.sql
npm run dev        # starts wrangler dev on :8787

# PWA
cd pwa
npm install
npm run dev        # Vite dev server (hot reload)
```

The PWA dev server proxies nothing — set `localStorage` keys `alongside_api` (worker URL) and `alongside_token` (bearer token) in the browser console to connect it to the worker.

Fresh worker checkouts need `worker/.dev.vars`; copy `worker/.dev.vars.example` so `AUTH_TOKEN=dev-token-change-me` is available locally and the PWA/API calls do not 401.

## Key decisions

- **nanoid v3** is used in the worker (not v4+) because v3 supports CommonJS which wrangler bundles more reliably.
- **Auth** is a single static bearer token in `wrangler.toml` vars (`AUTH_TOKEN`). The `/ui/*` routes skip auth so the iframe can be embedded.
- **Recurrence** uses a minimal RRULE parser in `db.ts` (DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL). No BYDAY support yet.
- **MCP endpoint** is at `/mcp` and expects JSON-RPC POST requests.
- **PWA sync** is local-first: writes go to IndexedDB immediately, then flush to the worker. Merge is last-write-wins on `updated_at`.
- **State management** is `useReducer` + React context. No external state library. Async ops are plain async functions in `context/actions.ts` that take `dispatch` as a parameter.
- **IDB is a module layer, not hooks** — pure async I/O functions, no React dependency. Called from action creators and the sync hook.
- **Service worker** uses Workbox via `vite-plugin-pwa` with `injectManifest` strategy so we keep full control of the SW logic (background sync message pattern).
- **Shared types** live in `shared/types.ts` and are imported in both worker and pwa via `@shared/*` path alias.

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start local worker (port 8787) |
| `npm run db:init` | Apply schema.sql to local D1 |
| `npm run db:generate` | Generate Drizzle migration from schema diff (from worker/) |
| `npm run deploy` | Deploy worker to Cloudflare |
| `npx tsc --noEmit` | Typecheck worker (from worker/) |
| `npm run dev` | Start PWA dev server (from pwa/) |
| `npm run build` | Production build (from pwa/) |
| `npm run typecheck` | Typecheck PWA (from pwa/) |

## Testing

Run `wrangler deploy --dry-run` from `worker/` before merging PRs that touch `wrangler.toml`, `shared/schema.ts`, or any new dependencies. It runs the full bundling step without publishing, catching resolver issues that typechecks miss.

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

## Cloudflare Pages deployment

Build command: `npm run build` (run from `pwa/`)
Output directory: `pwa/dist`

## Documentation

Per-file documentation lives in `docs/`. The structure mirrors the source tree:

```
docs/
  overview.md          High-level architecture and data flow
  shared/              → shared/
  worker/              → worker/src/
  pwa/                 → pwa/src/ (context/, idb/, api/, hooks/, utils/, components/)
```

Every TypeScript source file has a corresponding `.md` in `docs/`. Each doc contains a short paragraph on what the file is for and a one-sentence description of every exported function, class, hook, or component.

**Agents: when you add, remove, or significantly change a function in any `.ts` or `.tsx` file, update the corresponding doc in `docs/` to match.** If you add a new source file, create its doc file at the mirrored path. The doc for `worker/src/foo.ts` lives at `docs/worker/foo.md`; for `pwa/src/bar/baz.tsx` it lives at `docs/pwa/bar/baz.md`. Keep `docs/overview.md` up to date if the directory structure changes.
