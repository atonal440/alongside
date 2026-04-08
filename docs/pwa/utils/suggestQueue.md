# pwa/src/utils/suggestQueue.ts

## Functions

**`suggestQueue(tasks, links)`** — Returns an ordered array of tasks for the Suggest view. Priority order: (1) currently active tasks, (2) overdue pending tasks, (3) pending tasks with a kickoff note that are not blocked, (4) all other unblocked pending tasks. Blocked tasks (those with unresolved upstream dependencies) are excluded from the queue entirely. The first item in the result is what `SuggestView` shows; the length tells the user how many more are waiting.
