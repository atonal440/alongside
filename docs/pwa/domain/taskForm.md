# pwa/src/domain/taskForm.ts

Form boundary parser. Called once at submit time in `EditView` and `AddBar`; inside the app, data past this point is assumed valid. The server is the final authority, but should never see junk from the PWA's own forms.

## Purpose

Stage 7 adds a parse layer at every PWA form submission so that malformed titles, dates, RRULEs, and defer combinations are caught in the UI before entering the optimistic write path. This module contains all form-specific validation rules and produces typed values (`TaskUpdatePatch` with branded fields) or per-field error messages.

## `parseTaskForm(input: TaskFormInput): Result<TaskUpdatePatch, FieldErrors>`

Validates and converts a raw form submission to a fully typed `TaskUpdatePatch`.

### `TaskFormInput` shape

```ts
interface TaskFormInput {
  title: string;
  notes: string;
  kickoffNote: string;
  dueDate: string;          // YYYY-MM-DD or ''
  recurrence: string;       // RRULE string or ''
  sessionLog: string;
  deferKind: 'none' | 'until' | 'someday';
  deferUntil: string;       // YYYY-MM-DD or ''
}
```

### `FieldErrors` type

```ts
type FieldErrors = Partial<Record<keyof TaskFormInput, string>>;
```

### Validation rules

| Field | Rule |
|-------|------|
| `title` | Non-empty after trim; ≤ 200 chars |
| `notes` | Optional; ≤ 10 000 chars; empty string → `null` in patch |
| `kickoffNote` | Optional; ≤ 2 000 chars; empty string → `null` |
| `sessionLog` | Optional; ≤ 10 000 chars; empty string → `null` |
| `dueDate` | Optional; must be a real calendar date in `YYYY-MM-DD` format; empty → `null` |
| `recurrence` | Optional; must parse as a valid RRULE; **cross-field**: recurrence requires `dueDate` to be set |
| `deferKind='until'` | Requires `deferUntil` to be non-empty; produces `IsoDateTime` at 09:00 local time |

All errors are collected before returning — a single submit can surface multiple field errors at once.

## `parseQuickAddTitle(raw: string): Result<NonEmptyString<200>, string>`

Validates a quick-add title from `AddBar`. Same rules as the `title` field above. Returns an `err(message)` with a single human-readable string on failure (not a field-errors map, since `AddBar` has only one field).

## Three-layer validation contract

```
AddBar / EditView form
   └─ parseTaskForm / parseQuickAddTitle     ← UX layer: errors shown inline
       └─ applyUpdate / applyDefer (domain)  ← guard layer: re-checks invariants
           └─ worker API                     ← authority layer: final validation
```

The form layer provides user-facing errors. The domain layer re-guards against code paths that bypass the form. The server is the canonical authority and should never receive data that the client deliberately generated.

## See Also

- [[taskMutations]] — `TaskUpdatePatch`, `DeferInput`, `applyUpdate`
- [[EditView]] — main consumer of `parseTaskForm`
- [[AddBar]] — consumer of `parseQuickAddTitle`
- `@shared/parse` — branded primitive types (`NonEmptyString`, `IsoDate`, `Rrule`, etc.)
