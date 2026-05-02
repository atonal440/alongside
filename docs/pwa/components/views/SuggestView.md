# pwa/src/components/views/SuggestView.tsx

## Components

**`SuggestView`** — The default "Today" view. Shows a single ready task from `suggestQueue`, presented as a large `TaskCard`, with a side queue for picking another ready task. Search opens matching tasks in the real detail view so done, snoozed, or blocked results do not fall back to the first ready queue item. Task actions call the local-first context actions and sync later when offline.
