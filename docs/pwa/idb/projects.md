# pwa/src/idb/projects.ts

Pure async I/O functions for the `projects` object store in IndexedDB.

## Functions

**`idbGetAllProjects()`** — Returns all project records from the `projects` store as a `Project[]`.

**`idbPutProject(project)`** — Upserts a `Project` record (insert or replace by `id`).

**`idbClearProjects()`** — Removes every record from the `projects` store (used before a full server sync overwrite).
