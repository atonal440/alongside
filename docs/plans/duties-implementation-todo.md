# Duties Implementation Todo

Handoff checklist for `docs/plans/duties.md`. Keep this current as stages land so
another agent can resume without re-deriving the plan. Each stage has a
cold-start work order in `docs/plans/duties/`. When a design decision changes,
fan the revision out to every affected stage doc and to the two foundation docs
(`duties/00-recurrence-and-triggering.md`, `duties/01-type-system.md`) — the work
orders must never drift from each other or from the code.

## Locked decisions (see `duties/00`, `duties/02`)

- **Data model:** first-class `duties` table; tasks carry `duty_id` +
  `occurrence_at`; `UNIQUE(duty_id, occurrence_at)` idempotency backstop;
  `last_spawned_at` cursor (no occurrences ledger).
- **Triggering:** Cloudflare cron `scheduled()` handler **+** lazy-on-read hook,
  both calling one idempotent `materializeDueDuties(now)`.
- **Scope:** phased — type system models a task-graph template from the start;
  ship single-task spawning first (Stages 1–8), graph spawning later (Stage 9).
- **Spawn ownership:** server-authoritative; the PWA never materializes locally.
- **Completion:** decoupled from spawning; `completeTaskPlan`'s recurrence branch
  is retired.
- **Timestamps (Decision 4):** minute-resolution UTC on every scheduling field;
  no date-only fields; `due_date` migrates to a datetime app-wide; recurrence is
  expanded in UTC in Phase 1. Net-simplifies the trigger design (deletes
  `todayInZone` and the date-only RRULE profile). Timezone is presentation-only in
  Phase 1; an optional per-duty *anchor zone* for wall-clock-stable recurrence is
  the lean, planned for the later reminders / timeboxing track (`duties/02`).

## Foundation docs (read before implementing)

- [ ] `duties/00-recurrence-and-triggering.md` — recurrence-as-series-anchor,
  materialization algorithm, catch-up, idempotency, triggering.
- [ ] `duties/01-type-system.md` — full inventory of brands, domain unions, Op
  variants, row/wire schemas, MCP registry entries, and where each lives.
- [ ] `duties/02-timestamp-model.md` — minute-resolution-UTC substrate
  (Decision 4): why date-only is abandoned, what it removes/enables, DST tradeoff.

## Phase 1 — Single-task duties

### Stage 1 — Timestamp model, schema, migration (`stage-1-schema-and-migration.md`)
- [ ] **Part A:** `due_date` → UTC datetime app-wide; retire `IsoDate` as a
  scheduling type; minute-resolution parser; migrate existing values to midnight
  UTC; sweep worker + PWA date-only touch points (`formatDue`, `taskSort`
  sentinel, readiness window, edit form).
- [ ] **Part B:** `duties` table + `Duty` type in `shared/schema.ts`.
- [ ] **Part B:** `tasks.duty_id` + `tasks.occurrence_at` columns.
- [ ] **Part B:** `UNIQUE(duty_id, occurrence_at)` index (schema + `schema.sql`).
- [ ] Generated Drizzle migration(s).
- [ ] Idempotent, lossless backfill of legacy recurring tasks → duties.
- [ ] Tests: Part A representation change; backfill; unique-index
  NULL-distinctness; backfill-abort on bad row.
- [ ] `wrangler deploy --dry-run` + `verify` green.

### Stage 2 — Series recurrence (`stage-2-series-recurrence.md`)
- [ ] `SeriesRrule` / `SeriesRruleParts` / `parseSeriesRrule` (COUNT/UNTIL,
  time-capable); **drop the date-only profile** for series rules.
- [ ] `occurrencesBetween` (dtstart-anchored, over instants) + runaway cap.
- [ ] `isSeriesExhausted`.
- [ ] No timezone/`today` resolver (Decision 4).
- [ ] Deep tests incl. fast-check properties; legacy `parseRrule` unchanged.

### Stage 3 — Duty domain + Op/apply (`stage-3-duty-domain-and-ops.md`)
- [ ] `DutyId` / `DutyStatus` / `CatchUpPolicy` brands + `mintDutyId`.
- [ ] `DutyDomain` union + `dutyFromRow` invariants.
- [ ] `duty.insert/update/delete` ops + `duty.exists` precheck.
- [ ] `apply.ts` duty execution (insert/update/delete/exists).
- [ ] Tests: codec invariants, apply, brand parsers.

