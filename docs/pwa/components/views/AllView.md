# pwa/src/components/views/AllView.tsx

## Components

**`AllView`** — The "All Tasks" view. Displays every task grouped by project (ungrouped tasks in a "No project" bucket). Each group has a collapsible "Done" section. Supports task creation via `AddBar` at the top. Clicking a task title navigates to `DetailView`.

Tasks with in-section blocking relationships are rendered as a `TaskStack` accordion; standalone tasks render as plain `CompactCard`s. The `ProjectSection` helper uses a `collectChain` loop to follow the full blocking chain from each root task (not just 2 levels), marking each linked task as rendered to avoid duplicates. Tasks blocked by tasks in other sections fall through as overflow `CompactCard`s at the end of the section.
