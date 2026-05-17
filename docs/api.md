# REST API Reference

The Alongside worker exposes a REST API used by the PWA. All endpoints require a bearer token and return JSON.

**Base URL:** `http://localhost:8787` (local) or your deployed worker URL.

**Auth:** `Authorization: Bearer {AUTH_TOKEN}` on every request.

**CORS:** All origins allowed (`Access-Control-Allow-Origin: *`). Preflight OPTIONS requests return 204.

---

## Task Endpoints

### `GET /api/tasks`

Returns all tasks with status `pending` or `active`, ordered by `due_date` then `created_at`.

**Response:** `Task[]`

---

### `GET /api/tasks/sync`

Returns all tasks regardless of status. Used by the PWA for a full sync on load.

**Response:** `Task[]`

---

### `GET /api/tasks/:id`

**Response:** `Task` — 404 if not found.

---

### `POST /api/tasks`

Create a new task.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | |
| `notes` | `string` | no | |
| `due_date` | `string` | no | ISO 8601 date |
| `recurrence` | `string` | no | iCal RRULE |

**Response:** `Task` — 201

---

### `PATCH /api/tasks/:id`

Partial update. Only provided fields are changed.

**Request body:** any subset of `{ title, notes, due_date, recurrence }`

**Response:** `Task` — 404 if not found.

---

### `DELETE /api/tasks/:id`

Hard-deletes a task.

**Response:** `{ ok: true }` — 404 if not found.

---

### `POST /api/tasks/:id/complete`

Mark a task done. If the task has `recurrence` + `due_date`, a new task is created for the next occurrence.

**Response:**
```ts
{
  completed: Task,
  next?: Task   // present if recurrence was spawned
}
```
404 if not found.

---

## Action Log

### `GET /api/action-log`

Returns recent task mutations (last 50) in reverse chronological order. Each entry is an append-only record written at the time of the operation; entries survive task/project deletion.

**Response:**
```ts
{
  id:         number,
  tool_name:  string,   // e.g. "add_task", "complete_task"
  task_id:    string | null,
  title:      string,
  detail:     string | null,
  created_at: string    // ISO 8601 datetime
}[]
```

---

## Task Schema

Full field reference for the task object returned by all endpoints:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `string` | no | Nanoid, prefixed `t_` |
| `title` | `string` | no | |
| `notes` | `string` | yes | |
| `status` | `string` | no | `pending` or `done` |
| `due_date` | `string` | yes | ISO 8601 date |
| `recurrence` | `string` | yes | iCal RRULE string |
| `task_type` | `string` | no | `action` or `plan` |
| `project_id` | `string` | yes | FK to projects table |
| `kickoff_note` | `string` | yes | Forward-looking re-entry note |
| `session_log` | `string` | yes | Appended session history |
| `defer_until` | `string` | yes | ISO 8601 timestamp; required when `defer_kind = 'until'`, otherwise null |
| `defer_kind` | `string` | no | `none` (default), `until` (timed), or `someday` (indefinite) |
| `focused_until` | `string` | yes | ISO 8601 timestamp; task is "focused" while now < this value. Deferred and done tasks must keep this null |
| `created_at` | `string` | no | ISO 8601 datetime |
| `updated_at` | `string` | no | ISO 8601 datetime |

---

## Error Responses

All errors return `{ error: string }` with an appropriate HTTP status code.

| Status | Meaning |
|---|---|
| 401 | Missing or invalid bearer token |
| 403 | Invalid UI signature |
| 404 | Resource not found |
| 400 | Malformed request body |

---

## UI Routes

These routes serve the embedded iframe widget. Auth uses URL-embedded HMAC signatures (`?t=<timestamp>&sig=<hmac>`) rather than bearer tokens, so the iframe can be embedded without exposing credentials.

### `GET /ui/active`

Returns an HTML page showing the current active tasks. Dark-themed, auto-refreshes via polling every 10 seconds.

### `GET /ui/tasks`

JSON polling endpoint used by the iframe. Returns active tasks.

**Response:** `Task[]`

### `POST /ui/complete/:id`

Complete a task from within the iframe widget.

**Response:** `{ completed: Task, next?: Task }`
