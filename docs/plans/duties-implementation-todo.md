# Duties Implementation Todo

Handoff checklist for `docs/plans/duties.md`. Keep this current as stages land so
another agent can resume without re-deriving the plan. Each stage has a
cold-start work order in `docs/plans/duties/`. When a design decision changes,
fan the revision out to every affected stage doc and to the two foundation docs
(`duties/00-recurrence-and-triggering.md`, `duties/01-type-system.md`) — the work
orders must never drift from each other or from the code.

## Locked decisions (see `duties/00`, `duties/02`)

- **Data model:** first-class `duties` table (incl. `timezone`,
  `next_occurrence_at`); tasks carry `duty_id` + `occurrence_at` (set/null
  together); `action_log.duty_id`; `UNIQUE(duty_id, occurrence_at)` backstop;
  `last_spawned_at` cursor (no occurrences ledger).
- **Triggering:** Cloudflare cron `scheduled()` handler **+** lazy-on-read hook,
  both calling one idempotent `materializeDueDuties(now)`. Due-gate keys on
  `next_occurrence_at <= now`, **not** `last_spawned_at`.
- **Idempotency = three layers:** unique index (no dup instances) + monotonic
  `last_spawned_at` (no cursor regression) + `next_occurrence_at` gate.
- **Scope:** phased — `DutyTemplate` is a degenerate one-node template *shaped for*
  a task+link graph; ship single-task spawning first (Stages 1–8), graph spawning
  later (Stage 9).
- **Spawn ownership:** server-authoritative; the PWA never materializes locally.
- **Completion:** decoupled from spawning; `completeTaskPlan`'s recurrence branch
  is retired (Stage 4). **Stages 4 + 5 deploy as one unit** — retire-completion-
  spawn and wire-trigger cannot straddle a release, or recurrence stalls (0
  spawners) or double-spawns (2). See `duties/03`, State B.
- **Series anchor immutable:** `rrule` + `dtstart` + `timezone` are fixed at
  creation (all define the occurrence calendar); reschedule/re-zone = `end_duty` +
  `create_duty`. `updateDutyPlan` edits template fields + `catch_up` only.
- **`catch_up: next`:** spawn the latest occurrence; **orphan** any still-open
  prior instance (null `duty_id` + `occurrence_at`); advance cursor; drop
  intermediates. Orphans may accumulate — the deliberate cost of `next`.
- **Delete-duty:** orphans instances (keep tasks, null `duty_id` + `occurrence_at`),
  stops future spawns. Decided, not deferred.
- **Timestamps (Decision 4):** minute-resolution UTC on every scheduling field
  (truncate-on-write); no date-only fields; `due_date` migrates to a datetime
  app-wide. **Anchor zone is in Phase 1**: `duties.timezone` (nullable) expands a
  duty's rule in an IANA zone so wall-clock times survive DST; instants stored are
  always UTC. No global timezone preference; no `todayInZone`.

## Foundation docs (read before implementing)

- [ ] `duties/00-recurrence-and-triggering.md` — recurrence-as-series-anchor,
  materialization algorithm, catch-up, idempotency, triggering.
- [ ] `duties/01-type-system.md` — full inventory of brands, domain unions, Op
  variants, row/wire schemas, MCP registry entries, and where each lives.
- [ ] `duties/02-timestamp-model.md` — minute-resolution-UTC substrate
  (Decision 4): why date-only is abandoned, what it removes/enables, DST tradeoff.
- [ ] `duties/03-transition-invariants.md` — per-stage rollout-safety checklist for
  the partially-migrated coexistence windows. **Each stage's acceptance step
  verifies its state's invariants**; note the Stage 4 ↔ 5 atomic cut-over.
- [ ] `duties/04-invariants-and-contracts.md` — **canonical source of truth**:
  schema of record, domain invariants (INV-A…K), calendar signatures, op catalog,
  and the operations × invariants matrix. `04` wins over any stage doc; run the
  matrix (§6) when adding/changing a mutation. Update `04` **first**, then reconcile
  stage docs — this is the anti-drift discipline.

