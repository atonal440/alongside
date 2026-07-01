# Duties Plan (Master)

## Context

Alongside has recurrence today, but it is not a first-class concept — it is a
side effect of completing a task. A task carries an RRULE string in
`tasks.recurrence`; when you call `complete_task`, `completeTaskPlan`
(`worker/src/domain/ops/task.ts:48`) computes `nextOccurrence(parts, firstDue)`
and inserts one new task. That is the entire recurrence engine. It is simple and
elegant, and it has four structural limits that block everything the product
wants next:

1. **Nothing spawns unless you complete.** A weekly duty you never finish never
   recurs. There is no calendar cadence — the series advances only on
   completion. `alongside-ideas.md` already flags this: "We should seek
   alternatives to completion-driven recurrence logic."
2. **There is no series anchor.** `AGENTS.md` states plainly that `COUNT`,
   `UNTIL`, time parts, recurrence sets, and exceptions are "intentionally
   unsupported until recurrence has a series anchor model." The RRULE is
   evaluated relative to the *current instance's* `due_date`, not to a fixed
   `DTSTART`, so finite series and "the 3rd Friday of the month, forever from
   March" cannot be expressed correctly.
3. **Template and instance are conflated.** The recurring task *is* the template.
   Editing the title of this week's instance silently rewrites the template;
   there is nowhere to store "what every instance inherits" (kickoff notes,
   notes, a checklist) distinct from "this week's live task." `alongside-ideas.md`
   again: "Recurring tasks should inherit kickoff notes and other data, or at
   least be built from a template," and "There ought to be a way to have a
   recurring sequence of blockers."
4. **The concept has already half-leaked into the code as drift.**
   `docs/mcp-tools.md` documents a `task_type: 'recurring'` and a
   `link_type: 'supersedes'` that **do not exist** in `shared/schema.ts`. The PWA
   still carries a dead migration (`pwa/src/idb/decode.ts:18`) that rewrites
   `task_type: 'recurring'` back to `'action'`. The system is asking for this
   concept to be made real.

**Goal.** Introduce **Duties** as a first-class entity: a template plus a
recurrence series anchor that spawns task instances on a schedule, server-side,
whether or not the app is open. Duties own recurrence; tasks become pure
instances. This plan carries duties across the whole stack — schema, the
parse/domain/Op type layers built by the type-driven-safety work, the
materialization engine, the Cloudflare scheduled trigger, the REST and MCP
surfaces, and the PWA — as a series of scoped, cold-start implementation stages
in `docs/plans/duties/`.

This plan assumes and builds directly on the type system delivered by
`docs/plans/type-driven-safety.md` and `docs/plans/pwa-type-safety.md`: branded
primitives in `shared/parse/`, `Result`/`Brand` in `shared/`, discriminated
domain unions in `worker/src/domain/`, the `Op`/`Plan`/`apply` mutation engine in
`worker/src/domain/Op.ts` + `worker/src/storage/apply.ts`, and the PWA
parse-at-every-boundary architecture. Duties are expressed *inside* that system,
not alongside it.

## Design Decisions (locked)

These decisions were made before this plan was written; every stage assumes
them. See `duties/00-recurrence-and-triggering.md` and `duties/02-timestamp-model.md`
for the reasoning.

1. **Duties are a first-class `duties` table.** A duty owns the template fields,
   the recurrence series anchor (`rrule` + `dtstart`), and a lifecycle
   (`active | paused | ended`). Spawned tasks carry a `duty_id` back-reference
   and an `occurrence_at`. Template and instance are finally separated.
2. **Triggering is Cron Trigger + lazy on-read.** A Cloudflare scheduled handler
   materializes due instances on a cron so duties fire while the app is closed;
   read paths (`list_tasks`, `get_ready_tasks`, PWA sync pull) also materialize
   lazily so a client never renders stale state between cron ticks. Both paths
   call the same idempotent engine.
3. **Scope is phased: single-task first, task-graph-*ready* types.** Phase 1's
   `DutyTemplate` is a single task's fields, but it is deliberately shaped as a
   degenerate one-node template so widening it to *a set of tasks plus links*
   (Stage 9) is additive, not a rewrite. The shipping engine spawns exactly one
   task per occurrence; task-graph spawning (the "recurring sequence of blockers")
   is a designed-for, deferred stage, not a retrofit. (To be precise: the graph
   shape is *anticipated* in the type design, not fully *modeled* in Phase 1.)
