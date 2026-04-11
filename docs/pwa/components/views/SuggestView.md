# pwa/src/components/views/SuggestView.tsx

## Components

**`SuggestView`** — The default "Suggest" view. Shows a single task at a time from the `suggestQueue`, presented as a large `TaskCard`. Buttons: Focus (sets `focused_until` via `focusTaskAction`), Skip (snoozes briefly), Mark Done, Edit. Uses `isFocused()` to check focus state. A counter below the card shows how many more tasks are in the queue. Shows `EmptyState` when the queue is empty. Includes `AddBar` for creating new tasks.
