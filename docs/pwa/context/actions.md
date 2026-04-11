# pwa/src/context/actions.ts

Async action creators — the bridge between UI events and IndexedDB + server writes. Each function takes `dispatch` (and sometimes `config`) and performs the full write path: update IndexedDB, dispatch to React state, and attempt a server write (falling back to queuing a `PendingOp` for later sync).

## Functions

**`createTaskAction(title, config, dispatch)`** — Creates a new task: generates a temp nanoid, writes to IndexedDB, dispatches `UPSERT_TASK`, and attempts `POST /api/tasks`. On success, remaps temp ID to the server's ID.

**`updateTaskAction(id, updates, config, dispatch)`** — Updates task fields locally and attempts `PATCH /api/tasks/:id`. Falls back to a pending op if offline.

**`deleteTaskAction(id, config, dispatch)`** — Deletes from IndexedDB, dispatches `DELETE_TASK`, and attempts `DELETE /api/tasks/:id`.

**`completeTaskAction(id, config, dispatch)`** — Marks task done locally, attempts `POST /api/tasks/:id/complete`. If recurring, surfaces the next occurrence. Returns toast HTML or null.

**`focusTaskAction(id, config, dispatch)`** — Sets `focused_until` on a task locally and attempts `PATCH /api/tasks/:id` with the `focused_until` value.

**`createLinkAction(fromId, toId, linkType, config, dispatch)`** — Creates a task link locally and attempts `POST /api/tasks/links`.

**`deleteLinkAction(fromId, toId, linkType, config, dispatch)`** — Removes a task link locally and attempts `DELETE /api/tasks/links`.
