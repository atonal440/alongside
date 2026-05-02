# pwa/src/components/views/DetailView.tsx

Requires `marked` (runtime dependency).

## Components

**`DetailView`** — Read-only detail screen for a single task. Shows dependencies, task metadata, kickoff note, notes, carry-forward note, related tasks, and detail actions. Status label shows "Focused" when `focused_until > now`, or "Snoozed until DATE" when `snoozed_until > now`. Uses `focusTaskAction`. Task notes are rendered with the shared sanitized `Markdown` component.

**`DependencySection`** — Internal helper that renders a labeled group of linked tasks as clickable dependency cards that navigate to their own detail view.
