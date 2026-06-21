# pwa/src/domain/taskMutations.ts

Client-side mirror of the worker's domain invariants. Lives in `pwa/src/domain/` and is imported only by `pwa/src/context/actions.ts`. The server still re-validates everything — this module makes local optimistic writes consistent, not authoritative.

## Purpose

Before stage 6, every action creator in `actions.ts` hand-built task rows inline: `status: 'done'`, `defer_kind: kind`, `focused_until: null` scattered through fifteen async functions. A typo or a copy-paste silently desynced the optimistic write from the wire body. This module centralises mutation logic so the updated row and the wire body are always derived from the same inputs.

## `TaskWrite`

```ts
interface TaskWrite {
  task: Task;         // row to write to IDB and dispatch
  body: TaskUpdateBody; // exact wire body for the REST request or the pending-op queue
}
```

Every mutation function returns `Result<TaskWrite, LocalMutationError>`. Action creators read `task` for IDB/dispatch, and `body` for the API call or queue op. The two cannot drift.

## Functions

| Function | Guard | Output |
|---|---|---|
| `newLocalTask(title, nowIso, id)` | — | Canonical default row for optimistic creates |
| `applyUpdate(task, patch, nowIso)` | recurrence ↔ due-date invariant | `TaskWrite` |
| `applyComplete(task, nowIso)` | `already_done` if status='done' | `TaskWrite & { wasRecurring }` |
| `applyDefer(task, defer, nowIso)` | `not_pending` if status='done' | `TaskWrite` (atomically clears focus) |
| `applyClearDefer(task, nowIso)` | `not_pending` if status='done' | `TaskWrite` |
| `applyFocus(task, hours, nowIso)` | `not_pending`; hours 0 < h ≤ 24 | `TaskWrite` |
| `applyUnfocus(task, nowIso)` | — | `TaskWrite` |
| `applyReopen(task, nowIso)` | `not_done` if status='pending' | `TaskWrite` |

## `DeferInput`

```ts
type DeferInput =
  | { kind: 'someday' }
  | { kind: 'until'; until: IsoDateTime };
```

Discriminated union — `{ kind: 'someday', until: ... }` is unrepresentable at the call site. The `until` field is required when (and only when) `kind` is `'until'`.

## Invariants enforced

- **Defer atomicity**: `applyDefer` always sets `focused_until: null` — deferred and focused are mutually exclusive states. `applyFocus` does not enforce the inverse (a focused task with a pending defer edge is not a local concern).
- **Recurrence ↔ due date**: `applyUpdate` rejects patches that would produce `recurrence !== null && due_date === null`, whether by adding recurrence to a due-date-free task or by clearing the due date on a recurring task.
- **Status transitions**: `applyComplete` / `applyReopen` check status before writing. A locally-done task that is sent a second complete call returns `already_done` without making a server request.
- **Focus hours cap**: `applyFocus` mirrors `MAX_FOCUS_HOURS = 24` from the worker MCP.

## Non-goals

- **Recurring successor minting**: `applyComplete` does not mint the next occurrence. That is the server's responsibility. The local write just marks the task done; the successor arrives via `syncFromServer`.
- **Branded field types in AppState**: All functions accept and return plain `Task` row shapes. Branded inputs (`NonEmptyString<200>`, `IsoDateTime`) appear only in function parameters where the type-level distinction adds value — stage 7 will parse form input before calling these functions.

## `TaskUpdatePatch`

```ts
interface TaskUpdatePatch {
  title?: string;
  notes?: string | null;
  due_date?: string | null;
  recurrence?: string | null;
  task_type?: string;
  project_id?: string | null;
  kickoff_note?: string | null;
  session_log?: string | null;
  // Defer fields included so EditView's unified save still works through
  // updateTaskAction. Stage 7 will split form saves into typed domain calls.
  defer_kind?: string;
  defer_until?: string | null;
  focused_until?: string | null;
}
```

Stage 7 will tighten these to `NonEmptyString<200>`, `IsoDate | null`, etc. once the form boundary is typed.
