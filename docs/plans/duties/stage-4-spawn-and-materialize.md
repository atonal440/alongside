# Stage 4 — Spawn / Materialize Engine (and Backfill)

Part of `docs/plans/duties.md`. Prerequisites: Stages 1–3. Read
`00-recurrence-and-triggering.md` §2–§4 and §7 first — this stage implements that
algorithm, including the revised idempotency (three layers) and `catch_up: next`
(orphan) rules.

## Goal

Implement the duty plan builders in `worker/src/domain/ops/duty.ts` — chiefly
`materializeDutyPlan` — plus the DB-facing `materializeDueDuties` driver, the
catch-up policies, `next_occurrence_at` maintenance, series-exhaustion → `ended`,
and the idempotency guarantees. Run the **duty backfill** here (it needs
`dutyFromRow` from Stage 3), then **retire `completeTaskPlan`'s recurrence
branch**. Still no triggers or public surfaces (Stages 5–6) — exercised by tests.

## Context for a cold start

- Plan-builder style: `worker/src/domain/ops/task.ts` — `(...) => Result<Plan,
  AppError>`, returns `ops` + `assertions`. `completeTaskPlan` (`ops/task.ts:35`)
  is the current spawn site: its `recurrence.kind === 'recurring'` branch
  (`ops/task.ts:48-77`) builds the next task and carries `sessionLog ??
  kickoffNote` forward. **This branch is deleted here.**
- From Stage 2: `occurrencesBetween(parts, dtstart, timezone, after, through)`,
  `nextOccurrenceAfter(...)`, `isSeriesExhausted(...)` — all anchor-zone-aware.
- From Stage 3: `DutyDomain`, `duty.insert/update/update_cursor/delete`,
  `duty.exists`, monotonic `duty.update_cursor` in `apply`.
- `apply` batches a `Plan`; **`MAX_BATCH_STATEMENTS = 100`** (`apply.ts:99`) and
  guarded plans are not chunked across batches — so a plan must stay well under
  100 statements (drives the per-run cap below).
- Instance dedupe rides on `UNIQUE(duty_id, occurrence_at)` (Stage 1).

## Steps

### 1. Instance construction

`instanceFromTemplate(duty, occurrenceAt, mintId, priorSessionLog)` → `TaskRow`:

- `id: mintId()` (a `MintedTaskId`), `status: 'pending'`,
  `due_date: occurrenceAt`, `occurrence_at: occurrenceAt` (same UTC instant),
  `duty_id: duty.id`.
- Template fields from `duty.template`.
- `kickoff_note: priorSessionLog ?? duty.template.kickoffNote` — preserves the
  re-entry-ramp carry-forward `completeTaskPlan` gave (`00` §7). `priorSessionLog`
  is the `session_log` of the most recently completed instance of this duty, or
  `null`; the DB driver (Step 4) supplies it.
