# worker/src/domain/ops/project.ts

Project planner helpers for project lifecycle mutations.

## Types

**`ProjectPlanResult`** — `Result<Plan, AppError>` alias for project planners.

**`ProjectPlanner`** — Interface for callers that expose `createProjectPlan`.

## Functions

**`createProjectPlan(project, taskIds, updatedAt)`** — Plans a `project.insert` followed by one `task.update` per unique task id, assigning those tasks to the new project. Adds a `task.exists` assertion for each assigned task so a missing task prevents both the project insert and all task updates.