## Phase 1 — Single-task duties

### Stage 1 — Timestamp model + schema (`stage-1-schema-and-migration.md`)
- [ ] **Part A:** `due_date` → UTC datetime app-wide; retire `IsoDate` as a
  scheduling type; minute-resolution parser (**truncate-on-write**); migrate
  existing values to **noon UTC** (all-day preservation — displayed date stays
  stable in a non-UTC viewer zone); sweep worker + PWA date-only touch points
  (`formatDue`, `taskSort` sentinel, readiness window, edit form). **Legacy-
  recurrence shim (A2):** adapt `recurrenceFromRow`/`completeTaskPlan` to read the
  date part of the now-datetime `due_date` so recurring tasks keep loading and
  spawning through Stages 1–3 (removed in Stage 10).
- [ ] **Part B:** `duties` table (incl. `timezone`, `next_occurrence_at` + index)
  + `Duty` type; `tasks.duty_id`/`occurrence_at`; `action_log.duty_id`;
  `UNIQUE(duty_id, occurrence_at)` index; `schema.sql`.
- [ ] **Hand-written** `worker/migrations/007_*.sql` (Drizzle is a diff-preview
  only — `drizzle.config.ts`).
- [ ] **No duty backfill here** (moved to Stage 4). No `duty_id` set on any task.
- [ ] Tests: Part A representation change; schema; unique-index NULL-distinctness.
- [ ] `wrangler deploy --dry-run` + `verify` green.

### Stage 2 — Series recurrence (`stage-2-series-recurrence.md`)
- [ ] `SeriesRrule` / `SeriesRruleParts` / `parseSeriesRrule` (COUNT/UNTIL,
  time-capable). *Adds* the series profile; legacy date-only profile removal is
  Stage 10.
- [ ] **Anchor-zone-aware** `occurrencesBetween` + `nextOccurrenceAfter` (over
  instants, expand in `timezone` when set, UTC when null) + runaway cap.
- [ ] `isSeriesExhausted` (nullable `after`; `null`-cursor `COUNT=1` not exhausted).
- [ ] `Timezone` brand + `parseTimezone`. No global `todayInZone`/preference.
- [ ] Deep tests incl. DST-crossing zoned rule + fast-check; legacy `parseRrule`
  unchanged.

### Stage 3 — Duty domain + Op/apply (`stage-3-duty-domain-and-ops.md`)
- [ ] `DutyId` / `DutyStatus` / `CatchUpPolicy` (+ `Timezone`) brands + `mintDutyId`.
- [ ] `DutyDomain` (series incl. `timezone`, `nextOccurrenceAt`) + `dutyFromRow`
  invariants (cursor ≥ dtstart; `null`-cursor never `ended`; next_occurrence_at
  consistency).
- [ ] `duty.insert/update/update_cursor/orphan_stale/orphan_all/delete` ops +
  `duty.exists` precheck (`orphan_stale`/`orphan_all` = bulk UPDATEs so `next`
  orphaning and delete stay bounded; `orphan_stale` bounds `occurrence_at < latest`
  to exclude the current instance on a stale replay).
- [ ] `dutyFromRow` `ended` invariant is only `next_occurrence_at IS NULL` (not
  exhaustion) — so `end_duty` / reschedule-by-end works for infinite duties.
- [ ] **Monotonic** `duty.update_cursor` in `apply.ts` (compare-and-set; stale =
  no-op).
- [ ] Tests: codec invariants, monotonic cursor, apply, brand parsers.

### Stage 4 — Spawn / materialize engine + backfill (`stage-4-spawn-and-materialize.md`)
- [ ] `instanceFromTemplate` + kickoff carry-forward.
- [ ] `materializeDutyPlan` (catch-up `all`/`next`-with-orphan, `next_occurrence_at`
  maintenance, `maxPerRun` cap, exhaustion→ended, `COUNT=1` not-premature).
