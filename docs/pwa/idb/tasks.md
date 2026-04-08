# pwa/src/idb/tasks.ts

Pure async I/O functions for the `tasks` object store in IndexedDB. No React dependency — called from action creators and the sync module.

## Functions

**`idbGetAllTasks()`** — Returns all task records from the `tasks` store as a `Task[]`.

**`idbPutTask(task)`** — Upserts a `Task` record (insert or replace by `id`).

**`idbDeleteTask(id)`** — Deletes the task with the given `id` from the store.

**`idbClearTasks()`** — Removes every record from the `tasks` store (used before a full server sync overwrite).
