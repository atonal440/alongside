# shared/schema.ts

Drizzle ORM table definitions for the Cloudflare D1 SQLite database. This is the single source of truth for the database schema — both the runtime query builder and TypeScript types are derived from it.

Imported in the worker via the `@shared/schema` path alias. The PWA never imports schema directly; it uses the re-exported types from `shared/types.ts`.

## Tables

**`projects`** — Project rows. Columns: `id` (text PK, nanoid prefixed `p_`), `title`, `notes`, `kickoff_note`, `status` (`active | archived`), `created_at`, `updated_at`.

**`tasks`** — Task rows. Columns: `id` (text PK, nanoid prefixed `t_`), `title`, `notes`, `status` (`pending | done`), `due_date`, `recurrence` (legacy iCal RRULE; new tasks leave this null and use `duty_id` instead), `created_at`, `updated_at`, `defer_until`, `defer_kind` (`none | until | someday`), `task_type` (`action | plan`), `project_id` (FK → projects), `kickoff_note`, `session_log`, `focused_until`, `duty_id` (FK → duties, set null on delete), `duty_fire_at` (the duty's `next_fire_at` at the moment this instance was materialized; unique idempotency key with `duty_id`). A task is "deferred" when `defer_kind = 'someday'` (indefinitely), or `defer_kind = 'until'` with a future `defer_until` (timed). Expired `until` deferrals are treated as ready in queries without writing back.

**`duties`** — Schedule-driven task templates. Columns: `id` (text PK, nanoid prefixed `d_`), `title`, `notes`, `kickoff_note`, `task_type` (`action | plan`), `project_id` (FK → projects), `recurrence` (iCal RRULE; required), `due_offset_days` (added to fire date for the materialized task's `due_date`), `active` (boolean; pause without deleting), `next_fire_at` (precomputed UTC ISO timestamp), `last_fired_at`, `created_at`, `updated_at`. Replaces task-level recurrence so accidental task completion no longer shifts the schedule. See [[duties|worker/duties.ts]] for the materialization engine.

**`taskLinks`** — Directed dependency edges. Columns: `from_task_id` (FK → tasks, cascade), `to_task_id` (FK → tasks, cascade), `link_type` (`blocks | related`). Composite primary key on all three columns.

**`userPreferences`** — Key-value store for user settings. Columns: `key` (text PK), `value`.

**`actionLog`** — Append-only audit log. Columns: `id` (integer autoincrement PK), `tool_name`, `task_id`, `title`, `detail`, `created_at`.

**`oauthCodes`** — OAuth authorization codes for the PKCE flow. Columns: `code` (text PK), `client_id`, `redirect_uri`, `code_challenge`, `expires_at` (integer Unix timestamp).

## Exported types

**`Task`** — `typeof tasks.$inferSelect`. Matches the hand-written interface previously in `shared/types.ts`.

**`Project`** — `typeof projects.$inferSelect`.

**`TaskLink`** — `typeof taskLinks.$inferSelect`.

**`ActionLog`** — `typeof actionLog.$inferSelect`.

**`Duty`** — `typeof duties.$inferSelect`.

## See Also

- [[types|shared/types.ts]] — re-exported row types and `PendingOp` used by the PWA
- [[db|worker/db.ts]] — Drizzle client built on these table definitions
- [[readiness]] — predicates that operate on `Task` and `TaskLink` rows
- [[idb-db|pwa/src/idb/db.ts]] — client-side IDB schema; mirrors this structure without Drizzle
