# Stage 4 — Spawn and Materialize Engine

Part of `docs/plans/duties.md`. Prerequisites: Stages 1–3. Read
`00-recurrence-and-triggering.md` §2, §3, §4, §7 first — this stage implements
that algorithm.

## Goal

Implement the duty plan builders in `worker/src/domain/ops/duty.ts` — chiefly
`materializeDutyPlan` — plus the DB-facing `materializeDueDuties` driver, the
catch-up policies, series-exhaustion → `ended`, and the unique-index
idempotency. **Retire `completeTaskPlan`'s recurrence branch**: duties now own
spawning. Still no triggers or surfaces (Stages 5–6) — this stage is exercised
only by tests.

## Context for a cold start

- Plan-builder style: `worker/src/domain/ops/task.ts` — each builder is
  `(...) => Result<Plan, AppError>`, returns `ops` + `assertions`
  (`ops/task.ts:79`). `completeTaskPlan` (`ops/task.ts:35`) is the current spawn
  site: its `task.recurrence.kind === 'recurring'` branch (`ops/task.ts:48-77`)
  builds the next task row via `nextOccurrence` and carries `sessionLog ??
  kickoffNote` into the new `kickoff_note`. **This branch is deleted here.**
- The materialization primitives `occurrencesBetween` / `isSeriesExhausted` land
  in Stage 2; the `DutyDomain` union and `duty.*` ops in Stage 3.
- `apply` runs a `Plan` as one D1 batch (`worker/src/storage/apply.ts`).
- Instance idempotency rides on `UNIQUE(duty_id, occurrence_at)` (Stage 1).
- All times are UTC instants (Decision 4); the materializer takes a UTC `now`,
  never a zone-resolved `today` (`02-timestamp-model.md`).

## Steps

### 1. Instance construction

A helper `instanceFromTemplate(duty, occurrenceAt, ids, priorSessionLog)` →
`TaskRow`:

- `id: ids.taskId` (a `MintedTaskId`), `status: 'pending'`,
  `due_date: occurrenceAt`, `occurrence_at: occurrenceAt` (both the same UTC
  instant), `duty_id: duty.id`.
- Template fields from `duty.template` (title, notes, task_type, project_id).
- `kickoff_note: priorSessionLog ?? duty.template.kickoffNote` — preserves the
  "re-entry ramp carries the last session forward" behavior that
  `completeTaskPlan` gave (`00-recurrence-and-triggering.md` §7). `priorSessionLog`
  is the `session_log` of the most recently completed instance of this duty, or
  `null`; the DB driver (Step 4) supplies it.
- `defer_kind: 'none'`, `defer_until: null`, `focused_until: null`,
  `recurrence: null` (instances are not themselves recurring — the duty is),
  `session_log: null`, timestamps = spawn time.

### 2. `materializeDutyPlan` (pure)

```ts
export interface MaterializeCtx {
  now: IsoDateTime;               // current UTC instant = the through-bound AND the spawn timestamp
  openInstanceCount: number;      // pending, uncompleted instances of this duty (for `next` guard)
  priorSessionLog: BoundedString<10_000> | null;
  mintTaskId: () => MintedTaskId; // injected so tests are deterministic
}

export function materializeDutyPlan(duty: DutyDomain, ctx: MaterializeCtx): TaskPlanResult;
```

Algorithm (from `00` §2):

1. `duty.status !== 'active'` → `ok(emptyPlan())`.
2. `missed = occurrencesBetween(parts, dtstart, duty.series.cursor, ctx.now)`.
3. `missed` empty:
   - `isSeriesExhausted(parts, dtstart, cursor ?? dtstart)` →
     `ok({ ops: [duty.update { status: 'ended', updated_at: now }], assertions: [duty.exists] })`.
   - else `ok(emptyPlan())`.
4. `spawnAt = applyCatchUp(duty.series.catchUp, missed, ctx.openInstanceCount)`:
   - `all` → every instant in `missed`.
   - `next` → the single latest instant `max(missed)`, **and only if**
     `openInstanceCount === 0`; when an open instance already exists, spawn
     nothing new but still advance the cursor (the open instance stands in for
     the collapsed occurrences). This is the pile-up guard.
5. `ops = spawnAt.map(t => task.insert(instanceFromTemplate(duty, t, …)))`.
6. `newCursor = max(missed)` (advance past **all** missed, even if collapsed).
7. `ops += duty.update { last_spawned_at: newCursor, status:
   isSeriesExhausted(parts, dtstart, newCursor) ? 'ended' : duty.status,
   updated_at: now }`.
8. `ok({ ops, assertions: [duty.exists(duty.id)] })`.

Keep it clock-free: everything comes from `ctx`.

### 3. Idempotent instance insert in `apply`