- `defer_kind: 'none'`, `defer_until: null`, `focused_until: null`,
  `recurrence: null` (instances aren't themselves recurring), `session_log: null`,
  timestamps = spawn time.

### 2. `materializeDutyPlan` (pure)

```ts
export interface MaterializeCtx {
  now: IsoDateTime;                          // current UTC instant = through-bound + spawn timestamp
  openInstanceIds: readonly TaskId[];        // pending instances of THIS duty (for the next-orphan rule)
  priorSessionLog: BoundedString<10_000> | null;
  mintTaskId: () => MintedTaskId;            // injected for deterministic tests
  maxPerRun: number;                         // cap on occurrences materialized this run (e.g. 50)
}

export function materializeDutyPlan(duty: DutyDomain, ctx: MaterializeCtx): TaskPlanResult;
```

Algorithm (from `00` §2–§4):

1. `duty.status !== 'active'` → `ok(emptyPlan())`.
2. `missed = occurrencesBetween(parts, dtstart, timezone, cursor, now)`, truncated
   to `ctx.maxPerRun` (keeps the plan under the batch cap; the remainder is picked
   up next run — safe because the cursor only advances past what we spawn).
3. **`missed` empty:**
   - `isSeriesExhausted(parts, dtstart, timezone, cursor)` → emit
     `duty.update { status: 'ended', next_occurrence_at: null, updated_at: now }`.
     (Because `isSeriesExhausted` treats a `null` cursor as "no occurrence at/after
     `dtstart`", a `COUNT=1`/future-`dtstart` duty is **not** ended here — its
     first occurrence is still pending.)
   - else `ok(emptyPlan())`.
4. **`spawnAt = applyCatchUp(duty.catchUp, missed, ctx.openInstanceIds)`:**
   - `all` → every instant in `missed` (already capped at `maxPerRun`).
   - `next` → the single latest instant `max(missed)`. **Orphan rule (`00` §3):**
     for each id in `openInstanceIds`, emit `task.update { id, duty_id: null,
     occurrence_at: null, updated_at: now }` (detach the stale instance to a plain
     task), then spawn one fresh instance at `max(missed)`. Always one *current*
     instance; older opens become orphans.
5. `ops += spawnAt.map(t => task.insert(instanceFromTemplate(duty, t, ctx.mintTaskId, ctx.priorSessionLog)))`.
6. `newCursor = max(missed)`; `nextOcc = nextOccurrenceAfter(parts, dtstart,
   timezone, newCursor)`.
7. `ops += duty.update_cursor { id, lastSpawnedAt: newCursor, nextOccurrenceAt:
   nextOcc, updatedAt: now }` (monotonic — `00` §4). If `nextOcc === null`, also
   emit `duty.update { status: 'ended' }`.
8. `ok({ ops, assertions: [duty.exists(duty.id)] })`.

Clock-free: everything from `ctx`. Note the cursor advances to `max(missed)` even
when `next` collapses many into one, so the next run doesn't re-see them.

### 3. Idempotent instance insert in `apply`

Make a `task.insert` whose row has a non-null `duty_id` tolerate the
`tasks_duty_occurrence` unique-constraint violation as a **benign no-op** (detect
that specific SQLite constraint error; treat the op as already-applied). One-off
tasks (`duty_id IS NULL`) are unaffected. Combined with the monotonic
`duty.update_cursor` (Stage 3), this is the full three-layer idempotency (`00`
§4). Test: apply the same materialize plan twice → exactly one instance and no
cursor regression.

### 4. `materializeDueDuties` (DB driver)

In `worker/src/db.ts` (or `worker/src/duties/materialize.ts`):

```ts
async materializeDueDuties(now: IsoDateTime): Promise<{ spawned: number; ended: number }>;
```

- **Cheap gate on `next_occurrence_at`, not the cursor:** `SELECT 1 FROM duties
  WHERE status='active' AND next_occurrence_at IS NOT NULL AND next_occurrence_at
  <= ?now LIMIT 1`. Empty → return zero (the common path). This is genuinely
  cheap and — unlike `last_spawned_at < now` — does not trip every read for a
  month (`00` §4).
- Otherwise load matching active duties **ordered by `next_occurrence_at` ascending**
  (most-overdue first, so nothing is starved under Stage 5's cap). For each:
  `dutyFromRow` (skip-and-log parse failures so one corrupt duty can't stall the
  batch); gather `openInstanceIds` (pending instances of this duty) and
  `priorSessionLog` (latest completed instance's `session_log`); build the plan
  with `maxPerRun`; `apply` it. Aggregate counts; isolate per-duty failures.

### 5. Duty backfill (moved here from Stage 1)

Now that `parseSeriesRrule` and `dutyFromRow` exist, migrate legacy recurring
tasks (`00`/master Migration Strategy). In one transaction, for each task with
`recurrence != NULL` (assert `due_date != NULL`): mint a duty (`timezone: null`,
`catch_up: 'next'`, `dtstart = due_date`, `last_spawned_at = due_date`,
`next_occurrence_at = nextOccurrenceAfter(...)`); **validate it through
`dutyFromRow` and abort the whole backfill if any row fails**; set the task's
`duty_id`/`occurrence_at`. Idempotent (skip tasks that already have a `duty_id`).
Run it before Step 6 so no recurring task is left un-migrated and no longer
self-spawning.

### 6. Retire completion-driven spawn

- Delete the recurrence branch in `completeTaskPlan` (`ops/task.ts:48-77`); it now
  only marks the task done. Remove the `nextTaskId` input and `nextOccurrence`
  import there.
- `DB.completeTask` (`db.ts:286`): drop the `nextTaskId` argument (`db.ts:296`) and
  the `next` return plumbing (`db.ts:304-311`); return `{ completed: Task }`. Note
  the shape change for Stage 6 to clean up callers in `api.ts`/`mcp.ts`.
- Test: completing a backfilled instance spawns nothing (the duty materializer
  does, by date).

### 7. Lifecycle plan builders (used by Stage 6)

- `createDutyPlan(input, ids, now)` → `duty.insert` with
  `next_occurrence_at =` first occurrence; materialize immediately if
  `dtstart <= now`.
- `updateDutyPlan(duty, patch)` → `duty.update` on **template fields, `catch_up`,
  and `timezone` only**. `rrule`/`dtstart` are **immutable** (reject an attempt);
  rescheduling is `end_duty` + `create_duty`. A `timezone` change recomputes
  `next_occurrence_at` (already-spawned instances are not moved).
- `setDutyStatusPlan(duty, next)` → guarded `duty.update` (active⇄paused,
  active/paused→ended; ended terminal). Pausing sets `next_occurrence_at = null`
  (gate skips it); resuming recomputes it from the cursor.
- `deleteDutyPlan(duty)` → orphan every instance (`task.update { duty_id: null,
  occurrence_at: null }`) then `duty.delete`. This is the decided behavior, not a
  Stage 6 open question.

### 8. Tests (`worker/test/`)

- `materializeDutyPlan`: brand-new duty (`cursor=null`) at `now=dtstart` spawns
  one; a week past a daily duty under `all` spawns 7 (or `maxPerRun`), under `next`
  spawns 1 at the latest + advances cursor; `next` with an existing open instance
  **orphans it** (duty_id+occurrence_at nulled) and spawns one fresh; a finite rule
  whose last occurrence ≤ now spawns the remainder then `status: 'ended'` +
  `next_occurrence_at: null`; **`COUNT=1` with `now < dtstart` does NOT end**;
  paused/ended spawn nothing; a zoned duty across a DST boundary keeps wall-clock
  time; `maxPerRun` caps a huge `all` catch-up and the next run continues.
- Idempotency: apply the same plan twice → one instance, cursor unchanged (no
  regression); a stale-cursor plan is a monotonic no-op.
- Carry-forward: a completed prior instance's `session_log` → new
  instance's `kickoff_note`.
- Backfill: mixed recurring/plain tasks → validated duties; a duty row that would
  fail `dutyFromRow` aborts the whole backfill; second run is a no-op.
- Regression: completing a recurring/legacy task spawns nothing now.
- `materializeDueDuties`: cheap gate short-circuits when nothing is due; a monthly
  duty spawned yesterday does **not** trip the gate today.

## Acceptance criteria

- `npm --prefix worker run typecheck` / `test` pass; engine + backfill suites green.
- `completeTaskPlan` no longer spawns; completion tests updated (`{ completed }`).
- Materialize is idempotent and the cursor never regresses; `catch_up: next`
  yields exactly one current instance; `COUNT=1` never ends prematurely.
- Nothing calls `materializeDueDuties` in production paths yet (Stage 5).
- Root `npm run verify` passes.
- Check off Stage 4 in the todo; note the `maxPerRun` value and the `completeTask`
  return-shape change for Stage 6.
