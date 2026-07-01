# Stage 1 — Timestamp Model, Duties Schema, and Migration

Part of `docs/plans/duties.md`. Prerequisite: none (first stage). Read the
master's Data Model and Migration Strategy, `01-type-system.md`'s ROW layer, and
`02-timestamp-model.md` first.

## Goal

Two migrations that share one pass over the `tasks` table, so it is reshaped
once, not twice:

- **Part A — Timestamp unification (app-wide, Decision 4).** Convert `due_date`
  from date-only to a UTC datetime (minute resolution), retire the `IsoDate`
  domain type in favor of `IsoDateTime`, and sweep the existing worker + PWA code
  that assumed date-only. Migrate existing values to midnight UTC.
- **Part B — Duties schema.** Add the `duties` table, the `tasks.duty_id` /
  `tasks.occurrence_at` columns, and the `UNIQUE(duty_id, occurrence_at)` index;
  backfill existing recurring tasks into duties.

**No duties behavior yet** — the engine, triggers, and surfaces come later
against this schema. Part A *does* change behavior (a due "date" is now a due
instant), so it carries its own tests.

## Context for a cold start

- `shared/schema.ts` is the source of truth for tables (`AGENTS.md`), exporting
  `$inferSelect` row types (`shared/schema.ts:61-64`). `worker/schema.sql` is the
  reference/local schema; `worker/drizzle.config.ts` generates migrations.
  `wrangler deploy --dry-run` is required for schema changes.
- Time brands today: `IsoDate` and `IsoDateTime` in `shared/parse/`. `due_date`
  is `IsoDate | null` in the domain (`worker/src/domain/task.ts` `dueDate`);
  `defer_until` / `focused_until` / `created_at` / `updated_at` are already
  datetime.
- The PWA already documents a **two-time-vocabularies** hazard (date-only `today`
  vs datetime `nowIso`) in its test-harness notes; Part A collapses that to one.
  Existing date-only touch points to sweep: `pwa/src/utils/design.ts` `formatDue`,
  the `taskSort` null-date sentinel (`9999-99-99`), and `readinessScore`'s
  due-within-7d window; the task edit form's date input (`EditView.tsx`).
- IDs are minted `t_${nanoid(5)}` / `p_${nanoid(5)}` (`worker/src/db.ts:86-90`).
  Duty ids are `d_${nanoid(5)}`.
- `taskFromRow` (`worker/src/domain/task.ts:197`) guarantees any task with
  `recurrence != null` also has `due_date != null`.

## Part A — Timestamp unification

### A1. Brands and domain

- Make `IsoDateTime` the one scheduling time type. Where `due_date` was parsed as
  `IsoDate`, parse it as `IsoDateTime` (`worker/src/domain/task.ts` `dueDate:
  IsoDate | null` → `IsoDateTime | null`; the `nullableIsoDate` helper for
  `due_date` becomes `nullableIsoDateTime`).
- Tighten the scheduling-datetime parser to **minute resolution**: accept a UTC
  ISO instant and truncate/reject seconds per `02-timestamp-model.md` (decide
  truncate-on-write vs reject-with-seconds; truncate is friendlier). Audit
  timestamps keep full precision — do not route `created_at`/`updated_at` through
  the minute-resolution parser.
- Retire `IsoDate` as a domain/storage type. Keep it, if at all, only as an input
  to a presentation formatter. Remove `IsoDate` from row schemas
  (`shared/wire/rows.ts` `due_date`) and replace with the datetime schema.

### A2. Recurrence profile (coordinate with Stage 2)

The legacy date-only RRULE profile (`isDateOnlyProfile` and helpers in
`shared/parse/recurrence.ts`) is on its way out. In Part A, do the minimum: stop
requiring date-only for the *task* `recurrence` column that the backfill reads,
or simply leave `parseRrule` intact and let Stage 2's `parseSeriesRrule`
supersede it — whichever keeps the backfill (Part B) parsing legacy rules. Full
removal of the date-only profile lands in Stage 2/Stage 10; don't front-load it
here.

### A3. Data migration

- `tasks.due_date`: rewrite each non-null date-only value `"YYYY-MM-DD"` →
  `"YYYY-MM-DDT00:00:00Z"`. Deterministic, lossy-forward; document it in the
  migration header.
- `defer_until` / `focused_until`: already datetime — no data change, but ensure
  new writes truncate to minute resolution.

### A4. Code sweep

