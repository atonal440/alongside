# PWA Type Safety and Testing Plan (Master)

## Context

`docs/plans/type-driven-safety.md` introduced a layered, parse-don't-validate type system in the worker: branded primitives and enums in `shared/parse/`, `Result`/`Brand` helpers in `shared/result.ts` and `shared/brand.ts`, domain types with explicit transitions, `Op`/`Plan` mutation values, and a vitest suite under `worker/test/`. Six slices of that plan have landed (see `docs/plans/type-driven-safety-implementation-todo.md`); REST/UI route schemas, the MCP registry, OAuth/preference brands, D1 checks, and compiler hardening remain in flight on the worker side.

The PWA has none of this. It is a ~3.7k-line React app whose every boundary is an unchecked cast:

- **Server responses are cast, not parsed.** `pwa/src/context/actions.ts` does `result as Task` (lines 39, 94); `pwa/src/api/sync.ts` does `remote as Task[]`, `projectsRaw as Project[]`, `linksRaw as TaskLink[]`. A worker bug, a proxy error page, or a stale cached response flows straight into IndexedDB and React state.
- **All failures collapse to `null`.** `pwa/src/api/client.ts:21-26` turns every non-OK response *and* every network error into `null`. The sync layer cannot tell "the server rejected this write forever" (400/409) from "we are offline" — so durably rejected writes are queued and retried forever. This is the exact gap recorded under "Future PWA Type System Notes" in the worker todo.
- **Optimistic writes can create invalid state the server will refuse.** `createLinkAction` writes a link to IndexedDB before the server can reject self-links, missing endpoints, or `blocks` cycles; there is no rollback path.
- **The pending-op queue is stringly typed.** `PendingOp` is `{ method: string; path: string; body: unknown }`. Temp-ID reconciliation rewrites ops by substring-replacing IDs inside path strings (`pwa/src/api/sync.ts:44-53`), and offline-created tasks are matched back to server tasks **by title** (`sync.ts:69-80`).
- **IndexedDB reads are trusted.** `req.result as Task[]` in `pwa/src/idb/tasks.ts:8` (same pattern in projects/links/pendingOps). Rows written by older app versions are only handled by one hand-rolled migration in `pwa/src/idb/db.ts`.
- **Local mutations rebuild invariants by hand.** `actions.ts` constructs `Task` literals, spreads loose `TaskUpdate`s, and sets `status: 'done'` directly — re-creating exactly the inconsistent-state bugs the worker domain layer eliminated (defer/focus atomicity, recurrence-requires-due-date, done-task transitions).
- **Forms don't parse.** `EditView` saves whatever is in the inputs; due dates, RRULEs, and defer combinations are only checked server-side, after the optimistic write already happened.
- **There are no tests.** The worker has parser, domain, storage, and e2e suites; the PWA has only `tsc` and a production build. Pure logic that drives the entire UI (`shared/readiness.ts`, `pwa/src/utils/taskFlow.ts`, `pwa/src/context/reducer.ts`) is untested.

Goal: extend the worker's type and testing architecture to the PWA so that untrusted data — server responses, IndexedDB rows, queued ops, and form input — is parsed once at the boundary, sync distinguishes durable rejections from transient failures, and the logic that decides what the user sees is covered by a fast vitest suite wired into `npm run verify`.

## Design Pillars

Adapted from the worker plan to a client that is an *optimistic mirror* of the server rather than the source of truth:

