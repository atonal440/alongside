# worker/src/api.ts

REST API handler for the PWA. Exposes CRUD endpoints for tasks, projects, links, and pending-op flushing. All routes are under `/api/*` and require bearer-token auth (enforced by the router in `index.ts`).

## Functions

**`handleApiRequest(request, db)`** — Main dispatcher. Parses the URL path and HTTP method, then calls the appropriate `DB` method and returns a JSON `Response`. Covers:

- `GET /api/tasks` — list tasks (optional `?status=` filter)
- `POST /api/tasks` — create task
- `GET /api/tasks/:id` — get single task
- `PATCH /api/tasks/:id` — update task fields
- `DELETE /api/tasks/:id` — delete task
- `POST /api/tasks/:id/activate` — activate task
- `POST /api/tasks/:id/complete` — complete task
- `POST /api/tasks/:id/reopen` — reopen task
- `POST /api/tasks/:id/snooze` — snooze task
- `GET /api/projects` — list projects
- `POST /api/projects` — create project
- `GET /api/projects/:id` — get single project
- `PATCH /api/projects/:id` — update project
- `GET /api/links` — list all links
- `POST /api/links` — create link
- `DELETE /api/links` — delete link (body: `{from_task_id, to_task_id}`)
- `GET /api/ops` — list pending ops (debug/admin)
