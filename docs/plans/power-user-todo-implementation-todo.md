# Power-user todo implementation checklist

Status: Slice 1 and Slice 2a implemented and locally verified; PR reviews/merges pending. The remainder of Slice 2 and Slices 3–7 remain unimplemented.
Updated: 2026-09-30.

Semantic authority: [power-user-todo.md](power-user-todo.md). Read it first.
This checklist owns sequencing/progress, not another copy of the contracts.
Update the master contract before changing work orders. UI redesign is deferred.

## Cold start in another session

1. Read `AGENTS.md`, the master plan, this checklist, and `git status`.
2. Verify migrations, domain ops, wire schemas, MCP registry, export/import,
   client queue/decode pipeline, and background bindings against the baseline.
   A checked-in migration is not evidence of deployment.
3. Use the landed duties/type-safety work as foundations. Do not implement
   duties Stages 3–10 unchanged; the new plan revises their semantics.
4. Pick the first unimplemented slice and deliver a vertical feature through
   parse/storage/domain/apply/REST/MCP and client compatibility. Split large
   slices into deployable sub-slices with explicit transition invariants.
5. Record acceptance evidence and the next task when work lands. Distinguish
   proposed behavior from verified runtime behavior.

This is implementation guidance, not an automatic production deployment.
Implementation sessions should follow the user's requested scope and prepare
migrations/release evidence before deployment.

## Baseline

- Relational schema and branded parse/wire/domain/op architecture exist.
- Duties migrations 007/008 and zoned timed `SeriesRrule` expansion exist.
- Legacy task completion still spawns recurrence. No scheduled materializer or
  notification dispatcher exists in this checkout.
- Hierarchy, explicit date roles, blocks, reminders, receipts, and change-feed
  sync are proposed additions.
- Preserve PWA local writes/queued ops/decoding through the backend rollout.
  Data compatibility belongs here even though the visual redesign does not.
- This planning session changes docs only; it does not edit `shared/schema.ts`,
  migrate data, deploy services, or expose new runtime tools.

## Slice 1 — Temporal and contract foundation

Depends on baseline. Goal: distinguish dates, instants, and scheduling intent.

- [x] Add `LocalDate`, `LocalTime`, `MinuteInstant`, `EventInstant`, duration,
  revision, sort-key, and entity-ID brands/parsers; reuse existing semantics
  instead of maintaining competing timezone types.
- [x] Implement temporal unions, zoned date boundaries, elapsed/calendar
  offsets, explicit one-off DST resolution, and typed planning settings.
- [x] Add `get_capabilities`/`resolve_time`: contract versions, server now,
  timezone, feature gates, limits, and delivery configuration status. Require
  setup or a reported fallback zone; never use the host zone as user intent.
- [x] Define strict inputs/results/errors distinct from storage rows, including
  omission/null and unknown-key policies.
- [x] Prepare additive changes to `shared/schema.ts`, `worker/schema.sql`, and
  the next unused hand-written migration. Never edit applied 007/008 files.
- [x] Produce a dry-run legacy due-date classification: true all-day marker
  becomes target date from stored UTC date; false becomes target instant; null
  uses the existing all-day fallback with `legacy_ambiguous` provenance.
  Preserve original values and attach a reported/user-selected zone. No legacy
  due date automatically becomes a hard deadline.
- [x] Test extreme zones, 23/25-hour dates, skipped dates, folds/gaps, leap days,
  date/instant round-trip, and independent host `TZ` settings.
- [x] Update shared temporal and capability docs.

Acceptance: date meaning survives viewer-zone changes; ambiguity is visible;
no new parser depends on host-local Date behavior. No background engine enabled.

## Slice 2 — Reliable commands and local-first reconciliation

Depends on slice 1. Goal: make compound work safe before storing rich graphs.

- [ ] Add stable client IDs/client refs, versioned command envelopes, expected
  revisions, command IDs, payload hashes, and replay receipts.
- [ ] Extend pure `Plan`/SQL apply with in-batch version/aggregate guards,
  receipts, change feed, tombstones, and audit. Every writer advances revisions.
- [x] Count generated SQL including guards/logs/receipts/side effects before
  apply. Reject oversized atomic plans; eliminate unsafe multi-batch chunking
  for operations that promise logical atomicity.
- [ ] Add `preview_changes`/`apply_changes`: diff, IDs/ref map, warnings,
  expected versions, and final-state revalidation. Keep legacy adapters usable.
