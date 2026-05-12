# worker/src/api.ts

REST API handler for the PWA. Exposes CRUD endpoints for tasks, projects, and links. All routes are under `/api/*` and require bearer-token auth (enforced by the router in `index.ts`).

## Functions

**`handleApiRequest(request, url, db)`** — Main dispatcher. Parses the URL path and HTTP method, then calls the appropriate `DB` method and returns a JSON `Response`. Task-list reads (`GET /api/tasks`, `GET /api/tasks/sync`) and the duty list (`GET /api/duties`) call `materializeDueDuties` first so legacy recurring tasks are converted and any due duties become real tasks before the response is computed. Covers:

- `GET /api/tasks` — list actionable pending tasks (excludes currently-deferred)
- `GET /api/tasks/sync` — list all tasks including done and deferred-pending (for full PWA sync)
- `GET /api/tasks/links` — list all task links
- `POST /api/tasks/links` — create a link
- `DELETE /api/tasks/links` — remove a link (body: `{from_task_id, to_task_id, link_type}`)
- `GET /api/tasks/:id` — get single task
- `POST /api/tasks` — create task
- `PATCH /api/tasks/:id` — update task fields (including `focused_until`, `defer_until`, `defer_kind`)
- `DELETE /api/tasks/:id` — delete task
- `POST /api/tasks/:id/complete` — mark task done; duty schedule advances independently
- `GET /api/duties` — list all duties (active and paused)
- `POST /api/duties` — create a duty (`title`, `recurrence` required; `first_fire_date` defaults to today in user tz)
- `GET /api/duties/:id` — get single duty
- `PATCH /api/duties/:id` — update duty fields (`first_fire_date` shorthand resolves to `next_fire_at`)
- `DELETE /api/duties/:id` — delete a duty (materialized tasks survive)
- `GET /api/projects` — list active projects
- `GET /api/projects/sync` — list all projects including archived (for PWA sync)
- `POST /api/projects` — create project
- `GET /api/projects/:id` — get single project
- `PATCH /api/projects/:id` — update project (title, notes, kickoff_note, status)
- `DELETE /api/projects/:id` — delete project (unlinks tasks first)
- `GET /api/action-log` — recent action log entries
- `PUT /api/preferences/timezone` — set the IANA timezone used for duty scheduling
- `GET /api/export` — full data export as a dated JSON file (`?include_log=true` to also export action log)
- `POST /api/import` — restore data from an export payload; `?dry_run=true` returns row counts without writing
