# Stage 1 — Timestamp Model and Duties Schema

Part of `docs/plans/duties.md`. Prerequisite: none (first stage). Read the
master's Data Model and Migration Strategy, `01-type-system.md`'s ROW layer, and
`02-timestamp-model.md` first.

## Goal

Two schema changes that share one pass over `tasks`, so it is reshaped once:

- **Part A — Timestamp unification (app-wide, Decision 4).** Convert `due_date`
  from date-only to a UTC datetime (minute resolution), retire the `IsoDate`
  domain type in favor of `IsoDateTime`, and sweep the worker + PWA code that
  assumed date-only. Migrate existing values to **noon UTC** (all-day preservation
  — see A3).
- **Part B — Duties schema.** Add the `duties` table (including `timezone` and
  `next_occurrence_at`), the `tasks.duty_id` / `tasks.occurrence_at` columns,
  `action_log.duty_id`, and the `UNIQUE(duty_id, occurrence_at)` index.

**The duty backfill is NOT here.** It moves to Stage 4, where `parseSeriesRrule`
(Stage 2) and `dutyFromRow` (Stage 3) exist to validate every duty row it writes.
Stage 1 only lands DDL + the timestamp data migration; no duty rows are created,
and no `duty_id` is set on any task yet. Part A *does* change behavior (a due
"date" is now a due instant), so it carries its own tests.

## Context for a cold start

- `shared/schema.ts` is the source of truth for tables (`AGENTS.md`), exporting
  `$inferSelect` row types (`shared/schema.ts:61-64`).
- **Migrations are hand-written SQL**, not Drizzle-generated. `worker/drizzle.config.ts`
  says so explicitly: hand-numbered `worker/migrations/00N_*.sql` applied via
  `wrangler d1 migrations apply` are the source of truth; `db:generate` only
  produces an ALTER-preview in `./drizzle/` that you copy into a new migration.
  Existing migrations run `001_…` through `006_defer.sql`. This stage adds
  `007_*.sql` (and `008_*.sql` if you split A/B).
- Time brands today: `IsoDate` and `IsoDateTime` in `shared/parse/`. `due_date`
  is `IsoDate | null` in the domain (`worker/src/domain/task.ts` `dueDate`);
  `defer_until`/`focused_until`/`created_at`/`updated_at` are already datetime.
- The PWA documents a **two-time-vocabularies** hazard (date-only `today` vs
  datetime `nowIso`); Part A collapses that. Date-only touch points to sweep:
  `pwa/src/utils/design.ts` `formatDue`, the `taskSort` null-date sentinel
  (`9999-99-99`), `readinessScore`'s due-within-7d window, and the task edit form
  date input (`EditView.tsx`).
- IDs are minted `t_${nanoid(5)}` / `p_${nanoid(5)}` (`worker/src/db.ts:86-90`).

## Part A — Timestamp unification

### A1. Brands and domain

- Make `IsoDateTime` the one scheduling time type. Parse `due_date` as
  `IsoDateTime` (`worker/src/domain/task.ts` `dueDate: IsoDate | null` →
  `IsoDateTime | null`; the `nullableIsoDate` helper for `due_date` becomes
  `nullableIsoDateTime`). Remove `IsoDate` from `shared/wire/rows.ts`'s `due_date`.
- **Minute resolution — decided: truncate on write.** New scheduling-datetime
  writes are normalized to `:00`-seconds (`YYYY-MM-DDTHH:MM:00Z`). The parser
  accepts a full ISO instant and truncates seconds/millis rather than rejecting
  them, so no wire client breaks; storage is normalized. Audit timestamps
  (`created_at`/`updated_at`) keep full precision — do **not** route them through
  the minute-resolution parser (LWW ordering needs the sub-second detail).
- Retire `IsoDate` as a domain/storage type (keep it, if at all, only as a
  presentation-formatter input). Full removal of the brand is finalized in Stage 10.

### A2. Recurrence profile (hands off until Stage 2)

Leave `parseRrule` / `isDateOnlyProfile` (`shared/parse/recurrence.ts`) **intact**
in this stage — the backfill (Stage 4) reads legacy `task.recurrence` through
them, and Stage 2 adds `parseSeriesRrule` alongside. Removal of the date-only
profile is Stage 10, not here.

### A3. Data migration

- `tasks.due_date`: rewrite each non-null date-only value `"YYYY-MM-DD"` →
  `"YYYY-MM-DDT12:00:00Z"` (**noon UTC**, not midnight). A date-only value meant
  "this calendar day"; the PWA renders instants in the viewer's local zone, so
  midnight UTC would display a day early west of UTC. Noon UTC preserves the
  calendar date for all offsets UTC−12…+11 (`02-timestamp-model.md` "Migrated").
  Deterministic, lossy-forward; document it in the migration header.
- `defer_until`/`focused_until`: already datetime — no data change; new writes
  truncate to minute resolution.

### A4. Code sweep

