# pwa/src/components/views/SuggestView.tsx

## Components

**`SuggestView`** — The default "Suggest" view. Shows a single task at a time from the `suggestQueue`, presented as a large `TaskCard`. When the task is not focused: shows Focus (calls `focusTaskAction`) and Skip (marks card seen, moves to next) buttons. When focused: Skip becomes Next (same effect). Also shows Mark Done and Edit. A counter below the card shows how many more tasks are in the queue. Shows `EmptyState` when the queue is empty. Includes `AddBar` for creating new tasks.
