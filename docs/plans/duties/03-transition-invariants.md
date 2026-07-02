# Foundation 03 — Transition Invariants (Rollout Safety)

Part of `docs/plans/duties.md`. Read after `00`–`02`.

The duties work lands as ~10 stages, each a separable commit/deploy. That
separation is what makes the stages executable as cold-start work orders — but it
also means the system spends real time in **partially-migrated states** where the
old world (date-only `due_date`, `tasks.recurrence`, completion-driven spawn) and
the new world (datetime instants, `duties`, the materializer) **coexist**. Almost
every subtle bug found reviewing this plan lived in one of those windows: a reader
hitting the wrong time representation, recurrence silently stopping, the PWA
choking on a row shape it doesn't know yet.

This document is the **acceptance checklist for those windows**. When you finish a
stage, before you merge/deploy it, verify the invariants for the resulting state
below. If a stage would violate one, the stage is not done — fix it or adjust the
deploy grouping. Treat these the way you treat the per-stage tests: a gate, not a
suggestion.

## Cross-cutting invariants (must hold in *every* intermediate state)

- **I1 — Recurrence never silently stops.** From Stage 1 through Stage 10, a
  recurring obligation always keeps producing its next occurrence. There is never
  a deployed state where a recurring task/duty simply stops recurring.
- **I2 — Exactly one spawner is live.** At any moment, recurrence is driven by
  *either* legacy completion-spawn (`completeTaskPlan`) *or* the duty materializer
  — never **zero** (I1 violation: recurrence stalls) and never **both** (a
  completion and a materialize would each create a next task → duplicates). This is
  the tightest constraint; it dictates the Stage 4/5 cut-over (State B).
- **I3 — No row is read under the wrong time representation.** Once `due_date` is a
  datetime (Stage 1 A3), *every* reader treats it as such — including the surviving
  legacy recurrence path, via the Stage 1 A2 shim. No code path parses a migrated
  `due_date` as date-only (which would throw on the `IsoDate` assertion).
- **I4 — Client/server field contracts stay compatible in *both* directions.**
  (a) *Worker → PWA:* a field the worker starts emitting (datetime `due_date`,
  `duty_id`, `occurrence_at`, duty rows) must be *accepted* by the PWA's response
  parser no later than the deploy that emits it. (b) *PWA → worker:* the worker
  must **not start rejecting** a field the deployed PWA still *sends* — notably
  `recurrence` on task writes: the pre-Stage-8 `EditView` still sends it, and
  **queued offline pending ops carrying it would become durable 4xx failures and be
  dropped**. Neither side may tighten a contract ahead of the other loosening its
  use of it; when in doubt, tolerate on the receiver and remove the sender first.
  (This bidirectionality is the correction to an earlier one-way framing.)
- **I5 — The backfill is atomic and idempotent; a half-migrated table is never a
  resting state.** `tasks` is never left with some recurring rows carrying a
  `duty_id` and others not. The backfill either completes or rolls back (Stage 4).
- **I6 — Whole-DB paths learn a new table in the same deploy that first populates
  it.** Any path that operates on the whole database (export, import, wipe, bulk
  delete) is taught about `duties` in the deploy that creates duty rows — the
  Stage 4/5 cut-over — never in a later surface stage. (Generalized from the
  State C export/import finding below.)

## The rollout timeline, state by state

| State | After / before | What coexists | Sharpest risk |
|---|---|---|---|
| **A** | after Stage 1, before Stage 4 | datetime `due_date`; empty `duties` table; legacy spawn still live (via A2 shim) | I3 — legacy path reading datetime `due_date` |
| **B** | the Stage 4 ↔ 5 cut-over | backfill + retire-completion-spawn + wire-trigger | **I2 — must be one atomic deploy (see below)** |
| **C** | after Stage 5, before Stage 6 | duties spawn server-side; no public duty CRUD; PWA duty-unaware | duties fire but can't yet be created/edited (acceptable) |
| **D** | after Stage 6, before Stage 7/8 | worker emits `duty_id`/`occurrence_at` + duty rows; PWA pre-duty | I4 — PWA must tolerate the new fields |
| **E** | after Stage 8 | full Phase 1 | — (Phase 1 complete) |
| **F** | after Stage 10 | legacy `recurrence` column dropped | Stage 10's explicit rollout criterion |

### State A checks (after Stage 1)
- A recurring task still **loads** (no `IsoDate` throw in `recurrenceFromRow`) and
  still **completes and spawns its next occurrence** — verified through the A2
  shim, spawning at noon UTC. (I1, I3)
