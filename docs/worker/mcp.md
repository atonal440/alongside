# worker/src/mcp.ts

Model Context Protocol (MCP) handler. Exposes Alongside task data and operations as MCP tools and resources that Claude can call directly. The endpoint is `POST /mcp` and speaks JSON-RPC 2.0.

## Functions

**`handleMcpRequest(request, db, env, surface = 'default')`** — Parses the incoming JSON-RPC envelope and dispatches to the appropriate MCP method:

- `initialize` — Returns server info and capability declaration.
- `tools/list` — Enumerates the surface's tools with JSON Schema input definitions and annotations. `surface: 'admin'` (served at `/mcp/admin`) lists only the admin set from `toolSurface.ts`; the default list has the neutral read, preview/apply and quick-verb tools only.
- `tools/call` — Executes a named tool (see below) and returns its result or a JSON-RPC error.
- `resources/list` — Lists available MCP UI resources.
- `resources/read` — Returns the HTML content of a named resource.

### MCP tools exposed

| Tool | Purpose |
|------|---------|
| `find`, `get_context`, `get_history`, `describe_commands` | Phase B reads (`reads.ts`); see `docs/mcp-tools.md` |
| `show_tasks` | Renders tasks (`task_ids`) or a project and its pending tasks (`project_id`) in the inline widget |
| `add_task` | Creates a task in pending status |
| `complete_task` | Marks a task done, handles recurrence |
| `defer_task` | Hides a pending task. `kind: 'until'` requires an ISO timestamp; `kind: 'someday'` rejects `until` |
| `update_task` | Updates fields on a task (including `status` and `focused_until`) |
| `focus_task` | Sets `focused_until` on a non-deferred pending task; `hours` defaults to 3 and must be greater than 0 and no more than 24 |

## See Also

- [[mcp-tools]] — full parameter and return shape reference for every tool
- [[worker/api|worker/api.ts]] — implements the same functions as a REST api 
- [[db|worker/db.ts]] — all tool implementations delegate to DB methods
- [[oauth|worker/oauth.ts]] — how external clients authenticate before calling `/mcp`
- [[app-ui|worker/src/app-ui.ts]] — MCP App widget HTML returned by `show_tasks`
