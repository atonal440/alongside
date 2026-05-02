# pwa/src/components/views/AllView.tsx

## Components

**`AllView`** — The "All Tasks" view. Displays tasks in ready, blocked, and optional done groups with a split detail panel. Supports task creation from the filter input, sorting by readiness/due/project, project filtering, and task actions from the detail panel.

The detail panel renders task note previews with the shared `Markdown` component, which sanitizes task-authored markdown before injecting HTML.
