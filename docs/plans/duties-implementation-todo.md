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

- [x] `duties/00-recurrence-and-triggering.md` — recurrence-as-series-anchor,
  materialization algorithm, catch-up, idempotency, triggering.
- [x] `duties/01-type-system.md` — full inventory of brands, domain unions, Op
  variants, row/wire schemas, MCP registry entries, and where each lives.
- [x] `duties/02-timestamp-model.md` — minute-resolution-UTC substrate
  (Decision 4): why date-only is abandoned, what it removes/enables, DST tradeoff.
- [x] `duties/03-transition-invariants.md` — per-stage rollout-safety checklist for
  the partially-migrated coexistence windows. **Each stage's acceptance step
  verifies its state's invariants**; note the Stage 4 ↔ 5 atomic cut-over.
- [x] `duties/04-invariants-and-contracts.md` — **canonical source of truth**:
  schema of record, domain invariants (INV-A…L), calendar signatures, op catalog,
  and the operations × invariants matrix. `04` wins over any stage doc; run the
  matrix (§6) when adding/changing a mutation. Update `04` **first**, then reconcile
  stage docs — this is the anti-drift discipline.

## Phase 1 — Single-task duties

### Stage 1 — Timestamp model + schema (`stage-1-schema-and-migration.md`) — done, `worker/migrations/007_duties.sql`
- [x] **Part A:** `due_date` → UTC datetime app-wide; retire `IsoDate` as a
  scheduling type; minute-resolution parser (**truncate-on-write**); migrate
  existing values to **noon UTC** (all-day preservation — displayed date stays
  stable in a non-UTC viewer zone); sweep worker + PWA date-only touch points
  (`formatDue`, `taskSort` sentinel, readiness window, edit form). **Legacy-
  recurrence shim (A2):** adapt `recurrenceFromRow`/`completeTaskPlan` to read the
  date part of the now-datetime `due_date` so recurring tasks keep loading and
  spawning through Stages 1–3 (removed in Stage 10).
- [x] **Part B:** `duties` table (incl. `timezone`, `next_occurrence_at` + index)
  + `Duty` type; `tasks.duty_id`/`occurrence_at`; `action_log.duty_id`;
  `UNIQUE(duty_id, occurrence_at)` index; `schema.sql`.
- [x] **Hand-written** `worker/migrations/007_*.sql` (Drizzle is a diff-preview
  only — `drizzle.config.ts`).
- [x] **No duty backfill here** (moved to Stage 4). No `duty_id` set on any task.
- [x] Tests: Part A representation change; schema; unique-index NULL-distinctness.
- [x] `wrangler deploy --dry-run` + `verify` green.

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
  maintenance, `maxPerRun` **passed as `occurrencesBetween` limit**, exhaustion→
  ended, `COUNT=1` not-premature, **live-status guard INV-L** — no spawn/cursor
  write if paused/ended between plan-build and apply).
- [ ] Unique-index benign-conflict no-op in `apply` (idempotency layer 3).
- [ ] `materializeDueDuties` driver: gate on `next_occurrence_at <= now`, order by
  it, isolate per-duty failures.
- [ ] **Duty backfill** (validated through `dutyFromRow`; transactional abort),
  then retire `completeTaskPlan` spawn + fix `DB.completeTask` shape (and patch
  its `api.ts`/`mcp.ts` readers in the same stage so typecheck stays green —
  `mcp.ts:459` reads `result.next`).
- [ ] **Export/import + `wipe`** (moved here from Stage 6 — duties exist from the
  backfill): add `duties` to payload/import schema, wipe in FK order, restore
  projects→duties→tasks (`03` State C).
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
  task payloads; PATCH rejects `rrule`/`dtstart`/`timezone` **explicitly** (the
  loose `v.object` parse strips unknown keys — forbid them, don't rely on
  omission).
- [ ] MCP `create_duty`/`list_duties`/`update_duty`/`pause_duty`/`resume_duty`/
  `end_duty`/`delete_duty` (+ `timezone` arg; delete orphans).
- [ ] Action-log is **new** on REST (MCP-only today); wire `action_log.duty_id`.
- [ ] Duty-list endpoints (`GET /api/duties`, `list_duties`) run the
  `ensureDutiesFresh` gate (Stage 5) so a due-but-unspawned duty is materialized
  before listing.