- [ ] Add consistent snapshot/delta sync, fixed paginated watermarks, cursor
  reset/retention contract, and import epoch.
- [ ] Migrate IDB and parsed pending commands to server snapshot plus optimistic
  overlay. Retain 409 conflicts/failed intent with inspectable rebase; preserve
  command ordering and graph references. Retry auth/429/network/5xx as before.
- [ ] Negotiate client capability/version and block incompatible old writes.
- [ ] Version export/import scaffolding and retain v1 input. Support bounded
  atomic imports first; reject unsafe wipe/chunk plans before modifying data.
- [ ] Test lost-response replay, ID/hash mismatch, concurrent edits, phantom
  graph/calendar changes, rollback, tombstones, cursor expiry, and offline rebase.

Acceptance: replay cannot duplicate creation; concurrency cannot silently
overwrite; oversize rejection changes nothing; offline intent survives conflict.

## Slice 3 — Tasks, hierarchy, explicit dates, and organization

Depends on slices 1–2. Goal: LLM-usable work structure and explainable constraints.

- [ ] Add task extensions, `task_dates`, richer status/terminal timestamps,
  waiting reason, node roles, tags/order, estimates, and chunk policy.
- [ ] Build parsed row/domain codecs and semantic create/subdivide/move/reorder/
  complete/reopen/cancel/delete planners; forbid arbitrary managed-field patches.
- [ ] Enforce final-state hierarchy/effective-dependency validation, project
  consistency, depth limit, group policies/reopening, cancelled blockers,
  subtree scope, soft deletion, and separate purge.
- [ ] Share effective dates/readiness explanations with client helpers. Preserve
  independent focus/deferral and kickoff/session context.
- [ ] Expose bounded task/subtree context, explicit date-role commands, tags,
  and lifecycle operations through REST/MCP.
- [ ] Backfill due values as targets using slice 1 provenance. Legacy writers
  update only target; they cannot remove new hard deadlines/availability.
  Maintain legacy read projections during the compatibility window.
- [ ] Add export/import, feed/tombstone, IDB, queue, reducer/actions, and API
  parsing for each new field/store. Unsupported visual features remain unshown
  rather than misrepresented by the current UI.
- [ ] Test combined graph cycles, inherited constraints, cross-project moves,
  empty groups, cancel/reopen transitions, ordering, deleted blockers, and
  leaf-only effort/progress totals.
- [ ] Update architecture and REST/MCP references as contracts land.

Acceptance: an LLM can create/revise a subtask graph with separate targets and
deadlines, inspect blockers, and preserve existing task context through migration.

## Slice 4 — Timeblocks and deterministic planning

Depends on slices 1–3. Goal: reserve time independently of task completion.

- [ ] Add block owner/interval/placement/state constraints, working hours/date
  overrides, buffers, and explicit overlap reasons.
- [ ] Implement block create/move/swap/cancel with final-agenda validation and
  aggregate revision guards. Terminal tasks release future reservations and
  retain historical intervals.
- [ ] Add zoned agenda/free-slot search and `preview_schedule` using estimates,
  split/minimum chunks, availability, deadlines, and dependency order.
- [ ] Return missing-effort assumptions, feasible proposals, coverage, and
  unscheduled tasks/reasons. Fixed commitments and requested scope stay intact.
- [ ] Expose resource/planning methods through REST/MCP; commit proposed slots
  through the reliable command layer.
- [ ] Include blocks/settings in export/import, sync, IDB, and parsed pending
  ops. Offline reservations are explicitly provisional.
- [ ] Test adjacent/overlapping intervals, swaps, fixed/movable scope, partial
  capacity, effective deadlines, DST windows, and stale-preview conflicts.

Acceptance: reserving/moving work preserves deadlines; infeasible placement
returns reasons. No calendar view required.

## Slice 5 — Reminders and real background delivery

Depends on slices 1–3; block reminders also need slice 4. Goal: closed-app delivery.

- [ ] Add reminder owner/trigger/offset unions, generation/snooze/expiry state,
  inbox/channels, delivery/attempt tables, and due/retry indexes.
- [ ] Add create/pause/resume/rearm/snooze/acknowledge planners plus atomic
  recomputation on task/ancestor date or block changes.
- [ ] Persist notification intent with commands; enforce terminal cleanup,
  acknowledged history, missing-anchor pause, and explicit past-due policy.
- [ ] Implement bounded due-work scanning, conditional leases/fencing, capped
  retries/expiry, generation checks, channel disable, and redacted errors.
