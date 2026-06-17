# pwa/src/api/sync.ts + pwa/src/api/syncPolicy.ts

Two-phase sync between IndexedDB and the Cloudflare Worker. Called by `useSync` on a 30-second interval and on service worker background sync messages.

## Failure Policy

Every write attempt lands in one of five outcome categories. The policy applied to each is uniform — no call site makes a queue-vs-drop decision independently:

| `ApiResult` kind | Cause | Policy |
|---|---|---|
| `ok` | Server accepted the write | Delete op, run reconciliation if `task.create` |
| `contract` | 2xx but body failed schema | Drop op (server applied it; retry would duplicate); rebind IDs best-effort |
| `http` 4xx | Server rejected the write permanently | Drop op, collect rejection message for toast |
| `http` 5xx | Server error | Increment `attempts`, stop flush (transient) |
| `network` / `unconfigured` | Can't reach server | Increment `attempts`, stop flush (transient) |

**Durable vs transient:** 4xx and `contract` are durable (retrying cannot succeed). 5xx, network, and unconfigured are transient (may succeed on retry). `unconfigured` (no API base/token set) behaves like offline — op is queued, not rejected.

## Types

**`FlushSummary`** — `{ flushed: number; rejected: string[]; halted: boolean }`. `flushed` counts ops processed (ok + contract + 4xx). `rejected` collects human-readable messages from durable 4xx rejections for `useSync` to toast after the subsequent `syncFromServer`. `halted` is true when the flush stopped at a transient failure.

**`SyncResult`** — `{ online: boolean; tasks?: Task[]; projects?: Project[]; links?: TaskLink[] }`. Returned by `syncFromServer`.

**`WriteOutcome`** (`syncPolicy.ts`) — `'applied' | 'queued' | { kind: 'rejected'; message: string }`. Internal classification used by flush and action creators.

## Functions

**`flushPendingOps(config)`** → `FlushSummary`

Reads all `PendingOp`s from IndexedDB in FIFO order and replays them:

- On success (`ok`): delete the op. For `task.create`, parse the server row, replace the temp task in IDB, and rebind all subsequent ops in the current cycle's array (so dependent ops are sent with the real server ID in the same flush, not the next one) and in IDB (for ops not yet reached in this cycle).
- On durable failure (4xx): delete the op and add the error message to `rejected`. For `task.create`, additionally delete all queued ops that reference its `localId` (they target an ID that will never exist) and delete the temp task from IDB.
- On transient failure: increment `attempts`, persist, and `break`. The flush stops here to preserve op ordering. If `attempts ≥ 25` (the cap), fires a "changes aren't syncing" notice once per app session.

**`syncFromServer(config)`** → `SyncResult`

Fetches tasks, projects, and links from the server and writes them into IDB. LWW merge: server data overwrites local. A local task survives server-absence iff a pending `task.create` op carries its `id` as `localId` — this is the rollback mechanism for offline-created tasks after a durable create rejection. Two tasks with identical titles both survive correctly (the previous title-based heuristic is gone).

**`_resetStuckNotice()`** — Test helper that resets the per-session stuck-sync flag.

## Rollback for Optimistic Writes

The PWA has no per-op inverse operations. Rollback is always resync: when an action creator gets a durable rejection, it dispatches a toast and calls `requestSync()` (registered by `useSync`). The subsequent `syncFromServer` overwrites local state with server truth. For optimistic links rejected by the server (e.g. self-links, `blocks` cycles), `listLinks` from the server restores the correct graph.

## syncPolicy.ts helpers

- **`messageFromResult(result)`** — extracts a human-readable string from a durable `ApiResult`: `error: first-details-message` for 4xx with details, just `error` for plain 4xx, generic "version mismatch" for `contract`.
- **`referencesTaskId(op, taskId)`** — total function over the `PendingOp` union; returns true if the op targets `taskId` in any payload slot.
- **`ATTEMPTS_CAP`** — `25` (approximately 12 minutes at 30-second intervals before the stuck notice fires).

## See Also

- [[useSync|pwa/src/hooks/useSync.ts]] — registers the resync callback, wires `FlushSummary` toasts
- [[pendingOps|pwa/src/idb/pendingOps.ts]] — IDB store `flushPendingOps` drains
- [[actions|pwa/src/context/actions.ts]] — action creators that call `registerSyncCallback` target
- [[client|pwa/src/api/client.ts]] — `apiRequest` backing `toRequest`
- [[result|pwa/src/api/result.ts]] — `isDurableFailure` / `isTransientFailure` classifiers
