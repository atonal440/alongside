# Stage 1 — PWA Test Harness and Pure-Logic Tests

Part of `docs/plans/pwa-type-safety.md`. No prerequisites. Read that file's Design Pillars and Test Architecture sections first.

## Goal

Stand up a vitest harness for the PWA, install **all** test dependencies this plan will ever need (so later stages never touch `package.json`), and write tests that lock in the current behavior of the PWA's pure logic before any refactoring starts. No production behavior changes beyond minimal testability refactors (injectable time).

## Context for a cold start

- The repo is a Cloudflare Worker (`worker/`) + React PWA (`pwa/`) sharing types via `shared/` and a `@shared` path alias (see `pwa/vite.config.ts` and `pwa/tsconfig.app.json` `paths`).
- The worker already has a vitest suite (`worker/vitest.config.ts`, tests in `worker/test/`). Mirror its layout and style.
- The PWA currently has **no tests**. Its `package.json` scripts are `dev`, `build`, `preview`, `typecheck`.
- The root `package.json` has a `verify` script that chains worker typecheck/test/build-dry and pwa typecheck/build.

## Steps

### 1. Dependencies and scripts

In `pwa/package.json` add devDependencies (align versions with what `worker/package.json` already uses where applicable — vitest `^4`, fast-check `^4`):

- `vitest`, `jsdom`
- `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`
- `fake-indexeddb`
- `fast-check`

Add script `"test": "vitest run"`. In the root `package.json`, extend `verify` to run `npm --prefix pwa run test` between the pwa typecheck and pwa build.

### 2. Vitest config

Create `pwa/vitest.config.ts`:

- Aliases: copy `@shared` and `rrule` resolution from `pwa/vite.config.ts` (the rrule ESM alias matters — without it imports of `@shared/parse/recurrence` fail in node).
- `test.include: ['test/**/*.test.{ts,tsx}']`.
- Default `environment: 'node'`; `environmentMatchGlobs: [['test/components/**', 'jsdom'], ['test/hooks/**', 'jsdom']]`.
- A `test/setup.ts` registered via `setupFiles` that imports `@testing-library/jest-dom/vitest` (guarded so it's harmless in node-env files, or scope it via the jsdom globs if vitest version supports per-environment setup).

TypeScript: test files must typecheck. Either add `test` and `type-tests` to a new `pwa/tsconfig.test.json` referenced from `pwa/tsconfig.json`, or extend `tsconfig.app.json`'s include — pick whichever keeps `npm --prefix pwa run typecheck` (`tsc -b`) covering test code without breaking the Vite build. The worker keeps type-tests compiling under its main typecheck; do the same here.

### 3. Test helpers

Create `pwa/test/helpers/fixtures.ts` with row factories:

```ts
export function makeTask(overrides: Partial<Task> = {}): Task { /* all 15 fields, sane defaults, id 't_test1' */ }
export function makeProject(overrides?: Partial<Project>): Project;
export function makeLink(overrides?: Partial<TaskLink>): TaskLink;
```

Defaults must satisfy the worker's row invariants (status `pending`, `defer_kind: 'none'` with `defer_until: null`, recurrence null, valid ISO timestamps). These factories are the only place test task literals are defined; every later stage reuses them.

Also create `pwa/test/helpers/fetchStub.ts` (used from stage 3 onward, built now so the helper API is settled): `installFetchStub()` returns an object with `respondWith(matcher, response)`, `calls` (recorded `{ path, method, body }`), and `restore()`. Support JSON responses with status codes and a `networkError()` playback. Keep it under ~60 lines; no MSW.

And `pwa/test/helpers/idb.ts`: import `fake-indexeddb/auto` and export a `resetIdb()` that deletes the `alongside` database between tests (used from stage 4 onward).

### 4. Testability refactors (minimal, no behavior change)

Several pure functions read the clock internally, which makes them untestable:

- `pwa/src/utils/design.ts:11-17` — `isFocused`/`isDeferred` call `new Date().toISOString()`. Give each a trailing `nowIso = new Date().toISOString()` parameter (isDeferred already has one — keep it).
- `pwa/src/utils/design.ts:44-46` — `readinessScore` ignores its `_today` parameter and calls `new Date()` itself; make it pass through an injectable `nowIso` instead. Verify call sites (`taskFlow.ts`, views) still compile; do **not** change what callers pass yet.
- `pwa/src/utils/taskFlow.ts` — `deriveTaskFlow` takes `context.today`; check whether focus/defer predicates inside it use injected time after the design.ts change. Thread `nowIso` through `TaskFlowContext` if needed (optional field defaulting to now).

Keep these changes to default parameters and pass-throughs so production behavior is identical.

### 5. Tests to write

All in `node` env unless noted. Use fixed timestamps (e.g. `2026-06-09T12:00:00.000Z`) throughout.

- `test/shared/readiness.test.ts` — `shared/readiness.ts`:
  - `isDeferred`: someday → true; until in future → true; until in past → false; kind none with stale `defer_until` set → false (documents current lenient behavior).
  - `hasActiveBlocker`: blocker pending → true; blocker done → false; `related` links ignored; blocker missing from task list → false.
  - `isReady`: each gate (done status, deferred, blocked) flips it false.
  - `readinessScore`: done → 0; blocked → 5; additive components (kickoff +20, session log +15, focused +12, recent update +8, overdue +10 / today +7 / within-week +3) each asserted independently from a minimal base task; property test (fast-check): score is always ≥ 0 and ≤ the sum of all bonuses.
- `test/utils/design.test.ts` — `formatDue` (overdue/today/future/none), `projectColor` (deterministic, falls in palette, null → default), `projectTitle` (missing project → 'No project'), `firstNoteEntry` (splits on blank lines, trims, empty/null), `taskSort` (orders by readiness desc, then due date with nulls last via the `9999-99-99` sentinel, then title; fast-check property: comparator is antisymmetric and never throws for arbitrary task pairs built from the fixture factory).
- `test/utils/taskFlow.test.ts` — `deriveTaskFlow` precedence: done > focused > someday > deferred > blocked > ready (build one task per state and assert `mode`); per-surface action sets match `TASK_FLOW_CHART` (e.g. done task on `list` surface has no actions; ready task's primary is `focus` everywhere but detail also offers complete/defer/edit/delete); `relationships.blockedBy`/`unlocks` derived from `blocks` links only; `metaLabel` for deferred-until uses the formatted date.
- `test/context/reducer.test.ts` — `pwa/src/context/reducer.ts`: UPSERT_TASK inserts then replaces by id; DELETE_TASK; UPSERT_LINK dedupes on the (from,to,type) triple; DELETE_LINK removes only the exact triple; SET_VIEW maps `'session'` → `'review'` and clears editing/detail ids; LOG_OUT resets data and config but produces the documented toast.
- `test/utils/small.test.ts` — `genId` (format `^t_[0-9A-Za-z_-]{5}$`, honors prefix), `linkMaps`, `suggestQueue` (read the modules; assert their actual contracts).

Do **not** test `actions.ts`, `client.ts`, `sync.ts`, or idb modules yet — they get refactored in stages 3–5 and their current contracts are not worth locking.

### 6. Docs

Per `CLAUDE.md` conventions: add a short "Testing" note to `docs/pwa/overview.md` describing the harness (layout, environments, helpers, how to run), and update the Commands table in `CLAUDE.md` (and keep `AGENTS.md` aligned) with `npm --prefix pwa run test` / the extended `verify`.

## Acceptance criteria

- `npm --prefix pwa run test` runs the new suites green in under ~10s.
- `npm --prefix pwa run typecheck` and `npm --prefix pwa run build` still pass (test code included in typecheck).
- Root `npm run verify` passes end to end.
- No production behavior change: `git diff` on `pwa/src/` shows only injectable-time parameter additions.
- `docs/plans/pwa-type-safety-implementation-todo.md` stage-1 items checked off, with notes on any deviations.