The cursor guard makes double-spawn rare, but concurrent drivers can still race
before either batch commits. In `worker/src/storage/apply.ts`, make a
`task.insert` whose row has a non-null `duty_id` tolerate the
`tasks_duty_occurrence` unique-constraint violation as a **benign no-op**:
detect the specific SQLite constraint error and treat that op as already-applied
rather than failing the batch. One-off tasks (`duty_id IS NULL`) are unaffected.
Document this as the second idempotency layer (`00` §4). Add a focused test that
applies the same materialize plan twice and asserts exactly one instance.

### 4. `materializeDueDuties` (DB driver)

In `worker/src/db.ts` (or a new `worker/src/duties/materialize.ts`):

```ts
async materializeDueDuties(now: IsoDateTime): Promise<{ spawned: number; ended: number }>;
```

- Cheap gate first: `SELECT 1 FROM duties WHERE status='active' AND
  (last_spawned_at IS NULL OR last_spawned_at < ?now) LIMIT 1`. If empty,
  return zero immediately — this is the common path for lazy-read (`00` §5).
- Otherwise load the matching active duties (ordered by cursor staleness so the
  most-overdue go first — matters under Stage 5's per-tick cap). For each:
  parse with `dutyFromRow`; skip-and-log rows that fail to parse (don't let one
  corrupt duty stall the batch); compute `openInstanceCount` (a `COUNT(*)` of
  pending instances) and `priorSessionLog` (latest completed instance's
  `session_log`); build the plan; `apply` it.
- Aggregate spawned/ended counts. Wrap per-duty work so a single failure is
  isolated.

### 5. Retire completion-driven spawn

- Delete the recurrence branch in `completeTaskPlan` (`ops/task.ts:48-77`);
  `completeTaskPlan` now only marks the task done (its non-recurring path).
  Remove the `nextTaskId` input and the `nextOccurrence` import there.
- `DB.completeTask` (`worker/src/db.ts:286`): drop the
  `nextTaskId: … recurrence.kind === 'recurring' ? mintTaskId() : undefined`
  argument (`db.ts:296`) and the `next` return plumbing (`db.ts:304-311`). Its
  return type collapses to `{ completed: Task }`. Callers in `api.ts` / `mcp.ts`
  that read `.next` are updated in Stage 6; for now keep a `next?: undefined` on
  the type if that's less churn, and note it for Stage 6 to clean up.
- Any task that still has a non-null `recurrence` column (legacy, pre-Stage-10
  drop) is now inert — completing it spawns nothing. The duty created by the
  Stage 1 backfill is what recurs. Add a test proving completing a
  backfill-migrated instance does **not** spawn (the duty does, via materialize).

### 6. Plan builders for lifecycle (used by Stage 6 surfaces)

Also add the non-materialize builders here so Stage 6 is pure wiring:

- `createDutyPlan(input, ids)` → `duty.insert`. Optionally materialize the first
  occurrence immediately if `dtstart <= now` (so a duty created "starting now"
  spawns at once); otherwise just insert.
- `updateDutyPlan(duty, patch)` → `duty.update`. Guard: changing `rrule`/`dtstart`
  is a series edit — re-validate the new series and reset/clamp the cursor so it
  stays a valid occurrence (or `null` to re-anchor). Editing template fields does
  **not** retroactively rewrite already-spawned instances.
- `setDutyStatusPlan(duty, next)` → guarded `duty.update` (legal transitions from
  `01-type-system.md`: active⇄paused, active/paused→ended; ended terminal).
- `deleteDutyPlan(duty)` → orphan the instances (null their `duty_id`) and
  `duty.delete`. Final orphan-vs-cascade call is Stage 6, but implement orphan
  here as the default and expose the option.

### 7. Tests (`worker/test/`)

- `materializeDutyPlan`: brand-new duty (`cursor=null`) at `now=dtstart` spawns
  one; `now` a week past a daily duty under `all` spawns 7, under `next` spawns
  1 at the latest instant and advances cursor to the latest; `next` with
  `openInstanceCount=1` spawns 0 but still advances cursor; a finite rule whose
  last occurrence is ≤ now spawns the remainder then flips `status: 'ended'`;
  paused/ended duties spawn nothing; a sub-day rule spawns intra-day occurrences.
- Idempotency: apply the same plan twice → one instance (unique-index no-op).
- Carry-forward: a completed prior instance's `session_log` becomes the new
  instance's `kickoff_note`.
- Regression: completing a recurring (legacy) task spawns nothing now.
- `materializeDueDuties` against the D1 pool: seed mixed duties, run, assert
  counts and that the cheap gate short-circuits when nothing is due.

## Acceptance criteria

- `npm --prefix worker run typecheck` / `test` pass; the engine suite is green.
- `completeTaskPlan` no longer spawns; existing completion tests updated to match
  (a recurring completion returns only `{ completed }`).
- Materialize is idempotent under repeat application.
- Nothing calls `materializeDueDuties` in production paths yet (Stage 5 wires it).
- Root `npm run verify` passes.
- Check off Stage 4 in the implementation todo; note the `completeTask` return
  shape change for Stage 6.