- PWA: `formatDue` formats an instant (its date part, or a time when the instant
  isn't midnight) in the viewer's local zone; the `taskSort` null sentinel and
  `readinessScore` due window compare instants; the date-only `today` comparisons
  become instant comparisons against `nowIso`.
- Worker: any `IsoDate`-typed due-date handling in `api.ts`/`mcp.ts`/domain moves
  to `IsoDateTime`.
- Keep this mechanical and covered by the existing task tests — a representation
  change, not a logic change.

## Part B — Duties schema

### B1. `duties` table (`shared/schema.ts`)

```ts
export const duties = sqliteTable('duties', {
  id:                 text('id').primaryKey(),
  title:              text('title').notNull(),
  notes:              text('notes'),
  kickoff_note:       text('kickoff_note'),
  task_type:          text('task_type', { enum: ['action', 'plan'] }).notNull().default('action'),
  project_id:         text('project_id').references(() => projects.id),
  rrule:              text('rrule').notNull(),
  dtstart:            text('dtstart').notNull(),          // UTC datetime, minute resolution; immutable
  timezone:           text('timezone'),                   // optional IANA anchor zone; null = expand in UTC
  status:             text('status', { enum: ['active', 'paused', 'ended'] }).notNull().default('active'),
  catch_up:           text('catch_up', { enum: ['next', 'all'] }).notNull().default('next'),
  last_spawned_at:    text('last_spawned_at'),            // cursor; null = none yet
  next_occurrence_at: text('next_occurrence_at'),         // next un-spawned occurrence; drives the due-gate
  created_at:         text('created_at').notNull(),
  updated_at:         text('updated_at').notNull(),
});

export type Duty = typeof duties.$inferSelect;
```

Add an index on `next_occurrence_at` (partial/plain) so the Stage 5 due-gate
(`status='active' AND next_occurrence_at <= now`) is cheap.

### B2. Extend `tasks` (`shared/schema.ts`)

```ts
  duty_id:        text('duty_id').references(() => duties.id),
  occurrence_at:  text('occurrence_at'),   // UTC datetime; set together with duty_id, null together
```

`duties`-after-`tasks` forward reference is fine (Drizzle's `.references(() =>
duties.id)` resolves lazily); if declaration order bites at typecheck, move
`duties` above `tasks`.

### B3. `action_log.duty_id`

Add a nullable `duty_id: text('duty_id')` to the `action_log` table so Stage 6 can
log duty mutations. Today the table has only `task_id` (`shared/schema.ts:44-50`).

### B4. Unique index

```ts
export const tasks = sqliteTable('tasks', { /* … */ }, (t) => [
  uniqueIndex('tasks_duty_occurrence').on(t.duty_id, t.occurrence_at),
]);
```

SQLite treats `NULL`s as distinct, so all `duty_id IS NULL` rows are unconstrained
— verify with a test (B7).

### B5. `worker/schema.sql` + migration

- Mirror all of the above DDL in `worker/schema.sql` (the reference/local schema).
- Write a **hand-numbered** `worker/migrations/007_duties.sql` (and split into
  `007`/`008` if you keep Part A and Part B separate) with the `CREATE TABLE
  duties`, the `ALTER TABLE tasks ADD COLUMN …`, the `ALTER TABLE action_log ADD
  COLUMN duty_id`, the `due_date` datetime rewrite, and the indexes. Use
  `db:generate` only to preview the ALTERs, then copy them in. Do **not** point
  wrangler at Drizzle's `./drizzle/` output.

### B6. No backfill here

Explicitly leave `task.recurrence` untouched and create no duty rows. A note in
the migration header points to Stage 4 for the backfill.

### B7. Tests (`worker/test/`)

- **Part A:** a date-only `due_date` migrates to **noon UTC** and still renders as
  its original calendar date in a non-UTC (e.g. US Pacific) viewer zone; a post-migration
  write stores a minute-resolution instant (seconds truncated); the existing task
  suite (readiness, sort, `formatDue`) passes against datetime `due_date`.
- **Schema:** `duties`/`Duty` typecheck; `next_occurrence_at` index present.
- **Unique index:** duplicate `(duty_id, occurrence_at)` rejected; many
  `duty_id = NULL` rows all succeed (NULL-distinctness).

## Docs

Update the schema reference doc with the `duties` table, the new task/action_log
columns, and the datetime `due_date`. Flag for the Stage 6 doc pass that
`due_date` semantics changed. Do not touch `docs/mcp-tools.md`/`docs/api.md` yet.

## Acceptance criteria

- `npm --prefix worker run typecheck` passes; `Duty` exported; `IsoDate` no longer
  a scheduling type.
- `cd worker && wrangler deploy --dry-run` passes; the hand-written migration
  applies cleanly (`wrangler d1 migrations apply` locally).
- `npm --prefix worker run test` and `npm --prefix pwa run test` green.
- No duty rows are created and no `task.duty_id` is set in this stage.
- Root `npm run verify` passes.
- Check off Stage 1 (Parts A and B) in the implementation todo, noting the
  migration number used.
