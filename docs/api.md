# REST API Reference

The Alongside worker exposes a REST API used by the PWA. All endpoints require a bearer token and return JSON.

**Base URL:** `http://localhost:8787` (local) or your deployed worker URL.

**Auth:** `Authorization: Bearer {AUTH_TOKEN}` on every request.

**CORS:** All origins allowed (`Access-Control-Allow-Origin: *`). Preflight OPTIONS requests return 204.

---

## v2 temporal foundation

These authenticated, read-only endpoints return `contractVersion: 2`. They
share strict schemas and domain behavior with MCP. See
[temporal foundation](shared/temporal-foundation.md) for boundaries, errors,
feature gates, and legacy compatibility.

| Endpoint | Input | Result |
| --- | --- | --- |
| `GET /api/v2/capabilities` | Optional `timezone` query | Server time, interpreted zone/source, setup requirement, implemented features/limits and delivery configuration |
| `POST /api/v2/resolve-time` | Tagged structured input below | UTC minute `at`, interpreted zone/source, server time, inclusive/exclusive comparison |
| `POST /api/v2/legacy-dates/preview` | Optional `timezone`, `after` task ID, `limit` (1–500, default 100) | Dry-run target candidates preserving originals/provenance, unresolved rows and next cursor |

Resolve examples:

```json
{"kind":"wall_time","date":"2026-11-01","time":"01:30","timezone":"America/Los_Angeles","disambiguation":"later"}
```

```json
{"kind":"date_boundary","date":"2026-09-30","role":"deadline","timezone":"America/Los_Angeles"}
```

```json
{"kind":"offset","point":{"kind":"date","date":"2026-09-30","timezone":"America/Los_Angeles"},"offset":{"kind":"elapsed_minutes","minutes":-15},"dateAnchorTime":"09:00"}
```

Calendar offsets use `{"kind":"calendar_days","days":1,"localTime":"09:00"}`.
`dateAnchorTime` is required only for elapsed offsets from a date point and
rejected otherwise. Offset DST errors identify the submitted anchor field.
Unknown keys, duplicate queries, unsupported queries and explicit null return
400. Omitted zone uses a configured workspace zone or explicitly reported UTC
fallback. DST folds require a choice; gaps return alternatives. Errors use
`{"contractVersion":2,"error":{"code":...,"path":...,"message":...,"retryable":false,"recoveryHint":...}}`.
Legacy preview pagination is not a consistent concurrent snapshot; no date
migration or background delivery occurs through these endpoints.

---

## Task Endpoints

### `GET /api/tasks`

Returns actionable pending tasks, excluding currently deferred tasks, ordered by `due_date` then `created_at`.

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
| `due_date` | `string \| null` | no | ISO 8601 date or datetime. A bare date (`2026-04-15`) is all-day, anchored to noon UTC; a full datetime is a genuine deadline at that moment. |
| `due_all_day` | `boolean` | no | Overrides the all-day/timed inference from `due_date`'s shape. Rarely needed — the PWA sends this explicitly to preserve an existing value when an edit doesn't touch the due date. |
| `recurrence` | `string` | no | Infinite date-only RRULE |
| `task_type` | `string` | no | `action` or `plan` |
| `project_id` | `string \| null` | no | Existing project ID |
| `kickoff_note` | `string \| null` | no | Forward-looking re-entry note |

**Response:** `Task` — 201

---

### `PATCH /api/tasks/:id`

Partial update. Only provided fields are changed.

**Request body:** any subset of `{ title, notes, due_date, due_all_day, recurrence, kickoff_note, session_log, task_type, project_id, status, defer_until, defer_kind, focused_until }`. Use `POST /api/tasks/:id/complete` to mark a task done; direct `status: "done"` updates are rejected.

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

Supported recurrence rules are infinite, date-only RRULEs: `DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY` with optional `INTERVAL`, date-level filters (`BYDAY`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, `BYSETPOS`, `WKST`), and no `COUNT`, `UNTIL`, time parts, recurrence sets, or exception dates. RRULE calendar semantics are used: invalid target dates are skipped rather than clipped, and the rule must produce a next occurrence after the task's current `due_date`.

---

## Task Link Endpoints

### `GET /api/tasks/links`

Returns all task links.

**Response:** `TaskLink[]`

### `POST /api/tasks/links`

Create or replace a task link.

**Request body:** `{ from_task_id: string, to_task_id: string, link_type: "blocks" | "related" }`

**Response:** `{ ok: true }` — 201