- The `duties` table exists and is **empty**; no task has a non-null `duty_id`. (I5)
- App behavior is otherwise unchanged from before the migration.

### State B — the atomic cut-over (Stages 4 + 5)
This is the invariant the transition exercise surfaced, and the one most likely to
be missed because Stages 4 and 5 *look* independent. They are separable for
**implementation and review**, but they must land in **one deploy**, because of
I2. Walking the three ingredients — backfill (B-fill), retire-completion-spawn
(B-cut), wire-trigger (B-trig):

- **B-fill without B-cut** (duties created, but completion-spawn still live):
  completing a backfilled task spawns a *legacy plain task* for the next date, and
  once B-trig lands the duty *also* materializes that date → **duplicate future
  tasks**. (I2: two spawners.)
- **B-cut without B-trig** (completion-spawn removed, trigger not wired): nothing
  spawns at all → **recurrence stalls**. (I1/I2: zero spawners.)
- Therefore B-fill, B-cut, B-trig ship **together**. Concretely: deploy Stage 4 and
  Stage 5 as one unit, or move the completion-spawn retirement out of Stage 4 into
  the Stage 5 cut-over so no single deploy ever has zero or two spawners. Either
  way, **the acceptance check is: there is no deployable point at which recurrence
  is served by neither or both mechanisms.**

Checks after the cut-over:
- Every former recurring task now has a `duty_id`; `SELECT count(*) FROM tasks
  WHERE recurrence IS NOT NULL AND duty_id IS NULL` = 0. (I5)
- Completing a duty instance spawns nothing itself; the *materializer* produces the
  next instance on schedule (cron or lazy read). (I2)
- No date has both a legacy plain task and a duty instance for the same duty. (I2)

### State C checks (after Stage 5)
- Backfilled duties keep firing (cron + lazy read). (I1)
- There is no public way to create/edit a duty yet — acceptable; nothing regresses.
- The PWA still works: it receives datetime `due_date` and (null or populated)
  `duty_id`/`occurrence_at` — so **I4 already applies here** if the worker includes
  those fields in task payloads. Ensure the PWA task parser accepts them by now
  (this is why the PWA due-date sweep is in Stage 1 Part A, not deferred).
- **Whole-DB data paths already know about duties.** Because duties exist from the
  backfill (Stage 4), **export/import must handle them from State C** — not Stage 6.
  A backup taken here must not drop schedules; an import/wipe here must not FK-fail
  or leave stale duty rows. This is why the export/import + `wipe` extension moved
  into Stage 4's cut-over (Stage 4 §5b). *Generalize the lesson (I6):* any path that
  operates on the **whole database** (export, import, wipe, bulk delete) must be
  taught about a new table in the **same** deploy that first populates it, not in a
  later surface stage.

### State D checks (after Stage 6)
- I4(a): the pre-Stage-7 PWA does not choke on `duty_id`/`occurrence_at` on tasks or
  on any new endpoint's shape. **Verified against the code:** the PWA's response and
  IDB parsers use non-strict valibot `v.object` (`shared/wire/rows.ts`,
  `pwa/src/api/endpoints.ts`), which silently drops unknown keys — so the pre-Stage-7
  PWA tolerates the new task fields (they're stripped locally until Stage 7 adds
  them; harmless, since the PWA pushes patches via pending ops, never whole rows
  back). Stages 6 and 7 therefore need not deploy together. If a future refactor
  switches these parsers to `v.strictObject`, this invariant must be re-checked.
- I4(b): **REST task writes still accept `recurrence`** — the pre-Stage-8 PWA sends
  it, and offline pending ops carrying it must still flush. Stage 6 tolerates it
  (transparently upgrading to a duty); only MCP `add_task`/`update_task` reject it
  (no offline queue there). The hard REST rejection waits for Stage 10, after the
  PWA field is gone (Stage 8) and pending ops have drained.

### State F checks (after Stage 10)
- The Stage 10 rollout criterion (backfill complete, one release of overlap, no
  build still reads `recurrence`) holds before the column is dropped. (I1)

## Why this class of bug is structural

The stage split is load-bearing: Stage 4's backfill needs Stage 3's domain codec
to exist, so it *cannot* move earlier; the PWA layers depend on the worker
contract, so they *follow* it. Clean boundaries are what make the plan executable
cold. The cost of that split is exactly these coexistence windows — so rather than
collapse the stages, we make the transitional contract explicit here and check it
per stage. An implementing agent that lands a stage and verifies its state's
invariants cannot reintroduce the "reader hit the wrong representation" / "spawner
count went to 0 or 2" / "PWA can't parse the new shape" bugs after the fact.