- [ ] Wire scheduled handler/one-minute cron behind a readiness gate; verify
  environments/bindings with dry-run bundling.
- [ ] Implement inbox and Worker-compatible Web Push adapter. Keep VAPID
  secrets outside portable data; add minimal permission/subscription/test-send
  enrollment and service-worker handling. This is delivery plumbing, not a
  visual redesign.
- [ ] Add reminder/inbox/delivery REST/MCP queries with honest scheduled,
  unconfigured, provider-accepted, acknowledged, missed, and failed results.
- [ ] Add quiet hours and explicit bounded repeating policies after one-shot
  delivery works. Never create implicit overdue nags.
- [ ] Export intent without credentials/subscriptions/leases; restored reminders
  remain delivery-disabled until explicit rearm/enrollment.
- [ ] Test concurrent runners, expired leases, post-acceptance crash, retries,
  generation edits, terminal races, missing anchors, acknowledgment/snooze,
  quiet hours, and outage-expiry suppression with a fake adapter.
- [ ] Verify one real opted-in device with the app closed; record acceptance,
  observed notification, and known timing/device limits.

Acceptance: actual push plus durable/queryable history; no false exactly-once
or exact-time delivery promise.

## Slice 6 — Series, occurrence identity, exceptions, and templates

Depends on slices 1–3 and 5 for reminder templates; slice 4 for schedule queries.

- [ ] Reuse timed recurrence primitives; add date-profile and after-completion
  schedule parsers/tests with separate explicit semantics.
- [ ] Extend duties and add template versions, occurrence/node keys, exceptions,
  lineage, and bounded skip-range coverage.
- [ ] Replace two-column task occurrence uniqueness before graph spawning;
  preserve compatibility identity projections and forbid edited occurrence keys.
- [ ] Add bounded lookahead including negative reminder/date offsets, coverage/
  continuation, catch-up, and ledger-backed idempotent generation.
- [ ] Add completion successors keyed by predecessor and explicit cancel/reopen
  policy; completion never spawns calendar instances.
- [ ] Add occurrence skip/override, future template versions/propagation,
  pause/resume, end/archive, and replacement-cadence operations.
- [ ] Expose series REST/MCP/aliases, previews/context, export/import/feed,
  and client data stores/parsers. Clients never independently materialize.
- [ ] Dry-run legacy migration with original values and unresolved rows listed.
  A legacy RRULE advanced from previous due is not automatically an interval
  after actual completion. Reconstruct/report equivalent calendar anchors when
  possible; retain ambiguous records on a per-record compatibility path.
- [ ] Release backfill, legacy-spawner retirement, new engine/trigger, and
  export/import support together for migrated records. Each record has exactly
  one spawner throughout; incomplete gates cannot stall recurrence.
- [ ] Test replay/races, finite exhaustion, COUNT=1, all-day rules, edited
  occurrence identity, deletion without resurrection, template boundaries,
  cap/horizon coverage, DST, high-frequency backlog, and pause/end/reopen.
- [ ] Reconcile old duties work orders as implementation settles; document
  mixed-version transition invariants.

Acceptance: early reminders/planning see future calendar instances; actual
completion drives interval series; exceptions preserve identity/history.

## Slice 7 — Queries, continuity, history, and release hardening

Depends on relevant prior slices. Goal: efficient full-model operation by an LLM.

- [ ] Add saved query ASTs, compound filters/context, pagination/sorting, and
  explainable ranking. No model-authored SQL required.
- [ ] Add append-only session/progress entries, actual work logs, explicit
  remaining estimates, and optional one-live-timer/offline reconciliation.
- [ ] Add revision-guarded undo; external notification effects remain recorded.
- [ ] Complete portable round-trip, redacted optional history, restore epoch/
  rebase/rearm, and tombstone/receipt/history retention.
- [ ] If needed, design staged large imports with full validation and atomic
  live-generation switch. Never expose half-imported state as complete.
- [ ] Expose runner health: coverage, oldest due item, queue depth, successful
  runs, expired leases, failed channels, and per-series errors. Isolate failures.
- [ ] Exercise worked intentions through actual REST/MCP on a migrated local DB,
  including an offline client's concurrent change.
- [ ] Check realistic query plans/planner costs and bounded runtime/continuation.
- [ ] Update `docs/overview.md`, `docs/api.md`, `docs/mcp-tools.md`, focused
  module narratives, and LLM-facing usage guidance around final contracts.
