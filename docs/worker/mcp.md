# worker/src/mcp.ts

Model Context Protocol (MCP) handler. Exposes Alongside task data and operations as MCP tools and resources that Claude can call directly. The endpoint is `POST /mcp` and speaks JSON-RPC 2.0.

## Functions

**`handleMcpRequest(request, db)`** — Parses the incoming JSON-RPC envelope and dispatches to the appropriate MCP method:

- `initialize` — Returns server info and capability declaration.
- `tools/list` — Enumerates all available tools with JSON Schema input definitions.
- `tools/call` — Executes a named tool (see below) and returns its result or a JSON-RPC error.
- `resources/list` — Lists available MCP resources (e.g. action log widget URI).
- `resources/read` — Returns the HTML content of a named resource.

### MCP tools exposed

Each tool maps directly to a `DB` method and logs the action via `db.logAction`:

| Tool | Purpose |
|------|---------|
| `get_ready_tasks` | List unblocked pending tasks ranked by readiness |
| `get_active_tasks` | List currently active tasks |
| `get_action_log` | Fetch recent action log entries |
| `add_task` | Create a new task |
| `start_session` | Activate a task into a session |
| `complete_task` | Mark a task done (handles recurrence) |
| `reopen_task` | Reopen a completed/snoozed task |
| `snooze_task` | Snooze a task until a given date |
| `update_task` | Partial-update task fields |
| `delete_task` | Hard-delete a task |
| `create_project` | Create a new project |
| `get_project_context` | Get a project with its tasks and links |
| `list_projects` | List all projects |
| `show_project` | Show a project's details |
| `show_tasks` | Show tasks by IDs |
| `update_kickoff_note` | Update a project's kickoff note |
| `link_tasks` | Create a dependency edge |
| `list_tasks` | List tasks with optional status filter |
| `update_preference` | Set a user preference |
