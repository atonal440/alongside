# pwa/src/idb/links.ts

Pure async I/O functions for the `links` object store in IndexedDB.

## Functions

**`idbGetAllLinks()`** — Returns all `TaskLink` records from the `links` store.

**`idbPutLink(link)`** — Upserts a `TaskLink` record keyed on `{from_task_id, to_task_id}`.

**`idbDeleteLink(fromId, toId)`** — Deletes the link between two specific tasks.

**`idbClearLinks()`** — Removes every record from the `links` store (used before a full server sync overwrite).