- PWA: `formatDue` formats an instant (its date part, or a time when the instant
  isn't midnight) in the viewer's local zone; the `taskSort` null sentinel and
  `readinessScore` due window compare instants. Reconcile these with the
  one-vocabulary model — the date-only `today` comparisons become instant
  comparisons against `nowIso`.
- Worker: any `IsoDate`-typed due-date handling in `api.ts` / `mcp.ts` / domain
  moves to `IsoDateTime`.
- Keep the changes mechanical and covered by the existing task tests; this is a
  representation change, not a logic change.

## Part B — Duties schema

### B1. `duties` table (`shared/schema.ts`)

```ts
export const duties = sqliteTable('duties', {
  id:              text('id').primaryKey(),
  title:           text('title').notNull(),
  notes:           text('notes'),
  kickoff_note:    text('kickoff_note'),
  task_type:       text('task_type', { enum: ['action', 'plan'] }).notNull().default('action'),
  project_id:      text('project_id').references(() => projects.id),
  rrule:           text('rrule').notNull(),
  dtstart:         text('dtstart').notNull(),          // UTC datetime, minute resolution
  status:          text('status', { enum: ['active', 'paused', 'ended'] }).notNull().default('active'),
  catch_up:        text('catch_up', { enum: ['next', 'all'] }).notNull().default('next'),
  last_spawned_at: text('last_spawned_at'),            // UTC datetime; null = none yet
  created_at:      text('created_at').notNull(),
  updated_at:      text('updated_at').notNull(),
});

export type Duty = typeof duties.$inferSelect;
```

### B2. Extend `tasks` (`shared/schema.ts`)

```ts
  duty_id:        text('duty_id').references(() => duties.id),
  occurrence_at:  text('occurrence_at'),   // UTC datetime
```

Both nullable; `duty_id` is `NULL` for every one-off task. The `duties`-after-
`tasks` forward reference is fine (Drizzle's `.references(() => duties.id)` arrow
resolves lazily); if declaration order bites at typecheck, move `duties` above
`tasks`.

### B3. Unique index

```ts
export const tasks = sqliteTable('tasks', { /* …columns… */ }, (t) => [
  uniqueIndex('tasks_duty_occurrence').on(t.duty_id, t.occurrence_at),
]);
```

SQLite treats `NULL`s as distinct, so all `duty_id IS NULL` rows are
unconstrained — verify with a test (B6).

### B4. `worker/schema.sql`

Mirror the `duties` DDL, the two new `tasks` columns, and
`CREATE UNIQUE INDEX IF NOT EXISTS tasks_duty_occurrence ON tasks(duty_id, occurrence_at);`.

### B5. Migration + backfill

Generate the Drizzle migration for the additive DDL, then the backfill (runs
*after* Part A, so `task.due_date` is already an instant):

```
for each task where recurrence IS NOT NULL:
  assert due_date IS NOT NULL            -- taskFromRow invariant; abort if violated
  d := new duty {
    id: 'd_' || <nanoid>,
    title, notes, kickoff_note, task_type, project_id := <copied from task>,
    rrule:           task.recurrence,
    dtstart:         task.due_date,       -- now a datetime (midnight UTC after Part A)
    status:          'active',
    catch_up:        'next',
    last_spawned_at: task.due_date,       -- this task is the occurrence at dtstart
    created_at:      task.created_at,
    updated_at:      <now>,
  }
  insert d
  update task set duty_id = d.id, occurrence_at = task.due_date
```

Legacy `task.recurrence` values are infinite rules — a subset of `SeriesRrule` —
so they parse unchanged under Stage 2. Leave `task.recurrence` populated; Stage
10 drops the column. Implement the backfill idempotently (re-running skips tasks
that already have a `duty_id`); run it via the same mechanism prior data
migrations in this repo used, documented in the migration header.

### B6. Tests (`worker/test/`)

- **Part A:** a date-only `due_date` row migrates to midnight UTC; a task created
  post-migration stores a minute-resolution instant; the existing task suite
  (readiness, sort, formatDue) passes against datetime `due_date`.
- **Backfill:** seed a recurring + a plain task; assert one duty with the right
  template/anchor, the recurring task gains `duty_id` + `occurrence_at`, the plain
  task untouched, second run is a no-op.
- **Unique index:** duplicate `(duty_id, occurrence_at)` rejected; many
  `duty_id = NULL` rows all succeed (NULL-distinctness).
- **Backfill abort:** a recurring task with `due_date = NULL` (raw insert) makes
  the backfill throw.

## Docs

Update the schema reference doc with the `duties` table and new task columns, and
note in `02-timestamp-model.md`'s spirit that `due_date` is now a datetime. Do
not touch `docs/mcp-tools.md` / `docs/api.md` yet — no surface exposes duties
here (but flag that `due_date` semantics changed for the Stage 6 doc pass).

## Acceptance criteria

- `npm --prefix worker run typecheck` passes; `Duty` exported; `IsoDate` no longer
  a scheduling type.
- `cd worker && wrangler deploy --dry-run` passes (schema + migration bundle).
- `npm --prefix worker run test` and `npm --prefix pwa run test` green, including
  the Part A representation-change tests and the Part B schema/backfill tests.
- Backfill is idempotent and lossless; a fresh DB with no recurring tasks is a
  no-op for Part B.
- Root `npm run verify` passes.
- Check off Stage 1 (Parts A and B) in `docs/plans/duties-implementation-todo.md`
  with notes on how the migrations were run.
