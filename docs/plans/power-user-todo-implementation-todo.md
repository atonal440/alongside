# Power-user todo implementation checklist

Status: Slices 1 and 2a–2c merged/deployed. Slice 2d creation merged/deployed; guarded content edits merged/deployed. Guarded state commands merged/deployed; reliable completion merged/deployed. Guarded task fields merged/deployed. Reliable links merged/deployed. Task/project deletion merged/deployed. Bounded mixed graph batches merged/deployed. Compound lifecycle batches merged/deployed. Workspace bootstrap, delta and portable export merged/deployed; bounded v2 restore implemented with review/merge pending. Remaining Slice 2 work and Slices 3–7 remain unimplemented.
Updated: 2026-10-02.

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

- [x] Add stable client IDs/client refs, versioned command envelopes, expected
  revisions, command IDs, payload hashes, and replay receipts.
- [x] Extend pure `Plan`/SQL apply with in-batch version/aggregate guards,
  receipts, change feed, tombstones, and audit. Every writer advances revisions.
- [x] Count generated SQL including guards/logs/receipts/side effects before
  apply. Reject oversized atomic plans; eliminate unsafe multi-batch chunking
  for operations that promise logical atomicity.
- [x] Add `preview_changes`/`apply_changes`: diff, IDs/ref map, warnings,
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

### Remaining increments and review gates

Each increment receives tests and automated PR review before merge. Resolve
findings and obtain a clean review of the final head; passing CI alone is not
the review gate. Merge authorizes the existing production deployment workflow.

- **2c — legacy writer revision foundation:** entity/structural revision ledger,
  deletion records, storage triggers covering direct/Plan/import/cascade writes,
  atomic guards and parsed REST/MCP/PWA version lookup. No broad task reliability or sync
  capability enabled. Merged/deployed in PR #45.
- **2d — reliable existing task/project/link commands:** stable IDs/client refs,
  semantic command planning, coherent content/version reads, receipts and
  atomic final-state/aggregate validation. Creation-only increment merged/deployed in PR #46. Guarded content edits merged/deployed in PR #47. Guarded state, completion and task fields merged/deployed in PRs #48–#50.
  Reliable links merged/deployed in PR #51. Task/project deletion merged/deployed in PR #52. Bounded mixed creation/edit/
  state/membership/link batches merged/deployed in PR #53. Compound lifecycle
  batch effects merged/deployed in PR #54. Keep the legacy PWA usable.
- **2e — workspace sync and restore:** consistent snapshot and fixed-watermark
  deltas covering all current user data, tombstones/retention/reset policy,
  import epoch and bounded versioned export/import retaining v1 input. Bootstrap/
  all-writer feed, delta and portable export merged/deployed in PRs #55–#57; bounded
  v2 restore with epoch advance is under review.
- **2f — offline reconciliation and capability gate:** canonical IDB data plus
  ordered optimistic commands, retained conflicts/failed intent and inspectable
  rebase. Canonical store and staged pulls are the first increment (review pending). Negotiate versions and gate incompatible writers only after the
  compatible PWA and backend protocol are ready together.

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


Slice 1 second review follow-up: reference schema creation is safely repeatable;
one-time migration DDL stays strict. Offset input schemas/domain resolution
reject inapplicable anchors and require elapsed-date anchors. DST errors name
`offset.localTime` or `dateAnchorTime`. Added table-initialization preservation,
8-case anchor-matrix and offset-error-path regressions. Final checks and bot
re-review are recorded on the PR before merging.


Slice 1 final edge check: offset probes now handle internal year-zero/five-digit
Intl years at the supported AD range boundaries; final results remain validated
as 0001–9999 instants. Regression verifies year 0001/9999 wall times and a
structured out-of-range error for the last date's exclusive end. Full verification
passes: 288 Worker / 417 PWA tests, both typechecks, Worker dry-run and PWA build.


Slice 1 additional review hardening: all v2 JSON error bodies are parsed,
including branded strict DST alternatives; only validated unversioned string
errors use the legacy fallback. Arithmetic overflow names submitted offset
fields. Availability resolves only its requested start; calendar arithmetic
can re-enter the supported AD range from an instant's internal zoned projection.
Historical boundaries requiring seconds are rejected explicitly. New regressions
cover malformed versioned/nested JSON, overflow paths, availability at year 9999,
calendar re-entry from years zero/10000 and historical boundary precision.
Full `npm run verify` passes: 296 Worker / 424 PWA tests, both typechecks/builds.

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

