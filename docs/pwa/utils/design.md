# pwa/src/utils/design.ts

Shared presentation helpers for task status, project labels, due-date copy, and readiness ordering.

## Functions

**`isBlocked(task, links, tasks?)`** — Returns whether a task has an active incoming `blocks` relationship. When the full task list is provided, only incomplete upstream tasks count as blockers; completed blockers are ignored.

**`readinessScore(task, today, links?, tasks?)`** — Produces the numeric readiness score used by task cards, queues, and list sorting. Blocked tasks receive the low blocked score only when `isBlocked` reports an active blocker.

**`taskSort(a, b, today, links, tasks?)`** — Sorts by readiness first, then due date, then title. Pass the full task list when available so completed blockers do not suppress downstream tasks.
