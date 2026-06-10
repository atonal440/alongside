# Stage 5 — Sync Engine: Durable vs Transient Failure Policy

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–4. This stage is the behavioral payoff of stages 3–4 and the direct fix for the two items recorded under "Future PWA Type System Notes" in `docs/plans/type-driven-safety-implementation-todo.md`.

## Goal

Rewrite `flushPendingOps` and `syncFromServer` (`pwa/src/api/sync.ts`) and the failure paths in `pwa/src/context/actions.ts` so that:

1. **Durable rejections (4xx) are never queued and never retried.** The op is dropped, the user sees the server's message, and a re-sync restores server truth (this is the rollback mechanism for optimistic writes — no per-op inverse operations).
2. **Transient failures (network, 5xx) keep the current queue-and-retry behavior**, but the flush stops at the first transient failure to preserve op ordering, and ops carry an `attempts` count with a surfacing cap.
3. **Temp-ID reconciliation keys on `local_id`, not title.** The title-matching heuristic in `syncFromServer` is removed.
4. **Dependent ops are cleaned up.** When a `task.create` is durably rejected, queued ops referencing its temp ID are dropped too (they reference an ID that will never exist), and the local temp task is deleted.

## Context for a cold start

- Stage 3 gave every server call a typed `ApiResult<T>` with `isDurableFailure` / `isTransientFailure` (`pwa/src/api/result.ts`). Stage 4 gave the queue a discriminated `PendingOp` union with `toRequest`, `rebindTaskId`, `attempts` (`pwa/src/api/pendingOps.ts`).
- Current behavior to replace: `actions.ts` queues on *any* non-ok result; `sync.ts` flush loop continues past failures and deletes an op only on success; `syncFromServer` deletes local tasks missing from the server unless an offline-create op with the same **title** exists (`sync.ts:69-80`).
- UI surfaces available: `SET_TOAST` action (`pwa/src/context/reducer.ts`), `SET_SYNC_STATUS` (`idle | syncing | online | offline`), toast rendering in `pwa/src/components/common/Toast.tsx`, sync orchestration in `pwa/src/hooks/useSync.ts` (30s interval + SW `sync-requested` messages).
- Worker rejection cases worth designing around (all live behavior today): self-links and `blocks` cycles → 400/409 on `/api/tasks/links`; completing an already-done task → 409 `invalid_transition`; malformed due dates/RRULEs → 400 validation with `details`.

## Design

### Failure policy (one function, used by actions and flush)

New `pwa/src/api/syncPolicy.ts` (or fold into `sync.ts` if cohesive):

```ts
export type WriteOutcome =
  | { kind: 'applied' }                       // server accepted
  | { kind: 'queued' }                        // transient — op persisted for retry
  | { kind: 'rejected'; message: string };    // durable — dropped, caller must surface + resync
```

`settleWrite(result: ApiResult<T>, op: PendingOpPayload, …): Promise<WriteOutcome>` — applied on ok; enqueue on transient/unconfigured (unconfigured behaves like offline, as today); rejected on durable, formatting the message from `ApiErrorBody` (`error` plus first `details` message when present).

### Action creators

Each action in `actions.ts` keeps its optimistic local write, then:

- `applied` → existing success path (e.g. replace temp task with server task in `createTaskAction`; show the recurring-next toast in `completeTaskAction`).
- `queued` → as today (no toast; SyncStatus already shows offline).
- `rejected` → dispatch `SET_TOAST` with the server message, then trigger a re-sync to roll local state back to server truth. Give actions access to a `resync` callback (thread it from `useSync` via context, or export a module-level `requestSync()` the hook registers with — pick the smaller diff and document it). For `createLinkAction` specifically this closes the known invalid-local-graph hole: the optimistic link is removed by the resync.

Edge: a durable rejection while *offline-created* state exists locally (temp task) — `createTaskAction`'s rejection path must delete the temp task and its dispatched state, not just resync (the server never saw it, so resync won't remove it… verify: resync deletes local tasks absent from the server unless protected; after this stage protection keys on pending `task.create` ops, and the op was dropped, so resync *does* remove it — confirm and rely on that rather than duplicating deletion logic; test it).

### Flush loop (`flushPendingOps`)

FIFO over queued ops:

- `ok` → delete op; if it was `task.create`, run reconciliation: replace temp task in IDB + state, `rebindTaskId` over all remaining queued ops.
- durable → delete op; if `task.create`, also delete queued ops referencing its `localId` (use `rebindTaskId`'s knowledge or a sibling `referencesTaskId(op, id)` helper) and delete the temp task from IDB; collect the rejection message.
- transient → increment `attempts`, persist, **stop the flush** (preserves ordering; we're offline or the server is hurting). If `attempts` exceeds a cap (suggest 25 — ~12 minutes of 30s cycles), keep retrying but surface a persistent "some changes aren't syncing" toast once per session so the user isn't silently stuck.

Return a summary `{ flushed: number; rejected: string[]; halted: boolean }` for `useSync` to act on (toast the rejections after the subsequent `syncFromServer` completes, so the resync has already restored truth when the user reads the message).

### `syncFromServer`

- Replace title-based protection: a local task survives server-absence iff a queued `task.create` op carries its id as `localId`.
- Parse-failures from the typed endpoints (`syncTasks` etc. returning non-ok) → `{ online: false }` as today, except durable contract violations should `console.error` loudly.
- Keep LWW semantics and the clear-and-rewrite of projects/links (unchanged scope).

### `useSync`

Wire the summary through: dispatch toasts for `rejected` messages; keep status transitions as today (`halted` → `offline`). Register the `requestSync` callback if that design was chosen.

## Tests (`pwa/test/api/sync.test.ts` + extend `pwa/test/context/`)

fetch stub + fake-indexeddb together; fixtures throughout.

- Flush: ok deletes op; 400 deletes op and reports rejection; network stops loop leaving later ops untouched with `attempts` bumped only on the failed one; 500 treated as transient; ordering preserved across a queue of mixed kinds.
- Create reconciliation: queued `task.create` + dependent `task.update` + `link.create` referencing the temp id — on create success, dependents are rebound (assert exact ids); on create 400, dependents and temp task are gone, rejection reported once.
- `syncFromServer`: local task with pending `task.create` survives; local task without one is deleted; two offline-created tasks with identical titles both survive (the regression the title heuristic would fail).
- Actions: `createLinkAction` with a server 409 → link removed from IDB/state after resync, toast dispatched, nothing queued; `completeTaskAction` offline still queues and shows the recurring message; double-complete with server 409 → no retry loop.
- Attempts cap: op at cap still retries but surfaces the stuck-sync notice exactly once.

## Docs

This stage changes user-facing workflow behavior: update `docs/pwa/api/sync` page(s) and `docs/pwa/overview.md` with the policy table (durable/transient × action/flush), the reconciliation contract, and the rollback-via-resync rationale. Per `CLAUDE.md`, prefer a narrative slice note explaining *why* rollback is resync rather than inverse ops. Check off the two "Future PWA Type System Notes" items in `docs/plans/type-driven-safety-implementation-todo.md` with a pointer here.

## Acceptance criteria

- All new tests green; full `npm run verify` green.
- Manual smoke (dev worker running): create a `blocks` cycle from the UI → toast with server message, link vanishes, queue empty. Kill worker, make edits, restart → edits flush in order. Edit a task offline, also edit it from MCP/REST, reconnect → LWW resolves as before.
- No call site outside `syncPolicy.ts`/`sync.ts` decides queue-vs-drop on its own.
- Todo file updated.
