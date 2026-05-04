# pwa/src/utils/design.ts

Shared presentation helpers for task status, project labels, due-date copy, and readiness ordering. The numeric scoring functions delegate to [[readiness|shared/readiness.ts]] so both the PWA and worker use the same canonical formula.

## Functions

**`isFocused(task)`** — Convenience zero-arg wrapper around `shared/readiness.isFocused`; compares `focused_until` against `new Date().toISOString()`.

**`isDeferred(task, nowIso?)`** — Delegates to `shared/readiness.isDeferred`. Defaults `nowIso` to the current time.

**`isSomeday(task)`** — Returns true when `defer_kind === 'someday'`.

**`isBlocked(task, links, tasks?)`** — Returns whether a task has an active incoming `blocks` relationship. When `tasks` is empty, falls back to a simple link scan (no blocker-status check). When `tasks` is provided, delegates to `shared/readiness.hasActiveBlocker` so completed upstream tasks do not suppress downstream tasks.

**`readinessScore(task, _today, links?, tasks?)`** — Delegates to `shared/readiness.readinessScore` with `nowIso = new Date().toISOString()`. The `_today` parameter is accepted for call-site compatibility but ignored (the canonical function derives today from nowIso internally).

**`taskSort(a, b, today, links, tasks?)`** — Sorts by readiness first, then due date, then title.

**`projectTitle(task, projects)`** — Returns the project name for a task, or `'No project'`.

**`projectColor(projectId)`** — Deterministic color from a fixed palette based on project ID hash.

**`formatDue(task, today)`** — Returns a human-readable due label: `'Overdue YYYY-MM-DD'`, `'Due today'`, or `'Due YYYY-MM-DD'`.

**`firstNoteEntry(notes)`** — Returns the first double-newline-separated paragraph from `notes`, trimmed.
