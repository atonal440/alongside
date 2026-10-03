# worker/src/app-ui.ts

Generates self-contained HTML strings for the two embeddable iframe widgets. Each returned string includes all CSS and JavaScript inline so the widget works without any external assets.

## Functions

**`getAppHtml(tasks)`** — Returns the HTML for the focused-tasks dashboard widget. Renders the list of focused tasks passed in and sets up a `postMessage` JSON-RPC listener so the embedding page can trigger task actions (complete, reopen, etc.) without a full page reload. Includes a badge style and LABELS entry for `focus_task`.

**`getActionLogHtml(entries)`** — Returns the HTML for the action log widget. Renders a list of recent `ActionLogEntry` records showing which MCP tool ran, on which task, and when. Data is injected at render time from the `entries` argument rather than fetched from the DB by the widget itself.

## Tool calls from the task widget

The widget runs inside the host and calls tools by name through `tools/call`, so those names are a compatibility surface (see the compatibility constraints in [the MCP surface plan](../plans/mcp-surface.md)). Today it uses:

| Action | Calls |
|---|---|
| Refresh the displayed tasks | `find({ entity: 'task', filter: { statuses: ['pending', 'done'] }, limit: 200 })`, following `nextCursor` until every displayed task has been seen (at most 25 pages) |
| Check a task off | `complete_task({ task_id })`, and a toast for a recurring task's successor |
| Uncheck a task | `preview_changes({ intent: true, actor: 'user', commands: [{ kind: 'task.reopen', id }] })`, then `apply_changes` with the returned `pinnedEnvelope` unchanged |

A refused call (`isError` result) puts the checkbox back and logs the error; before, only JSON-RPC errors did. The widget no longer calls `list_tasks` or `reopen_task`, so phase D can remove them. `test/appWidget.test.ts` runs the real widget script against the real MCP handler through a fake host and fails if the widget starts calling a deprecated tool.
