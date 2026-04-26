# pwa/src/idb/pendingOps.ts

Pure async I/O functions for the `pendingOps` object store in IndexedDB. This store is the offline write queue — operations are added here when the app is offline and flushed to the server when connectivity returns.

## Functions

**`idbGetPendingOps()`** — Returns all queued `PendingOp` records, ordered by `created_at` so they replay in the order they were written.

**`idbQueueOp(method, path, body?)`** — Creates a new `PendingOp` with a generated `id` and the current timestamp, then upserts it into the store.

**`idbPutPendingOp(op)`** — Upserts an existing `PendingOp` record (used to increment `attempts` after a failed flush).

**`idbDeletePendingOp(id)`** — Removes a successfully flushed (or permanently failed) pending op from the queue.

**`idbClearPendingOps()`** — Clears the offline write queue. Used during logout so queued writes from one credential set cannot be replayed after another user or token connects.