### `DELETE /api/tasks/links`

Remove a task link.

**Request body:** `{ from_task_id: string, to_task_id: string, link_type: "blocks" | "related" }`

**Response:** `{ ok: true }`

---

## Project Endpoints

### `GET /api/projects`

Returns active projects.

**Response:** `Project[]`

### `GET /api/projects/sync`

Returns all projects, including archived projects, for PWA sync.

**Response:** `Project[]`

### `GET /api/projects/:id`

**Response:** `Project` — 404 if not found.

### `POST /api/projects`

Create a project.

**Request body:** `{ title: string, notes?: string | null, kickoff_note?: string | null }`

**Response:** `Project` — 201

### `PATCH /api/projects/:id`

Partial update for `{ title, notes, kickoff_note, status }`.

**Response:** `Project` — 404 if not found.

### `DELETE /api/projects/:id`

Delete a project and clear that project from assigned tasks.

**Response:** `{ ok: true }` — 404 if not found.

---

## Export / Import

### `GET /api/export`

Returns a full export payload. Optional `include_log=true` includes action-log rows; if present, `include_log` must be `true` or `false`.

**Response:** export JSON with `Content-Disposition` attachment filename.

### `POST /api/import`

Restore from an export payload. Optional `dry_run=true` validates and returns counts without writing; if present, `dry_run` must be `true` or `false`.

Invalid import payload details keep the `payload` path prefix used by the import parser.

**Response:** dry-run counts with status 200, or inserted counts with status 201.

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
| `due_date` | `string` | yes | ISO 8601 datetime, minute resolution. A date-only value on write is anchored to noon UTC |
| `due_all_day` | `boolean` | yes | Whether `due_date` is all-day (no real time-of-day) vs. a genuine timed deadline. `null` on rows that predate this field — treat as all-day |
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

Legacy errors return `{ error: string }` with an appropriate HTTP status code.
V2 errors use `{contractVersion: 2, error: {code, path, message, retryable,
recoveryHint, ...}}`. Validation errors may also include `details`, an array of field/path issues.

| Status | Meaning |
|---|---|
| 401 | Missing or invalid bearer token |
| 403 | Invalid UI signature |
| 404 | Resource not found |
| 400 | Malformed route param, query param, or request body |

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

## Atomic capacity errors

Mutation plans, including v1 replacement imports and their dry-runs, are bounded
at 100 **generated SQL statements**, including guards, logs and wipe effects.
An oversized plan returns HTTP 413 before any write:

```json
{"error":"Atomic plan requires 101 SQL statements; the limit is 100.","code":"capacity_exceeded","requiredStatements":101,"limit":100,"retryable":false,"recoveryHint":"Reduce the atomic scope. Replacement imports cannot be split into independent wipes."}
```

Accepted plans execute in one transactional batch. This temporarily limits
replacement imports to small snapshots until staged import is designed. Do not
split a replacement into multiple imports: each import wipes existing data.

## V2 planning settings and reliable commands

| Method / path | Result |
| --- | --- |
| `GET /api/v2/planning-settings` | `{contractVersion: 2, settings: PlanningSettings \| null}` |
| `GET /api/v2/planning-settings/export` | Versioned preferences document without managed revisions |
| `POST /api/v2/link` | Coherent link row, version and structural revision for an exact `LinkKey` |
| `POST /api/v2/changes/preview` | Side-effect-free normalized diff and generated SQL count |
| `POST /api/v2/changes` | Applied diff and replayable command result |

All five reject query parameters. Link reads accept an exact
`{entity: "link", from, to, linkType}` key. Preview/apply POST inputs are strict
v2 command envelopes; this release accepts exactly one of the following command families:

- `planning.set` for workspace settings.
- `task.create`/`project.create` with stable caller IDs and structural guards;
  see [reliable creation](shared/reliable-creation.md).
- `task.content.set`/`project.content.set` for conversational text;
  see [guarded content](shared/reliable-content.md).
- `task.focus.set`, `task.defer.set`, `task.reopen`, `project.archive` or
  `project.reopen` for existing state transitions;
  see [guarded state](shared/reliable-state.md) for required fields and effects.
- `task.complete` with required structural revision and `successor` (null for
  one-off tasks, a stable ID for legacy recurrence); see
  [reliable completion](shared/reliable-completion.md).
- `task.project.set`, `task.type.set` and `task.legacy-schedule.set` for
  membership, task type and the existing due-date/recurrence contract; see
  [guarded task fields](shared/reliable-task-fields.md). Membership requires
  a structural revision and selected-project revision. Legacy schedule values
  explicitly include due-date classification; they never create a hard deadline.

