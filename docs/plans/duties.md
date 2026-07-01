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
3. **Scope is phased: single-task first, task-graph-ready types.** The type
   system models a duty template as *a set of tasks plus links* from the start,
   but the shipping engine spawns exactly one task per occurrence. Task-graph
   spawning (the "recurring sequence of blockers") is a designed-in, deferred
   stage (Stage 9), not a retrofit.
4. **Minute-resolution UTC everywhere; no date-only, no stored timezones.**
   Alongside abandons "day" resolution: every scheduling timestamp is a UTC
   instant at minute resolution, and timezone is a pure presentation concern. A
   duty's `dtstart` and each `occurrence_at` are instants; recurrence is expanded
   in UTC; the materializer compares against `now`, not a zone-resolved `today`.
   This is app-wide (it migrates `tasks.due_date` from date-only to a datetime)
   and is a net *simplification* of the trigger design — it deletes the timezone
   resolution path and the date-only RRULE profile rather than adding to them.
   The full reasoning, the DST tradeoff, and the migration are in
   `duties/02-timestamp-model.md`.

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
3. **Spawning is idempotent by construction.** Two things race to materialize the
   same occurrence: the cron tick and a concurrent read. Correctness cannot
   depend on them not overlapping. A `UNIQUE(duty_id, occurrence_at)` index on
   `tasks` is the hard backstop; a `last_spawned_at` cursor on the duty is the
   fast path. A duplicate insert is a no-op, never a second task.
4. **Parse at the duty boundary, brand through the core.** Duties get the same
   four-layer treatment as tasks: `DutyId`/`DutyStatus`/`CatchUpPolicy` brands
   and a `SeriesRrule` (finite-capable) parser in `shared/parse/`; a
   `DutyDomain` discriminated union in `worker/src/domain/duty.ts`; row schemas in
   `shared/wire/rows.ts`; REST/MCP wire specs. Illegal duties (a finite rule with
   no occurrences, a paused duty with a live cursor ahead of its anchor) fail to
   parse, not at runtime.
5. **The series anchor is real.** `dtstart` is stored and fixed at creation. The
   RRULE is always evaluated relative to `dtstart`, never relative to the last
   instance's due date. This is what makes `COUNT`, `UNTIL`, and stable
   "nth-weekday-of-month" semantics correct, and what lets a finite series
   *end* (transition to `status: 'ended'`) deterministically.
6. **Server is authoritative for spawning; the PWA stays local-first for
   everything else.** The PWA creates, edits, pauses, and deletes duties through
   the same queued pending-op path as tasks, and it renders duties and their
   spawned instances offline. But it does **not** locally materialize
   occurrences — that would fork the clock and defeat the idempotency guarantees.
   Instances appear in the PWA when sync pulls them after the server spawned
   them. This is stated up front so no stage tries to make the client spawn.
7. **Timezone is presentation, not storage.** Every timestamp is a UTC instant
   (Decision 4). The materializer works in UTC and compares occurrence instants
   against `now` — there is no zone-resolved "today" and no `timezone` in the
   spawn path. The PWA formats instants into the viewer's local zone at render
   time; nothing is stored per-zone. This is the pillar date-only resolution
   was supposed to buy and never did (`duties/02-timestamp-model.md`).

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
  dtstart          text NOT NULL        series anchor instant (UTC datetime, minute resolution)
  status           text enum(active|paused|ended) NOT NULL default 'active'
  catch_up         text enum(next|all) NOT NULL default 'next'
  last_spawned_at  text                 cursor: occurrence instant of newest instance, null = none yet
  created_at       text NOT NULL
  updated_at       text NOT NULL
```

Columns added to `tasks`:

```
tasks
  + duty_id          text FK duties(id)    null for one-off tasks
  + occurrence_at    text                  the occurrence this instance represents (UTC datetime)