Slice 2a inherited verification: merged the temporal foundation's complete
review fixes without rewriting branch history. Full `npm run verify` passes:
303 Worker / 424 PWA tests, both typechecks, Worker dry-run (752.67 KiB / gzip
128.81 KiB) and PWA build. Atomic-capacity functionality remains the only Slice 2
contract enabled here; receipts/revisions/client reconciliation follow separately.

### 2026-09-30 — Verified merges and deployments

Slice 1 PR #42 merged as `b5374e2`; Slice 2a PR #43 merged as `43730cf`.
Each had a clean Codex review covering its final head, green GitHub checks, and
no unresolved review threads. Both Worker migration/deployment and PWA Pages
jobs succeeded (Deploy runs 36799285769 and 36799581012). Earlier pending-status
paragraphs above record intermediate history rather than current release state.

### 2026-09-30 — Slice 2b: reliable planning-settings commands

Branch: `codex/power-user-slice-2b`; PR review/merge pending. This deployable
sub-slice adds the first complete command family: a single `planning.set`
replacement with strict v2 envelope, caller command ID, expected revision,
canonical payload hash, preview and apply. Migration 010 adds permanent replay
receipts, command audit and an internal settings-only change feed. The shared
Plan compiler counts all revision guards/receipts/settings rows/audit/feed; one
transaction commits them together. Settings reads use one coherent SQL snapshot.

Acceptance: `npm run verify` passes with 328 Worker / 432 PWA tests, both
typechecks, Worker dry-run (763.59 KiB / gzip 133.43 KiB) and PWA build. New tests
cover lost-response replay, ID/hash mismatch, a replay after later edits,
pre-read and in-batch concurrency races, late audit/feed failure rollback,
strict REST/MCP/PWA parsers and portable settings-value round-trip.

Transition: task/project/link writers and the existing PWA task queue still
use legacy sync. Broader `reliableCommands` and `deltaSync` gates remain false.
The preferences export is scoped; restore non-null values with a fresh
`planning.set` identity and the destination revision. Legacy v1 export/import
preserves but excludes settings and receipts. No offline settings form/store,
aggregate graph/calendar revision, public feed or full workspace restore is
claimed by this sub-slice. See the reliable-settings narrative for usage.

Next: extend reliability to existing task/project/link writers with stable
client IDs, entity/aggregate revisions, tombstones, coherent snapshot/delta
sync and retained offline intent. Full v2 export/import and import epoch must
land with that workspace protocol before richer graph/date writes are enabled.

Slice 2b runtime acceptance: isolated local D1/Worker smoke on port 8789 passes
REST preview-without-writes, first apply, exact replay after later edits,
ID/hash and revision conflicts, export, workspace capability setup and MCP
replay/settings reads. The test used `/tmp/alongside-slice2b-smoke` and did not
modify the normal development database. No production settings were configured.

Slice 2b review follow-up: regenerated and committed the Drizzle diff-helper
journal, catch-up SQL and latest snapshot through hand-written migrations
007–010. These artifacts stay outside Wrangler's deploy migration directory.
A second `db:generate` reports no schema changes; a regression checks snapshot
tables/columns/indexes against fresh and upgraded schemas, allowing only the
known retired upgrade-only `tasks.session_id` column. Shared declarations now
include the three task indexes already installed by migration 001. The optional deploy
bookmark workflow change was omitted because the GitHub token lacks workflow
scope; the existing deployment jobs remain unchanged.

Slice 2b final review verification: full `npm run verify` passes with 330 Worker /
432 PWA tests, both typechecks, Worker dry-run (763.73 KiB / gzip 133.47 KiB) and
PWA build. Fresh/upgrade snapshot parity and an unchanged `db:generate` verify
the review fix. Bot re-review is required on the pushed fix before merge.


### 2026-10-01 — Slice 2c: legacy writer revision foundation

PR #44 merged as `d56080d`; the clean automated review covered `f892bbe` and
Deploy run 36808885930 succeeded for Worker migration 010 and PWA Pages.

