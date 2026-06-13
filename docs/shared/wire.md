# shared/wire/

Field-level row schemas shared between the worker's import pipeline and the PWA's API/IDB read boundaries.

## What lives here

`shared/wire/rows.ts` exposes one schema per persisted row type:

| Schema | Output type | Used by |
|--------|-------------|---------|
| `TaskRowSchema` | `Task` | PWA API client (stage 3), PWA IDB decode (stage 8) |
| `ProjectRowSchema` | `Project` | Worker import, PWA API client, PWA IDB decode |
| `TaskLinkRowSchema` | `TaskLink` | Worker import, PWA API client, PWA IDB decode |

Each schema validates **field-level constraints only**: branded IDs (regex format), enum membership, ISO timestamps, RRULE syntax, and text length bounds. No cross-field invariants.

The file also exports `taskRowEntries` (the valibot `ObjectEntries` map for `TaskRowSchema`) so the worker can spread them and overlay import-specific legacy tolerance without duplicating field definitions.

## Cross-field invariants live elsewhere

Rules like `defer_kind === 'until'` ↔ `defer_until` present, recurrence requires `due_date`, and done tasks can't be focused are enforced downstream:

- **Worker:** `taskFromRow` in `worker/src/domain/task.ts`
- **PWA writes:** stage 6 local mutation guards (`pwa/src/domain/taskMutations.ts`)
- **PWA IDB reads:** stage 8 decode layer (`pwa/src/idb/decode.ts`)

Do not add cross-field checks here — they would cause the import pipeline and response parsers to reject rows the system currently accepts.

## Legacy tolerance stays in the worker

The pre-006 `snoozed_until` normalization lives in `worker/src/wire/importPayload.ts` as a locally-composed `ImportTaskRowSchema`. REST responses and post-migration IDB rows always carry `defer_kind`/`defer_until`, so the shared canonical schema requires both fields.

## Assignability guarantee

The schema output types are structurally assignable to the Drizzle row types (`Task`, `Project`, `TaskLink`). This is enforced at two points:

1. The `v.transform((row): T => ({ ...row }))` annotation in each schema — TypeScript rejects the annotation if branded field types aren't assignable to the row's unbranded fields.
2. Exported compile-time assertions (`AssertTaskRowAssignable` etc.) document the guarantee explicitly; a failing assertion surfaces as a type error on the assertion itself.

## Shared module constraints

`shared/wire/` must load in workerd, Node (vitest), and the browser. It must not import worker-only types (`Plan`, `AppError`) or DOM/React APIs.
