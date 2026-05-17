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
| `start_session` | Returns ready tasks, focused tasks, preferences, and session instructions |
| `show_tasks` | Renders tasks in the inline widget |
| `show_project` | Renders a project and its tasks in the inline widget |
| `list_projects` | Lists projects filtered by status |
| `list_tasks` | Lists tasks filtered by status or search query |
| `get_ready_tasks` | Returns unblocked tasks sorted by readiness score |
| `add_task` | Creates a task in pending status |
| `complete_task` | Marks a task done, handles recurrence |
| `defer_task` | Hides a pending task. `kind: 'until'` requires an ISO timestamp; `kind: 'someday'` rejects `until` |
| `update_task` | Updates fields on a task (including `status` and `focused_until`) |
| `focus_task` | Sets `focused_until` on a non-deferred pending task; `hours` defaults to 3 and must be greater than 0 and no more than 24 |
| `reopen_task` | Moves a done or deferred task back to active pending |
| `delete_task` | Permanently deletes a task |
| `create_project` | Creates a project, optionally assigns tasks |
| `update_project` | Updates project title, notes, kickoff note, or status |
| `delete_project` | Permanently deletes a project, unlinks its tasks |
| `get_project_context` | Returns project details and ready tasks |
| `link_tasks` | Creates a dependency between two tasks |
| `unlink_tasks` | Removes a dependency between two tasks |
| `update_preference` | Sets a user preference |
| `get_action_log` | Returns recent operation history |

## See Also

- [[mcp-tools]] — full parameter and return shape reference for every tool
- [[worker/api|worker/api.ts]] — implements the same functions as a REST api 
- [[db|worker/db.ts]] — all tool implementations delegate to DB methods
- [[oauth|worker/oauth.ts]] — how external clients authenticate before calling `/mcp`
- [[app-ui|worker/src/app-ui.ts]] — MCP App widget HTML returned by `show_tasks` and `show_project`
