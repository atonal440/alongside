# worker/src/domain/errors.ts

Typed application errors for parser, planner, and storage layers.

## Types

**`AppError`** — Discriminated union for `validation`, `not_found`, `conflict`, `invalid_transition`, `invariant_violation`, and `storage`.

## Functions

**`validationErrorResult(errors)`** — Wraps validation errors as an `AppError`.

**`appErrorStatus(error)`** — Maps an `AppError` to an HTTP status.

**`appErrorMessage(error)`** — Produces a concise message for REST/MCP error payloads.
