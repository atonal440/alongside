# worker/src/domain/ops/link.ts

Link planner for dependency graph mutations.

## Types

**`LinkPlanResult`** — `Result<Plan, AppError>` alias for link planners.

**`LinkPlanner`** — Interface for link plan construction.

## Functions

**`linkTasksPlan(link)`** — Rejects self-links, asserts both endpoint tasks exist, attaches a `link.blocks_acyclic` precheck for `blocks` links, and emits one `link.upsert` op.

**`unlinkTasksPlan(link)`** — Rejects self-links and emits one `link.delete` op. It intentionally does not assert endpoint existence, preserving the previous no-op behavior for deleting absent links.
