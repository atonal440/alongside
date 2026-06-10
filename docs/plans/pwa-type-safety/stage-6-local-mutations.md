# Stage 6 — Local Mutation Domain

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–5. Can run in parallel with stage 8.

## Goal

Extract the optimistic-mutation logic scattered through `pwa/src/context/actions.ts` into pure, tested functions in a new `pwa/src/domain/` module that enforce the same invariants the worker's domain layer enforces. Action creators become thin orchestration: load row → call mutation fn → persist to IDB → dispatch → send/queue via the stage-5 policy. The PWA stops importing `TaskCreate`/`TaskUpdate` from `shared/types.ts`, unblocking the worker plan's cleanup slice.

## Context for a cold start

- `pwa/src/context/actions.ts` hand-builds rows: `createTaskAction` constructs a 15-field `Task` literal; `updateTaskAction` spreads a loose `TaskUpdate` over the row; `completeTaskAction` sets `status: 'done'` directly; `deferTaskAction`/`clearDeferAction`/`focusTaskAction` poke `defer_kind`/`defer_until`/`focused_until` individually. Every mutation also stamps `updated_at`.
- The worker's domain invariants these must mirror (see `docs/plans/type-driven-safety.md` "Discriminated Domain Types", and `worker/src/domain/task.ts` for current truth):
  - Defer state is atomic: `kind: 'until'` ⇔ `defer_until` set; `someday`/`none` ⇔ `defer_until` null.
  - Deferring clears focus (`focused_until: null`) — `deferTaskAction` already does this; make it structural.
  - Only pending tasks can be completed, deferred, or focused; only done/deferred tasks can be reopened.
  - Recurrence requires a due date.
  - Completing locally does **not** mint the next recurring occurrence — that is the server's job (the local write just marks done; the successor arrives by sync). Keep it that way.
- Stage 3 defined PWA-local wire body types in `pwa/src/api/endpoints.ts` (`TaskCreateBody`, `TaskUpdateBody`, `LinkBody`).
- Branded inputs available from `shared/parse`: `IsoDate`, `IsoDateTime`, `NonEmptyString`, `TaskId`, enum brands. Brands are assignable to their base primitives, so mutation outputs remain storable as plain `Task` rows.

## Design

New `pwa/src/domain/taskMutations.ts` (+ `linkMutations.ts` if it earns its own file). Shape:

```ts
export type LocalMutationError = { code: string; message: string }; // e.g. not_pending, already_done

export interface TaskWrite {
  task: Task;             // updated row → IDB + dispatch
  body: TaskUpdateBody;   // exact wire body → send/queue (create uses TaskCreateBody)
}

export function newLocalTask(title: NonEmptyString<200>, nowIso: IsoDateTime, id: string): Task;
export function applyUpdate(task: Task, patch: TaskUpdatePatch, nowIso: IsoDateTime): Result<TaskWrite, LocalMutationError>;
export function applyComplete(task: Task, nowIso: IsoDateTime): Result<TaskWrite & { wasRecurring: boolean }, LocalMutationError>;
export function applyDefer(task: Task, defer: { kind: 'someday' } | { kind: 'until'; until: IsoDateTime }, nowIso: IsoDateTime): Result<TaskWrite, LocalMutationError>;
export function applyClearDefer(task: Task, nowIso: IsoDateTime): Result<TaskWrite, LocalMutationError>;
export function applyFocus(task: Task, hours: number, nowIso: IsoDateTime): Result<TaskWrite, LocalMutationError>;
export function applyUnfocus(task: Task, nowIso: IsoDateTime): Result<TaskWrite, LocalMutationError>;
export function applyReopen(task: Task, nowIso: IsoDateTime): Result<TaskWrite, LocalMutationError>;
```

Decisions:

