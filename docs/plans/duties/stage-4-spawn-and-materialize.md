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
  priorSessionLog: BoundedString<10_000> | null;
  mintTaskId: () => MintedTaskId;            // injected for deterministic tests
  maxPerRun: number;                         // cap on task.inserts per run — applies to catch_up:'all' ONLY (e.g. 50)
}

export function materializeDutyPlan(duty: DutyDomain, ctx: MaterializeCtx): TaskPlanResult;
```

Algorithm (from `00` §2–§4):

1. `duty.status !== 'active'` → `ok(emptyPlan())`.
2. `latest = latestOccurrenceAtOrBefore(parts, dtstart, timezone, now)` — the last
   occurrence with instant `<= now` (Stage 2; backed by the rule's `.before(now,
   inclusive)`, so it is O(1)-ish and needs no enumeration). If `latest` is null or
   `latest <= cursor`, **nothing new is due:**
   - `isSeriesExhausted(parts, dtstart, timezone, cursor)` → emit
     `duty.update { status: 'ended', next_occurrence_at: null, updated_at: now }`.
     (`isSeriesExhausted` treats a `null` cursor as "no occurrence at/after
     `dtstart`", so a `COUNT=1`/future-`dtstart` duty is **not** ended here.)
   - else `ok(emptyPlan())`.
3. **Branch on `catch_up` (the per-run cap applies to `all` only):**
   - **`next`** → spawn exactly one at `latest` (the *true* latest due occurrence,
     never a cap boundary). **Orphan rule (`00` §3):** emit **one bulk op**
     `duty.orphan_open { id }` (a single `UPDATE tasks SET duty_id=NULL,
     occurrence_at=NULL WHERE duty_id=:id AND status='pending'`), **ordered before**
     the `task.insert` at `latest`. This detaches every stale open instance in one
     statement — *not* one `task.update` per instance, which could blow `apply`'s
     100-statement batch limit for a duty with many opens (e.g. switched from
     `all` to `next` with a backlog) and deadlock the plan on every run. Ordering
     orphan-before-insert means the fresh `latest` instance (created after) is not
     itself orphaned. `newCursor = latest`. Because the cursor only materializes
     when `latest > cursor`, every pre-existing pending instance is genuinely stale
     — safe to orphan wholesale. The `next` plan is thus a bounded ~3 statements
     regardless of how far behind the duty is.
   - **`all`** → `missed = occurrencesBetween(parts, dtstart, timezone, cursor,
     now)` **capped to the first `ctx.maxPerRun`** occurrences (keeps the plan under
     `apply`'s batch limit); one `task.insert` per occurrence. `newCursor =` the
     last spawned occurrence. If `missed` was truncated, the remainder is picked up
     next run (safe — the cursor only advances past what we spawned).
4. `nextOcc = nextOccurrenceAfter(parts, dtstart, timezone, newCursor)`.
5. `ops += duty.update_cursor { id, lastSpawnedAt: newCursor, nextOccurrenceAt:
   nextOcc, updatedAt: now }` (monotonic — `00` §4). If `nextOcc === null`, also
   emit `duty.update { status: 'ended' }`.
6. `ok({ ops, assertions: [duty.exists(duty.id)] })`.

Clock-free: everything from `ctx`. For `next`, `newCursor` is the true latest due
occurrence — so a duty 200 days behind spawns *today's* task and jumps the cursor
to today, rather than crawling forward `maxPerRun` at a time and repeatedly
orphaning a stale instance.

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
  batch); fetch `priorSessionLog` (latest completed instance's `session_log`);
  build the plan with `maxPerRun`; `apply` it. (No need to enumerate open instances
  — the `next` orphan is a single bulk `duty.orphan_open` op.) Aggregate counts;
  isolate per-duty failures.

### 5. Duty backfill (moved here from Stage 1)

Now that `parseSeriesRrule` and `dutyFromRow` exist, migrate legacy recurring
tasks (`00`/master Migration Strategy). In one transaction, for each task with
`recurrence != NULL` (assert `due_date != NULL`): mint a duty (`timezone: null`,
`catch_up: 'next'`, `dtstart = due_date`), then set the cursor **without assuming
`due_date` is an occurrence** of the anchored rule. This matters: today
`recurrenceFromRow` only requires that *some* `nextOccurrence(due_date)` exists —
a task due Monday with `FREQ=WEEKLY;BYDAY=FR` is valid but Monday is **not** an
occurrence of the anchored calendar. Seeding `last_spawned_at = due_date` on such a
row would fail the Stage 3 cursor-is-an-occurrence invariant and — because the
backfill is transactional and Step 6 removes completion spawning — abort the whole
upgrade for a perfectly valid legacy row. So:

- Compute `firstOcc = nextOccurrenceAfter(parts, dtstart, null, null)` (the first
  actual occurrence ≥ `dtstart`).
- **If `due_date` is an occurrence** (`firstOcc === due_date`): the legacy task *is*
  the anchor occurrence — `last_spawned_at = due_date`,
  `next_occurrence_at = nextOccurrenceAfter(..., due_date)`.
- **Else (`due_date` is off-calendar):** leave `last_spawned_at = null` (a null
  cursor is always valid) and `next_occurrence_at = firstOcc`. The legacy task
  keeps `occurrence_at = due_date` as an off-calendar current instance (there is no
  must-be-an-occurrence invariant on `occurrence_at`); the duty spawns `firstOcc`
  on schedule, and the unique index makes the `firstOcc === due_date` case a
  no-op if they ever coincide.

**Validate every minted duty through `dutyFromRow`; abort the whole backfill if any
row fails.** With the cursor seeded as above, no valid legacy row aborts. Set the
task's `duty_id`/`occurrence_at`. Idempotent (skip tasks that already have a
`duty_id`). Run it before Step 6.

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
  `next_occurrence_at = firstOcc`, where `firstOcc = nextOccurrenceAfter(parts,
  dtstart, timezone, null)` computes the rule's **first actual occurrence** (which
  may be after `dtstart` — e.g. a `BYDAY`/`BYMONTHDAY` filter the anchor instant
  doesn't match). Materialize immediately only if `firstOcc <= now` — **not**
  `dtstart <= now`, which would spawn early for such rules. If `firstOcc > now`,
  just insert the duty (it fires later via the gate).
- `updateDutyPlan(duty, patch)` → `duty.update` on **template fields and
  `catch_up` only**. The series anchor — `rrule`, `dtstart`, **and `timezone`** —
  is immutable (all three define the occurrence calendar; editing any would strand
  the cursor and break the Stage 3 invariant). Reject an attempt to change them;
  rescheduling (including changing the zone) is `end_duty` + `create_duty`.
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
  **orphans it** (duty_id+occurrence_at nulled) and spawns one fresh; **`next` with
  ~150 open instances** (e.g. after an `all`→`next` switch) produces a bounded plan
  (one bulk `duty.orphan_open` + insert + cursor, not 150 updates) that applies in
  one batch instead of deadlocking; a finite rule
  whose last occurrence ≤ now spawns the remainder then `status: 'ended'` +
  `next_occurrence_at: null`; **`COUNT=1` with `now < dtstart` does NOT end**;
  paused/ended spawn nothing; a zoned duty across a DST boundary keeps wall-clock
  time; a **`next` duty 200 days behind with `maxPerRun=50` spawns *today's* task
  and jumps the cursor to today** (the cap does not apply to `next`); `maxPerRun`
  caps a huge `all` catch-up and the next run continues.
- `createDutyPlan`: a rule whose **first occurrence is after `dtstart`** (e.g.
  `dtstart` on a Mon, `FREQ=WEEKLY;BYDAY=FR`) with `dtstart < now < firstOcc` does
  **not** spawn immediately (gate is `firstOcc <= now`, not `dtstart <= now`), and
  seeds `next_occurrence_at = firstOcc`; a future-`dtstart` duty inserts with a
  populated (future) `next_occurrence_at` and spawns nothing.
- Idempotency: apply the same plan twice → one instance, cursor unchanged (no
  regression); a stale-cursor plan is a monotonic no-op; an active not-yet-due
  duty keeps a populated `next_occurrence_at` (never nulled while merely not due).
- Carry-forward: a completed prior instance's `session_log` → new
  instance's `kickoff_note`.
- Backfill: mixed recurring/plain tasks → validated duties; a duty row that would
  fail `dutyFromRow` aborts the whole backfill; second run is a no-op. **An
  off-calendar legacy task** (due Monday under `FREQ=WEEKLY;BYDAY=FR`) migrates
  successfully — cursor `null`, `next_occurrence_at` = first Friday ≥ dtstart — and
  does **not** abort the backfill.
- Regression: completing a recurring/legacy task spawns nothing now.
- `materializeDueDuties`: cheap gate short-circuits when nothing is due; a monthly
  duty spawned yesterday does **not** trip the gate today.

## Acceptance criteria

- `npm --prefix worker run typecheck` / `test` pass; engine + backfill suites green.
- `completeTaskPlan` no longer spawns; completion tests updated (`{ completed }`).
- Materialize is idempotent and the cursor never regresses; `catch_up: next`
  yields exactly one current instance; `COUNT=1` never ends prematurely.
- Nothing calls `materializeDueDuties` in production paths yet (Stage 5).
- **Transition invariants — State B (`duties/03`):** because this stage retires
  completion-spawn while the backfill creates dormant duties, it **must not deploy
  without Stage 5's trigger** — a release with backfill + retirement but no trigger
  stalls recurrence (zero spawners), and one with backfill but *not* retirement
  double-spawns (two spawners). Stages 4 and 5 ship as one unit; the acceptance
  gate is "no deployable point where recurrence is served by neither or both."
- Root `npm run verify` passes.
- Check off Stage 4 in the todo; note the `maxPerRun` value and the `completeTask`
  return-shape change for Stage 6.
