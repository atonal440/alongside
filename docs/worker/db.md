# worker/src/db.ts

Database abstraction layer over Cloudflare D1 (SQLite). All SQL lives here; no other file issues queries directly.

## Types

**`ActionLogEntry`** — Shape of a row from the `action_log` table: `id`, `tool_name`, `task_id`, `title`, `detail`, `created_at`.

## Class: `DB`

Constructed with a `D1Database` instance. Every method is `async` and returns typed results.

### Task methods

**`listTasks(statuses?)`** — Returns tasks filtered by status array, ordered by `due_date` then `created_at`. Defaults to `['pending', 'active']`.

**`getTask(id)`** — Fetches a single task row by primary key.

**`addTask(data)`** — Inserts a new task with a generated nanoid. Returns the created `Task`.

**`completeTask(id)`** — Marks a task `done`. If the task has a `recurrence` rule, creates the next occurrence with a computed `due_date` and carries `session_log` forward as `kickoff_note`.

**`reopenTask(id)`** — Sets status back to `pending` and clears `snoozed_until`.

**`snoozeTask(id, until)`** — Sets status to `snoozed` with `snoozed_until` set to the given date.

**`updateTask(id, data)`** — Partial update: only columns present in `data` are written. Updates `updated_at` automatically.

**`deleteTask(id)`** — Hard-deletes a task row (cascade removes links).

**`listReadyTasks(projectId?)`** — Returns unblocked tasks (pending/active, no incomplete blockers) sorted by readiness score. Optionally filtered to a project.

### Project methods

**`createProject(data)`** — Inserts a new project row (with `notes` and `kickoff_note`) and returns it.

**`getProject(id)`** — Fetches a single project by primary key.

**`listProjects(status?)`** — Lists projects, optionally filtered by status.

**`updateProject(id, data)`** — Partial update of project fields (`title`, `notes`, `kickoff_note`, `status`).

**`deleteProject(id)`** — Unlinks all tasks from the project (sets `project_id = NULL`), then deletes the project row.

### Link methods

**`linkTasks(fromId, toId, linkType)`** — Creates a dependency edge between two tasks. `linkType` is `'blocks'` or `'related'`.

**`unlinkTasks(fromId, toId, linkType)`** — Removes a specific link between two tasks.

**`getTaskLinks(taskId)`** — Returns all links where the task is either the source or target.

**`listAllLinks()`** — Returns every row in the `task_links` table.

### Preference methods

**`getPreference(key)`** — Reads a single preference value by key.

**`setPreference(key, value)`** — Upserts a preference row.

**`getAllPreferences()`** — Returns all preference rows merged with built-in defaults.

**`seedDefaultPreferences()`** — Inserts default preference rows if they don't already exist.

### Action log methods

**`logAction(entry)`** — Appends a row to `action_log` recording which tool ran and on which entity.

**`getActionLog(limit?)`** — Returns the most recent action log entries (default 50).
