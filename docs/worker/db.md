# worker/src/db.ts

Database abstraction layer over Cloudflare D1 (SQLite). All SQL lives here; no other file issues queries directly.

## Types

**`ActionLogEntry`** — Shape of a row from the `action_log` table: `id`, `tool_name`, `task_id`, `title`, `detail`, `created_at`.

## Class: `DB`

Constructed with a `D1Database` instance. Every method is `async` and returns typed results.

### Task methods

**`listTasks(status?)`** — Returns tasks filtered by status, ordered by `due_date` then `created_at`. Omitting `status` returns all tasks.

**`getActiveTasks(sessionId?)`** — Returns tasks with `status = 'active'`, optionally filtered to a specific `session_id`.

**`getTask(id)`** — Fetches a single task row by primary key.

**`addTask(data)`** — Inserts a new task. Generates a nanoid if no `id` is provided. Returns the created `Task`.

**`activateTask(id, sessionId?)`** — Sets a task's status to `active` and optionally assigns it to a session.

**`completeTask(id)`** — Marks a task `done`. If the task has a `recurrence` rule, creates the next occurrence with a computed `due_date` before marking the original done.

**`reopenTask(id)`** — Sets status back to `pending` and clears `session_id`.

**`snoozeTask(id, until)`** — Sets status to `snoozed` with a `due_date` of `until`.

**`updateTask(id, data)`** — Partial update: only columns present in `data` are written. Updates `updated_at` automatically.

**`deleteTask(id)`** — Hard-deletes a task row and its associated links.

**`listReadyTasks()`** — Returns unblocked `pending` tasks sorted by a readiness score (overdue tasks rank highest, then by `created_at`).

### Project methods

**`createProject(data)`** — Inserts a new project row and returns it.

**`getProject(id)`** — Fetches a single project by primary key.

**`listProjects(status?)`** — Lists projects, optionally filtered by status.

**`updateProject(id, data)`** — Partial update of project fields.

### Link methods

**`linkTasks(fromId, toId, linkType)`** — Creates a `blocks` dependency edge between two tasks.

**`unlinkTasks(fromId, toId)`** — Removes the link between two tasks.

**`getTaskLinks(taskId)`** — Returns all links where the task is either the source or target.

**`listAllLinks()`** — Returns every row in the `task_links` table.

### Preference methods

**`getPreference(key)`** — Reads a single preference value by key.

**`setPreference(key, value)`** — Upserts a preference row.

**`getAllPreferences()`** — Returns all preference rows merged with built-in defaults.

**`seedDefaultPreferences()`** — Inserts default preference rows if they don't already exist (called on first run).

### Action log methods

**`logAction(entry)`** — Appends a row to `action_log` recording which MCP tool ran and on which task.

**`getActionLog(limit?)`** — Returns the most recent action log entries (default 20).