Branch: `codex/power-user-slice-2c`; automated review/merge pending. Migration
011 backfills existing task/project/link/duty identities at revision zero and
installs storage triggers maintaining entity revisions, retained deletion
records and a conservative workspace structural revision. This catches direct
Drizzle, raw SQL, Plan, recurrence, bulk detachment, v1 import and FK cascade
writers without changing their legacy row/IDB contracts. Recreated IDs keep
increasing revisions. Exhaustion and late failures roll back the original write.

Plan supports entity/aggregate guards inside its transactional batch, counted
by the generated SQL compiler. One coherent version lookup is exposed through
REST/MCP and the parsed PWA API client. No task command, public delta feed,
calendar revision, import epoch or offline overlay is claimed by this step.
See [the transition contract](../shared/entity-versions.md).

Acceptance: full `npm run verify` passes (359 Worker / 443 PWA tests, both
typechecks, Worker dry-run 769.24 KiB / gzip 134.42 KiB, PWA build). Fresh and
upgraded schema/snapshot parity passes; a second `db:generate` reports no
changes. Real SQLite tests cover race guards, legacy writers, rollback,
backfill, delete/recreate, cascades with recursive triggers on/off, and revision
exhaustion even under outer OR IGNORE/REPLACE policies. Isolated Wrangler/D1
migrations 001–011 and REST/MCP smoke on port 8789 passed version reads, legacy
updates, link cascade tombstones, strict inputs and unchanged capability gates.
Normal development and production data were not modified by local testing.
Automated review and merge remain pending.
Next: reliable existing task/project/link command families with coherent
content/version reads, stable IDs/ref maps and receipts; then workspace sync,
restore epochs and retained offline intention. Broad capability gates stay off.


### 2026-10-01 — Slice 2d first increment: stable creation

PR #45 merged as `055c6c0` after clean Codex review of final head `cf2d655`,
green checks and no outstanding threads. Deploy run 36921944334 succeeded for
both Worker migration 011 and PWA Pages.

Branch: `codex/power-user-slice-2d-create`; automated review/merge pending.
Adds single `task.create`/`project.create` commands with stable caller IDs,
scoped ref mapping, guarded project references, aggregate/identity checks,
receipt/audit/feed, and original-result replay. Coherent `get_entity` reads
content plus entity/aggregate versions; parsers enforce identity and tombstone
pairing. Migration 012 broadens the command feed without resetting old sequence
allocation. Settings commands/receipts and legacy PWA operations remain usable.

Transition: no task edits/lifecycle/link or mixed graph batch commands yet.
Creation is deliberately undated/nonrecurring until explicit date commands;
legacy date/recurrence creation remains available. No delta sync, restore epoch,
full v2 backup, IDB overlay or old-client write gate is claimed. Broad capability
gates remain false. See [reliable creation](../shared/reliable-creation.md).

Acceptance: `npm run verify` passes with 384 Worker / 457 PWA tests, both
typechecks/builds and Worker dry-run 786.70 KiB / gzip 137.71 KiB. Fresh/upgraded
snapshot parity and an unchanged second Drizzle generation pass. Real SQLite
tests cover original-result replay after edits/deletion, lost responses,
concurrent identity/phantom races, guarded project references, late rollback,
ref/row identity parsing, aggregate exhaustion and feed retention/watermark
migration. Isolated local D1 migrations 001–012 and REST/MCP smoke passed
preview, stable creation, project assignment, exact replay and structured
conflicts with capability gates still off. No production test writes occurred.

Next: guarded edit/lifecycle/project/link families and bounded graph batches,
then workspace snapshot/delta sync and restore epochs, then retained offline
command overlays and compatibility gating. Each PR requires clean automated
review on its final commit and green checks before merge.


### 2026-10-01 — Slice 2d second increment: guarded content

PR #46 merged as `aec027e` after clean automated review of final head
`37348c4`, green checks and no outstanding threads. Deploy run 36924869993
succeeded for both Worker migration 012 and PWA Pages.

Branch: `codex/power-user-slice-2d-edits`; automated review/merge pending.
Adds `task.content.set`/`project.content.set` using coherent content/version
reads, in-batch entity revision assertions and replay receipts. The complete
text replacement preserves all managed fields, including done/archived state;
unrelated edits may commit concurrently. Before/after images retain revisions
for later history/undo. No migration or broad capability gate change.