4. **Minute-resolution UTC everywhere; a timezone is a rule parameter, never on a
   timestamp.** Alongside abandons "day" resolution: every *stored* scheduling
   timestamp is a UTC instant at minute resolution. A duty's `dtstart` and each
   `occurrence_at` are UTC instants; the materializer compares against a UTC `now`,
   not a global zone-resolved `today`. This is app-wide (it migrates
   `tasks.due_date` from date-only to a datetime) and deletes the global
   today-resolver and the date-only RRULE profile. **Phase 1 also ships the
   optional per-duty anchor zone** (`duties.timezone`): when set, a duty's rule is
   *expanded* in that IANA zone so wall-clock times stay stable across DST; the
   occurrence instants it produces are still stored in UTC. Unset ⇒ UTC expansion.
   A timezone is thus a per-duty rule-expansion input, never a property of a
   stored timestamp, and never a user-global setting. The full reasoning, the
   two-conversions model, and the migration are in `duties/02-timestamp-model.md`.

## Design Pillars

1. **Duties own recurrence; tasks are instances.** After migration, no new code
   path spawns a task from another task. `completeTaskPlan`'s recurrence branch
   is retired. Recurrence lives in exactly one place: the duty materializer.
   Completing an instance marks it done — nothing more. Cadence is driven by the
   calendar, not by completion.
2. **Materialization is a pure plan over the calendar.** `materializeDutyPlan`
   is `(duty, now) => Result<Plan, AppError>`: given a duty and the current UTC
   instant, it emits `task.insert` + `duty.update` ops and nothing else. It reads
   the clock from its argument, never from `Date.now()`, so it is deterministic
   and table-testable. The scheduled handler and the lazy-read hook are thin
   drivers that supply `now` and hand the plan to the existing `apply` executor.
3. **Spawning is idempotent by construction — including the cursor.** Two things
   race to materialize the same occurrence: the cron tick and a concurrent read.
   Correctness cannot depend on them not overlapping. Three guards, not one: a
   `UNIQUE(duty_id, occurrence_at)` index on `tasks` is the hard backstop against
   duplicate instances; the `last_spawned_at` cursor advance is **monotonic**
   (`last_spawned_at = max(existing, new)` at the SQL level) so a slow driver
   built from a stale read can never move the cursor *backward*; and a
   `next_occurrence_at` column drives the "is anything due" gate so a duplicate or
   late run is a no-op, never a second task. (The naive `last_spawned_at < now`
   gate is *not* cheap — a monthly duty would trip it every read for a month — so
   the gate keys on `next_occurrence_at`, not the last-spawn cursor.)
4. **Parse at the duty boundary, brand through the core.** Duties get the same
   four-layer treatment as tasks: `DutyId`/`DutyStatus`/`CatchUpPolicy`/`Timezone`
   brands and a `SeriesRrule` (finite-capable) parser in `shared/parse/`; a
   `DutyDomain` discriminated union in `worker/src/domain/duty.ts`; row schemas in
   `shared/wire/rows.ts`; REST/MCP wire specs. Illegal duties (a finite rule with
   no occurrences, a paused duty with a cursor *before* its anchor) fail to
   parse, not at runtime.
5. **The series anchor is real and immutable.** The whole anchor — `rrule`,
   `dtstart`, **and `timezone`** — is **fixed at creation** and never editable,
   because all three define the occurrence calendar; editing any would strand the
   `last_spawned_at` cursor off the new calendar. Rescheduling (or re-zoning) a
   duty is `end_duty` + `create_duty`. The RRULE is always evaluated relative to
   `dtstart` (in `timezone`), never to the last instance's due date. This is what
   makes `COUNT`, `UNTIL`, and stable "nth-weekday-of-month" semantics correct, and
   what lets a finite series *end* deterministically.
6. **Server is authoritative for spawning; the PWA stays local-first for
   everything else.** The PWA creates, edits, pauses, and deletes duties through
   the same queued pending-op path as tasks, and it renders duties and their
   spawned instances offline. But it does **not** locally materialize
   occurrences — that would fork the clock and defeat the idempotency guarantees.
   Instances appear in the PWA when sync pulls them after the server spawned
   them. This is stated up front so no stage tries to make the client spawn.
