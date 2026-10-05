# Duty materialization (`worker/src/duties.ts`, `domain/duty.ts`, `domain/ops/duty.ts`, `scheduled.ts`)

A duty is a recurring series: `rrule` + `dtstart` + `timezone` define its calendar and never change after creation. This slice (recurrence R1) adds the engine that turns a due occurrence into a task. Creating, pausing and ending duties through commands, and reading them over MCP, are the next slice; until then duties can only exist through import/restore or direct inserts (tests).

## Flow

1. **Gate.** `materializeDueDuties(d1, at)` first runs one indexed read: is any active duty's `next_occurrence_at` at or before `at`? Usually not, and that is the whole cost. Any failure here is caught and reported in the summary so the lazy callers keep working.
2. **Load.** Otherwise it loads up to `DUTIES_PER_RUN` (200) due duties, most overdue first.
3. **Parse.** `dutyFromRow` turns a row into a `DutySeries` and checks it: the rule parses, `until` is not before `dtstart`, the cursor (`last_spawned_at`) is a real occurrence at or after `dtstart`, `next_occurrence_at` is exactly the occurrence after the cursor, and an `ended` duty has no next occurrence. A bad row is logged and skipped; it never blocks other duties and is never marked exhausted by accident.
4. **Plan.** `materializeDutyPlan` is pure. With `catch_up: 'next'` it creates one instance at the newest occurrence at or before now and jumps the cursor there; older open instances are left alone. With `'all'` it creates the backlog oldest first, at most `INSTANCES_PER_DUTY` (50) per run, so the cursor only passes what was created. A series with nothing left becomes `ended`.
5. **Apply.** One atomic plan: instance inserts first, then `duty.update_cursor`. Instance inserts only succeed while the duty is active and the cursor is behind that occurrence, and conflict on `(duty_id, occurrence_at)` as a no-op, so replays, concurrent triggers and stale plans cannot duplicate or regress anything.

An instance copies the duty's title, notes, task type and project; is due at the occurrence (a timed `due_date`, not all-day); starts with the duty's kickoff note, or the `session_log` of the latest completed instance (the re-entry ramp the legacy spawner carried forward); and carries `duty_id` and `occurrence_at`. Completing an instance never creates the next one: calendar generation is independent of completion.

## Triggers

All three call the same idempotent function; cadence is a latency knob, not a correctness one.

- **Cron.** `scheduled()` (`scheduled.ts`) runs every 15 minutes (`[triggers]` in `wrangler.toml`) and never throws. A rule finer than 15 minutes lags by up to one tick unless a client reads first.
- **Lazy reads.** `find`, `show_tasks`, `GET /api/tasks`, `GET /api/tasks/sync`, the sync snapshot and the first page of a sync delta call `db.materializeDueDuties()` first, so a client never sees a due occurrence missing. `get_context`, single-task reads, writes, delta continuation pages and export do not.
- **Direct.** `DB.materializeDueDuties(at?)` for callers and tests.

## Ops added

`duty.insert`, `duty.update` (with `ifStatus` so a stale transition is a successful no-op) and the `duty.exists` precheck join the existing `duty.update_cursor` and duty-bound `task.insert` guards in `storage/apply.ts`.

## Not here yet

Duty commands and MCP/REST reads, the `series_occurrences` ledger (skips, exceptions, templates versions), backfill of legacy completion-driven recurrence and its retirement (they ship together), reminders and the PWA UI. See `docs/plans/power-user-todo.md` section 7.
