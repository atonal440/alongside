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
| `add_task` | Creates a one-shot task in pending status (use `add_duty` for repeating work) |
| `complete_task` | Marks a task done; for duty-derived tasks, schedule advancement is independent |
| `defer_task` | Hides a task. `kind: 'until'` (with `until` ISO date) or `kind: 'someday'` (indefinite) |
| `update_task` | Updates fields on a task (including `status` and `focused_until`) |
| `focus_task` | Sets `focused_until` on a task (task_id required, hours optional defaulting to 3) |
| `reopen_task` | Moves a task back to pending |
| `delete_task` | Permanently deletes a task |
| `add_duty` | Creates a recurring task template that materializes on a schedule |
| `list_duties` | Lists all duties (active and paused) |
| `update_duty` | Updates a duty's template fields, schedule, or active state |
| `delete_duty` | Permanently deletes a duty (materialized tasks survive) |
| `create_project` | Creates a project, optionally assigns tasks |
| `update_project` | Updates project title, notes, kickoff note, or status |
| `delete_project` | Permanently deletes a project, unlinks its tasks |
| `get_project_context` | Returns project details and ready tasks |
| `link_tasks` | Creates a dependency between two tasks |
| `unlink_tasks` | Removes a dependency between two tasks |
| `update_preference` | Sets a user preference (note: `timezone` is read by the duties engine) |
| `get_action_log` | Returns recent operation history |

Read tools (`list_tasks`, `get_ready_tasks`, `show_tasks`, `show_project`, `start_session`) call `materializeDueDuties` first so any duties whose `next_fire_at` has passed are turned into real tasks before the response goes out.

## See Also

- [[mcp-tools]] — full parameter and return shape reference for every tool
- [[worker/api|worker/api.ts]] — implements the same functions as a REST api 
- [[db|worker/db.ts]] — all tool implementations delegate to DB methods
- [[oauth|worker/oauth.ts]] — how external clients authenticate before calling `/mcp`
- [[app-ui|worker/src/app-ui.ts]] — MCP App widget HTML returned by `show_tasks` and `show_project`
- [[duties|worker/duties.ts]] — materialization engine called by read paths and by duty MCP tools