Acceptance: full `npm run verify` passes (409 Worker / 463 PWA tests, both
typechecks/builds, Worker dry-run 793.13 KiB / gzip 138.61 KiB). Tests cover
legacy edit/deletion races, identical replay after lost response and later
writes, managed-field preservation, terminal state, late rollback, unrelated
concurrent edits and durable exhaustion. Isolated REST/MCP smoke passed
preview, edit, preserved dates/recurrence, exact replay and parsed conflicts.
See [guarded content](../shared/reliable-content.md).

Content review follow-up: corrected the API reference's inherited settings-only
conflict description. It now distinguishes currentSettings/currentEntity,
live/deleted/unknown identities, selected-project conflicts, structural conflicts
and ID/payload reuse. The fix changes docs only; automated re-review is required
on the updated head before merge.

Next: lifecycle, association/link commands and bounded compound batches; then
full sync/restore protocol and offline retained intention/compatibility gate.


### 2026-10-01 — Slice 2d third increment: guarded state

PR #47 merged as `fd19abe` after clean automated review of final head
`bbcc52f`, green checks and no outstanding threads. Deploy run
36928138980 succeeded for both Worker and PWA Pages.

Branch: `codex/power-user-slice-2d-state`; automated review/merge pending.
Adds task focus/deferral/reopen and project archive/reopen using coherent
reads, entity guards, receipts and before/after diffs. Preserves legacy
transitions and recurrence successor behavior; no migration, member/link
mutation or capability gate change. See [guarded state](../shared/reliable-state.md).

Acceptance: `npm run verify` passes (442 Worker / 469 PWA tests, both
typechecks/builds, Worker dry-run 799.48 KiB / gzip 139.68 KiB). Real SQLite
tests cover fresh/upgrade transitions, preserved managed fields/membership,
minute-normalized replay, stale/deleted identities, legacy races, identical
concurrent execution, invalid transitions, late rollback and exhaustion.
Isolated local REST/MCP smoke passed preview, transitions, replay, parsed
conflicts and unchanged capability gates. No production test writes occurred.

Next: reliable completion with explicit successor identity, association/link
commands and bounded compound batches; then sync/restore and offline retained
intention/capability gates. Future richer lifecycle semantics remain in Slice 3.


State review follow-up: updated the earlier MCP command matrix/summary to
include all supported state transitions. The detailed reference was already
present; the summary now agrees. Docs-only fix; final-head automated re-review
required before merging.


State second review follow-up: the command instant parser now matches the
legacy task-row codec's normalized UTC year range (0100–9999). Foundation
temporal resolution still supports 0001–9999. Earlier years, including an
offset crossing below 0100, fail at the command boundary before planning;
boundary and real-storage regression checks cover both focus and deferral.
Completion work remains separately preserved while this PR is re-reviewed.

### 2026-10-01 — Slice 2d fourth increment: reliable completion

Branch: `codex/power-user-slice-2d-complete`; automated review/merge pending.
Adds `task.complete` with entity/structural guards and a caller-stable successor
ID for legacy recurrence. One transaction commits completion, successor,
receipt/audit/feed and ledgers; replay returns both original images. Preserves
existing recurrence behavior and the single legacy spawner; no migration or
broad capability gate change. See
[reliable completion](../shared/reliable-completion.md).

Acceptance: final `npm run verify` passes (474 Worker / 484 PWA tests,
both typechecks/builds, Worker dry-run 807.59 KiB / gzip 140.88 KiB).
Fresh/upgrade SQLite tests cover stable successor inheritance, preview,
original-result replay after changes/deletion, concurrent identical execution,
entity/structural/identity races, complete rollback and revision exhaustion.
PWA boundaries reject malformed compound IDs/revisions/refs. Isolated local
REST/MCP smoke passed recurring and one-off completion, preview without writes,
replay after successor deletion and structured conflicts. No production test writes.

Next: deletion/association/link commands and bounded compound graph batches;
then workspace sync/restore and retained offline intention/capability gates.


### 2026-10-01 — Slice 2d fifth increment: guarded task fields

