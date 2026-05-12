# worker/duties.ts

Materialization engine for the `duties` table. A duty is a schedule-driven task template; this module computes when it next fires (in the user's configured timezone), creates one real task per fire, and advances the duty's `next_fire_at`.

Materialization runs from an hourly Cloudflare cron handler and still has request-path fallback. The cron advances already-created duties but skips legacy task recurrence migration so it cannot anchor old date-only tasks before the user's timezone has been synced. Read handlers in `worker/api.ts` and `worker/mcp.ts` call `materializeDueDuties` once at the top so listed tasks remain current even before the next cron tick. Idempotency on `(duty_id, duty_fire_at)` makes concurrent cron/read calls safe.

The user's timezone is read from the `user_preferences` table (`key = 'timezone'`); when absent it defaults to `UTC`. RRULE math runs on wall-clock parts in that timezone (not UTC), so DST transitions don't drift the anchor time.

Before selecting due duties, request-path materialization also converts pending legacy task-level recurrence rows into duties, but only after an explicit valid `user_preferences.timezone` row exists. That conversion is intentionally done in worker code instead of the SQL migration because D1 migrations do not have IANA timezone support; legacy due dates are normalized to valid `YYYY-MM-DD` values before `dateAtMidnightInTz` so the original local calendar day is preserved when possible and malformed old data falls back safely. Undated legacy recurrence rows are not converted into scheduled duties; their recurrence is cleared so they keep the old one-off completion behavior.

## Exported functions

**`computeNextFire(rrule, fromIso, tz)`** — Returns the next fire timestamp (UTC ISO) by adding one `INTERVAL` of the duty's `FREQ` to `fromIso` interpreted in `tz`. Supports only `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` plus an optional positive integer `INTERVAL`; unknown RRULE keys such as `BYDAY` are rejected instead of ignored. Monthly/yearly schedules avoid JavaScript date overflow: month-end anchors stay month-end, and non-month-end dates that do not exist in the target month skip forward to the next valid scheduled month. If a target wall-clock time disappears during a spring-forward DST transition, that fire is skipped so future recurrences keep the original local anchor instead of shifting earlier. Returns `null` for unsupported or malformed RRULEs (caller pauses the duty).

**`deriveDueDate(fireAtIso, offsetDays, tz)`** — Returns a `YYYY-MM-DD` string by converting `fireAtIso` to wall-clock in `tz` and adding `offsetDays`. Used to compute the materialized task's `due_date`.

**`isValidDateOnly(value)`** — Returns whether a string is an exact valid calendar date in `YYYY-MM-DD` form. Rejects overflow dates such as `2026-02-31` before `dateAtMidnightInTz` can normalize them.

**`dateAtMidnightInTz(yyyymmdd, tz)`** — Inverse of `deriveDueDate`: takes a valid date-only string and returns the UTC ISO timestamp at midnight on that date in `tz`. Used by `add_duty` / `update_duty` to translate a user-supplied `first_fire_date` into `next_fire_at`.

**`todayInTz(tz)`** — Returns today's `YYYY-MM-DD` in `tz`. Default for `first_fire_date` when callers omit it.

**`isValidTimezone(tz)`** — Returns whether a string is accepted by `Intl.DateTimeFormat` as an IANA timezone. Used by REST and MCP preference writers before saving `user_preferences.timezone`.

**`getUserTimezone(db)`** — Reads `timezone` from `user_preferences`; returns `'UTC'` when unset or invalid.

**`materializeDueDuties(db, nowIso, options?)`** — Main loop. Selects every active duty with `next_fire_at <= nowIso`. For each due fire up through `nowIso`, creates one task (skipped if a task with the same `duty_id + duty_fire_at` already exists) and advances `next_fire_at` via `computeNextFire` until the duty is no longer overdue. Logs a `duty_fired` action log entry per materialized task. Idempotent: safe to call from multiple read paths concurrently. Legacy task-level recurrence migration runs only when a valid timezone preference has been explicitly stored; pass `{ migrateLegacy: false }` from cron paths that should never perform that conversion.

## See Also

- [[schema|shared/schema.ts]] — `duties` and `tasks.duty_id` / `tasks.duty_fire_at` columns
- [[index|worker/src/index.ts]] — scheduled Worker handler that runs the hourly cron materializer
- [[db|worker/db.ts]] — duty CRUD methods (`addDuty`, `listDuties`, `updateDuty`, etc.)
- [[mcp|worker/mcp.ts]] — `add_duty`, `list_duties`, `update_duty`, `delete_duty` MCP tools
- [[api|worker/api.ts]] — `/api/duties` REST endpoints
