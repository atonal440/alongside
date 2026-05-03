# shared/readiness.ts

Shared predicate for "is this task currently ready to work on?" Used by the worker (in JS query post-processing where SQL isn't convenient) and by the PWA (sidebar badge, suggest queue, status filter chips). The worker also has a paired SQL fragment in `worker/src/db.ts` (`notDeferredCondition`) that mirrors `isDeferred` for D1 queries.

A task is **ready** when it is pending, not deferred, and not blocked by an unfinished task.

## Functions

**`isDeferred(task, nowIso)`** — Returns true when `defer_kind = 'someday'`, or `defer_kind = 'until'` with `defer_until > now`. Past `until` values are treated as not deferred (no write-back).

**`hasActiveBlocker(task, links, tasks)`** — Returns true when any incoming `blocks` link points from a task whose status is not `'done'`.

**`isReady(task, links, tasks, nowIso)`** — Composite of `status === 'pending'`, `!isDeferred`, and `!hasActiveBlocker`.
