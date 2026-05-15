# worker/src/domain/ops/task.ts

Task planner helpers for task lifecycle mutations.

## Types

**`TaskPlanResult`** — `Result<Plan, AppError>` alias for task planners.

**`CompleteTaskPlanInput`** — Planner inputs that are not stored on the current task: the branded completion timestamp and, for recurring tasks, a minted id for the successor task.

**`CompleteTaskPlanner`** — Interface for callers that expose `completeTaskPlan`. It accepts `PendingTaskDomain`, making repeat completion a type-level error.

## Functions

**`completeTaskPlan(task, input)`** — Returns a mutation `Plan` for completing a pending task. One-shot tasks produce a single `task.update`; recurring tasks also produce a `task.insert` for the next occurrence using parsed `RruleParts` and carrying `sessionLog` forward as the next `kickoff_note`.
