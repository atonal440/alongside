# pwa/src/components/views/DetailView.tsx

Requires `marked` (runtime dependency).

## Components

**`DetailView`** — Read-only detail screen for a single task. Layout order: back button, title, status/meta, action buttons (Start / Mark done), kickoff note section, notes section, task link groups (blocked by / blocking / related), edit link. Both `kickoff_note` and `notes` are rendered as markdown via the internal `Markdown` helper. The page scrolls naturally — no internal scroll box.

**`Markdown`** — Internal helper that renders a markdown string to HTML using `marked` (with `breaks: true`) and injects it via `dangerouslySetInnerHTML`. Styled with the `.detail-markdown` CSS class.

**`LinkGroup`** — Internal helper that renders a labeled group of linked tasks (blocked by / blocking / related) as clickable items that navigate to their own detail view.
