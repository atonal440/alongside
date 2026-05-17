# worker/src/storage/apply.ts

Typed mutation plan executor for D1.

## Types

**`ApplySummary`** — Minimal result summary with applied operation count.

**`ApplyResult`** — `Result<ApplySummary, AppError>`.

**`PlanApplier`** — Interface for applying a typed `Plan`.

## Functions

**`applyPlan(d1, plan)`** — Runs every precheck before mutation, converts each `Op` into D1 prepared statements, and executes the statements in one `d1.batch()` in planner-provided order. `task.exists` and `project.exists` return typed `not_found` errors before any batch runs. Link graph and custom prechecks currently return `invariant_violation` until their later slices implement the required checks.

Task and project update SQL is built from fixed allowlists, so unexpected patch keys are ignored instead of becoming column names.