### Stage 4 — Spawn / materialize engine (`stage-4-spawn-and-materialize.md`)
- [ ] `instanceFromTemplate` + kickoff carry-forward.
- [ ] `materializeDutyPlan` (catch-up next/all, pile-up guard, exhaustion→ended).
- [ ] Unique-index benign-conflict handling in `apply` (idempotency layer 2).
- [ ] `materializeDueDuties` DB driver with cheap gate + staleness ordering.
- [ ] Retire `completeTaskPlan` recurrence branch + fix `DB.completeTask` shape.
- [ ] `createDutyPlan` / `updateDutyPlan` / `setDutyStatusPlan` / `deleteDutyPlan`.
- [ ] Tests: engine matrix, idempotency, no-spawn-on-complete regression.

### Stage 5 — Triggering (`stage-5-trigger-scheduled-and-lazy.md`)
- [ ] `wrangler.toml` `[triggers]` cron.
- [ ] `scheduled()` export + `handleScheduled` (`now = Date.now()`, no tz) with
  runtime budget.
- [ ] `ensureDutiesFresh` lazy hook on all list/sync reads (not writes/GETs).
- [ ] No timezone plumbing (Decision 4 — presentation only).
- [ ] Tests: scheduled, lazy-read freshness, both-drivers race, sub-day lag,
  per-tick cap.
- [ ] `wrangler deploy --dry-run` green.

### Stage 6 — REST + MCP (`stage-6-rest-and-mcp.md`)
- [ ] DB duty methods.
- [ ] REST `/api/duties*` + duty fields on task payloads.
- [ ] MCP `create_duty`/`list_duties`/`update_duty`/`pause`/`resume`/`end`/`delete`.
- [ ] Deprecate `recurrence` on `add_task`/`update_task` (reject → point to duties).
- [ ] Clean up `complete_task` `next` readers.
- [ ] Resolve `docs/mcp-tools.md` `recurring`/`supersedes` drift; add Duties docs.
- [ ] Tests + curl smoke.

### Stage 7 — PWA data + sync (`stage-7-pwa-data-and-sync.md`)
- [ ] `duties` IDB store + `decodeDuty`; retire dead `recurring` migration.
- [ ] `parseDutyRow` + endpoints; task parser accepts `duty_id`/`occurrence_at`
  (and datetime `due_date`).
- [ ] Sync pull of duties + server-spawned instances.
- [ ] Typed duty pending ops + temp-id rebinding.
- [ ] `dutyMutations` (no local materialization) + `parseDutyForm`.
- [ ] State: `duties` in `AppState`, reducer + async actions.
- [ ] Tests at every boundary.

### Stage 8 — PWA UI (`stage-8-pwa-ui.md`)
- [ ] `DutiesView` + cadence-summary helper.
- [ ] `DutyEditView` (raw RRULE input, dtstart, catch_up).
- [ ] "From duty" badge on instances.
- [ ] Remove recurrence field from task creation.
- [ ] Component tests. **Phase 1 done.**

## Phase 2 — Task-graph duties

### Stage 9 — Task-graph templates (`stage-9-task-graph-templates.md`)
- [ ] Template storage (lean: normalized `duty_template_tasks`/`_links`).
- [ ] `DutyTemplate` widened to task+link graph; `dutyFromRows` acyclicity.
- [ ] Graph materialization (atomic N-task+M-link plan; wider unique key).
- [ ] Graph catch-up semantics (open = any pending instance in the occurrence).
- [ ] Surfaces: MCP/REST template arg, PWA template builder, optional `show_duties`.
- [ ] Tests.

## Hardening

### Stage 10 — Hardening + docs (`stage-10-hardening-and-docs.md`)
- [ ] Drop legacy `tasks.recurrence` column + remove fallbacks.
- [ ] Compiler-hardening flags over duty code.
- [ ] Push-notification seam in the scheduled handler (no transport).
- [ ] Property + e2e invariant tests.
- [ ] Full documentation sweep incl. `AGENTS.md`, `alongside-ideas.md`.
- [ ] Final `verify` + `wrangler deploy --dry-run` + `codex review`.

## Open decisions to confirm as stages are reached

- Exact `openInstanceCount` signature for the `next` pile-up guard (Stage 4).
- Per-tick processing order under the cap — staleness order chosen (Stage 5).
- Delete-duty behavior — orphan instances (keep tasks, null `duty_id`) chosen,
  confirm in tool copy (Stage 6).
- Template storage shape — normalized tables vs JSON blob (Stage 9; leaning
  normalized).
- Whether legacy `parseRrule`/`nextOccurrence` are deleted or retained after the
  backfill has run everywhere (Stage 10).

## Notes / deviations

_(Record here as stages land: what changed from the work order and why, so
sibling docs can be reconciled.)_
