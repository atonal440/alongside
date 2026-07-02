# shared/readiness.ts

Shared predicate and scoring functions for task readiness. Used by the worker (in JS post-processing where SQL isn't convenient) and by the PWA (sidebar badge, suggest queue, status filter chips, readiness score bars). The worker also has a paired SQL fragment in `worker/src/db.ts` (`notDeferredCondition`) that mirrors `isDeferred` for D1 queries.

A task is **ready** when it is pending, not deferred, and not blocked by an unfinished task.

## Functions

**`isDeferred(task, nowIso)`** — Returns true when `defer_kind = 'someday'`, or `defer_kind = 'until'` with `defer_until > now`. Past `until` values are treated as not deferred (no write-back).

**`hasActiveBlocker(task, links, tasks)`** — Returns true when any incoming `blocks` link points from a task whose status is not `'done'`.

**`isReady(task, links, tasks, nowIso)`** — Composite of `status === 'pending'`, `!isDeferred`, and `!hasActiveBlocker`.

**`isFocused(task, nowIso)`** — Returns true when `focused_until` is set and greater than `nowIso`. Pure function; call sites pass the current ISO timestamp.

**`readinessScore(task, nowIso, links?, tasks?)`** — Canonical numeric readiness score used by both the worker (`listReadyTasks` sort) and the PWA (`suggestQueue`, `taskFlow`, `taskSort`). Higher = more actionable. Score table:

| Condition | Points |
|---|---|
| done | 0 (floor) |
| has active blocker | 5 (fixed — below all ready tasks) |
| base (unblocked pending) | 10 |
| `kickoff_note` present | +20 |
| `session_log` present | +15 |
| `focused_until` in future | +12 |
| `updated_at` within 14 days | +8 |
| `due_date` is in the past | +10 |
| `due_date` is within the next 24h | +7 |
| `due_date` within the next 7 days | +3 |

`due_date` is a UTC instant (Decision 4, `docs/plans/duties/02-timestamp-model.md`) — the due window compares instants against `nowIso`, not calendar days; there is no date-only "today" bucket at this layer (the PWA's `formatDue`/`TaskMeta` labels handle the viewer-local "Due today" distinction separately, on top of this score). Max possible score: 75. No clamping applied — consumers use values for relative ordering only.

## See Also

- [[schema]] — `Task` and `TaskLink` types consumed by these functions
- [[db|worker/db.ts]] — `notDeferredCondition` SQL fragment that mirrors `isDeferred`; imports `isFocused` and `readinessScore`
- [[design|pwa/src/utils/design.ts]] — re-exports `readinessScore` with a backward-compatible signature; imports `isFocused` and `hasActiveBlocker`
- [[suggestQueue]] — imports `isReady` and `readinessScore` directly for queue ordering
- [[taskFlow]] — `design.readinessScore` populates the `readiness` field on `TaskFlow` objects
- [[AllView]] — uses ready/deferred/blocked groupings from `isReady` and `hasActiveBlocker`