7. **Timestamps are UTC; timezone is a per-duty rule parameter, never on a
   timestamp.** Every stored instant is UTC (Decision 4). The materializer takes a
   UTC `now` — there is no global zone-resolved "today" and no user-wide timezone
   preference in the spawn path. A duty may carry an optional **anchor zone**
   (`duties.timezone`) used *only* to expand its rule so wall-clock times stay
   stable across DST (Phase 1 — see Decision 4); the occurrence instants it
   produces are still UTC. The PWA formats instants into the viewer's (separate)
   local zone at render time. This is the clean split date-only resolution was
   supposed to buy and never did (`duties/02-timestamp-model.md`).

## Data Model

New table (Drizzle, `shared/schema.ts`):

```
duties
  id               text PK              "d_xxxxx"
  title            text NOT NULL        template: spawned task title
  notes            text                 template
  kickoff_note     text                 template: seeds each instance's kickoff_note
  task_type        text enum(action|plan) NOT NULL default 'action'   template
  project_id       text FK projects     template (nullable)
  rrule            text NOT NULL        series recurrence (finite allowed: COUNT/UNTIL; time-capable)
  dtstart          text NOT NULL        series anchor instant (UTC datetime, minute resolution); immutable
  timezone         text                 optional IANA anchor zone for rule expansion; null = UTC; immutable (series-defining)
  status           text enum(active|paused|ended) NOT NULL default 'active'
  catch_up         text enum(next|all) NOT NULL default 'next'
  last_spawned_at  text                 cursor: occurrence instant of newest instance, null = none yet
  next_occurrence_at text               next un-spawned occurrence (may be future); null ONLY for paused/ended/exhausted. Drives the "is anything due" gate.
  created_at       text NOT NULL
  updated_at       text NOT NULL
```

Columns added to `tasks`:

```
tasks
  + duty_id          text FK duties(id)    null for one-off tasks (and for orphaned ex-instances)
  + occurrence_at    text                  the occurrence this instance represents (UTC datetime); null when duty_id is null
```

Invariant: `duty_id` and `occurrence_at` are set together or both null — an
instance always has both; a one-off or orphaned task has neither.

`action_log` also gains a nullable `duty_id` so duty mutations can be logged
(today the table has only `task_id`; see Stage 6).

Note that `tasks.due_date` itself changes under Decision 4: it migrates from a
date-only string to a UTC datetime (minute resolution), app-wide. Existing values
become **noon UTC** (all-day preservation, so the displayed calendar date is
stable in the viewer's local zone). See `duties/02-timestamp-model.md` and Stage 1
Part A.

Idempotency backstop:

```
CREATE UNIQUE INDEX tasks_duty_occurrence
  ON tasks(duty_id, occurrence_at);
```

SQLite treats `NULL` as distinct in unique indexes, so the countless one-off
tasks with `duty_id = NULL` never collide. Only `(duty_id, occurrence_at)`
pairs for real duty instances are constrained.

**Why a cursor, not an occurrences ledger.** We chose the first-class-table
option, not the heavier `duty_occurrences` ledger. `last_spawned_at` +
`occurrence_at` gives us idempotency, catch-up, and "which instances belong to
this duty" without a second table. `duty_occurrences` (per-occurrence
spawned/skipped/backfilled rows) is deliberately out of scope; if per-occurrence
skip history is ever needed, `duties/00` sketches the upgrade path.

## Layer Map

Duties reuse the exact layering of tasks. New surface area at each layer:

```
WIRE     REST /api/duties*, MCP create_duty/list_duties/update_duty/…, import payload
  │      parsed by: worker/src/wire/rest.ts (DutyRoute*), MCP registry
  ▼
INPUT    shared/parse: DutyId, DutyStatus, CatchUpPolicy, Timezone, SeriesRrule (finite-capable)
  │
  ▼
DOMAIN   worker/src/domain/duty.ts: DutyDomain = Active|Paused|Ended, DutyTemplate
  │      worker/src/domain/ops/duty.ts: create/update/setStatus/delete/materialize plans
  ▼
ROW      shared/schema.ts duties table + tasks.duty_id/occurrence_at
         executed by: worker/src/storage/apply.ts (duty.* ops, duty.exists precheck)
```

The two new drivers sit above the WIRE layer:

```
TRIGGER  scheduled() handler (cron)  ─┐
         lazy-on-read hook (list/sync) ┼─► materializeDueDuties(db, now) ─► apply(Plan)
```

