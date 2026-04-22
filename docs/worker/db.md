# worker/src/db.ts

Database abstraction layer over Cloudflare D1 (SQLite). Uses the Drizzle ORM query builder for all reads and most writes; raw D1 batch API is used for import and for operations that need `last_row_id`. No other file issues queries directly.

## Types

**`ActionLogEntry`** — Type alias for `ActionLog` from `shared/schema.ts` (`typeof actionLog.$inferSelect`).

**`ExportPayload`** — Full-data JSON export format. Fields: `version` (always `1`), `exported_at`, `projects`, `tasks`, `links`, `preferences` (key/value map), optional `action_log`.

**`ImportResult`** — Response shape for `POST /api/import`. In dry-run mode: `would_delete` and `would_insert` counts. On commit: `inserted` counts per table.

## Class: `DB`

Constructed with a `D1Database` instance. Initializes a Drizzle client (`drizzle(d1)`) alongside the raw `d1` reference. Every method is `async` and returns typed results.

## Helper functions

**`isFocused(task)`** — Returns `true` if the task's `focused_until` is set and in the future.

**`readinessScore(task)`** — Scores a task for priority ordering; gives +5 to focused tasks.

### Task methods

**`listTasks(statuses?)`** — Returns actionable tasks: filtered by status (defaults to `['pending']`), excluding currently-snoozed tasks, ordered by `due_date` then `created_at`.

**`listAllTasks(statuses?)`** — Returns all tasks including currently-snoozed ones (defaults to `['pending', 'done']`). Used by the PWA sync endpoint so the client gets the full picture.

**`getTask(id)`** — Fetches a single task row by primary key.

**`addTask(data)`** — Inserts a new task with a generated nanoid. Returns the created `Task`.

**`completeTask(id)`** — Marks a task `done` and clears `focused_until`. If the task has a `recurrence` rule, creates the next occurrence with a computed `due_date` and carries `session_log` forward as `kickoff_note`.

**`reopenTask(id)`** — Clears `snoozed_until`, making the task immediately actionable again. Does not modify `status`.

**`snoozeTask(id, until)`** — Sets `snoozed_until` to the given ISO timestamp and clears `focused_until`. Does not modify `status` — the task remains `pending`.

**`updateTask(id, data)`** — Partial update: only columns present in `data` are written (including `focused_until` and `snoozed_until`). Updates `updated_at` automatically.

**`deleteTask(id)`** — Hard-deletes a task row (cascade removes links).

**`listReadyTasks(projectId?)`** — Returns unblocked pending tasks (not currently snoozed, no incomplete blockers) sorted by readiness score. Optionally filtered to a project.

**`listFocusedTasks()`** — Returns tasks where `focused_until` is in the future and the task is not currently snoozed or done.

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

**`logAction(entry)`** — Appends a row to `action_log` recording which tool ran and on which entity. Uses raw D1 to capture `last_row_id` for the returned row.

**`getActionLog(limit?)`** — Returns the most recent action log entries (default 50).

### Archive / Restore methods

**`exportAll(includeLog?)`** — Reads all tables in parallel and returns an `ExportPayload`. Action log is excluded by default (`includeLog = false`) since it can be large.

**`importAll(payload, dryRun?)`** — Validates the payload, then either returns a preview of what would change (`dryRun = true`) or wipes all data and restores from the payload. Uses D1 `batch()` for atomic execution when statement count ≤ 100; falls back to chunked batches of 100 for larger datasets.