PR #48 merged as `a85f5ac` after clean automated review of final head `f6b41c8`,
green checks and resolved findings. Deploy run 36931234429 succeeded for Worker
and PWA Pages. Its final review fix verification passed 447 Worker / 472 PWA
tests, both typechecks/builds and Worker dry-run.

PR #49 merged as `522e93f` after clean automated review of final head `111d768`,
green checks and zero threads. Deploy run 36931908836 succeeded for Worker
and PWA Pages.

Branch: `codex/power-user-slice-2d-task-fields`; automated review/merge pending.
Adds task project/type/legacy-schedule commands with guarded membership,
explicit date classification and preservation of other fields. Existing
lifecycle/recurrence and broad gates remain unchanged. No migration. See
[guarded task fields](../shared/reliable-task-fields.md).

Acceptance: `npm run verify` passes (505 Worker / 493 PWA tests, both
typechecks/builds, Worker dry-run 813.82 KiB / gzip 141.77 KiB). Fresh/upgrade
SQLite tests cover membership guards, selected-project conflicts, legacy races,
exact replay after changes/deletion, rollback, preserved terminal/content state,
explicit classification and command-boundary rejection. Isolated REST/MCP
smoke passed preview without writes, assignment, type/date changes, replay,
selected-project diagnostics and unchanged capability gates.

Next: reliable link/deletion commands and bounded mixed graph batches; then
workspace sync/restore and retained offline intention/capability gates.


### 2026-10-01 — Slice 2d sixth increment: reliable links

PR #50 merged as `95e6689` after clean automated review of final head `72745c5`,
green checks and zero threads. Deploy run 36932770328 succeeded for Worker and
PWA Pages.

Branch: `codex/power-user-slice-2d-links`; automated review/merge pending.
Adds coherent link reads and guarded add/remove with retained identities,
canonical related additions, legacy reverse-edge cleanup, atomic blocks-cycle
guards and exact replay. Migration 013 broadens feed identity/deletion images
and preserves history/sequence. Broad gates remain off. See
[reliable links](../shared/reliable-links.md).

Acceptance: `npm run verify` passes (536 Worker / 512 PWA tests, both
typechecks/builds, Worker dry-run 826.90 KiB / gzip 144.37 KiB). Fresh/upgrade
SQLite tests cover revisions/tombstones, races, lost responses, rollback, cycle
rejection, recursive triggers, feed constraints and migration allocator/history.
PWA parsers reject malformed identities/versions/diffs and preserve current-link
conflicts. Isolated migration and REST/MCP smoke passed preview without writes,
add/remove/revive, replay, cycle rejection, reverse legacy collision and unchanged
capability gates. Drizzle regeneration reports no further changes.

Next: task/project deletion and bounded mixed graph batches; workspace
sync/restore and retained offline intention/capability gates follow.


### 2026-10-01 — Slice 2d seventh increment: reliable deletion

PR #51 merged as `8f4ac3f` after clean automated review of final head `1ae5c36`,
green checks and the resolved API reference finding. Deploy run 36935324269
succeeded for Worker (including migration 013) and PWA Pages.

Branch: `codex/power-user-slice-2d-delete`; automated review/merge pending.
Adds guarded task/project deletion with coherent, complete cascade/detachment
images and exact replay. Bounds count all generated SQL before writes; one
task with 93 incident edges or project with 31 members fits 100 statements.
Projects owning duties return a durable rejection until reliable duty ownership
commands exist. No migration; broad gates remain off. See
[reliable deletion](../shared/reliable-deletion.md).

Acceptance: `npm run verify` passes (554 Worker / 526 PWA tests, both
typechecks/builds, Worker dry-run 838.55 KiB / gzip 146.46 KiB). Fresh/upgrade
SQLite tests cover complete effects, exact capacity boundaries, phantom races,
identical/lost-response replay, rollback, revision exhaustion and duty ownership.
PWA parsers reject malformed deletion/cascade data and retain exact capacity
diagnostics. Isolated REST/MCP smoke passes preview without writes, member
detachment/preserved context, task/link tombstones, replay, stale deletion
conflicts, exact capacity rejection and unchanged capability gates.

Next: bounded mixed graph batches; workspace sync/restore and retained offline
intention/capability gates follow.

