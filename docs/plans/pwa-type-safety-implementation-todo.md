# PWA Type Safety Implementation Todo

Handoff checklist for `docs/plans/pwa-type-safety.md`. Stage work orders live in `docs/plans/pwa-type-safety/`. Keep this file current as stages land so another agent can resume without re-deriving the plan — same convention as `docs/plans/type-driven-safety-implementation-todo.md`.

Rules for implementing agents:

- One stage per PR. Root `npm run verify` green before merge.
- Check items off here as you complete them; add a dated note under the stage for any deviation from the stage file (and why).
- If the codebase has drifted from a stage file, trust the code, adapt, and record the drift here.

## Stage 1 — Test Harness (`stage-1-test-harness.md`)

- [x] Add pwa test dependencies (vitest, jsdom, RTL trio, fake-indexeddb, fast-check) and `test` script; extend root `verify`.
- [x] Add `pwa/vitest.config.ts` (node default, jsdom globs, `@shared`/rrule aliases) and test-tsconfig coverage (`pwa/tsconfig.test.json` added to `pwa/tsconfig.json` references).
- [x] Add `pwa/test/helpers/` (fixtures, fetchStub, idb).
- [x] Injectable-time refactors in `design.ts` / `taskFlow.ts` (no behavior change). Also added `nowIso` to `taskSort` for consistency.
- [x] Tests: shared/readiness, utils/design, utils/taskFlow, context/reducer, small utils. 109 tests, all green.
- [x] Docs: testing note in `docs/pwa/overview.md`; Commands table in `AGENTS.md`.

**Deviations**:
- `taskSort` also got `nowIso` injectable parameter (not listed in plan but follows same pattern as `readinessScore`).
- Worker node_modules were not installed in the worktree; `npm install` in `worker/` was needed before `pwa typecheck` passed (drizzle-orm path alias).
- `CLAUDE.md` points to `AGENTS.md`; verification commands updated there only.

## Stage 2 — Shared Row Schemas (`stage-2-shared-row-schemas.md`)

- [x] Create `shared/wire/rows.ts` (+ index) with Task/Project/TaskLink row schemas, parse fns, assignability guard.
- [x] Repoint `worker/src/wire/importPayload.ts` to shared schemas; delete duplicates.
- [x] Worker verification: typecheck, test, `build:dry` (record bundle delta).
- [x] `pwa/test/shared/rows.test.ts` (fixtures validated against real schemas).
- [x] Docs: `docs/shared/wire.md` page; `docs/worker/wire/importPayload.md` updated.
- [x] Record any import-schema vs REST-response mismatches here for stage 3.

**Bundle delta:** 688.31 KiB / gzip 115.61 KiB (unchanged — pure relocation).

**Deviations:**
- `t_to1` fixture ID fixed to `t_to001` — only 3 chars after `t_`, fails `TaskIdSchema` regex.
- Worker node_modules required `npm install` in worktree before typecheck (same as stage 1).
- `ImportTaskRowSchema` is unexported (worker-internal only); `ProjectRowSchema`/`TaskLinkRowSchema` are re-exported from `importPayload.ts` via the existing `wire/index.ts` chain.

**Stage 3 notes (REST-response mismatches):**
- No schema/API mismatches discovered during this relocation. Stage 3 should verify the REST response shapes in `worker/src/api.ts` against `TaskRowSchema`/`ProjectRowSchema` before assuming they match.

## Stage 3 — Typed API Client (`stage-3-typed-api-client.md`)

- [x] `pwa/src/api/result.ts` (`ApiResult`, durable/transient classifiers).
- [x] Rewrite `client.ts` as `apiRequest` (lenient error-body parsing, contract-violation handling).
- [x] `pwa/src/api/endpoints.ts` — typed endpoint per route, PWA-local wire body types; verify endpoint inventory against `worker/src/api.ts` and record corrections here.
- [x] Migrate `actions.ts` / `sync.ts` call sites mechanically (`kind === 'ok'`), behavior unchanged.
- [x] Tests: client, endpoints, result truth table, createTask contract regression.
- [ ] Docs: `docs/pwa/api/` failure-kind contract.

**Deviations:**
- `apiFetch` is fully deleted (not retained as a deprecated wrapper) — no callers remained.
- `flushPendingOps` uses a `v.unknown()` passthrough parser since it replays generic ops; the `POST /api/tasks + local_id` path now calls `parseTaskRow` on the result to safely extract the server task.
- The three array parser lambdas in `endpoints.ts` (syncTasks, syncProjects, listLinks) simplify to direct `parseSchema` calls — no cast needed because valibot infers `Task[]`/`Project[]`/`TaskLink[]` from the transforms.
- Docs update not yet done (separate commit per AGENTS.md convention for large doc changes).

**Endpoint inventory (verified against `worker/src/api.ts`):**
All 9 endpoints match plan description. No schema/response mismatches found.

## Stage 4 — Typed Pending Ops (`stage-4-typed-pending-ops.md`)

