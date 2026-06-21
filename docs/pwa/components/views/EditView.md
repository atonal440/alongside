# pwa/src/components/views/EditView.tsx

## Components

**`EditView`** — Edit form for a single task. Fields: title (text), notes (textarea), due date (date input), recurrence (select), defer state (`None` / `Until…` / `Someday`, with a required date input for `Until…`), kickoff note (textarea), session note (textarea), and relationship management. Parses the entire form with `parseTaskForm` at submit time; renders per-field `role="alert"` error spans for validation failures and does not call `updateTaskAction` unless parsing succeeds. On success passes a fully typed `TaskUpdatePatch` to `updateTaskAction` and navigates back to `DetailView`.

## Validation (three-layer contract)

| Layer | Where | What |
|-------|-------|-------|
| Form boundary | `parseTaskForm` in `domain/taskForm` | Provides UX errors; blocks the optimistic write on bad input |
| Domain guard | `applyUpdate` in `domain/taskMutations` | Re-checks invariants on every mutation (handles non-form code paths) |
| Server | Worker API | Final authority; rejects anything still malformed |

Fields validated at the form layer: title (non-empty, ≤ 200 chars); notes/kickoff/session log (optional, bounded); due date (ISO format, real calendar date); recurrence (valid RRULE; cross-field: requires due date); defer until (required when defer kind is `until`; results in a 9 am `IsoDateTime`).

## See Also

- [[taskForm]] — `parseTaskForm` and `FieldErrors` type
- [[taskMutations]] — `TaskUpdatePatch` (branded field types)
- [[DetailView]] — navigated to on successful save
