# pwa/src/context/actions.ts

Async action creators — the bridge between UI events and IndexedDB + server writes. Each function takes `dispatch` (and sometimes `state`) and performs the full write path: update IndexedDB, dispatch to React state, and queue a `PendingOp` for server sync.

## Functions

**`createTaskAction(dispatch, data, apiConfig?)`** — Creates a new task: generates a temp nanoid, writes to IndexedDB, dispatches `ADD_TASK`, and queues a `POST /api/tasks` pending op. If `apiConfig` is available and online, attempts an immediate server write and remaps the temp ID to the server's ID.

**`updateTaskAction(dispatch, id, data, apiConfig?)`** — Updates task fields: writes the partial update to IndexedDB, dispatches `UPDATE_TASK`, and queues a `PATCH /api/tasks/:id` pending op. Handles status transitions (complete, reopen, snooze) as well as field edits.
