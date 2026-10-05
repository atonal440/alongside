# shared/readiness.ts

Shared predicate and scoring functions for task readiness. Used by the worker (in JS post-processing where SQL isn't convenient) and by the PWA (sidebar badge, suggest queue, status filter chips, readiness score bars). The worker also has a paired SQL fragment in `worker/src/db.ts` (`notDeferredCondition`) that mirrors `isDeferred` for D1 queries.

A task is **ready** when it is pending, not deferred, already available (its own `available_from`, and every ancestor's, has opened), not blocked by an unfinished task (its own prerequisites and those of any ancestor), and has no finished ancestor.

**Effective dates.** A subtask cannot start before any ancestor opens or finish after any ancestor's hard deadline, so `effectiveDates(task, tasks)` returns the latest `available_from` and earliest `deadline` along the ancestor chain, each with the id of the task whose own date sets it (ties go to the nearest task). Targets (`due_date`) are never inherited. A child dated later than its parent keeps its own value; the parent's simply wins. `windowEmpty` is true when the effective opening is not strictly before the effective deadline: the task is infeasible, not corrupt, and surfaces an `empty_window` warning.

**`readiness(task, links, tasks, nowIso)`** — `{ ready, reasons, warnings, effective }`. `reasons` is empty exactly when ready; each is a code with data: `not_pending`, `deferred` (`until`), `not_yet_available` (`opensAt`, `sourceId`), `blocked_by` (`taskId`, plus `via` when an ancestor's prerequisite), `ancestor_done` (`taskId`). `warnings` never gate: `empty_window`, `deadline_passed` (`at`, `sourceId`) and `open_subtasks` (`count`; there are no node roles yet, so a parent with open subtasks stays actionable). Parent loops and missing parents end the chain instead of throwing.

## Functions

**`isDeferred(task, nowIso)`** — Returns true when `defer_kind = 'someday'`, or `defer_kind = 'until'` with `defer_until > now`. Past `until` values are treated as not deferred (no write-back).

**`isAvailable(task, nowIso, tasks?)`** — False only while `available_from` (the latest along the ancestor chain when `tasks` is passed) resolves to an instant after `nowIso`. A date opens at the start of its local day in its own zone; an unset or unreadable value never blocks. Independent of deferral.

**`deadlineBoundary(task)`** — The minute-UTC instant the hard `deadline` passes (the start of the next local day for a date deadline), or null. Used to sort and to score.

**`hasActiveBlocker(task, links, tasks)`** — Returns true when any incoming `blocks` link to the task or one of its ancestors points from a task whose status is not `'done'`.

**`isReady(task, links, tasks, nowIso)`** — `readiness(...).ready`.

**`isFocused(task, nowIso)`** — Returns true when `focused_until` is set and greater than `nowIso`. Pure function; call sites pass the current ISO timestamp.

**`readinessScore(task, nowIso, links?, tasks?)`** — Canonical numeric readiness score used by both the worker (`listReadyTasks` sort) and the PWA (`suggestQueue`, `taskFlow`, `taskSort`). Higher = more actionable. Score table:

| Condition | Points |
|---|---|
| done | 0 (floor) |
| has active blocker, or `available_from` not yet open | 5 (fixed — below all ready tasks) |
| base (unblocked pending) | 10 |
| `kickoff_note` present | +20 |
| `session_log` present | +15 |
| `focused_until` in future | +12 |
| `updated_at` within 14 days | +8 |
| `due_date` is in the past | +10 |
| `due_date` is within the next 24h | +7 |
| `due_date` within the next 7 days | +3 |
| `deadline` boundary passed / within 24h / within 7 days | +12 / +9 / +4 |

The target and the hard deadline do not add: the larger of the two bumps applies, so a hard deadline presses a little harder than a target at the same distance.

`due_date` is a UTC instant (Decision 4, `docs/plans/duties/02-timestamp-model.md`) — the due window compares instants against `nowIso`, not calendar days; there is no date-only "today" bucket at this layer (the PWA's `formatDue`/`TaskMeta` labels handle the viewer-local "Due today" distinction separately, on top of this score). Max possible score: 77. No clamping applied — consumers use values for relative ordering only.

## See Also

- [[schema]] — `Task` and `TaskLink` types consumed by these functions
- [[db|worker/db.ts]] — `notDeferredCondition` SQL fragment that mirrors `isDeferred`; imports `isFocused` and `readinessScore`
- [[design|pwa/src/utils/design.ts]] — re-exports `readinessScore` with a backward-compatible signature; imports `isFocused` and `hasActiveBlocker`
- [[suggestQueue]] — imports `isReady` and `readinessScore` directly for queue ordering
- [[taskFlow]] — `design.readinessScore` populates the `readiness` field on `TaskFlow` objects
- [[AllView]] — uses ready/deferred/blocked groupings from `isReady` and `hasActiveBlocker`
