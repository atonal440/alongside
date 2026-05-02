# pwa/src/components/common/Markdown.tsx

Requires `marked` (runtime dependency).

## Components

**`Markdown`** — Renders task-authored markdown with line breaks enabled and the `.detail-markdown` CSS class. Escapes raw HTML before parsing, then allowlist-sanitizes the generated HTML so task notes cannot inject script tags, event handlers, or unsafe link protocols.