Deletion review follow-up: response parsing now compares every detached member
field against its before image, allowing only a null project and the command's
server timestamp. Regressions reject altered titles, terminal status, dates or
timestamps. Full verification passes 554 Worker / 530 PWA tests, both
builds/typechecks and Worker dry-run (838.78 KiB / gzip 146.52 KiB).


### 2026-10-01 — Slice 2d eighth increment: bounded mixed batches

PR #52 merged as `566d00f` after clean automated review of final head `9b66d15`,
green checks and the resolved detached-member parser finding. Deploy run
36936717750 succeeded for Worker and PWA Pages.

Branch: `codex/power-user-slice-2d-batches`; automated review/merge pending.
Adds 2–20-command mixed creation/edit/state/membership/link envelopes with
base structural guards, distinct written identities, scoped refs, virtual
semantic planning, final dependency graph checks and one receipt/audit. SQL
guards retain original revisions; edge removals precede adds and final guards
run inside the same transaction. No migration or broad gate change. See
[bounded mixed batches](../shared/reliable-batches.md).

Acceptance: full `npm run verify` passes 573 Worker / 540 PWA tests, both
typechecks/builds and Worker dry-run (852.15 KiB / gzip 149.14 KiB). Two additional
focused acceptance cases pass: the final SQL graph guard rolls back staged
cycles, and aggregate exhaustion rejects the whole batch before writes (575
Worker tests total; all 21 focused batch tests pass). Fresh/upgrade cases cover
creation/ref graphs, edge reversal/removal order, reverse legacy cleanup, new
cycles, phantom/identical/lost-response races, rollback, original revision guards,
stored conflict images, exact 100/103-statement boundaries and REST/MCP parity.
PWA parsers reject malformed markers/identities/refs/guards and unsupported
lifecycle deletion images. Isolated REST/MCP smoke passes mixed preview, atomic
creation, refs, replay, final-edge replacement, cycle rejection and unchanged gates.

Next: compound lifecycle batches; workspace sync/restore and retained offline
intention/capability gates follow.


### 2026-10-01 — Slice 2d ninth increment: compound lifecycle batches

PR #53 merged as `6a18000` after clean automated review of final head `ef796ad`,
green checks and zero threads. Deploy run 36938040323 succeeded for Worker
and PWA Pages.

