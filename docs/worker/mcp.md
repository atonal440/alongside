# worker/src/mcp.ts

Model Context Protocol (MCP) handler. Exposes Alongside task data and operations as MCP tools and resources that Claude can call directly. The endpoint is `POST /mcp` and speaks JSON-RPC 2.0.

## Functions

**`handleMcpRequest(request, db, env)`** — Parses the incoming JSON-RPC envelope and dispatches to the appropriate MCP method:

- `initialize` — Returns server info and capability declaration.
- `tools/list` — Enumerates all available tools with JSON Schema input definitions.
- `tools/call` — Executes a named tool (see below) and returns its result or a JSON-RPC error.
- `resources/list` — Lists available MCP UI resources.
- `resources/read` — Returns the HTML content of a named resource.

### MCP tools exposed

| Tool | Purpose |
|------|---------|
| `start_session` | Returns ready tasks, preferences, and session instructions |
| `show_tasks` | Renders tasks in the inline widget |
| `show_project` | Renders a project and its tasks in the inline widget |
| `list_projects` | Lists projects filtered by status |
| `list_tasks` | Lists tasks filtered by status or search query |
| `get_ready_tasks` | Returns unblocked tasks sorted by readiness score |
| `add_task` | Creates a task in pending status |
| `complete_task` | Marks a task done, handles recurrence |
| `snooze_task` | Hides a task until a given date |
| `update_task` | Updates fields on a task |
| `reopen_task` | Moves a task back to pending |
| `delete_task` | Permanently deletes a task |
| `create_project` | Creates a project, optionally assigns tasks |
| `update_project` | Updates project title, notes, kickoff note, or status |
| `delete_project` | Permanently deletes a project, unlinks its tasks |
| `get_project_context` | Returns project details and ready tasks |
| `link_tasks` | Creates a dependency between two tasks |
| `unlink_tasks` | Removes a dependency between two tasks |
| `update_preference` | Sets a user preference |
| `get_action_log` | Returns recent operation history |
