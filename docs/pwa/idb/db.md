# pwa/src/idb/db.ts

IndexedDB initialization module. All other IDB modules call `getDB()` to obtain the database handle.

## Functions

**`getDB()`** — Opens (or creates) the `alongside` IndexedDB database. On first open, creates the object stores: `tasks`, `projects`, `links`, `duties`, and `pendingOps` with their key paths and indexes. The v3 upgrade rewrites every stored task: `snoozed_until` is mapped onto `defer_until` and a new `defer_kind` field (`'until'` if a snooze date was set, otherwise `'none'`). It also rewrites queued pending-op bodies with the same legacy field so offline mutations survive the schema change and flush against the new worker shape. The v4 upgrade adds the `duties` store. Returns a promise that resolves to the `IDBDatabase` instance. Subsequent calls return the cached instance without reopening.