Branch: `codex/power-user-slice-2d-lifecycle-batches`; review/merge pending.
Completion/deletion now compose with other task/project/link commands, with
`changeGroups` preserving each standalone derived-effect contract. New/derived
identities obey the same write-once rule; scoped refs cover stable successors.
Legacy simple mixed receipts remain readable. No migration or broad gate change.
See [compound lifecycle effects](../shared/reliable-batches.md#compound-lifecycle-effects).

Acceptance: full `npm run verify` passes 586 Worker / 554 PWA tests, both
typechecks/builds and Worker dry-run (854.97 KiB / gzip 149.78 KiB). Four additional
focused lifecycle cases pass (590 Worker tests total; all 15 lifecycle tests):
combined 98/101-statement capacity, linking a stable successor and explicit
member movement before project deletion. Fresh/upgrade tests cover grouped
completion/cascade/detachment, loss/concurrency/rollback, overlap rejection and
exact replay. PWA parsers reject malformed groups and altered member fields,
retain old simple receipts and reject duplicate creation/successor refs. Isolated
REST/MCP smoke passes grouped preview without writes, completion/successor/link,
cascade plus survivor edit, project detach with terminal preservation, replay
and unchanged gates.

Next: all-writer workspace snapshot/feed foundation, fixed-watermark delta sync,
versioned restore/import epoch, then retained offline commands and capability gates.

Lifecycle review follow-up: standalone and grouped completion receipts now verify
all preserved source fields, the exact terminal-state patch, the derived successor
content/kickoff, the shared recurrence calculation and server timestamps. Both
apply and preview boundaries reject altered images and missing/extra successors.
Full verification passes 590 Worker / 590 PWA tests, both typechecks/builds and
Worker dry-run (856.56 KiB / gzip 150.16 KiB).

### 2026-10-01 — Slice 2e first increment: all-writer feed and coherent bootstrap

PR #54 merged as `34b931b` after clean automated review of final head `04d2506`,
green checks and zero unresolved threads. Deploy run 36941594353 succeeded for
Worker and PWA Pages.

Branch: `codex/power-user-slice-2e-sync-foundation`; review/merge pending.
Migration 014 captures all eight current user-data families, including legacy
writers, raw SQL, FK cascades and provenance. Auxiliary revisions, monotonic
sequence/epoch/floor metadata and atomic feed failure guards complement the
existing entity ledger. A parsed REST/MCP/PWA workspace snapshot reads all rows,
tombstones, revisions and its cursor with one SQL statement. Credentials and
receipts are excluded. No broad capability gate change. See
[workspace sync bootstrap](../shared/workspace-sync.md).

Acceptance: full `npm run verify` passes 613 Worker / 616 PWA tests, both
typechecks/builds and Worker dry-run (870.75 KiB / gzip 152.77 KiB). Fresh/upgrade tests cover all source families, exact row/
feed agreement, no-op writers, cascade/delete/recreate, auxiliary replacements,
hour projections, exhausted counters, late failure rollback, retained revisions,
history purge, strict input, v1 import capture and REST/MCP parity. PWA rejects
invalid identities, cursors, source fields, live references and credentials.
Isolated Wrangler migration and REST/MCP smoke pass coherent bootstrap, legacy/
reliable capture, no preview/replay events, tombstones and unchanged gates. The
real D1 smoke caught its lower compound-SELECT limit; the query now unions only
two ledgers and selects row projections by entity, preserving one-read consistency.

Next: fixed-watermark delta pagination and explicit reset responses, then bounded
versioned restore/import epochs and retained offline commands/capability gates.

Bootstrap review follow-up: snapshot SQL returns one entity per query row with
matching cursor metadata instead of aggregating the entire workspace into a D1
value. Empty workspaces retain a metadata-only result. Regressions and the real
local Worker verify a 250-task workspace larger than 2 MB. Full verification
passes 615 Worker / 616 PWA tests and Worker dry-run (871.01 KiB / gzip 152.81 KiB).

Legacy compatibility review follow-up: sync read codecs preserve `snooze_task`
in historical logs and the previously advertised preference choices without
rewriting source rows or broadening current write validation. Git history
confirms the former names/values; pre-014 upgrade and PWA boundary regressions
cover them. Full verification passes 616 Worker / 622 PWA tests and Worker
dry-run (871.24 KiB / gzip 152.93 KiB).

### 2026-10-01 — Slice 2e second increment: fixed-watermark delta reads

Branch: `codex/power-user-slice-2e-delta`; based on the bootstrap increment while
its final automated review is pending. Delta pages expose historical images,
strict sequence/revision relationships, one upper watermark across continuations
and explicit 409 reset diagnostics for epoch, retention and invalid future cursors.
PWA parsing verifies the requested range/watermark/limit as well as entity fields.
Both bootstrap and delta queries return separate D1 rows. No migration or broad
gate change; canonical/offline integration remains later. See
[fixed-watermark pulls](../shared/workspace-sync.md#fixed-watermark-delta-pulls).

Acceptance: full `npm run verify` passes 635 Worker / 643 PWA tests, both
typechecks/builds and Worker dry-run (877.99 KiB / gzip 154.34 KiB). Fresh/upgrade
cases cover interleaved writes, historical images, cascade/deletion/resurrection,
reset reasons and in-flight expiry, allocator gaps, strict REST/MCP inputs and
all-family staged reconciliation. PWA rejects malformed pages, changed request
ranges/watermarks, invalid entities/revisions and missing reset diagnostics.
Isolated actual-D1 smoke passes a 2.63 MB page, fixed-watermark continuations,
next-pull mid-write delivery, REST/MCP parity, explicit reset, limits and gates.

Next: bounded versioned workspace restore/export and import epoch transitions,
then canonical IDB/retained offline intentions and capability negotiation.

### 2026-10-01 — Slice 2e third increment: coherent portable export

PR #55 merged as `621efa8` after clean automated review of final head `49bf3d2`,
green checks and all three findings resolved. Deployment 36945020841 succeeded,
including migration 014 and both Worker/PWA deployments. PR #56 delta received a
clean review of `9455248`; synchronizing the production base produced `66cd2b7`,
which is awaiting its final fresh review/CI before a separate merge.

Branch: `codex/power-user-slice-2e-export`; review/merge pending. Adds a version 2
portable document containing all eight current live user-data families and
provenance from one coherent read. Strict fields/references preserve current and
supported historical values; credentials, receipt/replay data, sync/version
metadata and tombstones are excluded. Existing v1 export/import stays available.
Version 2 restore follows separately. See
[workspace portability](../shared/workspace-portability.md).

Acceptance: full `npm run verify` passes 640 Worker / 658 PWA tests, both
typechecks/builds and Worker dry-run (882.00 KiB / gzip 155.38 KiB). Fresh/upgrade
cases cover all families, one-read/no-write behavior, historical values/provenance,
portable key scope, tombstone exclusion, empty data and v1 compatibility. PWA
rejects unsupported fields, duplicate identities, invalid rows and live references.
Actual local D1 smoke passes a 2.65 MB export, live-row counts, REST/MCP parity,
unchanged cursor, strict inputs and the existing v1 export.

Next: bounded restore/preflight, portable archival audit and import epochs,
then canonical IDB/retained offline intentions and capability negotiation.

### 2026-10-02 — Slice 2e fourth increment: bounded atomic v2 restore

PRs #56 and #57 merged (delta `da9fbb8`, export `cb3b182`).

Branch: `claude/zen-planck-4ykmrm`; review/merge pending. Adds `restore_workspace` /
`POST /api/v2/restore` / `api.restoreWorkspace`: preflight (no writes) and apply of
a v2 export as one atomic batch guarded by the caller's sync cursor, advancing the
epoch before the wipe/insert so old cursors reset. Capacity above 100 statements is
rejected before writes; incoming command audit is validated but not restored. See
[restoring a v2 export](../shared/workspace-portability.md#restoring-a-version-2-export).

Next: staged restore for larger workspaces, archival audit storage and v1 input with
migration diagnostics, then canonical IDB/retained offline intentions and capability
negotiation.

Acceptance: full `npm run verify` passes 652 Worker / 670 PWA tests, both
typechecks/builds and Worker dry-run (894.33 KiB / gzip 158.37 KiB). Fresh/upgrade
cases cover preflight without writes, full replacement and round-trip equality,
tombstoned dropped rows, empty restore, epoch reset of old cursors, stale and raced
cursors, 413 oversize, cycle/occurrence rejection, late-failure rollback including
the epoch, retained receipts and REST/MCP parity. PWA tests reject mismatched mode,
cursor, counts and malformed results.

Review follow-ups: the blocks-cycle search is now iterative (also protecting v1 import),
so oversize rejection comes from exact plan counting alone; legacy `related`
self-links round-trip; a lost apply response reports `restore_outcome_unknown` rather
than claiming nothing changed. Restore does not re-run per-task domain validation, so
backups keep every stored row exactly as exported.

### 2026-10-02 — Slice 2f first increment: canonical store and staged pulls

PR #58 merged as `b5b6bcb` (bounded v2 restore with epoch advance; deploy triggered).

Branch: `claude/slice-2f-reconcile`; review/merge pending. IDB v5 adds a canonical
server-state cache (versioned entity images, tombstones, cursor) read through strict
boundary parsing, and `pullWorkspace` stages snapshot/delta pages and commits them
atomically, falling back to one bootstrap on sync resets or inconsistent pulls. It
is not yet wired into UI state or the legacy flush; no capability gate changes. See
[canonical workspace](../pwa/sync/canonical-workspace.md).

Acceptance: full `npm run verify` passes 652 Worker / 704 PWA tests, both
typechecks/builds and Worker dry-run (895.37 KiB / gzip 158.71 KiB). New tests cover
pure reconciliation (revision regression/equality, discontinuity, moved watermark,
incomplete/empty pulls, cross-page dangling references, final dangling state),
IDB round trip/replace/commit/abort/corruption-as-miss, the v4→v5 upgrade, and
pull orchestration (bootstrap, fixed-watermark continuation, mid-pull failure,
resets, non-reset 409/401, inconsistent pull fallback, single-flight).

Next: reducer/UI integration of canonical state with an optimistic command overlay,
retained conflicts and inspectable rebase, then version negotiation and the gate.
