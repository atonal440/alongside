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

- [ ] `settleWrite` / `WriteOutcome`; durable = drop + toast + resync, transient = queue.
- [ ] Action creators: rejection path (incl. temp-task removal via resync — verified), resync callback wiring.
- [ ] Flush loop: FIFO, stop-on-transient, attempts cap surfacing, durable-create dependent-op cleanup.
- [ ] `syncFromServer`: `local_id`-based survivor protection (title heuristic removed).
- [ ] `useSync`: rejection toasts after resync; status transitions preserved.
- [ ] Tests: flush matrix, reconciliation, duplicate-title regression, link 409 rollback, attempts cap.
- [ ] Docs: sync policy narrative; check off the two "Future PWA Type System Notes" items in the worker todo.

## Stage 6 — Local Mutation Domain (`stage-6-local-mutations.md`)

- [ ] `pwa/src/domain/taskMutations.ts` (+ links if split): `TaskWrite` pairs, guards, typed defer union, hours cap matching worker.
- [ ] Thin action creators; no row-field literals outside `pwa/src/domain/`.
- [ ] PWA off `TaskCreate`/`TaskUpdate`/`ProjectCreate`/`ProjectUpdate` (aliases left in shared until stage 9).
- [ ] Tests: mutation guard tables, `{task, body}` consistency property, type-tests fixtures.
- [ ] Docs: `docs/pwa/domain/` page; note alias-removal unblock in the worker todo.

## Stage 7 — Form Boundary (`stage-7-form-boundary.md`)

- [ ] `pwa/src/domain/taskForm.ts`: `parseTaskForm`, `parseQuickAddTitle`, field-scoped errors, cross-field rules (bounds verified against worker schemas).
- [ ] EditView inline errors; AddBar cap; DeferMenu emits discriminated defer.
- [ ] Tests: taskForm tables (node), EditView/AddBar/DeferMenu RTL (jsdom).
- [ ] Docs: components pages + three-layer validation note.

## Stage 8 — IDB Read Boundary (`stage-8-idb-boundary.md`)

- [ ] `pwa/src/idb/decode.ts`: parse → repair (shared `migrateLegacyDeferShape`) → quarantine-in-place; decode-local cross-field checks mirroring `taskFromRow`; write-back of repairs; boot report + single toast.
- [ ] Decode wired into tasks/projects/links reads (report mechanism documented).
- [ ] Tests: repair, quarantine, mixed store, boot integration.
- [ ] Docs: `docs/pwa/idb/` boundary contract + migration↔repair rule.

## Stage 9 — Hardening + Cleanup (`stage-9-hardening-cleanup.md`)

- [ ] `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` on for pwa app/tests; fallout fixed properly.
- [ ] Reducer payloads tightened; dead sessionId placeholder resolved; cast sweep.
- [ ] Shared alias deletion per worker-usage check; full worker verification.
- [ ] Docs sweep: `docs/pwa/overview.md` narrative, `CLAUDE.md`/`AGENTS.md` conventions + commands.
- [ ] Master-plan end-to-end smoke list run and recorded; bundle delta recorded.
- [ ] This file and the master plan marked complete.
