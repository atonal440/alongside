# Stage 4 — Typed Pending-Op Queue

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–3.

## Goal

Replace the stringly-typed offline queue (`PendingOp = { method: string; path: string; body: unknown; local_id; created_at }`) with a discriminated union of typed operations, a single serializer to wire requests, and a total temp-ID rebind function. Migrate persisted queue entries (IndexedDB v3 → v4) so unsynced offline work survives the upgrade — users may have queued ops from the deployed app.

## Context for a cold start

- `PendingOp` is declared in `shared/types.ts:3-10` but used only by the PWA (`pwa/src/idb/pendingOps.ts`, `pwa/src/api/sync.ts`, re-exported by `pwa/src/types.ts`). The worker never touches it.
- Ops are enqueued in `pwa/src/context/actions.ts` via `idbQueueOp(method, path, body, localId?)` whenever a server write fails — paths like `/api/tasks/${id}`, bodies are ad-hoc objects.
- `pwa/src/api/sync.ts:35-56` reconciles offline-created tasks: after a queued `POST /api/tasks` succeeds, it rewrites *other* queued ops by `path.replace(oldId, newId)` and by patching `from_task_id`/`to_task_id`/`task_id` keys in bodies.
- IndexedDB plumbing: `pwa/src/idb/db.ts` (currently `IDB_VERSION = 3`; v3 migrated a legacy defer shape, including inside pending-op bodies — use it as the migration template), `pwa/src/idb/pendingOps.ts` (CRUD on the `pending_ops` store, autoincrement key).
- Stage 3 created `pwa/src/api/endpoints.ts` with request body types (`TaskCreateBody`, `TaskUpdateBody`, `LinkBody`) and typed endpoint functions.

## Design

### The union (new `pwa/src/api/pendingOps.ts` — types + serializer; IDB I/O stays in `pwa/src/idb/pendingOps.ts`)

```ts
export type PendingOp = { id?: number; created_at: string; attempts: number } & PendingOpPayload;

export type PendingOpPayload =
  | { op: 'task.create';   localId: string; body: TaskCreateBody }
  | { op: 'task.update';   taskId: string;  body: TaskUpdateBody }
  | { op: 'task.complete'; taskId: string }
  | { op: 'task.delete';   taskId: string }
  | { op: 'link.create';   body: LinkBody }
  | { op: 'link.delete';   body: LinkBody };
```

- `attempts` starts at 0; stage 5 increments it on transient flush failures and surfaces ops stuck past a cap. Include it now so the store schema is final.
- `toRequest(op, config): Promise<ApiResult<…>>` — the single mapping from op kind to endpoint function. Method/path strings exist nowhere else in queue handling.
- `rebindTaskId(op, oldId, newId): PendingOp | null` — total over the union: rewrites `taskId`, `body.project_id`?, `body.from_task_id`/`to_task_id` as applicable per kind; returns the op unchanged when the id doesn't appear. (Keep it pure; tests enumerate every variant. This replaces the substring surgery — note `path.replace` could corrupt an id that happens to contain another id as a substring.)
- `parsePendingOp(input: unknown): Result<PendingOp, ValidationError[]>` — valibot `v.variant('op', …)` schema; used by the IDB read path and the migration.

### IDB migration (v4 in `pwa/src/idb/db.ts`)

Bump `IDB_VERSION` to 4. In `onupgradeneeded` for `oldVersion < 4`, cursor over `pending_ops` and translate each legacy record `{ method, path, body, local_id }` into the union:

| Legacy shape | New op |
| --- | --- |
| `POST /api/tasks` (+ `local_id`) | `task.create` with `localId`, body as `TaskCreateBody` |
| `PATCH /api/tasks/:id` | `task.update` (extract id from path) |
| `POST /api/tasks/:id/complete` | `task.complete` |
| `DELETE /api/tasks/:id` | `task.delete` |
| `POST /api/tasks/links` | `link.create` |
| `DELETE /api/tasks/links` | `link.delete` |

Set `attempts: 0`, keep `created_at`. A legacy record matching no pattern (or whose translated form fails `parsePendingOp`) is **deleted with a `console.warn`** — a queue entry we cannot interpret would otherwise wedge the flush loop forever; losing one unrecognizable op beats a permanently stuck queue. Follow the cursor-update pattern of the existing v3 block.

### Enqueue sites

Replace every `idbQueueOp(method, path, body, localId)` call in `actions.ts` with typed enqueues (`idbQueueOp({ op: 'task.update', taskId: id, body: updates })`). `idbQueueOp` now takes a `PendingOpPayload`, stamps `created_at`/`attempts`, and writes. `idbGetPendingOps` runs reads through `parsePendingOp`, skipping (and `console.warn`-ing) records that fail — defense against future drift.

### `sync.ts` minimal adaptation

This stage does **not** redesign flush policy (stage 5). Adapt `flushPendingOps` and the temp-ID reconciliation mechanically: dispatch on `op.op` via `toRequest`, use `rebindTaskId` instead of string replacement, and identify offline-created ops by `op.op === 'task.create'` instead of method/path matching. The title-based survivor check in `syncFromServer` can now key on `task.create` ops' `localId`s but keep its current title-based semantics if changing them would expand the diff — flag whichever you choose in the todo file (stage 5 fixes it properly).

### Shared types cleanup

Remove the `PendingOp` interface from `shared/types.ts` and the re-export from `pwa/src/types.ts`; the type now lives with its only consumer. (Leave the other shared aliases alone — stage 6/9 handle them.)

## Tests

- `pwa/test/api/pendingOps.test.ts` — `toRequest` produces the right endpoint call per variant (fetch stub asserts method/path/body); `rebindTaskId` table over all six variants × {id present in each slot, id absent, oldId-as-substring-of-another-id is *not* rewritten}; `parsePendingOp` accepts each variant and rejects unknown `op`, missing fields, wrong field types.
- `pwa/test/idb/pendingOps.test.ts` (fake-indexeddb via `test/helpers/idb.ts`) — enqueue/read/delete round-trip; reads skip a hand-planted malformed record with a warning.
- `pwa/test/idb/migration.test.ts` — open the DB at version 3 (fake-indexeddb supports explicit versioning), seed legacy-shaped ops covering every row of the table above plus one unrecognizable op, close, reopen at version 4: translated ops parse, the junk op is gone. Also re-run the v3 defer-shape case to prove migrations compose (a v2-era record upgraded straight to v4).

## Docs

Update `docs/pwa/idb/` (pendingOps + db migration history table) and `docs/pwa/api/` (the op union and the one-serializer rule). The migration table above belongs in the docs, not just this plan.

## Acceptance criteria

- No `method`/`path` string literals related to queueing outside `pwa/src/api/endpoints.ts` + the migration translator: `grep -rn "idbQueueOp\|/api/" pwa/src/context pwa/src/api/sync.ts` shows only typed enqueues and endpoint-module references.
- `shared/types.ts` no longer exports `PendingOp`; worker typecheck/test/build:dry green (it never imported it — verify).
- All pwa suites green, `npm run verify` green.
- Manual check: with the dev worker stopped, queue a few ops in a browser profile running the *previous* build, then load the new build — ops migrate and flush once the worker is back. Note the result in the PR.
- Todo file updated.
