# shared/schema.ts

Drizzle ORM table definitions for the Cloudflare D1 SQLite database. This is the single source of truth for the database schema — both the runtime query builder and TypeScript types are derived from it.

Imported in the worker via the `@shared/schema` path alias. The PWA never imports schema directly; it uses the re-exported types from `shared/types.ts`.

## Tables

**`projects`** — Project rows. Columns: `id` (text PK, nanoid prefixed `p_`), `title`, `notes`, `kickoff_note`, `status` (`active | archived`), `created_at`, `updated_at`.

**`tasks`** — Task rows. Columns: `id` (text PK, nanoid prefixed `t_`), `title`, `notes`, `status` (`pending | done`), `due_date`, `recurrence` (iCal RRULE, legacy — superseded by `duties`), `created_at`, `updated_at`, `defer_until`, `defer_kind` (`none | until | someday`), `task_type` (`action | plan`), `project_id` (FK → projects), `kickoff_note`, `session_log`, `focused_until`, `duty_id` (FK → duties, nullable), `occurrence_at` (nullable). A task is "deferred" when `defer_kind = 'someday'` (indefinitely), or `defer_kind = 'until'` with a future `defer_until` (timed). Expired `until` deferrals are treated as ready in queries without writing back. `duty_id`/`occurrence_at` are set together and null together (enforced by the `tasks_duty_occurrence` unique index, not yet written by anything — see `docs/plans/duties.md` Stage 4) and identify which duty occurrence a spawned task instance belongs to.

**`due_date` is a UTC datetime, not a date.** As of the duties migration (`docs/plans/duties/02-timestamp-model.md`, Decision 4), every scheduling timestamp in the app — `due_date` included — is minute-resolution UTC (`YYYY-MM-DDTHH:MM:00Z`); there are no date-only fields. A bare calendar date is still accepted on write (REST, MCP, the task edit form) and anchored to **noon UTC**, which keeps the displayed calendar date stable for viewer zones from UTC−12 to UTC+11 — the migration rewrote every pre-existing date-only `due_date` the same way. Rendering a `due_date` as a plain date means reading its date part back in the *viewer's* local zone (`pwa/src/utils/design.ts` `localDateOf`), not slicing the stored UTC string. `defer_until`/`focused_until` are unaffected in shape (already datetime) but new writes now also truncate to minute resolution.

**`duties`** — A recurring series' anchor. Columns: `id` (text PK, nanoid prefixed `d_`), `title`, `notes`, `kickoff_note`, `task_type` (`action | plan`), `project_id` (FK → projects), `rrule`, `dtstart` (UTC datetime, immutable), `timezone` (nullable IANA anchor zone, immutable; null ⇒ expand in UTC), `status` (`active | paused | ended`), `catch_up` (`next | all`), `last_spawned_at` (nullable cursor), `next_occurrence_at` (nullable; indexed — drives the due-gate), `created_at`, `updated_at`. `rrule`/`dtstart`/`timezone` together define the occurrence calendar and are fixed at creation; rescheduling or re-zoning is `end_duty` + `create_duty`, not an edit. As of Stage 1 (`docs/plans/duties.md`) this table exists but nothing writes to it yet — no duty rows are created and no task references one until the Stage 4 backfill.

**`taskLinks`** — Directed dependency edges. Columns: `from_task_id` (FK → tasks, cascade), `to_task_id` (FK → tasks, cascade), `link_type` (`blocks | related`). Composite primary key on all three columns.

**`userPreferences`** — Key-value store for user settings. Columns: `key` (text PK), `value`.

**`actionLog`** — Append-only audit log. Columns: `id` (integer autoincrement PK), `tool_name`, `task_id`, `duty_id` (nullable — not yet written; lands with duty mutations), `title`, `detail`, `created_at`.

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
