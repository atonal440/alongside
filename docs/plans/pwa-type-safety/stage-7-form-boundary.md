# Stage 7 — Form-Boundary Parsing

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–6 (uses stage-6 patch types and the shared parsers).

## Goal

Parse user input at the form boundary so malformed titles, dates, RRULEs, and defer combinations never enter the optimistic write path. Today the server's 400 is the *first* validation anywhere — by which point the bad value is already in IndexedDB and on screen. After this stage, form submits parse to typed patches with inline field errors; the server remains the authority but should never see junk from the PWA's own forms.

## Context for a cold start

- `pwa/src/components/views/EditView.tsx` — the task edit form (title, notes, kickoff note, due date, recurrence string, session log, defer kind/until, links). `onSave` passes raw input state to `updateTaskAction`. ~220 lines; read it fully before editing — the `EditForm` inner component holds field state.
- `pwa/src/components/common/AddBar.tsx` — quick-add input; trims and rejects empty, nothing else (no length cap; the worker caps titles at 200).
- `pwa/src/components/task/DeferMenu.tsx` — produces defer choices (`kind` + optional until date).
- Parsers available in `shared/parse`: `parseIsoDate`, `parseIsoDateTime`, `parseRrule` (returns brand + parsed parts in one shot), `parseNonEmpty(max)` / bounded-string helpers in `primitives.ts`, all returning `Result<T, ValidationError[]>` — check `shared/parse/primitives.ts` for the exact factory names/signatures before use.
- Stage 6 defined `TaskUpdatePatch` and the mutation guards (recurrence-requires-due-date etc. are *re-checked* there; the form layer's job is good error UX, not sole enforcement).
- jsdom + React Testing Library are installed and configured for `pwa/test/components/**` since stage 1.

## Design

### Field parsing module (new `pwa/src/domain/taskForm.ts`)

Keep React out of the parsing. One function per form:

```ts
export interface TaskFormInput { title: string; notes: string; kickoffNote: string; dueDate: string; recurrence: string; sessionLog: string; deferKind: 'none' | 'until' | 'someday'; deferUntil: string }
export type FieldErrors = Partial<Record<keyof TaskFormInput, string>>;
export function parseTaskForm(input: TaskFormInput): Result<TaskUpdatePatch, FieldErrors>;
export function parseQuickAddTitle(raw: string): Result<NonEmptyString<200>, string>;
```

Rules in `parseTaskForm` (empty string ⇒ null/absent per field):

- `title` — trimmed, non-empty, ≤ 200 (match the worker's bound; verify against `worker/src/wire/` schemas).
- `dueDate` — empty or `parseIsoDate` (the `<input type="date">` already emits `YYYY-MM-DD`; the parser still guards manual/legacy values and impossible dates like Feb 30).
- `recurrence` — empty or `parseRrule`; surface the parser's message verbatim (it names the unsupported RRULE features).
- Cross-field: `recurrence` present requires `dueDate` present (error attached to the recurrence field with a message explaining why); `deferKind === 'until'` requires `deferUntil`, other kinds forbid it (disable/clear the date input in the UI rather than erroring where possible).
- `notes`/`kickoffNote`/`sessionLog` — bounded length per worker limits (10k/2k/10k — verify).
- Error messages are human, field-scoped strings derived from the first `ValidationError` per field — not raw issue dumps.

### Component changes

- `EditView`: hold a `FieldErrors` state; on save, `parseTaskForm` → on error render messages adjacent to fields (and an aria-described-by hookup so tests can query by accessible description); on ok call `updateTaskAction(task.id, patch, …)`. No submit-while-invalid. Don't restyle the form beyond error affordances.
- `AddBar`: `parseQuickAddTitle`; over-long input shows a brief inline error (or visibly truncates — pick one, document it); `onAdd` now receives the branded title, matching stage 6's `newLocalTask` signature.
- `DeferMenu`: emit the stage-6 discriminated defer union directly (`{ kind: 'until', until }` parsed from its date input) so the unrepresentable-state guarantee starts at the menu.

## Tests

- `pwa/test/domain/taskForm.test.ts` (node env) — table per rule above: accepted/rejected values, cross-field cases, empty-vs-null normalization, message presence per field. This carries most of the coverage.
- `pwa/test/components/EditView.test.tsx` (jsdom, RTL) — render with a fixture task via a wrapped AppContext provider (build a `renderWithState` helper in `test/helpers/` if one doesn't exist yet); typing an invalid recurrence and saving shows the inline error and does **not** call the action (spy via module mock); fixing the field then saving calls it with the parsed patch.
- `pwa/test/components/AddBar.test.tsx` — Enter on whitespace does nothing; valid title fires `onAdd` and clears; 250-char paste behaves per the documented choice.
- `pwa/test/components/DeferMenu.test.tsx` — choosing "until" with a date emits the union shape; "someday" emits no date.

## Docs

Update `docs/pwa/components/` pages for the touched components and add the form-parsing contract to the `docs/pwa/domain/` page from stage 6 (forms parse for UX; domain re-guards; server re-validates — three layers, one schema family).

## Acceptance criteria

- Manual: typing `FREQ=WEEKL` in EditView shows an inline error; the network tab shows no PATCH; IndexedDB unchanged. Clearing the due date on a recurring task is blocked with an explanation.
- No raw form state reaches `updateTaskAction`/`createTaskAction` — their parameter types (branded/patch types) make that a compile error, not a convention.
- All suites + `npm run verify` green; todo file updated.
