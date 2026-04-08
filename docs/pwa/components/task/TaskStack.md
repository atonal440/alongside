# pwa/src/components/task/TaskStack.tsx

## Components

**`TaskStack`** — Renders a root task as a `CompactCard` with up to two of its directly blocked tasks stacked visually below it (also as `CompactCard`s). Used in `AllView` to show dependency context at a glance without expanding to full detail. If more than two blocked tasks exist, a "+N more" indicator is shown.
