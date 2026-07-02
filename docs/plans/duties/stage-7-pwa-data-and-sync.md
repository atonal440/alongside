# Stage 7 — PWA Data Layer and Sync

Part of `docs/plans/duties.md`. Prerequisites: Stages 1–6 (duties exist on the
worker). Read `01-type-system.md`'s PWA section and `docs/plans/pwa-type-safety.md`
(the parse-at-every-boundary contract) first.

## Goal

Make the PWA duty-aware at the data level: a `duties` IndexedDB store with a
decode/parse boundary, a typed response parser, sync pull of duties, and typed
pending-ops for duty create/edit/pause/delete. **No UI yet** (Stage 8). Enforce
the master's Pillar 6: the PWA renders duties and their spawned instances but
**never materializes occurrences locally** — spawning is server-authoritative.

## Context for a cold start

- PWA boundaries each need a parser + tests (`AGENTS.md` "Parse at Every
  Boundary"; `docs/plans/pwa-type-safety.md`). The four are: API responses
  (`pwa/src/api/endpoints.ts`), IDB reads (`pwa/src/idb/decode.ts`), pending ops
  (`pwa/src/api/pendingOps.ts`), form input (`pwa/src/domain/taskForm.ts`).
- IDB stores are pure async modules (`pwa/src/idb/tasks.ts`, `projects.ts`,
  `links.ts`), upgraded in `pwa/src/idb/db.ts`. `decode.ts` repairs/quarantines
  rows on read (`pwa/src/idb/decode.ts:11,88`) and carries a legacy `task_type:
  'recurring' → 'action'` migration (`decode.ts:18,24`) to retire here.
- Sync is local-first, last-write-wins on `updated_at` (`AGENTS.md`);
  `pwa/src/api/sync.ts` pulls tasks/projects/links; `pwa/src/api/pendingOps.ts`
  is the typed op queue; `pwa/src/api/endpoints.ts` parses REST responses
  (`endpoints.ts:14,24` already list `recurrence`).
- State is `useReducer` + context (`pwa/src/context/reducer.ts`, `actions.ts`).
  Local mutations go through `pwa/src/domain/taskMutations.ts`.
- Shared row schema lives in `shared/wire/rows.ts` — `DutyRowSchema` from Stage 3
  is reused here, not re-authored.

## Steps

### 1. IDB `duties` store (`pwa/src/idb/`)

- Bump the IDB version in `pwa/src/idb/db.ts` and create a `duties` object store
  (keyPath `id`). Add the store to the upgrade pipeline.
- New module `pwa/src/idb/duties.ts`: `idbGetAllDuties`, `idbPutDuty`,
  `idbDeleteDuty`, wired through the decode pipeline like `idbGetAllTasks`.
- `pwa/src/idb/decode.ts`: add a `decodeDuty` that validates against
  `DutyRowSchema` and repairs/quarantines like `decodeTask`. Add duties to the
  task decode's sibling checks. **Retire** the dead `task_type: 'recurring'`
  migration (`decode.ts:18-24`) — that stub is superseded by the real `duties`
  store; replace it with a note that recurrence now lives on duties.
- Add `duty_id` / `occurrence_at` to the task decode (nullable; accept `null`).
  Note `due_date` is now a UTC datetime, not date-only (Decision 4 / Stage 1
  Part A) — the decode's recurrence-shape check (`decode.ts:88`) and any
  date-only assumptions in the PWA time helpers must already be reconciled by
  Stage 1's sweep; this stage just carries the datetime forward.

### 2. Response parsing (`pwa/src/api/endpoints.ts`)

- `parseDutyRow` over `DutyRowSchema`; `listDuties()` / `createDuty()` /
  `updateDuty()` / `deleteDuty()` endpoint functions returning `ApiResult<…>`
  (the discriminated result from `pwa/src/api/result.ts`).
- Extend the task response parser to accept `duty_id` / `occurrence_at`.
- Never trust raw JSON past this layer (`endpoints.ts` is boundary #1).

### 3. Sync pull (`pwa/src/api/sync.ts`)

- Add duties to the full-sync pull: fetch `/api/duties`, parse each row, merge
  last-write-wins on `updated_at` into the `duties` store, dispatch to state.
  Note one duty-specific wrinkle: unlike tasks, duty rows are rewritten
  server-side **without user action** (every spawn advances the cursor and bumps
  `updated_at`), so a queued-but-unflushed local duty edit will lose the LWW merge
  far more often than a task edit would. That is still eventually consistent —
  the pending op flushes and re-applies the patch server-side — but preserve the
  existing flush-pending-ops-before-pull ordering so the window is one cycle, and
  don't "fix" a transient UI revert by weakening LWW.
- **Crucial:** the pull is also what surfaces server-spawned instances. Because
  the worker's list/sync endpoints run lazy materialize (Stage 5), a pull after
  a due date already returns the new task instances — the PWA just stores them
  like any other task. The PWA does **not** compute occurrences itself.
- Handle durable (4xx/contract) vs transient failures per the existing policy
  (`pwa/src/api/result.ts`, `syncPolicy.ts`): a rejected duty write is dropped +
  toasted + resynced, not retried forever.

### 4. Pending ops (`pwa/src/api/pendingOps.ts`)

Extend the discriminated pending-op union with duty ops:

```ts
| { kind: 'duty.create'; tempId: MintedDutyId; payload: DutyCreateInput }
| { kind: 'duty.update'; id: DutyId; patch: DutyUpdatePatch }
| { kind: 'duty.setStatus'; id: DutyId; status: DutyStatus }
| { kind: 'duty.delete'; id: DutyId }
```

- `parsePendingOp` validates these on read (boundary #4).
- Temp-id rebinding: a `duty.create` mints a `MintedDutyId` locally; when the
  server responds with the real id, rewrite subsequent queued ops referencing the
  temp id — the same total-function rebinding tasks use, extended over the duty
  variants (not string surgery).
- Serialization to method/path/body happens once, at flush time, mapping each op
  to the Stage 6 REST routes.

### 5. Local mutations (`pwa/src/domain/dutyMutations.ts`, new)

- Pure, tested duty mutation helpers mirroring `taskMutations.ts`: build the
  optimistic `Duty` row for create, apply an edit patch (re-validating the
  recurrence↔dtstart shape client-side the way `taskMutations.ts:77` guards
  recurrence↔due-date), and status transitions (reject resume-from-ended locally
  so the UI can gray it out).
- **No local materialization.** There is no client function that spawns
  instances. Add a comment making this explicit so a future contributor doesn't
  "helpfully" add one and fork the clock.
- `parseDutyForm` (`pwa/src/domain/`): brand the duty editor's raw inputs at
  submit (boundary #3), mirroring `parseTaskForm`. Stage 8 consumes it.

### 6. State (`pwa/src/context/`)

- Add `duties: Duty[]` to `AppState`; reducer actions `UPSERT_DUTY` /
  `DELETE_DUTY` mirroring the task actions (`reducer.ts`). Async creators in
  `actions.ts` for create/update/pause/resume/end/delete that write IDB
  optimistically, enqueue the pending op, and dispatch — the standard
  local-first flow.

### 7. Tests (`pwa/test/` — mirrors `worker/test/` layout)

- `decodeDuty`: valid row round-trips; corrupt rrule/status quarantined; the
  retired `recurring` migration path is gone; task decode accepts `duty_id`/
  `occurrence_at` and rejects malformed ones.
- `pendingOps`: duty ops parse; temp-id rebinding rewrites a queued
  `duty.update` after the create resolves.
- `dutyMutations`: create builds a valid optimistic row; resume-from-ended
  rejected; recurrence↔dtstart guard.
- `sync` (stubbed fetch): a pull that returns a new server-spawned instance
  stores it; a 4xx duty create is dropped + toasted, not requeued.

### 8. Docs

Update `docs/pwa/overview.md` and the relevant `docs/pwa/*` boundary docs with
the `duties` store, the new parser boundary, and the **server-authoritative
spawn** rule (why the client never materializes).

## Acceptance criteria

- `npm --prefix pwa run typecheck` / `test` / `build` pass; new suites green.
- Duties round-trip through IDB, sync, and pending ops with parsing at every edge.
- No client code path spawns instances; the "no local materialization" comment is
  present.
- The dead `recurring` task_type migration is removed.
- Root `npm run verify` passes.
- Check off Stage 7 in the implementation todo.
