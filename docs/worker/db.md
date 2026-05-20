# worker/src/db.ts

Database abstraction layer over Cloudflare D1 (SQLite). Uses the Drizzle ORM query builder for all reads and most writes; typed mutation plans go through `applyPlan`, and raw D1 is used where the platform API is required (such as `last_row_id`). No other file issues queries directly.

## Types

**`ActionLogEntry`** — Type alias for `ActionLog` from `shared/schema.ts` (`typeof actionLog.$inferSelect`).

**`ExportPayload`** — Full-data JSON export format. Fields: `version` (always `1`), `exported_at`, `projects`, `tasks`, `links`, `preferences` (key/value map), optional `action_log`.

**`ImportResult`** — Response shape for `POST /api/import`. In dry-run mode: `would_delete` and `would_insert` counts. On commit: `inserted` counts per table.

**`DomainOperationError`** — Error wrapper for typed `AppError` values raised by storage-facing methods when validation or lifecycle checks fail.

## Class: `DB`

Constructed with a `D1Database` instance. Initializes a Drizzle client (`drizzle(d1)`) alongside the raw `d1` reference. Every method is `async` and returns typed results.

## Helper functions

**`notDeferredCondition(nowIso)`** — Drizzle SQL fragment expressing the "not currently deferred" predicate for valid rows. Used by all read paths that should hide deferred tasks; invalid timed deferrals without `defer_until` are not treated as actionable.

`isFocused` and `readinessScore` are imported from [[readiness|shared/readiness.ts]] — see that doc for the canonical scoring table and weights.

## Task operations

**`listTasks(statuses?)`** — Returns actionable tasks: filtered by status (defaults to `['pending']`), excluding currently-deferred tasks (`defer_kind = 'someday'` or future `defer_until`), ordered by `due_date` then `created_at`.

**`listAllTasks(statuses?)`** — Returns all tasks including currently-deferred ones (defaults to `['pending', 'done']`). Used by the PWA sync endpoint so the client gets the full picture.

**`getTask(id)`** — Fetches a single task row by primary key.

**`addTask(data)`** — Inserts a new task with a generated nanoid (`defer_kind` defaults to `'none'`). Builds the final row and validates it through the task row/domain codec before writing, including RRULE parsing and the invariant that recurring tasks must have a due date. Returns the created `Task`.

**`completeTask(id)`** — Loads the task as a `PendingTaskDomain`, plans completion through `completeTaskPlan`, then applies the plan through `applyPlan`. Marks the task `done`, clears focus and deferral fields, and for recurring tasks creates the next occurrence with a computed `due_date` and carries `session_log` forward as `kickoff_note`.

**`reopenTask(id)`** — Loads the row as `TaskDomain`, accepts only done tasks or deferred pending tasks, then applies the reopen plan through `applyPlan`. Writes `status = 'pending'`, clears deferral, clears focus, and refreshes `updated_at`.

**`deferTask(id, kind, until?)`** — Loads the row as `PendingTaskDomain`, parses the defer input, and applies the deferral plan through `applyPlan`. For `'until'`, `until` is required and must be an ISO timestamp; for `'someday'`, `until` must be omitted. Both variants clear `focused_until`.

**`clearDeferTask(id)`** — Loads the row as `PendingTaskDomain`, then applies the clear-defer plan through `applyPlan`.

**`focusTask(id, focusedUntil)`** — Loads the row as `PendingTaskDomain`, parses the focus timestamp, and applies the focus plan through `applyPlan`. Any existing pending deferral is cleared while focusing.

**`updateTask(id, data)`** — Partial update: only columns present in `data` are written (including `focused_until`, `defer_until`, and `defer_kind`). Loads the existing row, routes non-null `focused_until` through `focusTaskPlan`, applies the patch in memory, validates the final row through the task row/domain codec, then writes it with a fresh `updated_at`.

**`deleteTask(id)`** — Hard-deletes a task row (cascade removes links).

## Readiness and focus

**`listReadyTasks(projectId?)`** — Returns unblocked pending tasks (not currently deferred, no incomplete blockers) sorted by readiness score. Optionally filtered to a project.

**`listFocusedTasks()`** — Returns tasks where `focused_until` is in the future and the task is not currently deferred or done.

## Project operations

**`createProject(data, taskIds?)`** — Mints a project id, builds a project row, and applies `createProjectPlan`. When task ids are provided, the plan asserts each unique task exists before inserting the project and assigning those tasks in the same batch.

**`getProject(id)`** — Fetches a single project by primary key.

**`listProjects(status?)`** — Lists projects, optionally filtered by status.

**`updateProject(id, data)`** — Partial update of project fields (`title`, `notes`, `kickoff_note`, `status`).

**`deleteProject(id)`** — Unlinks all tasks from the project (sets `project_id = NULL`), then deletes the project row.

## Link operations

**`linkTasks(fromId, toId, linkType)`** — Parses a typed link domain value, rejects self-links, asserts both endpoint tasks exist, and applies `linkTasksPlan`. `blocks` links also run an acyclic graph precheck so a task cannot indirectly block itself.

**`unlinkTasks(fromId, toId, linkType)`** — Parses a typed link domain value and applies `unlinkTasksPlan` to remove a specific link. Missing rows remain a no-op.

**`getTaskLinks(taskId)`** — Returns all links where the task is either the source or target.

**`listAllLinks()`** — Returns every row in the `task_links` table.

## Preferences

**`getPreference(key)`** — Reads a single preference value by key.

**`setPreference(key, value)`** — Upserts a preference row.

**`getAllPreferences()`** — Returns all preference rows merged with built-in defaults.

**`seedDefaultPreferences()`** — Inserts default preference rows if they don't already exist.

## Action log

**`logAction(entry)`** — Appends a row to `action_log` recording which tool ran and on which entity. Uses raw D1 to capture `last_row_id` for the returned row.

**`getActionLog(limit?)`** — Returns the most recent action log entries (default 50).

## Import / export

**`exportAll(includeLog?)`** — Reads all tables in parallel and returns an `ExportPayload`. Action log is excluded by default (`includeLog = false`) since it can be large.

**`importAll(payload, dryRun?)`** — Parses unknown JSON through `parseImport`, validates cross-row integrity with `planImport`, then either returns a preview of what would change (`dryRun = true`) or applies the planned wipe-and-restore through `applyPlan`. The parser translates legacy `snoozed_until` (from pre-006 exports) into `defer_kind = 'until'` so previously-snoozed tasks remain hidden after restore. Small restores run as one D1 batch; large unguarded restore plans are chunked by the shared plan executor after validation.

## See Also

- [[schema]] — table definitions this module queries
- [[readiness|shared/readiness.ts]] — frontend readiness predicates that correspond to the worker query filters for valid rows
- [[api|worker/api.ts]] — REST handler that calls these methods
- [[mcp|worker/mcp.ts]] — MCP handler that calls these methods