- `link.add`/`link.remove` with edge and structural revisions, endpoint/cycle
  guards and retained tombstones; see [reliable links](shared/reliable-links.md).
  `POST /api/v2/link` accepts an exact link key and returns its coherent
  row/version/structural snapshot. It rejects query parameters.

- `task.delete`/`project.delete` with entity and structural revisions; see
  [reliable deletion](shared/reliable-deletion.md). Task effects include incident
  link tombstones; project effects include preserved, detached member tasks.
  Oversized effects return versioned HTTP 413 `capacity_exceeded` with exact
  `requiredStatements` and `limit`. Duty ownership blocks project deletion.

For settings, `expectedRevision: null`
requires absent settings; a number must equal the existing revision. Managed
revisions are excluded from values. Working-hour overlaps are rejected before
writes. See [the command contract](shared/reliable-settings-commands.md) for a
complete input and replay/rebase instructions.

Applied/preview results contain `contractVersion`, `commandId`, `payloadHash`,
`serverNow`, `changes` (settings/entity/link changes, completion plus successor, or all deletion effects),
`warnings` and `refs`. Recurring completion orders the completed task first and
the successor creation second; its optional ref maps to the successor ID.
Preview adds `dryRun: true` and `requiredStatements`; apply adds `applied: true`.
Same ID/payload returns the original result. Same ID/different payload or stale
revision returns HTTP 409. Conflict bodies are `{contractVersion: 2, error}`;
the structured error includes `code`, `path`, `message`, `retryable` and a
`recoveryHint`. Current values depend on the command family:

- Settings `revision_conflict` includes `expectedRevision` and
  `currentSettings` (the complete settings and their revision, or null).
- Task/project `revision_conflict` includes `expectedRevision` and
  `currentEntity`: `{contractVersion: 2, entity, id, row, version,
  structuralRevision}`. A live entity has its current row and
  `version: {revision, deletedAt: null}`. A deleted entity has null row and a
  retained version with `deletedAt`; no recorded identity has null row/version.
  Existing task/project commands expect a numeric revision, while creation expects null
  identity history. A changed selected project is reported as that project's
  `currentEntity`, not the proposed task. A used completion successor identity
  reports that successor with `expectedRevision: null`.
- Creation/completion `structural_conflict includes `expectedStructuralRevision` and
  `currentEntity` with the current structural revision.
- `command_id_conflict` reports command-ID/payload reuse; it does not provide
  current row or settings values.

Invalid state transitions return HTTP 409 `invalid_transition` with
`currentEntity` and `retryable: false`; they commit no receipt. Focus/deferral
require pending tasks. Reopen requires a done/deferred task or archived project;
archive requires an active project. Completion requires a pending task. A stale
revision is reported first. Completion recurrence/successor mismatch returns
HTTP 400 `invalid_input`, with no receipt or partial write.

Retain the intended change and explicitly rebase from the appropriate current
values with a fresh command ID. A transient commit failure returns HTTP 503 with
`retryable: true`; retain the command ID/payload for retry.

Portable preference values restore through this same command endpoint with
`actor: import`, a fresh ID and the destination's expected revision. V1 backup
scope is unchanged; it excludes and preserves planning settings/receipts.


## V2 entity version lookup

`POST /api/v2/entity-version` accepts `{entity: "task"|"project"|"duty", id}`
or `{entity: "link", from, to, linkType: "blocks"|"related"}`. Inputs are
strict, IDs use their corresponding prefixes, and query parameters are rejected.
Returns `{contractVersion: 2, key, structuralRevision, version}` from one SQL
snapshot. `version` is null for an identity with no ledger history; otherwise
it contains `revision` and `deletedAt` (null when live, UTC event instant when
deleted). This read does not include entity content or provide a sync cursor.
See [revision tracking](shared/entity-versions.md) for backfill, tombstones,
legacy compatibility and the transition to guarded task commands.


## V2 coherent entity read

`POST /api/v2/entity` accepts a strict `{entity: "task"|"project", id}` key and
rejects query parameters. Returns `{contractVersion: 2, entity, id, row,
version, structuralRevision}` from one SQL statement. Missing/deleted rows are
null; versions distinguish no history from tombstones. The row's ID and
live/deleted state must agree with the version. Read this together before
planning reliable commands. See [stable creation](shared/reliable-creation.md)
for creation envelopes, project guards and conflict/replay behavior.
