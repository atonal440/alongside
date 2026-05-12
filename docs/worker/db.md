# worker/src/db.ts

Database abstraction layer over Cloudflare D1 (SQLite). Uses the Drizzle ORM query builder for all reads and most writes; raw D1 batch API is used for import and for operations that need `last_row_id`. No other file issues queries directly.

## Types

**`ActionLogEntry`** — Type alias for `ActionLog` from `shared/schema.ts` (`typeof actionLog.$inferSelect`).

**`ExportPayload`** — Full-data JSON export format. Fields: `version` (always `1`), `exported_at`, `projects`, `tasks`, `links`, `preferences` (key/value map), optional `action_log`.

**`ImportResult`** — Response shape for `POST /api/import`. In dry-run mode: `would_delete` and `would_insert` counts. On commit: `inserted` counts per table.

## Class: `DB`

Constructed with a `D1Database` instance. Initializes a Drizzle client (`drizzle(d1)`) alongside the raw `d1` reference. Every method is `async` and returns typed results.

## Helper functions

**`notDeferredCondition(nowIso)`** — Drizzle SQL fragment expressing the "not currently deferred" predicate (mirrors `isDeferred` from `shared/readiness.ts`). Used by all read paths that should hide deferred tasks.

`isFocused` and `readinessScore` are imported from [[readiness|shared/readiness.ts]] — see that doc for the canonical scoring table and weights.

## Task operations

**`listTasks(statuses?)`** — Returns actionable tasks: filtered by status (defaults to `['pending']`), excluding currently-deferred tasks (`defer_kind = 'someday'` or future `defer_until`), ordered by `due_date` then `created_at`.

**`listAllTasks(statuses?)`** — Returns all tasks including currently-deferred ones (defaults to `['pending', 'done']`). Used by the PWA sync endpoint so the client gets the full picture.

**`getTask(id)`** — Fetches a single task row by primary key.

**`TaskRecurrenceUnsupportedError`** — Thrown when public task create/update tries to set a non-null task-level `recurrence`. New recurring work must be represented by duties.

**`addTask(data)`** — Inserts a new public task with a generated nanoid (`defer_kind` defaults to `'none'`). Rejects non-null `recurrence` input and always stores `recurrence`, `duty_id`, and `duty_fire_at` as null so callers cannot create legacy recurrence rows or reserve a duty fire.

**`addTaskFromDuty(data)`** — Inserts a materialized duty task with required `duty_id` and `duty_fire_at` idempotency keys. This is the only task-creation path that can set those internal fields.

**`LegacyRecurringTaskNeedsTimezoneError`** — Thrown when completion reaches a legacy task-level recurrence row that was not converted to a duty because no explicit valid timezone preference exists yet.

**`completeTask(id)`** — Marks a task `done` and clears `focused_until`. Callers run duty materialization first so legacy task-level recurrence is converted before completion; if a legacy recurring row remains, completion is blocked with `LegacyRecurringTaskNeedsTimezoneError` so the series is not lost before timezone-aware migration can run. If the task came from a duty (`duty_id` is set) and has a `session_log`, copies the log onto the parent duty as its new `kickoff_note` so the next materialization carries forward the user's re-entry note. Schedule advancement is handled by the duty (not by completion), so accidental completion does not shift the schedule.

**`reopenTask(id)`** — Clears `defer_kind`/`defer_until`, making the task immediately actionable again. Does not modify `status`.

**`deferTask(id, kind, until?)`** — Sets `defer_kind` to `'until'` or `'someday'` and clears `focused_until`. For `'until'`, also writes the supplied ISO timestamp to `defer_until`; for `'someday'`, clears `defer_until`. Does not modify `status`.

**`clearDeferTask(id)`** — Resets `defer_kind` to `'none'` and clears `defer_until`. Equivalent to `reopenTask` for currently-pending tasks.

**`updateTask(id, data)`** — Partial update: only columns present in `data` are written (including `focused_until`, `defer_until`, and `defer_kind`). Updates `updated_at` automatically.

**`deleteTask(id)`** — Hard-deletes a task row (cascade removes links).

## Readiness and focus

**`listReadyTasks(projectId?)`** — Returns unblocked pending tasks (not currently deferred, no incomplete blockers) sorted by readiness score. Optionally filtered to a project.

**`listFocusedTasks()`** — Returns tasks where `focused_until` is in the future and the task is not currently deferred or done.

## Project operations

**`createProject(data)`** — Inserts a new project row (with `notes` and `kickoff_note`) and returns it.

