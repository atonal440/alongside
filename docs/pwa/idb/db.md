# pwa/src/idb/db.ts

IndexedDB initialization module. All other IDB modules call `getDB()` to obtain the database handle.

## Functions

**`getDB()`** — Opens (or creates) the `alongside` IndexedDB database. On first open, creates the object stores: `tasks`, `projects`, `links`, and `pendingOps` with their key paths and indexes. The v3 upgrade rewrites every stored task: `snoozed_until` is mapped onto `defer_until` and a new `defer_kind` field (`'until'` if a snooze date was set, otherwise `'none'`); `pending_ops` is cleared so stale offline writes do not flush against the new field shape. Returns a promise that resolves to the `IDBDatabase` instance. Subsequent calls return the cached instance without reopening.
