# Duty materialization (`worker/src/duties.ts`, `domain/duty.ts`, `domain/ops/duty.ts`, `scheduled.ts`)

A duty is a recurring series: `rrule` + `dtstart` + `timezone` define its calendar and never change after creation. Recurrence R1 added the engine that turns a due occurrence into a task; R2 added the commands that create and manage duties and the reads that show them.

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

## Commands and reads (R2)

Three standalone commands (`domain/dutyCommands.ts`; they cannot join a batch):

- `duty.create` with `values: { title, notes, kickoffNote, taskType, project, catchUp, schedule: { rrule, dtstart, timezone } }` and `expectedStructuralRevision`. The first occurrence at or after `dtstart` becomes `next_occurrence_at`; a schedule with no occurrence, an unsupported rule or an unknown zone is `invalid_input`. `dtstart` is the series anchor instant; `timezone` governs rule expansion. Loose intent defaults `timezone` to the workspace planning zone.
- `duty.content.set` edits the template (title, notes, kickoff, type, project, `catchUp`). It affects future instances only; generated tasks and the schedule are untouched. To change the schedule, end the duty and create a new one.
- `duty.status.set` moves between `active` and `paused`, or to `ended` (clears the next occurrence). `ended` is final and a same-status change is `invalid_transition`. Resuming does not backfill: the cursor and next occurrence are unchanged, so the catch-up mode decides what the next run creates.

`find({ entity: 'duty', filter: { status, project_id } })` omits ended duties unless asked and sorts by `created`. `get_context({ entity: 'duty', id })` returns the duty, its project and its 20 most recent instances. `describe_commands({ family: 'duty' })` lists the schemas. Migration 017 lets the legacy command feed carry duty rows; the client protocol is 6 because duty changes now reach the sync feed as action names.

## Adopting legacy recurring tasks (R3)

Completion-driven recurrence (`tasks.recurrence`) has one spawner per record: a pending task with a recurrence and no `duty_id` is on the legacy path (completing it creates the successor); once it has a duty it is on the calendar path and its recurrence is cleared. `adoptLegacyRecurrence` (`duties.ts`, called first by `materializeDueDuties`, so by the cron and every lazy read) moves records from the first to the second. It is idempotent and processes up to 50 tasks per run, each as its own atomic `duty.adopt_task` plan (the duty insert and the task update test the same predicate in one batch, so a task that changed after planning produces nothing).

- **Mapping.** The duty copies title, notes, kickoff note, type and project; `rrule` is the legacy rule; `dtstart` is the task's due date (the legacy noon-UTC convention); `timezone` is null; `catch_up` is `next`; id is `d_` plus the task id suffix. Instances of a duty with no timezone anchored at 12:00Z are all-day, like legacy successors.
- **On calendar.** When the due date is an occurrence of the rule, the task becomes the duty's current occurrence (`duty_id`, `occurrence_at`) and the cursor sits there.
- **Off calendar.** Otherwise the task stays a one-off (recurrence cleared, no duty) and the series starts at the first occurrence after it, where the legacy successor would have landed.
- **Not adopted.** Tasks with no due date, a timed due date, a rule the series parser rejects, or `COUNT` (its origin is lost) stay on the legacy completion path and are logged each run. Done tasks are ignored.
- **Behavior change to expect.** Legacy rules advanced from the previous due date when a task was completed. Calendar generation is independent of completion: an overdue adopted task stays open while the engine creates the newest due occurrence alongside it, and completing a task creates no successor.

Writing a recurrence through the legacy verbs (`add_task`/`update_task` with `recurrence`, `task.legacy-schedule.set`) still works; the next run adopts the task. New series should use `duty.create`.

## Not here yet

The `series_occurrences` ledger (skips, exceptions, templates versions), reminders and a PWA UI for duties (adopted tasks already sync as ordinary tasks with `duty_id`). See `docs/plans/power-user-todo.md` section 7.