**`getProject(id)`** — Fetches a single project by primary key.

**`listProjects(status?)`** — Lists projects, optionally filtered by status.

**`updateProject(id, data)`** — Partial update of project fields (`title`, `notes`, `kickoff_note`, `status`).

**`deleteProject(id)`** — Unlinks all tasks and duties from the project (sets `project_id = NULL`), then deletes the project row.

## Duty operations

**`addDuty(data)`** — Inserts a new duty with a generated nanoid. `recurrence` and `next_fire_at` are required; everything else has sensible defaults (`task_type = 'action'`, `due_offset_days = 0`, `active = true`). Rejects non-integer `due_offset_days` values before storage so materialized due dates remain valid.

**`getDuty(id)`** — Fetches a single duty row by primary key.

**`listDuties()`** — Returns all duties (active and paused) ordered by `created_at`.

**`listDueDuties(nowIso)`** — Returns active duties whose `next_fire_at <= nowIso`. Used by the materialization engine.

**`findTaskByDutyFire(dutyId, fireAt)`** — Returns the task that was already materialized for this duty/fire (if any). Used as the idempotency check in `materializeDueDuties`.

**`listLegacyRecurringTasks()`** — Returns pending tasks that still carry the legacy task-level `recurrence` field. Used by the duty materializer to lazily migrate old recurring tasks with access to user timezone math.

**`convertLegacyRecurringTaskToDuty(task, fireAt, nowIso)`** — Creates a deterministic duty for one legacy recurring task (`d_` plus the task suffix), links the task to that duty/fire, and clears `tasks.recurrence`. Uses `INSERT OR IGNORE` plus a guarded task update so repeated request-path conversions are safe.

**`updateDuty(id, data)`** — Partial update of duty fields. Updates `updated_at` automatically and rejects non-integer `due_offset_days` patches.

**`markDutyFired(id, firedAt, nextFireAt, nowIso)`** — After a successful materialization, sets `last_fired_at` to `firedAt` and `next_fire_at` to the precomputed next fire timestamp.

**`setDutyActive(id, active, nowIso)`** — Pause or resume a duty without deleting it. The materialization engine calls this with `active = false` when it encounters an unparseable RRULE.

**`deleteDuty(id)`** — Hard-deletes a duty. Materialized tasks survive (their `duty_id` is set null via the FK).

## Link operations

**`linkTasks(fromId, toId, linkType)`** — Creates a dependency edge between two tasks. `linkType` is `'blocks'` or `'related'`.

**`unlinkTasks(fromId, toId, linkType)`** — Removes a specific link between two tasks.

**`getTaskLinks(taskId)`** — Returns all links where the task is either the source or target.

**`listAllLinks()`** — Returns every row in the `task_links` table.

## Preferences

**`getPreference(key)`** — Reads a single preference value by key.

**`setPreference(key, value)`** — Upserts a preference row.

**`getAllPreferences()`** — Returns all preference rows merged with built-in defaults.

**`seedDefaultPreferences()`** — Inserts default preference rows if they don't already exist, except `timezone`. `timezone` remains a computed default (`UTC`) until the PWA or MCP preference writer stores an explicit IANA timezone, so legacy recurrence migration can distinguish real user timezone from fallback.

## Action log

**`logAction(entry)`** — Appends a row to `action_log` recording which tool ran and on which entity. Uses raw D1 to capture `last_row_id` for the returned row.

**`getActionLog(limit?)`** — Returns the most recent action log entries (default 50).

## Import / export

**`exportAll(includeLog?)`** — Reads all tables in parallel and returns an `ExportPayload`. Action log is excluded by default (`includeLog = false`) since it can be large.

**`importAll(payload, dryRun?)`** — Validates the payload, then either returns a preview of what would change (`dryRun = true`) or wipes all data and restores from the payload. Translates legacy `snoozed_until` (from pre-006 exports) into `defer_kind = 'until'` so previously-snoozed tasks remain hidden after restore. Uses D1 `batch()` for atomic execution when statement count ≤ 100; falls back to chunked batches for larger datasets after preflighting duplicate IDs, task/link/duty references, and integer duty due offsets.

## See Also

- [[schema]] — table definitions this module queries
- [[readiness|shared/readiness.ts]] — `isDeferred` predicate mirrored by `notDeferredCondition`
- [[api|worker/api.ts]] — REST handler that calls these methods
- [[mcp|worker/mcp.ts]] — MCP handler that calls these methods
- [[duties|worker/duties.ts]] — materialization engine that calls duty methods on this DB
