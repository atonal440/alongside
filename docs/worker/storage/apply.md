# worker/src/storage/apply.ts

Plan-application scaffolding.

## Types

**`ApplySummary`** — Minimal result summary with applied operation count.

**`ApplyResult`** — `Result<ApplySummary, AppError>`.

**`PlanApplier`** — Interface for applying a typed `Plan`.

The actual D1 implementation will land with the `Op`/`Plan` slice.