- [ ] REST recurrence tolerance is **idempotent on `duty_id`**: auto-create a duty
  only for unattached legacy tasks (seeded via the shared Stage 4 backfill helper —
  INV-B-safe for off-calendar due dates); no-op if `duty_id` already set (no double
  schedule). Export/import moved to Stage 4.
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

## Resolved by the consistency review (2026-07-01)

A full-pass consistency review of all 17 docs, verified against the code:
INV-L's guard mechanism made concrete and reconciled into the `04` §5 op catalog
(status predicates on `duty.update_cursor`/`duty.orphan_stale`, an
`ifStatus: 'active'` field on `duty.update` for the exhaustion transition, and
`INSERT…SELECT WHERE EXISTS(active)` for duty-instance inserts — silent no-op, not
the batch-aborting precheck); stale "INV-A…K" references updated to INV-A…L;
Stage 2's goal no longer contradicts its own anchor-zone content; Stage 4 now
patches `DB.completeTask`'s readers in-stage (typecheck would fail otherwise —
`mcp.ts:459` reads `result.next`); Stage 6's anchor-edit rejection must be
explicit (loose `v.object` strips unknown keys) and its recurrence→duty upgrade
reuses the backfill seeding helper (off-calendar `due_date` would otherwise 4xx);
`03` I6 promoted to the cross-cutting list and State D's PWA-parser question
resolved as verified fact (non-strict parsers; Stages 6/7 separable); wipe order
names `user_preferences`; Stage 5/00 ordering language aligned to
`next_occurrence_at` ascending; Stage 7 notes the duty-row LWW churn wrinkle.

## Notes / deviations

### Stage 1 landed (2026-07-02)

