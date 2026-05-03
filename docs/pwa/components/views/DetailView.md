# pwa/src/components/views/DetailView.tsx

Requires `marked` (runtime dependency).

## Components

**`DetailView`** — Read-only detail screen for a single task. Shows dependencies, task metadata, kickoff note, notes, carry-forward note, related tasks, and detail actions. Status label shows "Focused" when `focused_until > now`, "Someday" when `defer_kind === 'someday'`, or "Deferred until DATE" when `defer_kind === 'until'` and the date is in the future. Uses `focusTaskAction`. Task notes are rendered with the shared sanitized `Markdown` component.

**`DependencySection`** — Internal helper that renders a labeled group of linked tasks as clickable dependency cards that navigate to their own detail view.