1. **Parse at every boundary, trust inside.** Four untrusted edges: HTTP responses, IndexedDB reads, the pending-op queue, and form input. Each gets a valibot parser returning `Result<T, ValidationError[]>` from the existing `shared/result.ts` / `shared/parse/` toolkit. Inside the app, data is row-shaped and assumed valid.
2. **Rows stay in state; invariants live in functions.** `AppState.tasks` keeps the `Task` row shape (`shared/schema.ts` `$inferSelect`). We do *not* convert React state to the worker's lifecycle-union domain types — every render touches state, and the conversion tax outweighs the benefit in a thin client. Instead, all local mutations go through pure, tested functions in `pwa/src/domain/` that enforce the same invariants the worker enforces (defer/focus atomicity, no completing done tasks, recurrence requires due date). Branded types appear in function signatures, not in stored state — `Brand<string, K>` is assignable to `string`, so parsed values flow into row shapes for free.
3. **Errors are data; failure has kinds.** `apiRequest` returns a discriminated `ApiResult<T>`: `ok`, `http` (status + parsed `{ error, details? }` body), `contract` (a 2xx response whose body failed our schema), `network`, `unconfigured`. Policy is uniform: **network errors and 5xx are transient** (queue and retry), **4xx and contract violations are durable** (never queue — a retry cannot succeed; surface a toast and re-sync from the server, which is the rollback mechanism for optimistic writes).
4. **Operations are values, client edition.** The pending-op queue becomes a discriminated union of typed ops (`task.create`, `task.update`, `task.complete`, `task.delete`, `link.create`, `link.delete`) with typed payloads. Serialization to method/path/body happens in exactly one place at flush time. Temp-ID rebinding becomes a total function over the union instead of string surgery.
5. **One schema per row, shared.** The worker already validates task/project/link rows field by field in `worker/src/wire/importPayload.ts`. Those field-level schemas move to `shared/wire/rows.ts` so the worker's import pipeline and the PWA's response/IDB parsers consume a single source of truth. Cross-field invariants are deliberately *not* in these schemas — they live in the worker's `taskFromRow` and, PWA-side, in the stage-6 mutation guards and stage-8 decode checks. Wire field names never change.
6. **Tests mirror the worker suite.** `pwa/test/` mirrors `worker/test/` in layout and tone: table-driven parser tests, invariant tests on pure logic, fake-indexeddb tests for the IDB layer, stubbed-fetch tests for the client and sync engine, and a small number of React Testing Library tests where behavior lives in components. `fast-check` covers sort/score invariants. Everything runs in `npm run verify`.

## Boundary Map

```
            ┌──────────────────────────────────────────────┐
            │  Worker REST API (source of truth)           │
            └───────▲──────────────────────────┬───────────┘
        typed req   │                          │ unknown JSON
        (wire body) │                          ▼ parse: shared/wire/rows
┌───────────────────┴───────┐        ┌─────────────────────────┐
│ pwa/src/api/  (client,    │        │ ApiResult<T>            │
│ endpoints, sync engine)   │◄───────│ ok | http | contract |  │
└───────▲───────────┬───────┘        │ network | unconfigured  │
        │           │                └─────────────────────────┘
 typed PendingOp    │ rows
 (discriminated)    ▼
┌───────────────────────────┐   parse on read   ┌──────────────┐
│ pwa/src/idb/  (IDB layer) │◄──────────────────│ IndexedDB    │
└───────▲───────────────────┘                   └──────────────┘
        │ rows (validated)
┌───────┴───────────────────┐
│ pwa/src/context/ reducer  │   AppState: row shapes, no casts
│ pwa/src/domain/ mutations │   pure transitions, invariants
└───────▲───────────────────┘
        │ parsed input (IsoDate, Rrule, NonEmptyString…)
┌───────┴───────────────────┐
│ components/ forms          │   parse user input at submit
└───────────────────────────┘
```

## Tooling Choices

| Concern | Choice | Why |
| --- | --- | --- |
| Test runner | **vitest** (plain, no workers pool) | Matches the worker suite; the PWA needs node + DOM environments, not `workerd`. |
| DOM environment | **jsdom**, scoped via `environmentMatchGlobs` to `test/components/**` and `test/hooks/**` | Pure-logic tests stay in fast `node` env; only component/hook tests pay the DOM tax. |
| Component testing | `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` | Standard, behavior-first. Used sparingly — most logic is extracted to pure functions first. |
| IndexedDB in tests | `fake-indexeddb` | In-memory IDB that runs in node; exercises the real `pwa/src/idb/` modules including migrations. |
| HTTP in tests | tiny fetch stub helper (`pwa/test/helpers/fetchStub.ts`), no MSW | Matches the repo's lean-deps ethos (same reasoning that rejected `neverthrow` worker-side). The client has one fetch call site; a stub that records requests and plays back typed responses is ~40 lines. |
| Schemas | **valibot** (already a `pwa/package.json` dependency) | Same library as the worker; row schemas are shared. |
| Property-based | `fast-check` | Already used worker-side; covers `taskSort` totality/transitivity and readiness-score bounds. |
| Where shared-code tests live | `pwa/test/shared/` | `shared/readiness.ts` drives UI states, and the PWA harness (node env, `@shared` alias) imports it directly. A third top-level test harness for `shared/` is not worth the plumbing. |