Single migration `worker/migrations/007_duties.sql` covers both Part A and
Part B (one pass over `tasks`, per the stage doc's framing). `npm run verify`
green; `wrangler d1 migrations apply --local` and a manual noon-UTC/unique-
index/NULL-distinctness check (now also covered by `worker/test/schema.test.ts`,
which runs `schema.sql` through Node's built-in `node:sqlite` — a new pattern,
since no prior migration had DDL-level test coverage) both pass.

**Two new minute-resolution parsers, not one** (`shared/parse/primitives.ts`).
`01-type-system.md`'s `DutyRowSchema` sketch and `stage-3`'s "`parseIsoDateTime`
for `dtstart`" both name the *existing* `parseIsoDateTime`/`IsoDateTimeSchema`
for scheduling fields — but that parser must stay untouched for
`created_at`/`updated_at` (LWW needs the sub-second precision), so it cannot
also be the truncating one. Landed instead:
- `parseIsoDateTimeMinute`/`IsoDateTimeMinuteSchema` — truncates a full instant
  to `:00` seconds; UTC-normalizes any offset. Use for `dtstart`,
  `last_spawned_at`, `next_occurrence_at`, `occurrence_at` in Stage 2+, and for
  `defer_until`/`focused_until` write-time normalization (currently wired only
  at `worker/src/db.ts`'s `parseRequiredDateTime` — the one place both REST and
  MCP funnel through for those two fields).
- `parseDueDateTime`/`DueDateTimeSchema` — same truncation, plus accepts a bare
  `YYYY-MM-DD` and anchors it to noon UTC. `due_date` is the one scheduling
  field still commonly set from a bare date (REST/MCP callers, the task edit
  form's `type="date"` input), so it needs the fallback; the other scheduling
  fields above never receive a bare date and use the non-fallback parser.
- `parseIsoDateTime`/`IsoDateTimeSchema` (unchanged) stays reserved for
  `created_at`/`updated_at` only.

Stage 2/3 implementers: when you add `DutyRowSchema`/`dutyFromRow`, use
`IsoDateTimeMinuteSchema`/`parseIsoDateTimeMinute` for `dtstart`,
`last_spawned_at`, `next_occurrence_at` — not `parseIsoDateTime`. Fix this in
`01-type-system.md` and `stage-3-duty-domain-and-ops.md` when you touch them.

**`TaskRowSchema.duty_id` is unbranded** (`v.nullable(v.string())`) — Stage 3
owns the `DutyId` brand/`mintDutyId`/`parseDutyId`; tighten this field then.
`occurrence_at` already uses `IsoDateTimeMinuteSchema`.

**`TASK_INSERT_COLUMNS`/`TASK_UPDATE_COLUMNS`** (`worker/src/storage/apply.ts`)
were **not** extended with `duty_id`/`occurrence_at` — nothing writes non-null
values to them yet, and `bindInsert`/`bindUpdate` silently drop any row/patch
keys not in these allowlists, so the columns stay `NULL` either way. The
`completeTaskPlan` legacy-recurrence spawn (`worker/src/domain/ops/task.ts`)
sets `duty_id: null, occurrence_at: null` on the row it inserts only to satisfy
`TaskRow`'s type (`Task` now requires those keys); the DB layer ignores them.
**Stage 4 must add both columns to both allowlists** when the spawn engine
starts writing real values.

**`TaskFlowContext.today` was removed**, not just repointed — it was doing
nothing `context.nowIso` didn't already do (that field already existed,
already defaulted to `new Date().toISOString()`). `design.ts`'s `formatDue`,
`taskSort`, and `readinessScore` wrapper all dropped their vestigial `today`/
`_today` params for the same reason (`_today` in `readinessScore` and
`suggestQueue` was already dead code pre-Stage-1). New helper:
`design.ts` `localDateOf(iso)` — converts a stored UTC instant to the
*viewer's* local `YYYY-MM-DD` (`toLocaleDateString('en-CA')`). This is not
optional/cosmetic: it's why noon UTC (not midnight) was chosen for the
migration in the first place, so every plain-date rendering of `due_date`
(`formatDue`, `TaskMeta`, `DetailView`, the edit form's date input) goes
through it rather than slicing the raw UTC string. `formatDue`/`TaskMeta`
decide "Due today" by comparing viewer-local dates (so an all-day task due
today never flips to "Overdue" mid-day); the overdue/future split and
`readinessScore`'s due window otherwise compare instants directly.

### `tasks.due_all_day` added (2026-07-02, same day, codex-flagged follow-up)

`formatDue`/`TaskMeta`'s "same local day ⇒ never Overdue" rule (above) went
through two more codex review rounds after landing, converging on a real
schema addition rather than a smarter heuristic — recorded here because it
changes facts stated elsewhere in this doc and in `01-type-system.md`/
`02-timestamp-model.md`.

**The problem:** making the overdue check instant-first (so a *timed*
due_date goes overdue the moment it passes, not at local midnight) broke the
*common* case — an all-day due_date (noon-UTC anchor, from the PWA's own date
picker) went "Overdue" the moment local time passed noon UTC, e.g. 5am PDT.
A `isAllDayDueDate(dueDate)` heuristic (treat exactly `T12:00:00Z` as all-day)
fixed that, but has an irreducible false positive: a genuinely timed due_date
that normalizes to exactly noon UTC (e.g. `05:00:00-07:00` via REST/MCP) is
byte-identical to an all-day one once stored — no heuristic on the stored
value can tell them apart, because the "was a time explicitly given"
information is real information, and a lossy convention can't reconstruct
what it never kept.

**The fix:** `tasks.due_all_day` (nullable boolean, `shared/schema.ts` — this
supersedes `02-timestamp-model.md`'s "no explicit all-day flag by design" and
`04`'s schema-of-record silence on the point; both predate this decision and
should be reconciled if you're touching them). `NULL` on every pre-existing
row (nothing before this could set a genuinely timed due_date via this app's
own UI) and treated as all-day wherever read.

**Where it's derived, and why only once:** `due_all_day` can only be computed
from the *as-submitted* input shape — a bare date is all-day, a full instant
is timed — never from an already-stored `due_date`, for the same
byte-identical reason above. `shared/parse/primitives.ts` `parseDueDateParts`
is the one function that does this; `worker/src/db.ts`'s `resolveDueDate` is
the one call site (used by both `addTask` and `updateTask`, so both REST and
MCP get it for free without any new tool-schema surface). `resolveDueDate`
also accepts an explicit `due_all_day` override, which wins over derivation —
this is how the PWA preserves an existing timed due_date's flag when an
edit-form save doesn't touch the due date (`existingDueAllDay` in
`taskForm.ts`, mirroring the pre-existing `existingDueDate`/
`existingDeferUntil` pattern). REST's `due_date` body field switched from
`DueDateTimeSchema` (which collapses a bare date to its noon-UTC instant) to
the new `DueDateStringSchema` (validates shape only) specifically so
`resolveDueDate` still sees the original bare-vs-datetime shape — collapsing
it at the wire boundary would have defeated the whole point.

`formatDue`/`taskMetaString` now read `task.due_all_day ?? true` directly
instead of the `isAllDayDueDate` heuristic (deleted). `worker/test/schema.test.ts`
and `shared/parse/primitives.test.ts` cover the column and `parseDueDateParts`
respectively, including the residual case codex flagged (a datetime that
normalizes to noon UTC still derives `due_all_day: false` when parsed from
its original shape — the bug was only in trying to reconstruct that fact
*after* storage).

**Stage 2+ implementers:** duties' `dtstart` has the identical ambiguity
("every day" vs. "every day at 9am") and will need the same treatment —
either its own `all_day`-style column, or an explicit decision that duty
recurrence is always timed. Don't reach for a noon-UTC heuristic there; it's
the exact mistake this section documents undoing.

**Two more gaps codex caught in the same round, both about *pre-existing*
data the new column can't see:**
- The migration didn't backfill anything, on the theory that nothing could
  predate the column. False — Stage 1 (007) already let REST/MCP write a
  full-instant `due_date`, so a real upgrade path could have timed rows
  before 008 runs. Fixed: `008_due_all_day.sql` now backfills any `due_date`
  NOT at exactly noon UTC to `due_all_day = 0` (definitely timed); rows at
  exactly noon UTC stay `NULL` (genuinely ambiguous, read as all-day, same as
  any other unspecified case). Covered by a new `worker/test/schema.test.ts`
  case that applies the real migration files in order via a new
  `dbFromMigrations(stopBefore)` helper, so the backfill runs against
  pre-existing data the way a real upgrade would.
- Offline PWA writes queued before this landed (IndexedDB `pendingOps`, made
  by an older build) have `due_date` but no `due_all_day` key. Flushing them
  unchanged would hit the server's auto-derive path, which sees the
  already-normalized noon-UTC instant a *bare date* becomes and derives
  `due_all_day: false` — wrong, it was all-day. Fixed:
  `pwa/src/api/pendingOps.ts` `repairMissingDueAllDay`, applied in
  `parsePendingOp`.

  This one took three passes to get right, which is worth recording so the
  next person doesn't re-walk it: first cut backfilled `due_all_day: true`
  unconditionally for any missing key — wrong, because a build with the
  `existingDueDate` preservation fix (1082d58) but not yet `due_all_day`
  itself could queue a `task.update` that resent a genuinely *timed*
  `due_date` verbatim on an unrelated-field edit. Second cut switched to the
  noon-UTC signal (matching the migration backfill) — still wrong, because it
  didn't account for ops queued even earlier, before Decision 4's `due_date`
  datetime unification, where `due_date` can still be a bare `YYYY-MM-DD`
  with no `T` at all. The actual queue can hold **three** generations of
  shape (bare date / Stage-1-era noon-UTC-or-preserved-timed / current
  paired-with-due_all_day); `legacyIsAllDay` now checks for a bare date
  first, then falls back to the noon-UTC signal. Same lesson as the
  migration backfill, just with one more generation of drift to account for
  because client state persists longer than a server column does.

### Two more PR review rounds (2026-07-02, same day)

- `db.updateTask` only copied `due_all_day` into the patch inside the
  `due_date` branch, so a PATCH of just `{ due_all_day: false }` — no
  `due_date` — fell through to the empty-patch check and silently no-op'd.
  That's exactly the operation needed to correct an ambiguous noon-UTC row
  the migration backfill left `NULL`. Fixed with an `else if
  (updates.due_all_day !== undefined)` branch alongside the `due_date` one.
- The legacy RRULE math (`nextOccurrence`, date-only) has no way to carry a
  time-of-day into a spawned occurrence — `completeTaskPlan`'s A2 shim always
  re-inflates the next occurrence to the noon-UTC anchor. Once `due_date`
  could carry a real time (this stage), nothing stopped a caller from
  creating a *recurring* task with a *timed* `due_date`, and completing it
  would silently discard that time on the next spawn. Fixed by rejecting the
  combination at write time: `recurrenceFromRow` takes a third
  `dueAllDayInput` parameter and errors `path: ['due_all_day'], code:
  'invalid_state'` when recurrence is set and `due_all_day === false`. This
  makes "legacy recurring tasks are all-day" a real enforced invariant rather
  than a comment `completeTaskPlan` hoped stayed true — worth knowing before
  Stage 2's series-recurrence model has to decide whether timed recurrence is
  ever supported for real.
