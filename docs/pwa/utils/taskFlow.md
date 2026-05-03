# pwa/src/utils/taskFlow.ts

Typed task-flow model used by cards, queues, lists, and detail surfaces. It maps a task plus surrounding context into a stable `TaskFlow` object with mode, status copy, meta-slot copy, readiness, project styling, note previews, relationships, and the actions that should be shown on a given surface.

## Exports

**`TaskFlowContext`** — Context passed into `deriveTaskFlow`: date, projects, links, optional full task list, surface, and selection state. Supplying `tasks` lets blocked/focused/readiness states distinguish active blockers from completed upstream blockers.

**`TASK_FLOW_CHART`** — Declarative state table for `done`, `focused`, `someday`, `deferred`, `blocked`, and `ready` tasks, including per-surface actions. Ready and focused tasks expose a `defer` action; deferred and someday tasks expose a `reopen` action that clears the deferral.

**`deriveTaskFlow(task, context)`** — Returns the normalized view model for a task. Blocked mode and readiness are computed with the active-blocker semantics from `design.ts`. `metaLabel` is the single source of truth for score-vs-date card meta slots: ready and focused tasks return `null`, deferred tasks return compact "Until {date}" copy, someday tasks return `Someday`, done tasks return the compact completion date from `updated_at`, and blocked tasks reuse `statusLabel`.
