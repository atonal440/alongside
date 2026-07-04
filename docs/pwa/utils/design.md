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

**`localDateOf(iso)`** — Converts a stored UTC instant to `YYYY-MM-DD` in the *viewer's* local zone (`Intl`/`toLocaleDateString('en-CA')`). `due_date` is a UTC instant (Decision 4); a date-only value migrates to noon UTC specifically so this conversion lands back on the original calendar date for viewer zones UTC−12..+11.

**`localTimeOf(iso)`** — Converts a stored UTC instant to an `h:mm AM/PM`-style string in the viewer's local zone (`toLocaleTimeString`). Only meaningful for a genuinely timed due date (`due_all_day: false`) — an all-day value's time component is a storage artifact (the noon-UTC anchor), not intent, so it's never shown.

**`dueDateLabel(task)`** — The shared plain-date-or-datetime label: `localDateOf` alone when `due_all_day` is `true`/`null` (all-day, including legacy rows that predate the column), or `'<date> at <time>'` when it's `false` (genuinely timed — REST/MCP can set a full datetime directly, so this is a real part of the public contract, not just internal state). `formatDue`, `TaskMeta`, and `DetailView`'s raw `"- Due …"` span all go through this rather than slicing the raw UTC string or calling `localDateOf` alone.

**`formatDue(task, nowIso)`** — Returns a human-readable due label built on `dueDateLabel`: `'Overdue <label>'`, `'Due today'` / `'Due today at <time>'`, or `'Due <label>'`. Reads `task.due_all_day` directly (`null` on legacy rows is treated as all-day) rather than inferring it — an earlier noon-UTC-instant heuristic here couldn't distinguish "no time was specified" from "genuinely due at noon UTC" once `due_date` was stored, so `due_all_day` became a real column (`shared/schema.ts`). An all-day due date stays `'Due today'` for the whole viewer-local day even after its instant passes; a genuinely timed due date goes `'Overdue'` the instant it passes, same local day or not, and always shows its time (otherwise indistinguishable from an all-day task). `TaskMeta`'s `taskMetaString` mirrors this exactly.

**`firstNoteEntry(notes)`** — Returns the first double-newline-separated paragraph from `notes`, trimmed.
