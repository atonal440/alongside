# worker/src/domain/ops/task.ts

Task planner interface scaffolding.

## Types

**`TaskPlanResult`** — `Result<Plan, AppError>` alias for task planners.

**`CompleteTaskPlanner`** — Interface for the future `completeTaskPlan` implementation. It accepts `PendingTaskDomain`, making repeat completion a type-level error once wired in.