- [ ] Complete release checks and record acceptance evidence below.

Acceptance: full backend workflow works without redesigned views; failures and
recovery are understandable from tool results.

## Verification and release discipline

Use narrow meaningful tests during implementation; all new boundary parsers
have tests. Existing commands:

```sh
npm --prefix worker run typecheck
npm --prefix worker run test
npm --prefix worker run build:dry
npm --prefix pwa run typecheck
npm --prefix pwa run test
npm --prefix pwa run build
# Full integration/release verification when justified:
npm run verify
```

Schema/migration/dependency/Wrangler changes require Worker dry-run bundling.
Test fresh DB creation and upgrade from representative existing snapshots,
including ambiguous noon dates and legacy/finite recurrence. Back up before
production migration; use additive changes and compatibility gates. Record
rollback boundaries when new data cannot fit the old schema. Fake adapter or
foreground toast is not evidence of closed-app notification delivery.

## Progress and next-session handoff

### 2026-09-30 — Slice 1 temporal/contract foundation

Branch: `codex/power-user-slice-1`; PR review/merge pending. Migration 009 adds
empty planning settings/working hours and rewrites no legacy values. REST/MCP
capabilities, time resolution, legacy classification and parsed PWA callers are
implemented. `npm run verify` passes: Worker 276 tests, PWA 417 tests, both
typechecks, Worker dry-run (738.30 KiB / gzip 127.50 KiB) and PWA build. Targeted
coverage includes UTC−12/UTC+14, midnight gaps/folds, skipped dates, 23/25-hour
days, leap dates, explicit fold selection, offset distinctions, strict boundary
errors, fresh/upgrade SQL constraints and preservation of legacy rows. A separate
process with `TZ=Pacific/Auckland` also passes the temporal tests.

Transition: no background engine enabled; legacy task writers/spawner remain
unchanged. Settings are typed/readable but have no public writer until Slice 2
receipts/concurrency. The default is explicitly reported UTC fallback, never
host inference. Preview pages report that they are not a consistent snapshot;
Slice 3 must revalidate classification before committing migration. Public
settings export/import lands with its first writer in Slice 2. Historical wall
times with sub-minute offsets return an explicit precision error. Deployment
has not been verified; merging triggers the existing deploy workflow.

Next task: Slice 2 reliable commands/reconciliation, in deployable sub-slices
with one branch/PR each. Do not expose task-date writes before receipt, revision,
atomic-capacity and client conflict-retention guards are ready.

As work lands, append date, commit/PR if applicable, new migrations, gates and
deployment state, targeted check results, smoke evidence, compatibility limits,
and the next work item. Update checkboxes only from verified implementation.


Slice 1 review follow-up: addressed both Codex P2 findings. Fresh-db migration
bookkeeping now includes 009 (with a complete migration-list regression check).
The PWA parses v2 error envelopes and retains machine-readable codes, recovery
hints and DST alternatives; legacy authentication errors remain compatible.
Focused boundary tests and final `npm run verify` pass (276 Worker / 417 PWA
tests, both typechecks and builds). Bot re-review pending.


### 2026-09-30 — Slice 2a: atomic-plan capacity

Branch: `codex/power-user-slice-2a`, based on Slice 1; PR review/merge pending.
Deployable sub-slice of Slice 2, with no new schema or protocol gate. Every
existing pure Plan now renders/counts all actual SQL before acceptance and
executes in a single D1 batch. Oversize returns `capacity_exceeded` with an exact
statement count/limit. Import dry-run uses the same capacity check; large v1
replacement imports are rejected before even querying live counts or wiping.
REST returns 413 diagnostics and MCP retains structured capacity errors.

Acceptance: targeted 29 tests pass, including real SQLite 100-statement apply,
101-statement rejection before reads/writes, guard/log/wipe counting, empty
patches and rollback of wipe/prior inserts on late failure. Full `npm run verify` after prerequisite review fixes passes (283 Worker / 417
PWA tests, both typechecks, Worker dry-run 748.66 KiB / gzip 127.98 KiB and PWA
build).

Transition: legacy adapters remain usable for bounded commands/imports. A large
replacement cannot safely be split into independent wipes; staged restore is
explicitly deferred. No reliable-command/sync/hierarchy capability is enabled.
Next: Slice 2 receipts, stable IDs, revision/aggregate guards and feed scaffolding;
then client intent retention/reconciliation and versioned snapshot/import gates.
