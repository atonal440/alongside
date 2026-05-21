# worker/src/storage/apply.ts

Typed mutation plan executor for D1.

## Types

**`ApplySummary`** — Minimal result summary with applied operation count.

**`ApplyResult`** — `Result<ApplySummary, AppError>`.

**`PlanApplier`** — Interface for applying a typed `Plan`.

## Functions

**`applyPlan(d1, plan)`** — Runs every precheck before mutation, converts each `Op` into D1 prepared statements, and executes the statements in planner-provided order. `task.exists` and `project.exists` return typed `not_found` errors before any batch runs. `link.blocks_acyclic` uses a recursive D1 query to reject a new `blocks` edge when the target can already reach the source. It also emits an in-batch cycle guard so concurrent graph changes can abort the mutation batch instead of creating a cycle. Custom prechecks currently return `invariant_violation` until a future slice gives them semantics.

The executor also emits in-batch existence guards for task/project prechecks and task/project update/delete targets, so a row that disappears between precheck and mutation aborts the batch and is reported as `not_found` instead of becoming a silent zero-row write.

Plans with no row-existence guards are chunked into 100-statement batches when needed, which keeps large import restores under D1 batch limits. Guarded plans stay in one batch so guard+mutation pairs remain atomic.

Task and project update SQL is built from fixed allowlists, so unexpected patch keys are ignored instead of becoming column names.

Project deletes clear `tasks.project_id` before deleting the project row, matching the current "delete the project, keep the tasks" storage behavior and avoiding a foreign-key failure for non-empty projects.
