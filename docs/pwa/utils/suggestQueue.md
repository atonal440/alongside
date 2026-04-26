# pwa/src/utils/suggestQueue.ts

## Functions

**`suggestQueue(tasks, today, cardSeen, links?)`** — Returns an ordered array of tasks for the Suggest view. Excludes done tasks, currently-snoozed tasks, tasks blocked by incomplete upstream tasks, and tasks already seen this session (`cardSeen`). Completed blockers do not keep downstream tasks out of the queue. Priority order: (1) focused tasks (`focused_until > now`), (2) overdue pending tasks, (3) pending tasks with a kickoff note, (4) all other pending tasks. The first item is what `SuggestView` shows; the length tells the user how many more are waiting.
