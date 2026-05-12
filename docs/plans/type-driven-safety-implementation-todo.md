# Type-Driven Safety Implementation Todo

This is the handoff checklist for implementing `docs/plans/type-driven-safety.md`. Keep this file current as slices land so another agent can resume without re-deriving the plan.

## Current Slice: Foundations

- [x] Add worker dependency scaffolding: `valibot`, `vitest`, `@cloudflare/vitest-pool-workers`, `fast-check`.
- [x] Add scripts: worker `test`, worker `build:dry`, root `verify`.
- [x] Add `shared/brand.ts` and `shared/result.ts`.
- [x] Add initial `shared/parse/*` modules for primitives, IDs, enums, recurrence, and time.
- [x] Add worker scaffolds for `parse`, `domain`, `wire`, and `storage`.
- [x] Add initial Vitest config and parser smoke tests.
- [x] Add docs for new exported modules.
- [x] Run final worker checks for this slice.

## Next Slice: Recurrence Vertical

- [ ] Move `parseNextOccurrence` out of `worker/src/db.ts` and onto `shared/parse/recurrence.ts`.
- [ ] Introduce the first real task row/domain codec for recurrence-bearing tasks.
- [ ] Rewrite `DB.completeTask` to use parsed `Recurrence` and `PendingTaskDomain`.
- [ ] Parse recurrence at worker write boundaries before persistence.
- [ ] Add tests for recurring completion and invalid RRULE rejection.

## Later Slices

- [ ] Defer + focus lifecycle unions.
- [ ] `Op`/`Plan`/`apply` execution path.
- [ ] Link domain and dependency cycle checks.
- [ ] REST + UI route schemas.
- [ ] MCP typed registry.
- [ ] Import pipeline.
- [ ] OAuth, preferences, and action-log policy.
- [ ] D1 check constraints.
- [ ] Cleanup, compiler hardening, and PWA compatibility aliases.
