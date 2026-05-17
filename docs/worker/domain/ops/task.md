# worker/src/domain/ops/task.ts

Task planner helpers for task lifecycle mutations.

## Types

**`TaskPlanResult`** — `Result<Plan, AppError>` alias for task planners.

**`CompleteTaskPlanInput`** — Planner inputs that are not stored on the current task: the branded completion timestamp and, for recurring tasks, a minted id for the successor task.

**`ActiveDeferState`** — The non-`none` defer variants accepted by `deferTaskPlan`.

**`FocusedState`** — The focused variant accepted by `focusTaskPlan`.

**`ReopenableTaskDomain`** — A done task or deferred pending task that can be reopened into active pending state.

**`CompleteTaskPlanner`** — Interface for callers that expose `completeTaskPlan`. It accepts `PendingTaskDomain`, making repeat completion a type-level error.

## Functions

**`completeTaskPlan(task, input)`** — Returns a mutation `Plan` for completing a pending task. One-shot tasks produce a single `task.update`; recurring tasks also produce a `task.insert` for the next occurrence using parsed `RruleParts` and carrying `sessionLog` forward as the next `kickoff_note`.

**`deferTaskPlan(task, input)`** — Plans an atomic deferral update for a pending task. Timed deferrals write branded `defer_until`; someday deferrals clear it. Both variants clear `focused_until`.

**`clearDeferTaskPlan(task, input)`** — Plans `defer_kind = 'none'` and `defer_until = null` for a pending task.

**`focusTaskPlan(task, input)`** — Plans a focused timestamp for a non-deferred pending task. Deferred tasks return an `invalid_transition` error instead of becoming hidden-but-focused.

**`isReopenableTask(task)`** — Type guard for the tasks accepted by `reopenTaskPlan`.

**`reopenTaskPlan(task, input)`** — Plans a done or deferred pending task back to active pending state, clearing deferral and focus fields.
