# worker/src/api.ts

REST API handler for the PWA. Exposes CRUD endpoints for tasks, projects, and links. All routes are under `/api/*` and require bearer-token auth (enforced by the router in `index.ts`).

## Functions

**`handleApiRequest(request, url, db)`** — Main dispatcher. Parses the URL path and HTTP method, then calls the appropriate `DB` method and returns a JSON `Response`. Covers:

- `GET /api/tasks` — list actionable pending tasks (excludes currently-deferred)
- `GET /api/tasks/sync` — list all tasks including done and deferred-pending (for full PWA sync)
- `GET /api/tasks/links` — list all task links
- `POST /api/tasks/links` — create a link
- `DELETE /api/tasks/links` — remove a link (body: `{from_task_id, to_task_id, link_type}`)
- `GET /api/tasks/:id` — get single task
- `POST /api/tasks` — create task
- `PATCH /api/tasks/:id` — update task fields (including `focused_until`, `defer_until`, `defer_kind`)
- `DELETE /api/tasks/:id` — delete task
- `POST /api/tasks/:id/complete` — complete task (handles recurrence)
- `GET /api/projects` — list active projects
- `GET /api/projects/sync` — list all projects including archived (for PWA sync)
- `POST /api/projects` — create project
- `GET /api/projects/:id` — get single project
- `PATCH /api/projects/:id` — update project (title, notes, kickoff_note, status)
- `DELETE /api/projects/:id` — delete project (unlinks tasks first)
- `GET /api/action-log` — recent action log entries
- `GET /api/export` — full data export as a dated JSON file (`?include_log=true` to also export action log)
- `POST /api/import` — restore data from an export payload; `?dry_run=true` returns row counts without writing
