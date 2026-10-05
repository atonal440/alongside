# shared/schema.ts

Drizzle ORM table definitions for the Cloudflare D1 SQLite database. This is the single source of truth for the database schema — both the runtime query builder and TypeScript types are derived from it.

Imported in the worker via the `@shared/schema` path alias. The PWA never imports schema directly; it uses the re-exported types from `shared/types.ts`.

## Tables

**`projects`** — Project rows. Columns: `id` (text PK, nanoid prefixed `p_`), `title`, `notes`, `kickoff_note`, `status` (`active | archived`), `created_at`, `updated_at`.

**`tasks`** — Task rows. Columns: `id` (text PK, nanoid prefixed `t_`), `title`, `notes`, `status` (`pending | done`), `due_date`, `due_all_day` (nullable boolean), `recurrence` (iCal RRULE, legacy — superseded by `duties`), `created_at`, `updated_at`, `defer_until`, `defer_kind` (`none | until | someday`), `task_type` (`action | plan`), `project_id` (FK → projects), `kickoff_note`, `session_log`, `focused_until`, `duty_id` (FK → duties, nullable), `occurrence_at` (nullable), `available_from` and `deadline` (nullable TemporalPoint JSON text, see below), `parent_id` (nullable task id, no foreign key) and `position` (nullable real, sibling sort key). A task is "deferred" when `defer_kind = 'someday'` (indefinitely), or `defer_kind = 'until'` with a future `defer_until` (timed). Expired `until` deferrals are treated as ready in queries without writing back. `duty_id`/`occurrence_at` are set together and null together (enforced by the `tasks_duty_occurrence` unique index, not yet written by anything — see `docs/plans/duties.md` Stage 4) and identify which duty occurrence a spawned task instance belongs to.

**`due_date` is a UTC datetime, not a date.** As of the duties migration (`docs/plans/duties/02-timestamp-model.md`, Decision 4), every scheduling timestamp in the app — `due_date` included — is minute-resolution UTC (`YYYY-MM-DDTHH:MM:00Z`); there are no date-only fields. A bare calendar date is still accepted on write (REST, MCP, the task edit form) and anchored to **noon UTC**. Rendering a `due_date` as a plain date means reading its date part back in the *viewer's* local zone (`pwa/src/utils/design.ts` `localDateOf`), not slicing the stored UTC string. `defer_until`/`focused_until` are unaffected in shape (already datetime) but new writes now also truncate to minute resolution.

**`due_all_day` is an explicit marker, not inferred.** A `due_date` set from a bare calendar date is all-day intent (`due_all_day: true`); one set from a full instant is a genuine timed deadline (`due_all_day: false`). This can only be derived from the *as-submitted* input shape (`shared/parse/primitives.ts` `parseDueDateParts`, used by `worker/src/db.ts`'s `resolveDueDate` — the single choke point both REST and MCP funnel through) — once `due_date` is stored as an instant, a timed value that happens to normalize to noon UTC is indistinguishable from an all-day one, so nothing downstream may re-derive `due_all_day` from `due_date` after the fact. `null` on legacy rows (predates the column) and treated as all-day everywhere it's read. This replaced an earlier noon-UTC-instant heuristic that had exactly that false-positive; see `docs/plans/duties-implementation-todo.md` "Notes / deviations" for the history.

**Date roles.** `due_date` is the task's *target* — when to aim to finish. Migration 015 adds the other two roles from `docs/plans/power-user-todo.md`: `available_from` (earliest permitted start, independent of deferral) and `deadline` (hard completion boundary). Each column holds one canonical `TemporalPoint` JSON object, `{"kind":"date","date":"YYYY-MM-DD","timezone":"<IANA>"}` or `{"kind":"instant","at":"YYYY-MM-DDTHH:MM:00Z","timezone":"<IANA>"}`, with that exact key order (`temporalPointText` in `shared/temporal`; a row whose text is not the canonical spelling fails `TaskRowSchema`). A date keeps its zone so "Friday in Los Angeles" stays Friday elsewhere: a date `available_from` opens at the start of that local day, a date `deadline` allows completion until the start of the next. Null means unset. Existing rows keep both null, legacy writers cannot touch them, and a legacy recurring completion's successor starts without them. The roadmap sketched a separate `task_dates` table; two columns on the task row reach the same behavior without a new synced entity, and the plan notes the choice.

**`duties`** — A recurring series' anchor. Columns: `id` (text PK, nanoid prefixed `d_`), `title`, `notes`, `kickoff_note`, `task_type` (`action | plan`), `project_id` (FK → projects), `rrule`, `dtstart` (minute-resolution UTC datetime, immutable and always timed), `timezone` (nullable IANA anchor zone, immutable; null or explicit `UTC` ⇒ expand in UTC), `status` (`active | paused | ended`), `catch_up` (`next | all`), `last_spawned_at` (nullable cursor), `next_occurrence_at` (nullable; indexed — drives the due-gate), `created_at`, `updated_at`. Duties have no `due_all_day`: creation requires a full datetime `dtstart` and never infers noon or all-day intent. `rrule`/`dtstart`/`timezone` together define the occurrence calendar and are fixed at creation; rescheduling or re-zoning is `end_duty` + `create_duty`, not an edit. The exact duty-only RRULE subset and expansion semantics are documented in `docs/shared/parse/recurrence.md`. As of Stage 1 (`docs/plans/duties.md`) this table exists but nothing writes to it yet — no duty rows are created and no task references one until the Stage 4 backfill.

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