## Test Architecture

```
pwa/
  vitest.config.ts            node default env; jsdom via environmentMatchGlobs;
                              @shared + rrule aliases copied from vite.config.ts
  test/
    helpers/
      fetchStub.ts            install/restore fetch; queue typed responses; record calls
      fixtures.ts             makeTask/makeProject/makeLink row factories (single source)
      idb.ts                  fresh fake-indexeddb per test, seed/reset helpers
    shared/                   readiness.test.ts
    utils/                    taskFlow, design, linkMaps, suggestQueue, genId tests
    context/                  reducer tests
    api/                      client, endpoints, sync engine tests
    idb/                      migration + module tests (fake-indexeddb)
    domain/                   local mutation invariant tests
    components/               RTL tests (jsdom): forms, AddBar, DeferMenu
  type-tests/                 @ts-expect-error fixtures, mirrors worker/type-tests/
```

Conventions, for every stage:

- Test files are named after the module under test and grouped by layer, exactly like `worker/test/`.
- Time is always injected. Functions that currently call `new Date()` internally gain a `nowIso`/`now` parameter with a default; tests pass fixed values. No fake-timer suites for pure logic.
- Fixtures come from `pwa/test/helpers/fixtures.ts` only — no inline 15-field task literals in test bodies.
- `pwa/package.json` gains `"test": "vitest run"`; the root `verify` script gains `npm --prefix pwa run test` (after the pwa typecheck, before the pwa build).

## Stages

Each stage is a separate work order in `docs/plans/pwa-type-safety/`, written to be executed by an agent with no other context. Each stage lands as its own PR, keeps `npm run verify` green, and updates `docs/plans/pwa-type-safety-implementation-todo.md` plus any affected `docs/pwa/` files.

| Stage | Plan file | Summary | Depends on |
| --- | --- | --- | --- |
| 1 | `stage-1-test-harness.md` | Vitest harness, all test dependencies, fixtures/helpers, and tests for the existing pure logic (readiness, taskFlow, design, reducer, small utils). Locks current behavior before any refactor. | — |
| 2 | `stage-2-shared-row-schemas.md` | Lift `TaskRowSchema` / `ProjectRowSchema` / `TaskLinkRowSchema` from `worker/src/wire/importPayload.ts` into `shared/wire/rows.ts`; worker import pipeline consumes them from there. Touches the worker; worker suite + `wrangler deploy --dry-run` must stay green. | 1 |
| 3 | `stage-3-typed-api-client.md` | Replace `apiFetch`'s `unknown \| null` with `ApiResult<T>`; add a typed endpoint module that parses every response with the shared row schemas and parses error bodies; classify durable vs transient. | 2 |
| 4 | `stage-4-typed-pending-ops.md` | `PendingOp` becomes a discriminated union with typed payloads and an `attempts` counter; one serializer to wire requests; total `rebindTaskId`; IDB v4 migration translating legacy stored ops. | 3 |
| 5 | `stage-5-sync-engine.md` | Rewrite `flushPendingOps` / `syncFromServer` on stages 3–4: durable rejections drop + toast + re-sync; transient failures stop the flush; temp-ID reconciliation by `local_id` (not title); dependent-op cleanup when a create is rejected. | 4 |
| 6 | `stage-6-local-mutations.md` | Pure mutation functions in `pwa/src/domain/` enforcing worker invariants; `actions.ts` becomes thin (mutate → persist → dispatch → send/queue); PWA stops importing `TaskCreate`/`TaskUpdate` from `shared/types.ts`. | 5 |
| 7 | `stage-7-form-boundary.md` | Parse user input at submit in `EditView`/`AddBar`/`DeferMenu` using `shared/parse` (title, IsoDate, RRULE, defer combinations); inline field errors; RTL tests. | 6 |
| 8 | `stage-8-idb-boundary.md` | Parse IndexedDB reads through the shared row schemas with a repair/quarantine policy for drifted rows; fake-indexeddb tests including legacy-shape rows. | 5 (parallel with 6–7) |
| 9 | `stage-9-hardening-cleanup.md` | Enable `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` for the PWA; tighten reducer action payloads; delete now-unused `TaskCreate`/`TaskUpdate`/`ProjectCreate`/`ProjectUpdate`/`PendingOp` exports from `shared/types.ts` (coordinating with the worker cleanup slice); docs sweep + convention notes in `CLAUDE.md`/`AGENTS.md`. | 6, 7, 8 |
```
1 → 2 → 3 → 4 → 5 ─┬→ 6 → 7 ─┬→ 9
                   └→ 8 ──────┘
```