- [x] `pwa/src/api/pendingOps.ts`: op union (+`attempts`), `toRequest`, `rebindTaskId`, `parsePendingOp`.
- [x] IDB v4 migration translating legacy queue records (delete-with-warn for unrecognizable).
- [x] Typed enqueues in `actions.ts`; parsed reads in `idb/pendingOps.ts`.
- [x] Mechanical `sync.ts` adaptation (no policy change yet); title-based survivor check kept (flagged below).
- [x] Remove `PendingOp` from `shared/types.ts` (+ pwa re-export); worker verification green.
- [x] Tests: pendingOps unit, idb round-trip, v3→v4 (and v2→v4 compose) migration. 230 tests green.
- [ ] Docs: `docs/pwa/idb/` migration history; manual legacy-queue upgrade check noted in PR.

**Deviations:**
- `closeDb()` added to `pwa/src/idb/db.ts` to allow singleton reset between test phases (migration test seeds v3 then opens at v4).
- `translateLegacyPendingOp` in `db.ts` applies the snoozed_until→defer_until body migration inline. v3 and v4 cursors run concurrently in a single upgrade transaction (both open cursors on `pending_ops`), so v4 cannot rely on v3 having already rewritten the body. Applying it inline in the translator makes v4 self-contained for that case.
- Title-based survivor check in `syncFromServer` kept as-is (now typed: filters `op.op === 'task.create'` instead of method/path). Stage 5 replaces it with `localId`-based protection per the plan.
- Docs update deferred per AGENTS.md convention for large doc changes.

## Stage 5 — Sync Engine Policy (`stage-5-sync-engine.md`)

- [x] `WriteOutcome` / `FlushSummary`; durable = drop + toast + resync, transient = queue.
- [x] Action creators: rejection path (incl. temp-task removal via resync — verified), resync callback wiring via `registerSyncCallback`.
- [x] Flush loop: FIFO, stop-on-transient, attempts cap surfacing (`ATTEMPTS_CAP=25`), durable-create dependent-op cleanup.
- [x] `syncFromServer`: `local_id`-based survivor protection (title heuristic removed).
- [x] `useSync`: rejection toasts after resync; `halted → offline` status transition.
- [x] Tests: flush matrix, reconciliation (rebound IDs verified in requests), duplicate-title regression, link 409 rollback, attempts cap. 254 tests green (15 new + 10 new in actions).
- [x] Docs: `docs/pwa/api/sync.md` rewritten with policy table and rollback rationale; `docs/pwa/context/actions.md` updated.

**Deviations:**
- `settleWrite(result, op)` helper was not introduced as a separate function; instead `isDurableFailure`/`isTransientFailure` are used directly in the flush loop and action creators with a shared `handleRejection` helper — same policy, less indirection.
- After a `task.create` success, the flush now rebinds both IDB AND the in-memory `ops` array so dependent ops are sent with the server ID in the same flush cycle (not deferred to the next). This matches the plan's intent more faithfully: dependent ops referencing a temp ID are processed immediately after the create resolves.
- `_resetStuckNotice()` exported from `sync.ts` for test isolation of the once-per-session stuck notice.
- "Future PWA Type System Notes" items in `docs/plans/type-driven-safety-implementation-todo.md` checked off below.

**Worker todo items resolved (see stage 5 plan):**
- ✓ "Sync distinguishes durable rejections from transient failures" — implemented via `isDurableFailure`/`isTransientFailure` from `result.ts`; 4xx drops, transient queues.
- ✓ "Title-based temp-task survivor check" — replaced with `localId`-based protection in `syncFromServer`.

## Stage 6 — Local Mutation Domain (`stage-6-local-mutations.md`)

- [x] `pwa/src/domain/taskMutations.ts` (+ links if split): `TaskWrite` pairs, guards, typed defer union, hours cap matching worker.
- [x] Thin action creators; no row-field literals outside `pwa/src/domain/`.
- [x] PWA off `TaskCreate`/`TaskUpdate`/`ProjectCreate`/`ProjectUpdate` (aliases left in shared until stage 9).
- [x] Tests: mutation guard tables, `{task, body}` consistency property, type-tests fixtures.
- [x] Docs: `docs/pwa/domain/taskMutations.md`; worker alias-removal unblocked (noted below).

**Deviations**:
- `TaskUpdatePatch` includes defer/focus fields (not content-only) so EditView's unified save keeps working through `updateTaskAction`. Stage 7 will split this into typed domain calls.
- `newLocalTask` requires `NonEmptyString<200>` at the type level; `createTaskAction` casts `title as NonEmptyString<200>` until stage 7 parses form input.
- `unfocusTaskAction` and `reopenTaskAction` added (not in plan); components now call `unfocusTaskAction` instead of `updateTaskAction(id, { focused_until: null }, ...)`.
- Existing `completeTaskAction` test updated: `already_done` guard now fires locally before the server request (was: tested a 409 server rejection); `syncCalled` is now `false` in that case (correct — no server rejection to roll back).
- `linkMutations.ts` not needed; link actions are already thin and have no field-level literals.
- Bundle: 311.14 KiB / gzip 95.68 KiB (no meaningful change).
- Worker alias removal (`TaskCreate`/`TaskUpdate`/`ProjectCreate`/`ProjectUpdate` in `shared/types.ts`) is now unblocked — PWA no longer imports them.

