# Stage 4 — Spawn / Materialize Engine (and Backfill)

Part of `docs/plans/duties.md`. Prerequisites: Stages 1–3. Read
`00-recurrence-and-triggering.md` §2–§4 and §7 first — this stage implements that
algorithm, including the revised idempotency (three layers) and `catch_up: next`
(orphan) rules.

> **Canonical invariants & matrix:** `04-invariants-and-contracts.md` §3 (INV-A…L)
> and §6 (operations × invariants) are authoritative — the materializer must
> satisfy every ✓ cell for `create_duty` and the three `materialize` rows. If this
> doc disagrees with `04`, `04` wins.

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
     `duty.orphan_stale { id, before: latest }` — a single `UPDATE … WHERE
     duty_id=:id AND status='pending' AND occurrence_at < :latest` — then the
     `task.insert` at `latest`. This detaches every stale open instance in one
     statement (not one `task.update` each, which could blow `apply`'s 100-statement
     limit for a big backlog and deadlock). The `occurrence_at < latest` bound is
     load-bearing: it **excludes the current occurrence**, so a *stale replay* that
     runs after a concurrent driver already inserted the `latest` instance cannot
     detach that valid current task (which would leave a duplicate/orphan). The
     replay's orphan then matches nothing new and its insert hits the unique index
     → benign no-op. `newCursor = latest`. Bounded ~3 statements however far behind.
   - **`all`** → `missed = occurrencesBetween(parts, dtstart, timezone, cursor,
     now, /*limit*/ ctx.maxPerRun)` — **pass `maxPerRun` as the expansion limit**,
     don't expand-all-then-slice. A minutely duty months behind has millions of
     occurrences; `occurrencesBetween` would hit its ~10 000 runaway cap and
     throw/log, failing *every* materialization even though we only want 50. With
     the limit it stops at `maxPerRun`. One `task.insert` per returned occurrence;
     `newCursor =` the last spawned; the remainder is picked up next run (safe —
     the cursor only advances past what we spawned).
4. `nextOcc = nextOccurrenceAfter(parts, dtstart, timezone, newCursor)`.
5. `ops += duty.update_cursor { id, lastSpawnedAt: newCursor, nextOccurrenceAt:
   nextOcc, updatedAt: now }` (monotonic — `00` §4). If `nextOcc === null`, also
   emit `duty.update { status: 'ended' }`.
6. `ok({ ops, assertions: [duty.exists(duty.id)] })`.

**Guard the plan on live status (INV-L).** `duty.exists` is *not* sufficient: a
`pause_duty`/`end_duty` can commit between the moment this plan was built (against
an `active` row) and the moment it applies. A stale plan would then spawn an
instance for a stopped duty, and its `duty.update_cursor` could write a non-null
`next_occurrence_at` onto an `ended` row (violating INV-D). So **every write the
materializer emits** — the instance `task.insert`, `duty.orphan_stale`,
`duty.update_cursor`, and the exhaustion/ended `duty.update` — must be
**conditional on `status='active'`** at apply time, via predicates on the write
statements themselves (silent no-op = success; the batch-aborting precheck trick
is the wrong semantics here). Mechanism per op (`04` §5): `duty.update_cursor`
and `duty.orphan_stale` carry the status condition unconditionally (Stage 3
executor); the exhaustion `duty.update` ops in Steps 2 and 5 set
`ifStatus: 'active'`; and the duty-instance `task.insert` is emitted as
`INSERT INTO tasks (…) SELECT … WHERE EXISTS (SELECT 1 FROM duties WHERE
id = :duty_id AND status = 'active')` — extend the same `apply` special case that
Step 3 adds for the benign unique-conflict (both key off the row's non-null
`duty_id`). A no-op under this guard is success (the duty was stopped).

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
  — the `next` orphan is a single bulk `duty.orphan_stale` op.) Aggregate counts;
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

### 5b. Export / import + wipe (moved here from Stage 6)

Because the backfill above creates active duties, the export/import pipeline must
handle duties **from this stage** — not Stage 6. Otherwise, in the State-C window
after the cut-over, a backup export silently drops every recurring schedule and an
import wipe FK-fails or leaves stale/colliding duty rows (`03` State C). Extend
(`worker/src/db.ts` `exportAll`, `worker/src/wire/importPayload.ts`):

- Add `duties: v.array(DutyRowSchema)` to `ExportPayload` and `ImportV1Schema`;
  include duties in `exportAll`. (`DutyRowSchema` exists from Stage 3.)
- **Extend the `wipe` op to delete `duties`**, in FK order: `task_links →
  action_log → tasks → duties → projects → user_preferences` (duties after the
  tables that reference them, before the projects they reference).
- **Restore order** in `planImport`: `projects → duties → tasks → …` (duties before
  tasks since `tasks.duty_id`→duties; after projects since `duties.project_id`→
  projects); validate each duty via `dutyFromRow`; keep the pre-wipe integrity check.
- A legacy (duty-less) v1 payload imports as "no duties," which is correct.
- Tests: round-trip preserves duties + instances' `duty_id`/`occurrence_at`; import
  **over a DB that already has duties** wipes them (no FK failure, no id collision);
  a legacy payload still imports.

