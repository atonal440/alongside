# pwa/src/idb/db.ts

IndexedDB initialization module. All other IDB modules call `getDB()` to obtain the database handle.

## Functions

**`getDB()`** — Opens (or creates) the `alongside` IndexedDB database. On first open, creates the object stores: `tasks`, `projects`, `links`, and `pendingOps` with their key paths and indexes. Returns a promise that resolves to the `IDBDatabase` instance. Subsequent calls return the cached instance without reopening.