- [ ] Unique-index benign-conflict no-op in `apply` (idempotency layer 3).
- [ ] `materializeDueDuties` driver: gate on `next_occurrence_at <= now`, order by
  it, isolate per-duty failures.
- [ ] **Duty backfill** (validated through `dutyFromRow`; transactional abort),
  then retire `completeTaskPlan` spawn + fix `DB.completeTask` shape.
- [ ] `createDutyPlan(now)` / `updateDutyPlan` (no rrule/dtstart) /
  `setDutyStatusPlan` / `deleteDutyPlan` (orphan both).
- [ ] Tests: engine matrix, orphan-on-next, cursor no-regression, `COUNT=1`,
  zoned-DST, cap, backfill abort, no-spawn-on-complete.

### Stage 5 — Triggering (`stage-5-trigger-scheduled-and-lazy.md`)
- [ ] `wrangler.toml` `[triggers]` cron.
- [ ] `scheduled()` export + `handleScheduled` (`now = Date.now()`, no tz) with
  runtime budget.
- [ ] `ensureDutiesFresh` lazy hook on all list/sync reads (not single-task GETs
  or mutations).
- [ ] No timezone plumbing at the edge (per-duty zone lives inside the engine).
- [ ] Tests: scheduled, lazy-read freshness, both-drivers race, sub-day lag,
  per-tick cap, monthly-duty gate not tripped daily.
- [ ] `wrangler deploy --dry-run` green.

### Stage 6 — REST + MCP (`stage-6-rest-and-mcp.md`)
- [ ] DB duty methods.
- [ ] REST `/api/duties*` returning **raw rows** (not envelopes) + duty fields on
  task payloads; PATCH rejects `rrule`/`dtstart` (immutable).
- [ ] MCP `create_duty`/`list_duties`/`update_duty`/`pause_duty`/`resume_duty`/
  `end_duty`/`delete_duty` (+ `timezone` arg; delete orphans).
- [ ] Action-log is **new** on REST (MCP-only today); wire `action_log.duty_id`.
- [ ] **Export/import**: add `duties` to payload + import schema; insert duties
  before tasks; validate.
- [ ] Deprecate `recurrence` on task writes: **MCP** rejects (→ create_duty);
  **REST** tolerates through the transition (transparent task→duty upgrade so the
  in-flight PWA + offline ops don't 4xx). Hard REST reject moves to Stage 10.
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
- [ ] `DutyEditView` (raw RRULE + dtstart + `timezone` all **read-only on edit**
  — anchor immutable; `timezone` select defaults to browser zone on create;
  `catch_up` + template editable; Reschedule/re-zone = end+create affordance).
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

- `maxPerRun` value (Stage 4) and per-tick duty cap + ordering (Stage 5, by
  `next_occurrence_at` asc).
- Zoned-expansion implementation: `rrule` library tz support vs a small
  `Intl`-offset helper — validate in Workers (Stage 2).
- Template storage shape — normalized tables vs JSON blob (Stage 9; leaning
  normalized).
- Whether legacy `parseRrule`/`nextOccurrence` + date-only profile are deleted or
  retained after the rollout criterion holds (Stage 10).

## Resolved by the second-opinion review (2026-06-30)

Folded in from a `codex exec` review of the first draft: hand-written SQL
migrations (not Drizzle-generated); REST action-logging is new behavior;
`apply` batch cap (100) → `maxPerRun`; export/import must include duties; cursor
regression → monotonic `duty.update_cursor`; cheap-gate → `next_occurrence_at`;
`COUNT=1`/future-`dtstart` premature-`ended` fix; Stage 1 over-scoped → backfill
moved to Stage 4 (after domain validation exists); `dtstart` immutable;
`catch_up: next` orphan semantics; anchor zone pulled into Phase 1;
`occurrence_at`/`duty_id` paired invariant.

## Notes / deviations

_(Record here as stages land: what changed from the work order and why, so
sibling docs can be reconciled.)_