### 6. Retire completion-driven spawn

- Delete the recurrence branch in `completeTaskPlan` (`ops/task.ts:48-77`); it now
  only marks the task done. Remove the `nextTaskId` input and `nextOccurrence`
  import there.
- `DB.completeTask` (`db.ts:286`): drop the `nextTaskId` argument (`db.ts:296`) and
  the `next` return plumbing (`db.ts:304-311`); return `{ completed: Task }`.
  **Update the existing readers in this same stage or the worker won't typecheck:**
  the MCP `complete_task` handler reads `result.next` (`worker/src/mcp.ts:459`) and
  the REST complete handler passes the result through — strip their `next` usage
  now (minimal mechanical change), and leave the outward response-shape/docs
  cleanup to Stage 6 §5.
- Test: completing a backfilled instance spawns nothing (the duty materializer
  does, by date).

### 7. Lifecycle plan builders (used by Stage 6)

- `createDutyPlan(input, ids, now)` → `duty.insert` with
  `next_occurrence_at = firstOcc`, where `firstOcc = nextOccurrenceAfter(parts,
  dtstart, timezone, null)` computes the rule's **first actual occurrence** (which
  may be after `dtstart` — e.g. a `BYDAY`/`BYMONTHDAY` filter the anchor instant
  doesn't match). **Reject an empty series here:** if `firstOcc` is `null` (the
  rule yields no occurrence at/after `dtstart` — e.g. `UNTIL` before the first
  match), return a `validation` error ("recurrence produces no occurrences from
  its start"). This is the anchor-aware non-empty check that `parseSeriesRrule`
  can't do (Stage 2) — it lives here because it needs `dtstart`. Otherwise:
  materialize immediately only if `firstOcc <= now` — **not** `dtstart <= now`,
  which would spawn early for filtered rules. If `firstOcc > now`, just insert the
  duty (it fires later via the gate).
- `updateDutyPlan(duty, patch)` → `duty.update` on **template fields and
  `catch_up` only**. The series anchor — `rrule`, `dtstart`, **and `timezone`** —
  is immutable (all three define the occurrence calendar; editing any would strand
  the cursor and break the Stage 3 invariant). Reject an attempt to change them;
  rescheduling (including changing the zone) is `end_duty` + `create_duty`.
- `setDutyStatusPlan(duty, next)` → guarded `duty.update` (active⇄paused,
  active/paused→ended; ended terminal). Pausing sets `next_occurrence_at = null`
  (gate skips it); resuming recomputes it from the cursor.
- `deleteDutyPlan(duty)` → `duty.orphan_all { id }` (one bulk `UPDATE` detaching
  **every** instance — pending *and* completed, so no `duty_id` FK dangles after
  the delete) then `duty.delete`. Two statements regardless of instance count; the
  pure planner needs no DB read of the instance list. Decided behavior, not a
  Stage 6 open question.

### 8. Tests (`worker/test/`)

- `materializeDutyPlan`: brand-new duty (`cursor=null`) at `now=dtstart` spawns
  one; a week past a daily duty under `all` spawns 7 (or `maxPerRun`), under `next`
  spawns 1 at the latest + advances cursor; `next` with an existing open instance
  **orphans it** (duty_id+occurrence_at nulled) and spawns one fresh; **`next` with
  ~150 open instances** (e.g. after an `all`→`next` switch) produces a bounded plan
  (one bulk `duty.orphan_stale` + insert + cursor, not 150 updates) that applies in
  one batch instead of deadlocking; **a stale `next` replay after a concurrent run
  already inserted `latest` does NOT orphan that current instance** (the
  `occurrence_at < latest` bound excludes it) and produces no duplicate; a finite rule
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
  populated (future) `next_occurrence_at` and spawns nothing; **an empty series**
  (`FREQ=WEEKLY;BYDAY=FR;UNTIL=<a Thursday ≥ dtstart>`, `firstOcc = null`) is
  **rejected** at create.
- Lifecycle: `end_duty` (`setDutyStatusPlan`) on an **infinite, never-exhausted**
  duty writes a row that **passes `dutyFromRow`** (`ended` requires only
  `next_occurrence_at IS NULL`, not exhaustion) — so reschedule-by-`end_duty` +
  `create_duty` works for the common case; `end_duty` on a brand-new (null-cursor)
  duty is also valid. `deleteDutyPlan` on a duty with **both pending and completed**
  instances orphans **all** of them (`duty.orphan_all`) so no `duty_id` FK dangles,
  in a bounded 2-statement plan.
- Idempotency: apply the same plan twice → one instance, cursor unchanged (no
  regression); a stale-cursor plan is a monotonic no-op; an active not-yet-due
  duty keeps a populated `next_occurrence_at` (never nulled while merely not due).
- INV-L: a materialize plan built against an `active` duty, applied **after** the
  duty was paused/ended, is a complete no-op — no instance inserted, no cursor or
  `next_occurrence_at` write, no orphaning, no status write.
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