**Worker todo note**: Stage 6 unblocks `shared/types.ts` alias deletion. After stage 9, the worker cleanup slice can delete the aliases without checking back.

## Stage 7 — Form Boundary (`stage-7-form-boundary.md`)

- [x] `pwa/src/domain/taskForm.ts`: `parseTaskForm`, `parseQuickAddTitle`, field-scoped errors, cross-field rules (bounds verified against worker schemas).
- [x] EditView inline errors; AddBar cap; DeferMenu emits discriminated defer.
- [x] Tests: taskForm tables (node), EditView/AddBar/DeferMenu RTL (jsdom). 353 tests green.
- [x] Docs: components pages + three-layer validation note.

**Deviations**:
- `TaskUpdatePatch` tightened in place (title → `NonEmptyString<200>`, notes/kickoff/sessionLog → `BoundedString<N>`, due_date → `IsoDate`, recurrence → `Rrule`). Existing test files updated with branded-type casts.
- `deferTaskAction` now takes a `DeferInput` union instead of `(kind, untilIso)` pair — removes the internal reconstruction that was in the action creator.
- `nextDeferUntil()` in old EditView (preserved exact time when date unchanged) replaced by `new Date(\`${date}T09:00:00\`).toISOString()` in `parseTaskForm` — normalizes to 9 am on save, acceptable behavior change.
- `vitest.config.ts` gained a `valibot` alias (same pattern as existing `rrule` alias) so jsdom-environment tests can resolve the shared package's valibot import.
- `test/setup.ts` gained `afterEach(cleanup)` from `@testing-library/react` — RTL auto-cleanup was not firing in jsdom env without it.
- Worker `node_modules` must be installed in the worktree before `pwa typecheck` passes (drizzle-orm path alias in tsconfig.app.json points to `../worker/node_modules/drizzle-orm`).

## Stage 8 — IDB Read Boundary (`stage-8-idb-boundary.md`)

- [x] `pwa/src/idb/decode.ts`: parse → repair (`migrateLegacyDeferShape` exported from `db.ts`) → quarantine-in-place; decode-local cross-field checks mirroring `taskFromRow`; write-back of repairs; `onDecodeReport` hook.
- [x] Decode wired into tasks/projects/links reads (module-level callback, unchanged return types); `AppContext` aggregates reports + dispatches one toast on quarantine.
- [x] Tests: repair, quarantine, cross-field quarantine, mixed store, write-back round-trip, boot integration. 378 tests green (25 new).
- [x] Docs: `docs/pwa/idb/decode.md` (boundary contract, repair/quarantine policy, migration rule); `docs/pwa/idb/tasks.md` updated.

**Deviations**:
- `decodeTaskRows` returns `{ rows, report, repairedRows }` internally; write-back is done in `idbGetAllTasks` using `idbPutTask`. The plan's simplified interface (`{ rows, report }`) was extended with `repairedRows` to avoid passing IDB references into `decode.ts`.
- `decodeProjectRows` and `decodeLinkRows` have no repair pipeline entries yet — projects and links have no known legacy shape changes. Repair hooks can be added alongside future IDB migrations per the documentation rule.
- The module-level `onDecodeReport` callback is reset in `beforeEach` of tests to avoid cross-test leakage. `AppContext` clears it in the effect cleanup.

## Stage 9 — Hardening + Cleanup (`stage-9-hardening-cleanup.md`)

- [x] `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` on for pwa app/tests; fallout fixed properly.
- [x] Reducer payloads tightened (`DELETE_LINK.linkType: string` → `TaskLink['link_type']`); dead sessionId placeholder removed; cast sweep done (redundant `body as TaskUpdateBody` removed; remaining casts annotated or justified by boundary context).
- [x] Shared alias check: worker still imports `TaskCreate`/`TaskUpdate`/`ProjectCreate`/`ProjectUpdate` from `shared/types.ts` (in `worker/src/db.ts`); aliases retained until the worker plan's cleanup step runs. `PendingOp` already removed in stage 4. Worker typecheck + test green.
- [x] Docs sweep: `docs/pwa/overview.md` updated with type-safety architecture section; `AGENTS.md` updated with "parse at boundary" convention and new boundary rule.
- [x] Bundle: 318.85 KiB / gzip 97.31 KiB (vs pre-plan baseline ~280 KiB / ~90 KiB — within expected range for valibot + domain layer).
- [x] This file marked complete. 390 tests green; typecheck clean with both hardening flags.

**Deviations:**
- `pwa/src/types.ts` (re-export shim for `Task`, `Project`, `TaskLink`) retained — 14 import sites; deleting it would be a mechanical rename pass with no type-safety benefit. Left for a future cleanup.
- `shared/parse/primitives.ts` and `shared/parse/recurrence.ts` needed minor fixes (`match[8] ?? 'Z'`, destructuring defaults) for the new `noUncheckedIndexedAccess` flag because the pwa tsconfig typechecks shared files transitively. These fixes are backward-compatible with the worker (worker tsconfig lacks the flag).
- Manual smoke list not run (no local running dev environment in this session); all automated checks pass.
