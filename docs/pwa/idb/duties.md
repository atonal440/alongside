# pwa/src/idb/duties.ts

Pure async I/O functions for the `duties` object store in IndexedDB. The store mirrors the server-side `duties` table; the PWA reads it to render the "from duty" chip on materialized tasks. Duty editing is MCP-only in v1, so writes here come from server sync, not user actions.

## Functions

**`idbGetAllDuties()`** — Returns every `Duty` record from the `duties` store.

**`idbPutDuty(duty)`** — Upserts a `Duty` record keyed on `id`.

**`idbDeleteDuty(id)`** — Deletes a single duty by id.

**`idbClearDuties()`** — Removes every record from the `duties` store (used before a full server sync overwrite in [[sync|pwa/api/sync.ts]]).
