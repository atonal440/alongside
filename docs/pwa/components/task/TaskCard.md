# pwa/src/components/task/TaskCard.tsx

## Components

**`TaskCard`** — Full-detail task card used in `SuggestView` and `AllView`. Displays title, `TaskMeta` metadata, truncated notes, and a row of action buttons driven by the task's flow mode (Mark Done, Defer, Focus, Edit/Detail). Calls the appropriate action creator for each button. Highlighted differently when the task is focused vs. pending.

## See Also

- [[SuggestView]] — primary host of TaskCard for the main queue card
- [[AllView]] — uses TaskCard alongside TaskStack for list items
- [[TaskMeta]] — renders the metadata row inside each card
- [[taskFlow]] — `deriveTaskFlow` drives action button set and mode styling