## Migration Strategy

Existing recurrence-bearing tasks must become duties without losing the live
instance or its history.

**Sequencing (revised).** The duty backfill does *not* run in Stage 1. Stage 1
only converts `due_date` to a UTC datetime and adds the duties schema. The
backfill runs in **Stage 4**, once `parseSeriesRrule` (Stage 2) and `dutyFromRow`
(Stage 3) exist, so every duty row it writes is validated by the same domain codec
that will read it back — a row the codec would reject is never persisted. The
backfill is also paired with retiring the completion-driven spawn (Stage 4) so no
recurring task is left both un-migrated and no longer self-spawning.

For each task with `recurrence != NULL` and `due_date != NULL`:

1. Mint a duty; copy template fields (`title`, `notes`, `kickoff_note`,
   `task_type`, `project_id`) from the task.
2. Set the duty's `rrule = task.recurrence`, `dtstart = task.due_date`,
   `timezone = NULL` (legacy rules were UTC/date-only), `status = 'active'`,
   `catch_up = 'next'`. **Seed the cursor without assuming `due_date` is an
   occurrence** (a legacy task can be valid with a `due_date` that is *not* a
   rule-match — e.g. due Monday under `BYDAY=FR`). If `due_date` is the first
   occurrence, `last_spawned_at = due_date` and `next_occurrence_at =` the next
   occurrence after it; otherwise `last_spawned_at = NULL` and `next_occurrence_at
   =` the first actual occurrence ≥ `dtstart`. (Stage 4 §5 gives the exact rule.)
   This avoids seeding a cursor that fails the Stage 3 occurrence invariant and
   would abort the transactional backfill.
3. Point the task at the duty: `duty_id = <new duty>`,
   `occurrence_at = task.due_date` (kept as-is, even when off-calendar). Leave the
   task's own `recurrence` column in place but stop treating it as authoritative.
4. Validate the minted duty row through `dutyFromRow`; abort the whole backfill
   (transactional) if any row fails to parse.

Tasks with `recurrence != NULL` but `due_date = NULL` are already invalid under
`taskFromRow`'s `recurrence-requires-due-date` invariant, so none should exist;
the backfill asserts this and fails loudly if one does.

After the backfill, `completeTaskPlan` stops spawning (both in Stage 4, in that
order). The `tasks.recurrence` column becomes read-only legacy: no new writes,
retained for one release for rollback, then dropped in Stage 10 (which defines the
explicit rollout criterion for the drop, not just "a stage later").
`docs/mcp-tools.md`'s phantom `'recurring'` task_type and `'supersedes'` link_type
are resolved in Stage 6 (the concept they gestured at is now the `duties` table).

## Phasing

- **Phase 1 — Single-task duties (Stages 1–8).** A duty spawns one task per
  occurrence. This is the full vertical: schema, recurrence, domain, engine,
  trigger, REST, MCP, PWA. It reaches feature parity with today's completion
  recurrence and surpasses it (calendar cadence, finite series, pause/resume,
  template/instance separation, offline-safe server spawning).
- **Phase 2 — Task-graph duties (Stage 9).** A duty template becomes a set of
  tasks plus links; each occurrence spawns the whole graph with a fresh set of
  ids and rewritten link endpoints. Stage 3's `DutyTemplate` is shaped so this
  widening is additive (a degenerate one-node template); Stage 9 lights up the
  engine and surfaces.
- **Hardening (Stage 10).** Compiler flags, the push-notification hook that the
  scheduled handler makes possible, drop the legacy `recurrence` column, and the
  documentation sweep.

## Stage Index

Foundational analysis (read first):

- `duties/00-recurrence-and-triggering.md` — how recurrence actually works as a
  series anchor, the materialization algorithm, catch-up policies, idempotency,
  and why cron + lazy-on-read (with the tradeoffs of each alternative).
- `duties/01-type-system.md` — the exact brands, domain unions, Op variants,
  assertions, row/wire schemas, and MCP registry entries duties add, and where
  each lives.
- `duties/02-timestamp-model.md` — the minute-resolution-UTC substrate
  (Decision 4): why date-only is abandoned, what it removes and enables, the DST
  tradeoff, and the app-wide `due_date` migration.

Implementation stages (cold-start work orders in `docs/plans/duties/`):

