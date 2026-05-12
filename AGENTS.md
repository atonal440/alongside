# Alongside Agent Notes

This file is the Codex-readable companion to `CLAUDE.md`. Keep both files aligned when project conventions change.

## What This Is

Alongside is a lightweight task manager built around conversational workflow. It has two main surfaces:

- A Cloudflare Worker backend with D1 storage, REST endpoints, MCP tools, OAuth routes, and widget UI routes.
- A React + Vite + TypeScript PWA that is offline-first and syncs through the worker REST API.

`shared/schema.ts` is the source of truth for database schema and shared row types.

## Project Layout

```text
shared/
  schema.ts        Drizzle ORM table definitions
  types.ts         Shared Task, Project, TaskLink, ActionLog, pending op, and input types

worker/
  src/index.ts     Worker entrypoint, routing, CORS, auth dispatch
  src/db.ts        D1 operations, recurrence, readiness scoring, export/import
  src/api.ts       REST endpoints for the PWA
  src/mcp.ts       MCP JSON-RPC handler and tool definitions
  src/ui.ts        Iframe/widget UI route handlers
  src/app-ui.ts    MCP App widget UI
  schema.sql       Reference/local D1 schema
  wrangler.toml    Worker configuration

pwa/
  src/App.tsx      Top-level app shell and view switching
  src/context/     Reducer and async action creators
  src/idb/         IndexedDB modules
  src/api/         REST client and sync
  src/hooks/       App state, sync, history hooks
  src/components/  Layout, common UI, task cards, views
  src/utils/       Queueing, task flow, design helpers, link maps
  src/sw.ts        Workbox service worker
```

## Local Dev

Use Node.js 22 or newer for local installs and Cloudflare tooling.

From the repo root, use the combined dev runner for day-to-day work:

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

Run the backend and PWA separately only when you need isolated logs or flags.

### Manual Worker Backend

```sh
cd worker
npm install
npm run db:init
npm run dev
```

The worker starts on `http://127.0.0.1:8787` or `http://localhost:8787`.

Local auth comes from `worker/.dev.vars`. The expected development token is usually:

```text
dev-token-change-me
```

Fresh worker checkouts should copy `worker/.dev.vars.example` to `worker/.dev.vars` so `AUTH_TOKEN=dev-token-change-me` is available locally and the PWA/API calls do not 401.

### Manual PWA

```sh
cd pwa
npm install
npm run dev
```

Vite usually starts on `http://127.0.0.1:5173`.

The PWA does not proxy to the worker. In the browser console for the PWA origin, configure:

```js
localStorage.setItem('alongside_api', 'http://127.0.0.1:8787');
localStorage.setItem('alongside_token', 'dev-token-change-me');
```

Then reload the PWA.

## Verification Commands

Use the narrowest verification command that matches the change.

```sh
# Worker
cd worker
npm run typecheck
wrangler deploy --dry-run

# PWA
cd pwa
npm run typecheck
npm run build
```

Run `wrangler deploy --dry-run` before merging worker changes that touch `wrangler.toml`, `shared/schema.ts`, migrations, or dependencies. It catches bundling/resolution failures typecheck can miss.

## Smoke Tests

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

## Implementation Conventions

- Use the existing React + reducer pattern in `pwa/src/context/`.
- Keep IndexedDB access in `pwa/src/idb/` as pure async modules, not hooks.
- Keep shared data types in `shared/types.ts` and schema in `shared/schema.ts`.
- Preserve the PWA local-first behavior: write locally first, then flush pending operations to the worker.
- Prefer existing task-flow helpers in `pwa/src/utils/taskFlow.ts` for task-card action logic.
- Prefer existing design helpers in `pwa/src/utils/design.ts` for labels, colors, and sorting.
- Do not introduce a new state library unless the existing reducer/context model is intentionally being replaced.

## Documentation Rule

Per-file documentation lives in `docs/` and mirrors TypeScript source paths.

When adding, removing, or significantly changing an exported function, hook, component, class, or module contract in any `.ts` or `.tsx` file, update the corresponding doc file in `docs/`.

Examples:

- `worker/src/foo.ts` -> `docs/worker/foo.md`
- `pwa/src/bar/baz.tsx` -> `docs/pwa/bar/baz.md`

Keep `docs/overview.md` current if the architecture or directory structure changes.
