# pwa/src/utils/design.ts

Shared presentation helpers for task status, project labels, due-date copy, and readiness ordering. The numeric scoring functions delegate to [[readiness|shared/readiness.ts]] so both the PWA and worker use the same canonical formula.

## Functions

**`isFocused(task)`** — Convenience zero-arg wrapper around `shared/readiness.isFocused`; compares `focused_until` against `new Date().toISOString()`.

**`isDeferred(task, nowIso?)`** — Delegates to `shared/readiness.isDeferred`. Defaults `nowIso` to the current time.

**`isSomeday(task)`** — Returns true when `defer_kind === 'someday'`.

**`isBlocked(task, links, tasks?)`** — Returns whether a task has an active incoming `blocks` relationship. When `tasks` is empty, falls back to a simple link scan (no blocker-status check). When `tasks` is provided, delegates to `shared/readiness.hasActiveBlocker` so completed upstream tasks do not suppress downstream tasks.

**`readinessScore(task, links?, tasks?, nowIso?)`** — Delegates to `shared/readiness.readinessScore`. `nowIso` defaults to `new Date().toISOString()`.

**`taskSort(a, b, links, tasks?, nowIso?)`** — Sorts by readiness first, then due date, then title.

**`projectTitle(task, projects)`** — Returns the project name for a task, or `'No project'`.

**`projectColor(projectId)`** — Deterministic color from a fixed palette based on project ID hash.

**`localDateOf(iso)`** — Converts a stored UTC instant to `YYYY-MM-DD` in the *viewer's* local zone (`Intl`/`toLocaleDateString('en-CA')`). `due_date` is a UTC instant (Decision 4); a date-only value migrates to noon UTC specifically so this conversion lands back on the original calendar date for viewer zones UTC−12..+11. Every plain-date rendering of `due_date` (`formatDue`, `TaskMeta`, `DetailView`, the edit form's date input) goes through this, not a raw string slice.

**`formatDue(task, nowIso)`** — Returns a human-readable due label: `'Overdue YYYY-MM-DD'`, `'Due today'`, or `'Due YYYY-MM-DD'`. Reads `task.due_all_day` directly (`null` on legacy rows is treated as all-day) rather than inferring it — an earlier noon-UTC-instant heuristic here couldn't distinguish "no time was specified" from "genuinely due at noon UTC" once `due_date` was stored, so `due_all_day` became a real column (`shared/schema.ts`). An all-day due date stays `'Due today'` for the whole viewer-local day even after its instant passes; a genuinely timed due date goes `'Overdue'` the instant it passes, same local day or not. `TaskMeta`'s `taskMetaString` mirrors this exactly.

**`firstNoteEntry(notes)`** — Returns the first double-newline-separated paragraph from `notes`, trimmed.
