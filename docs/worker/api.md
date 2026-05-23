# worker/src/api.ts

REST API handler for the PWA. Exposes CRUD endpoints for tasks, projects, and links. All routes are under `/api/*` and require bearer-token auth (enforced by the router in `index.ts`).

## Functions

**`handleApiRequest(request, url, db)`** — Main dispatcher. Matches exact route specs from `wire/rest.ts`, parses params/query/body values through the route schemas, then calls the appropriate `DB` method and returns a JSON `Response`. Import body validation is intentionally delegated to the existing import parser to preserve its `payload`-prefixed error paths, and malformed import JSON keeps the legacy `{ error: "Invalid JSON body" }` response. Covers:

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
- `GET /api/export` — full data export as a dated JSON file (`?include_log=true` to also export action log; the query value must be `true` or `false` when present)
- `POST /api/import` — restore data from an export payload; `?dry_run=true` returns row counts without writing (the query value must be `true` or `false` when present)

Malformed route params, query params, and route-owned JSON bodies return HTTP 400 with issue details before DB methods run. Task create, update, complete, link, unlink, and import routes still map typed `DomainOperationError` failures from the DB layer into JSON errors. Lifecycle/conflict failures, such as completing an already-done task or creating a dependency cycle, return HTTP 409.