Stages 6–7 and 8 touch disjoint files and can run in parallel after stage 5.

## Coordination with the Worker Plan

- **Do not depend on unfinished worker slices.** REST/UI route schemas, the MCP registry, and OAuth brands are still pending worker-side. Nothing here requires them; the REST wire contract (field names, response shapes, the `{ error, details? }` error body produced by `domainErrorJson` in `worker/src/api.ts:12-16`) is consumed as it exists today.
- **Stage 2 is the only stage that edits worker code**, and only to relocate schemas. Run the full worker verification for it.
- **Stages 6 and 9 unblock the worker's "cleanup + compiler hardening" slice**, which is waiting on the PWA to stop importing `TaskCreate`/`TaskUpdate` from `shared/types.ts` (see that plan's step 11 and Non-Goals). After stage 9, the worker slice can delete the aliases without checking back.
- **Wire shapes never change.** Same rule as the worker plan: REST payload field names stay as-is so the deployed worker and PWA versions interoperate during rollout in either order.

## Non-Goals

- **Domain-union AppState.** React state keeps row shapes (pillar 2). Re-evaluate only if the tested mutation functions prove insufficient — that would be a new plan.
- **Wire/protocol changes**, including fixing server semantics from the client side. If a stage uncovers a worker bug, file it against the worker plan; do not work around it silently.
- **Browser E2E (Playwright/Cypress).** The vitest + RTL + fake-indexeddb stack covers the logic; full-browser tests are a possible future plan once the sync engine stabilizes.
- **Service-worker rewrite.** `pwa/src/sw.ts` keeps its current Workbox message pattern; stage 5 only touches the message *handler* side in `useSync` if needed.
- **Conflict resolution beyond last-write-wins.** Merge semantics stay `updated_at` LWW; this plan only makes the existing semantics typed and tested.
- **Offline-first redesign.** The optimistic-write → queue → flush shape stays; it just becomes typed, policy-driven, and tested.

## Execution Protocol (for implementing agents)

1. Read this file, then your stage file in `docs/plans/pwa-type-safety/`, then the files it lists. Stage files are self-contained but link back here for rationale.
2. Work on a branch; keep the change reviewable as one PR per stage.
3. Verification for every stage: `npm --prefix pwa run typecheck && npm --prefix pwa run test && npm --prefix pwa run build`. Stages touching `shared/` or `worker/` additionally run `npm --prefix worker run typecheck && npm --prefix worker run test && npm --prefix worker run build:dry`. The root `npm run verify` must pass before merge.
4. Before finishing, update `docs/plans/pwa-type-safety-implementation-todo.md` (check off your items, note deviations) and any `docs/pwa/` pages whose contracts changed, per the documentation conventions in `CLAUDE.md`.
5. If you find the codebase has drifted from a stage file's description, trust the code, note the drift in the todo file, and adapt — do not force the plan's letter against the code's reality.

## End-to-End Verification (after stage 9)

Manual smoke pass over `npm run dev` with the worker running:

1. Create a task with an invalid due date typed into EditView — inline field error, no optimistic write, no queued op.
2. Stop the worker, create/edit/complete tasks offline — ops queue; restart the worker — flush succeeds, temp IDs reconcile by `local_id`, no duplicate tasks.
3. With the worker up, attempt a self-link or a `blocks` cycle (server rejects with 400/409) — toast with the server message, local state restored by re-sync, op **not** retried.
4. Manually plant a malformed task row in IndexedDB (devtools) — app boots, row is quarantined with a console report, UI unaffected.
5. Complete a recurring task — next occurrence appears after sync; complete it again quickly — second attempt surfaces `invalid_transition` without corrupting local state.
6. `npm run verify` passes; PWA bundle size delta from valibot schema reuse stays under ~10 KB gzipped (valibot is already a dependency; the schemas are the only addition).
