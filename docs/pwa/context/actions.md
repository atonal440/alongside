# pwa/src/context/actions.ts

Async action creators — the bridge between UI events and IndexedDB + server writes. Each function performs the full write path: write to IndexedDB, dispatch to React state, attempt a server write, and handle the result via the unified failure policy.

## Failure Policy

After the optimistic local write (IDB + dispatch), every action creator applies the same three-way policy:

| Server result | Action taken |
|---|---|
| `ok` | Success path (ID reconciliation, recurring-task toast, etc.) |
| `contract` | Silently ignored — server applied the write despite schema mismatch |
| `http` 5xx / `network` / `unconfigured` | Queue op in IDB for later retry |
| `http` 4xx | Dispatch `SET_TOAST` with the server message; call `requestSync()` |

No action creator decides "durable vs transient" independently — `isTransientFailure` and `messageFromResult` from the policy modules are the only entry points.

## Rollback via Resync

There are no per-op inverse operations. When a durable rejection arrives, the action creator dispatches a toast and calls `requestSync()`, which triggers `useSync`'s `doSync` function. The subsequent `syncFromServer` overwrites local state with server truth. For example: an optimistic link rejected with 409 is removed when `listLinks` restores the server graph; an optimistic task-create rejected with 400 is removed because `syncFromServer` deletes local tasks absent from the server when no `task.create` op remains to protect them.

## Sync Callback Registration

```ts
registerSyncCallback(fn: () => void): void
```

Called by `useSync` after defining `doSync`. This allows action creators to trigger a resync without importing from a React hook. The callback is replaced each time `useSync`'s effect re-runs (when `apiBase` or `authToken` change). Before the first `useSync` mount, `requestSync` is a no-op.

## Task mutations

**`createTaskAction(title, config, dispatch)`** — Creates a new task: generates a temp nanoid, writes to IndexedDB, dispatches `UPSERT_TASK`, and attempts `POST /api/tasks`. On success, remaps temp ID to the server's ID. On 4xx: toast + resync (resync will delete the temp task since no `task.create` op remains to protect it). On transient: queues `task.create` op with `localId` so `syncFromServer` keeps the temp task alive.

**`updateTaskAction(id, updates, config, dispatch)`** — Updates task fields locally and attempts `PATCH /api/tasks/:id`. 4xx → toast + resync; transient → pending op.

**`deleteTaskAction(id, config, dispatch)`** — Deletes from IndexedDB, dispatches `DELETE_TASK`, and attempts `DELETE /api/tasks/:id`. 4xx → toast + resync.

**`completeTaskAction(id, config, dispatch)`** — Marks task done locally, attempts `POST /api/tasks/:id/complete`. If recurring and ok, surfaces the next occurrence. 409 `invalid_transition` (double-complete) → toast + resync; transient → queued op.

## Focus and Deferral

**`focusTaskAction(id, config, dispatch, hours?)`** — Sets `focused_until` locally and attempts `PATCH /api/tasks/:id`.

**`deferTaskAction(id, kind, untilIso, config, dispatch)`** — Sets `defer_kind` to `'until'` or `'someday'`, clears `focused_until`. Local-first; pending op on transient failure.

**`clearDeferAction(id, config, dispatch)`** — Resets `defer_kind` to `'none'` and `defer_until` to `null`.

## Links

**`createLinkAction(fromId, toId, linkType, config, dispatch)`** — Creates a task link locally and attempts `POST /api/tasks/links`. 409 self-link or `blocks` cycle → toast + resync; the resync's `listLinks` call removes the invalid optimistic link.

**`deleteLinkAction(fromId, toId, linkType, config, dispatch)`** — Removes a task link locally and attempts `DELETE /api/tasks/links`.

## See Also

- [[sync|pwa/src/api/sync.ts]] — `flushPendingOps` / `syncFromServer` called by `useSync` after each action's resync trigger
- [[syncPolicy|pwa/src/api/syncPolicy.ts]] — `messageFromResult`, `ATTEMPTS_CAP`, `referencesTaskId`
- [[result|pwa/src/api/result.ts]] — `isTransientFailure`, `isDurableFailure`
- [[idb-tasks|pwa/src/idb/tasks.ts]] — underlying IDB writes for task mutations
- [[idb-links|pwa/src/idb/links.ts]] — underlying IDB writes for link mutations
- [[reducer]] — action types dispatched (`UPSERT_TASK`, `DELETE_TASK`, `SET_TOAST`, etc.)
