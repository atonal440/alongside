# pwa/src/context/actions.ts

Async action creators — the bridge between UI events and the pending-op queue. Every user write has one shape:

1. Read the current view (`loadView`: stored canonical workspace + queue replayed) and, for edits, run the pure local mutation (`applyUpdate`, `applyComplete`, …) so invalid changes are refused with a toast and nothing is queued.
2. Queue the command (`idbQueueOp`) — never call the server directly.
3. Dispatch `SET_DATA` with the freshly replayed view, so the screen shows the change at once.
4. Call `requestSync()`; the single-flight flush sends the op in queue order, owns retries, and retains refusals for review.

Because of that, an action creator makes no network call and has no failure policy of its own: transient failures keep the op queued, durable refusals are retained (see [canonical workspace](../sync/canonical-workspace.md)), and a rejected write disappears from the view on the next refresh because nothing replays it.

## Sync Callback Registration

```ts
registerSyncCallback(fn: () => void): void
```

Called by `useSync` after defining `doSync`. This allows action creators to trigger a resync without importing from a React hook. The callback is replaced each time `useSync`'s effect re-runs (when `apiBase` or `authToken` change). Before the first `useSync` mount, `requestSync` is a no-op.

## Task mutations

**`createTaskAction(title, config, dispatch)`** — Queues `task.create` with a fresh temp `localId` (the flush maps it to the server's ID and rebinds later queued ops).

**`updateTaskAction(id, updates, config, dispatch)`** — Runs `applyUpdate`, then queues `task.update` with the patch.

**`deleteTaskAction(id, config, dispatch)`** — Queues `task.delete`; the view drops the task and its links.

**`completeTaskAction(id, config, dispatch)`** — Runs `applyComplete`, queues `task.complete`. For a recurring task it returns a message that the next occurrence will appear after syncing (the server creates it).

## Focus and Deferral

**`focusTaskAction`**, **`unfocusTaskAction`**, **`deferTaskAction`**, **`clearDeferAction`**, **`reopenTaskAction`** — Each runs its pure mutation (`applyFocus`, `applyUnfocus`, `applyDefer`, `applyClearDefer`, `applyReopen`) and queues the resulting patch as `task.update`. Deferring clears `focused_until`.

## Links

**`createLinkAction(fromId, toId, linkType, config, dispatch)`** / **`deleteLinkAction(...)`** — Queue `link.create` / `link.delete`. A self-link or `blocks` cycle the server refuses is retained for review and disappears from the view on the next refresh.

## See Also

- [[sync|pwa/src/api/sync.ts]] — `flushPendingOps`, called by `useSync` after each action's `requestSync()`
- `pwa/src/sync/view.ts` — `loadView`, the canonical-plus-queue view each action dispatches
- [[idb-pendingOps|pwa/src/idb/pendingOps.ts]] — the queue the actions write to
- [[reducer]] — `SET_DATA` and `SET_TOAST`, the actions dispatched
