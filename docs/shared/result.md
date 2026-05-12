# shared/result.ts

Small `Result` helper used by parser and domain scaffolding to return data instead of throwing.

## Types

**`Result<T, E>`** — Discriminated union with `{ ok: true, value }` and `{ ok: false, error }`.

## Functions

**`ok(value)`** — Builds a successful result.

**`err(error)`** — Builds a failed result.

**`mapResult(result, map)`** — Maps the success value while preserving errors.

**`andThen(result, next)`** — Chains a result-producing function after a successful result.

**`all(results)`** — Collects successful values and aggregates array-shaped errors.

**`unwrapOr(result, fallback)`** — Returns the success value or a fallback.
