# pwa/src/idb/db.ts

IndexedDB initialization module. All other IDB modules call `getDB()` to obtain the database handle.

## Functions

**`getDB()`** — Opens (or creates) the `alongside` IndexedDB database. The stores are `pending_ops` (the command queue), `retained_ops` (v6: durably refused commands kept with diagnostics), and `canonical_meta` / `canonical_entities` (v5: the canonical server-state cache; see [canonical workspace](../sync/canonical-workspace.md)). v7 deletes the legacy `tasks`, `projects` and `links` mirror stores, which nothing reads any more; a fresh install never creates them. The open connection closes itself on `versionchange` so a newer tab can upgrade, and logs when its own upgrade is blocked. The v3 upgrade rewrites queued pending-op bodies (`snoozed_until` → `defer_until` plus `defer_kind`) so offline mutations survive the schema change and flush against the new worker shape; the v4 upgrade translates legacy `{method, path, body}` ops to the typed `PendingOp` union. Returns a promise that resolves to the `IDBDatabase` instance. Subsequent calls return the cached instance without reopening.
