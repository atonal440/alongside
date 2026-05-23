# Type-Driven Safety Implementation Todo

This is the handoff checklist for implementing `docs/plans/type-driven-safety.md`. Keep this file current as slices land so another agent can resume without re-deriving the plan.

## Completed Slice: Foundations

- [x] Add worker dependency scaffolding: `valibot`, `vitest`, `@cloudflare/vitest-pool-workers`, `fast-check`.
- [x] Add scripts: worker `test`, worker `build:dry`, root `verify`.
- [x] Add `shared/brand.ts` and `shared/result.ts`.
- [x] Add initial `shared/parse/*` modules for primitives, IDs, enums, recurrence, and time.
- [x] Add worker scaffolds for `parse`, `domain`, `wire`, and `storage`.
- [x] Add initial Vitest config and parser smoke tests.
- [x] Add docs for new exported modules.
- [x] Run final worker checks for this slice.

## Completed Slice: Recurrence Vertical

- [x] Move `parseNextOccurrence` out of `worker/src/db.ts` and onto `shared/parse/recurrence.ts`.
- [x] Introduce the first real task row/domain codec for recurrence-bearing tasks.
- [x] Rewrite `DB.completeTask` to use parsed `Recurrence` and `PendingTaskDomain`.
- [x] Parse recurrence at worker write boundaries before persistence.
- [x] Add tests for recurring completion and invalid RRULE rejection.

## Completed Slice: Defer, Focus, and Task Lifecycle

- [x] Tighten `taskFromRow` so impossible defer/focus/lifecycle row combinations are rejected instead of normalized.
- [x] Add planners for defer, clear defer, focus, and reopen transitions.
- [x] Route `DB.deferTask`, `DB.clearDeferTask`, `DB.focusTask`, and `DB.reopenTask` through the task lifecycle planners.
- [x] Cap and parse MCP `focus_task.hours` before computing `focused_until`.
- [x] Add regression tests for defer/focus invariants and transition plans.

## Completed Slice: Op Plan + Apply

- [x] Implement `worker/src/storage/apply.ts` with typed prechecks and D1 batch execution for `Plan` values.
- [x] Route `DB.completeTask` and single-task lifecycle transitions through `applyPlan`.
- [x] Add `createProjectPlan` and route project creation with task assignment through one plan batch.
- [x] Add storage executor tests and DB regression tests for recurring completion and project assignment prechecks.

## Completed Slice: Import Pipeline

- [x] Parse import payloads through row schemas with branded IDs, enums, timestamps, RRULEs, and bounded text.
- [x] Normalize legacy `snoozed_until` rows before planning restore operations.
- [x] Route `DB.importAll` through `parseImport`, `planImport`, and `applyPlan`.
- [x] Add import regression tests for duplicate IDs, missing references, invalid recurrence rows, invalid preferences, and pre-wipe failure.

## Completed Slice: Link Domain And Dependency Checks

- [x] Parse link inputs into `TaskLinkDomain` before storage writes.
- [x] Add `linkTasksPlan` and `unlinkTasksPlan` with self-link rejection and endpoint prechecks.
- [x] Implement `link.blocks_acyclic` in `applyPlan` with a recursive D1 graph query.
- [x] Reject self-links and cyclic `blocks` graphs during import planning.
- [x] Add link planner, storage executor, DB, and import regression tests.

## Completed Slice: REST + UI Route Schemas

- [x] Define REST route specs for task, link, project, action-log, export, and import endpoints, including path params, strict boolean query params, JSON body schemas for route-owned bodies, and an import body handoff to the existing export-v1 parser.
- [x] Define the UI complete route spec and parse `/ui/complete/:task_id` before dispatch.
- [x] Route `worker/src/api.ts` and `worker/src/ui.ts` through shared wire parsing helpers instead of regex path parsing and typed `request.json<T>()`.
- [x] Add focused REST/UI tests for strict path matching, malformed IDs, invalid bodies, invalid query params, import error path compatibility, domain error mapping, and representative happy-path dispatch.
- [x] Run worker typecheck and test suite.

## Later Slices

- [ ] MCP typed registry.
- [ ] OAuth, preferences, and action-log policy.
- [ ] D1 check constraints.
- [ ] Cleanup, compiler hardening, and PWA compatibility aliases.

## Future PWA Type System Notes

- [ ] When the type-driven safety work reaches the frontend, distinguish durable 4xx validation failures from transient offline/network failures in the PWA sync layer. Today `apiFetch` collapses all non-OK responses to `null`, so rejected writes can be queued like offline retries; the frontend migration should parse validation errors, surface them to the user, and avoid retry loops.
- [ ] Link mutations need the same treatment specifically: `createLinkAction` writes optimistically to IndexedDB before the server can reject self-links, missing endpoints, or `blocks` cycles. The PWA pass should roll back or annotate durable link rejections instead of leaving invalid local graph state and retrying the rejected op forever.