| Stage | File | Scope |
|---|---|---|
| 1 | `stage-1-schema-and-migration.md` | **Part A:** app-wide minute-resolution-UTC unification (`due_date`→datetime, retire `IsoDate`, migrate). **Part B:** `duties` table (incl. `timezone`, `next_occurrence_at`), `tasks.duty_id`/`occurrence_at`, `action_log.duty_id`, unique index, hand-written SQL migration, `schema.sql`. **No duty backfill here** (moved to Stage 4). |
| 2 | `stage-2-series-recurrence.md` | Extend `shared/parse/recurrence.ts`: finite, time-capable `SeriesRrule` (COUNT/UNTIL); `dtstart`-anchored, **anchor-zone-aware** `occurrencesBetween`/`nextOccurrenceAfter` over instants; `isSeriesExhausted`. *Adds* the series profile; legacy date-only profile removal is deferred to Stage 10. |
| 3 | `stage-3-duty-domain-and-ops.md` | `DutyId`/`DutyStatus`/`CatchUpPolicy`/`Timezone` brands; `worker/src/domain/duty.ts` `DutyDomain`; `duty.*` `Op` variants + `duty.exists` precheck; monotonic-cursor `apply.ts` execution. |
| 4 | `stage-4-spawn-and-materialize.md` | `materializeDutyPlan` (catch-up, orphan-on-`next`, `next_occurrence_at` maintenance, per-run cap, exhaustion → `ended`); monotonic cursor; **duty backfill** (validated); retire `completeTaskPlan`'s spawn branch. |
| 5 | `stage-5-trigger-scheduled-and-lazy.md` | `wrangler.toml` cron, `scheduled()` handler, runtime budget, lazy-on-read hook in list/sync endpoints. |
| 6 | `stage-6-rest-and-mcp.md` | REST `/api/duties*`; MCP `create_duty`/`list_duties`/`update_duty`/`pause_duty`/`resume_duty`/`end_duty`/`delete_duty`; resolve `recurring`/`supersedes` drift; deprecate task-level recurrence input. |
| 7 | `stage-7-pwa-data-and-sync.md` | PWA `duties` IDB store, decode/parse, endpoints, sync pull, typed pending-ops; server-authoritative spawn boundary. |
| 8 | `stage-8-pwa-ui.md` | Duties view, duty editor, spawned-instance badges, pause/resume/end controls, App shell wiring. |
| 9 | `stage-9-task-graph-templates.md` | Phase 2: template as task+link graph; graph materialization with id rewrite; surfaces. |
| 10 | `stage-10-hardening-and-docs.md` | Compiler hardening, drop legacy `recurrence` column, push-notification hook, full docs sweep, final `verify`. |

## Out of Scope

- **DST-transition edge cases in rule expansion.** Wall-clock-stable recurrence
  *is* in Phase 1 (the anchor zone, Decision 4), but when an anchored wall-clock
  time lands in a nonexistent (spring-forward) or doubled (fall-back) hour, we
  rely on the `rrule` library's default skip/first-match behavior rather than
  adding custom handling; Stage 8's editor steers users toward safe hours. A
  user-*global* timezone setting is also out of scope — the zone is always
  per-duty.
- **A `duty_occurrences` ledger** with per-occurrence skip/backfill history. The
  cursor model is deliberately lighter; `duties/00` records the upgrade path if
  it is ever needed.
- **Client-side (offline) materialization.** Server is authoritative for
  spawning (Pillar 6).
- **Push notifications themselves.** Stage 10 lands only the *hook* the scheduled
  handler exposes; the notification transport is its own future project.
- **An RRULE builder UI.** Stage 8 keeps the raw-RRULE text input the current
  `EditView` already uses, relocated to the duty editor. A friendly recurrence
  picker is a follow-up.

## Verification

Every stage ends with the narrowest matching command from `AGENTS.md`
(`npm run typecheck` / `npm run test` per package; `wrangler deploy --dry-run`
for any change to `wrangler.toml`, `shared/schema.ts`, migrations, or deps — and
Stage 1 and Stage 5 both touch those). The root `npm run verify` must pass at
every stage boundary. Per the repo convention, run `codex review --commit <sha>`
after each stage's commit.

Keep `docs/plans/duties-implementation-todo.md` current as stages land, and fan
any design revision out to every sibling doc in `docs/plans/duties/` so the
work orders never drift from each other or from the code.