- **Inputs are typed; outputs are rows.** The defer parameter is a discriminated union — `{ kind: 'someday', until }` is unrepresentable at the call site, which is the client-side analogue of the worker's `DeferState`. `applyFocus` clamps/validates `hours` (finite, 0 < h ≤ 24 — mirror the worker's `focus_task` cap; check `worker/src/wire/` or mcp.ts for the live bound).
- **Each function returns both the updated row and the wire body**, so the optimistic write and the server request cannot drift (today they're assembled separately — `deferTaskAction` builds `updates` then spreads it; a typo desyncs them silently).
- **Guards return errors, not silence.** `applyComplete` on a done task → `err({ code: 'already_done', … })`. Actions surface these as toasts (reuse the stage-5 toast path) instead of writing anyway. Today's actions return early when the task is missing — keep that as `not_found`.
- `TaskUpdatePatch` (the EditView save shape) is defined here, built from parsed field types; `applyUpdate` enforces cross-field invariants: setting `recurrence` requires a due date (existing or in-patch); clearing `due_date` on a recurring task is rejected; explicit-null semantics match the wire contract (`null` clears, absent leaves alone).
- Wait to brand `AppState` — state and reducer stay row-shaped (master plan pillar 2).

### Action creator rewrite

Every action in `actions.ts` becomes ≤ ~15 lines: fetch row from IDB (or take it as an argument where call sites already hold it — reduce the re-read-all-tasks pattern if it falls out naturally, but don't make that this stage's mission), call the mutation, on `ok` persist + dispatch + `settleWrite`, on `err` toast. `genId` moves behind `newLocalTask` (have `genId` output validated against `TASK_ID_PATTERN` from `shared/parse/ids.ts` in a test, not at runtime).

### Shared-type decoupling

Replace all `TaskCreate`/`TaskUpdate`/`ProjectCreate`/`ProjectUpdate` imports in `pwa/src` (`pwa/src/types.ts` re-exports them; `actions.ts`, `EditView`, possibly others consume them) with the stage-3 wire body types / stage-6 patch types. After this stage, `grep -rn "TaskCreate\|TaskUpdate\|ProjectCreate\|ProjectUpdate" pwa/src` is empty. Leave the aliases themselves in `shared/types.ts` — deleting them is stage 9's call, coordinated with the worker cleanup slice.

## Tests

- `pwa/test/domain/taskMutations.test.ts` — per function: happy path produces consistent `{ task, body }` (property test with fast-check: for arbitrary pending fixture tasks, applying `body` fields onto the original row equals `task` minus `updated_at`); guard table (complete/defer/focus on done task → error; reopen on ready pending task → error; defer-until sets both fields; clear-defer nulls both; defer clears focus; recurrence-without-due-date rejected in `applyUpdate`; focus hours: NaN/0/negative/Infinity/25 rejected, 1–24 accepted).
- `pwa/type-tests/domain/taskMutations.typecheck.ts` (mirror `worker/type-tests/domain/task.typecheck.ts` conventions) — `@ts-expect-error` fixtures: `{ kind: 'someday', until: … }` defer input; passing a raw `string` where `NonEmptyString<200>` is required by `newLocalTask`.
- Update `pwa/test/api/sync.test.ts` / action tests from stage 5 only where signatures changed; behavior assertions stay identical.

## Docs

New `docs/pwa/domain/` page: module intent (client-side mirror of worker invariants, *not* a second source of truth — the server still re-validates everything), the `TaskWrite` contract, and the explicit non-goal of local recurring-successor minting. Update `docs/pwa/context/` for the slimmed actions.

## Acceptance criteria

- `actions.ts` contains no field-level row construction (`status: 'done'`, `defer_kind:`, `focused_until:` literals appear only in `pwa/src/domain/`).
- `grep -rn "TaskCreate\|TaskUpdate" pwa/src` → empty; worker verification still green (shared/types.ts untouched).
- All suites + `npm run verify` green.
- Note in the todo file (and in `docs/plans/type-driven-safety-implementation-todo.md`'s cleanup slice) that the PWA no longer blocks shared-alias removal.
