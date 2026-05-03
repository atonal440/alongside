# pwa/src/components/views/SuggestView.tsx

## Components

**`SuggestView`** — The default "Today" view. Shows a single ready task from `suggestQueue`, presented as a large `TaskCard`, with a side queue for picking another ready task. Search opens matching tasks in the real detail view so done, deferred, or blocked results do not fall back to the first ready queue item. The task action bar replaces the old transient skip with a `Defer` button that opens a `DeferMenu` (1d / 1w / 2w / Someday / pick date), so dismissing a card always commits a durable state change. Task actions call the local-first context actions and sync later when offline.
