# worker/src/app-ui.ts

Generates self-contained HTML strings for the two embeddable iframe widgets. Each returned string includes all CSS and JavaScript inline so the widget works without any external assets.

## Functions

**`getAppHtml(tasks)`** — Returns the HTML for the focused-tasks dashboard widget. Renders the list of focused tasks passed in and sets up a `postMessage` JSON-RPC listener so the embedding page can trigger task actions (complete, reopen, etc.) without a full page reload. Includes a badge style and LABELS entry for `focus_task`.

**`getActionLogHtml(entries)`** — Returns the HTML for the action log widget. Renders a list of recent `ActionLogEntry` records showing which MCP tool ran, on which task, and when. Data is injected at render time from the `entries` argument rather than fetched from the DB by the widget itself.