```

Note that `tasks.due_date` itself changes under Decision 4: it migrates from a
date-only string to a UTC datetime (minute resolution), app-wide. Existing values
become midnight UTC. See `duties/02-timestamp-model.md` and Stage 1 Part A.

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
INPUT    shared/parse: DutyId, DutyStatus, CatchUpPolicy, SeriesRrule (finite-capable)
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

The duty backfill runs *after* Stage 1 Part A has converted `due_date` to a UTC
datetime (date-only `due_date` values become midnight UTC), so `task.due_date` is
already an instant here. For each task with `recurrence != NULL` and
`due_date != NULL`:

1. Mint a duty; copy template fields (`title`, `notes`, `kickoff_note`,
   `task_type`, `project_id`) from the task.
2. Set the duty's `rrule = task.recurrence`, `dtstart = task.due_date`,
   `status = 'active'`, `catch_up = 'next'`, `last_spawned_at = task.due_date`
   (this task *is* the occurrence at `dtstart`, so the cursor starts there).
3. Point the task at the duty: `duty_id = <new duty>`,
   `occurrence_at = task.due_date`. Leave the task's own `recurrence` column in
   place but stop treating it as authoritative.

Tasks with `recurrence != NULL` but `due_date = NULL` are already invalid under
`taskFromRow`'s `recurrence-requires-due-date` invariant, so none should exist;
the migration asserts this and fails loudly if one does.

After migration, `completeTaskPlan` stops spawning (Stage 4). The
`tasks.recurrence` column becomes read-only legacy: no new writes, retained for
one release for rollback, then dropped in Stage 10. `docs/mcp-tools.md`'s
phantom `'recurring'` task_type and `'supersedes'` link_type are resolved in
Stage 6 (the concept they gestured at is now the `duties` table).

## Phasing

- **Phase 1 — Single-task duties (Stages 1–8).** A duty spawns one task per
  occurrence. This is the full vertical: schema, recurrence, domain, engine,
  trigger, REST, MCP, PWA. It reaches feature parity with today's completion
  recurrence and surpasses it (calendar cadence, finite series, pause/resume,
  template/instance separation, offline-safe server spawning).
- **Phase 2 — Task-graph duties (Stage 9).** A duty template becomes a set of
  tasks plus links; each occurrence spawns the whole graph with a fresh set of
  ids and rewritten link endpoints. The type system from Stage 3 already models
  this; Stage 9 lights up the engine and surfaces.
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
| 1 | `stage-1-schema-and-migration.md` | **Part A:** app-wide minute-resolution-UTC unification (`due_date`→datetime, retire `IsoDate`, migrate). **Part B:** `duties` table, `tasks.duty_id`/`occurrence_at`, unique index, Drizzle migration, `schema.sql`, backfill of existing recurring tasks. |
| 2 | `stage-2-series-recurrence.md` | Extend `shared/parse/recurrence.ts`: finite, time-capable `SeriesRrule` (COUNT/UNTIL), `dtstart`-anchored `occurrencesBetween` over instants, `isSeriesExhausted`. Removes the date-only RRULE profile. |
| 3 | `stage-3-duty-domain-and-ops.md` | `DutyId`/`DutyStatus`/`CatchUpPolicy` brands; `worker/src/domain/duty.ts` `DutyDomain`; `duty.*` `Op` variants + `duty.exists` precheck; `apply.ts` execution. |
| 4 | `stage-4-spawn-and-materialize.md` | `materializeDutyPlan`, catch-up policies, series-exhaustion → `ended`, idempotency; retire `completeTaskPlan`'s spawn branch. |
| 5 | `stage-5-trigger-scheduled-and-lazy.md` | `wrangler.toml` cron, `scheduled()` handler, runtime budget, lazy-on-read hook in list/sync endpoints. |
| 6 | `stage-6-rest-and-mcp.md` | REST `/api/duties*`; MCP `create_duty`/`list_duties`/`update_duty`/`pause_duty`/`resume_duty`/`end_duty`/`delete_duty`; resolve `recurring`/`supersedes` drift; deprecate task-level recurrence input. |
| 7 | `stage-7-pwa-data-and-sync.md` | PWA `duties` IDB store, decode/parse, endpoints, sync pull, typed pending-ops; server-authoritative spawn boundary. |
| 8 | `stage-8-pwa-ui.md` | Duties view, duty editor, spawned-instance badges, pause/resume/end controls, App shell wiring. |
| 9 | `stage-9-task-graph-templates.md` | Phase 2: template as task+link graph; graph materialization with id rewrite; surfaces. |
| 10 | `stage-10-hardening-and-docs.md` | Compiler hardening, drop legacy `recurrence` column, push-notification hook, full docs sweep, final `verify`. |

## Out of Scope

- **Wall-clock-stable (DST-anchored) recurrence.** Recurrence is expanded in UTC
  in Phase 1 (Decision 4), so a rule fixed at `14:00Z` drifts against a local wall
  clock across DST. The fix — an optional per-duty *anchor zone* used only to
  expand the rule, with instants still stored in UTC — is designed additively in
  `duties/02-timestamp-model.md` and is the current lean, but is **planned for the
  later reminders / timeboxing track**, not Phase 1. (Time-of-day and sub-day
  recurrence themselves are already *in* scope, a free consequence of Decision 4.)
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
