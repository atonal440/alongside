# pwa/src/utils/suggestQueue.ts

## Functions

**`suggestQueue(tasks, today, links?)`** — Returns an ordered array of tasks for the Suggest view. Uses the shared `isReady` predicate from `shared/readiness.ts` to filter out done, deferred (any kind), and blocked tasks. Priority order within ready: (1) focused tasks (`focused_until > now`), (2) overdue pending tasks, (3) pending tasks with a kickoff note, (4) all other pending tasks. The first item is what `SuggestView` shows; the length tells the user how many more are waiting.
