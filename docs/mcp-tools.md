# MCP Tools Reference

Alongside exposes 18 tools via the MCP endpoint at `/mcp` (JSON-RPC POST). All calls require an `Authorization: Bearer {AUTH_TOKEN}` header.

---

## Session & Discovery

### `start_session`

Call this at the beginning of every work session. Seeds default preferences if this is the first session, detects gaps in usage, and returns behavioral instructions for Claude to follow.

**Parameters:** none

**Returns:**
```ts
{
  suggested_tasks: Task[],          // top 3 ready tasks by readiness score
  preferences: Record<string, string>,
  returning_after_gap: boolean,     // true if >7 days since last session
  instructions: string              // behavioral instructions for Claude
}
```

---

### `list_projects`

List projects filtered by status.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `status` | `'active'\|'archived'` | no | Filter by status. Defaults to `"active"`. |

**Returns:** `{ projects: Project[] }`

---

### `list_tasks`

List tasks filtered by status and/or a text search query.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `statuses` | `('pending'\|'done')[]` | no | Filter to these statuses. Defaults to `['pending']`. |
| `query` | `string` | no | Text search across title and notes. |

**Returns:** `{ tasks: Task[] }`

---

### `get_ready_tasks`

Returns unblocked tasks sorted by readiness score — the most actionable tasks first. A task is blocked if it has an incomplete task with a `blocks` link pointing to it.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `project_id` | `string` | no | Restrict to tasks in this project. |

**Returns:** `{ tasks: Task[] }`

**Readiness score formula:**
```
base:            3 pts  (unblocked)
has kickoff_note +3 pts
has session_log  +2 pts
due within 7d    +1 pt
recently active  +1 pt  (session in last 14 days)
```

---

### `get_action_log`

Fetches the last 50 actions (creates, updates, completions, deletions, etc.) in reverse chronological order. Intended for the action log badge widget — not for direct use in conversation.

**Parameters:** none

**Returns:** `{ entries: ActionLogEntry[] }`

Each entry: `{ id, tool_name, task_id, title, detail, created_at }`

---

## Task CRUD

### `add_task`

Create a new task.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | Task title. |
| `notes` | `string` | no | Freeform notes. |
| `due_date` | `string` | no | ISO 8601 date (e.g. `2026-04-15`). |
| `recurrence` | `string` | no | iCal RRULE (e.g. `FREQ=WEEKLY;INTERVAL=1`). |
| `task_type` | `'action'\|'plan'\|'recurring'` | no | Defaults to `'action'`. |
| `project_id` | `string` | no | Associate with a project. |
| `kickoff_note` | `string` | no | Re-entry ramp — what to do next time. |

**Returns:** `{ ...Task, action_log_entry }`

---

### `update_task`

Update one or more fields on an existing task. Only provided fields are changed.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |
| `title` | `string` | no | |
| `notes` | `string` | no | |
| `due_date` | `string` | no | |
| `recurrence` | `string` | no | |
| `task_type` | `string` | no | |
| `project_id` | `string` | no | |
| `kickoff_note` | `string` | no | Overwrites existing kickoff_note. |
| `session_log` | `string` | no | Appended to existing session_log. |

**Returns:** `{ ...Task, action_log_entry }`

---

### `complete_task`

Mark a task done. If the task has both `recurrence` and `due_date`, a new task is automatically created for the next occurrence. The completed task's `session_log` is carried forward as the new task's `kickoff_note`.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |

**Returns:** `{ completed: Task, next?: Task, action_log_entry }`

`next` is present only when a recurrence was spawned.

**Supported RRULE frequencies:** `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY` with optional `INTERVAL=N`. No `BYDAY` support.

---

### `defer_task`

Hide a task. Use `kind: 'until'` (with a future ISO date in `until`) to defer temporarily; use `kind: 'someday'` to defer indefinitely with no specific date. Deferred tasks do not appear in `get_ready_tasks` or active lists.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |
| `kind` | `'until'\|'someday'` | yes | `'until'` requires `until`; `'someday'` ignores it. |
| `until` | `string` | when `kind='until'` | ISO 8601 date when task should resurface. |

**Returns:** `{ ...Task, action_log_entry }`

---

### `reopen_task`

Revert a completed or deferred task back to `pending`. Clears `defer_kind`/`defer_until`.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |

**Returns:** `{ ...Task, action_log_entry }`

---

### `delete_task`

Permanently delete a task. This is a hard delete — there is no undo.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |

**Returns:** `{ deleted: true, task_id, title, action_log_entry }`

---

## Display (MCP App Widgets)

These tools return a `ui` field that Claude renders as an inline widget using the MCP Apps spec. The widget communicates back to Claude via postMessage JSON-RPC to perform mutations (complete, reopen).

### `show_tasks`

Render a task list widget inline in Claude. Checkboxes in the widget call `complete_task` or `reopen_task` without additional user prompting.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_ids` | `string[]` | yes | Tasks to display. |

**Returns:** `{ tasks: Task[], projects: Record<projectId, projectTitle> }` plus MCP App widget metadata.

---

### `show_project`

Render a project and all its tasks as an inline widget.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `project_id` | `string` | yes | |

**Returns:** `{ project: Project, tasks: Task[] }` plus MCP App widget metadata.

---

## Projects

### `create_project`

Create a new project and optionally link existing tasks to it.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | |
| `kickoff_note` | `string` | no | Re-entry context for the project. |
| `task_ids` | `string[]` | no | Existing tasks to associate immediately. |

**Returns:** `{ project: Project, linked_task_count: number, action_log_entry }`

---

### `get_project_context`

Fetch a project and its ready (unblocked) tasks. Useful for orienting at the start of a focused work session.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `project_id` | `string` | yes | |

**Returns:** `{ project: Project, ready_tasks: Task[] }`

---

## Relationships

### `link_tasks`

Create a dependency or relationship between two tasks.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `from_task_id` | `string` | yes | |
| `to_task_id` | `string` | yes | |
| `link_type` | `'blocks'\|'related'\|'supersedes'` | yes | |

**Link type semantics:**

| Type | Meaning |
|---|---|
| `blocks` | `from_task` must be completed before `to_task` appears in ready lists |
| `related` | Informational only; no scheduling effect |
| `supersedes` | `from_task` replaces `to_task`; `to_task` is effectively archived |

**Returns:** `{ linked: true, from_task_id, from_task_title, to_task_id, to_task_title, link_type, action_log_entry }`

---

## Preferences & Notes

### `update_preference`

Update a user preference. Preferences are applied automatically on the next `start_session`.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `key` | `string` | yes | Preference key (see below). |
| `value` | `string` | yes | New value. |

**Valid preference keys:**

| Key | Description |
|---|---|
| `sort_by` | How to sort task lists |
| `urgency_visibility` | How prominently to surface due-date urgency |
| `kickoff_nudge` | Whether to prompt for kickoff notes at session end |
| `session_log` | Whether to log session summaries |
| `interruption_style` | How Claude should handle mid-session context switches |
| `planning_prompt` | Prompt style for plan-type tasks |
| `timezone` | IANA timezone used for duty scheduling, e.g. `America/Los_Angeles` |

**Returns:** `{ updated: true, key, value }`

---

### `update_kickoff_note`

Update the kickoff note on a task or project. A kickoff note is a forward-looking re-entry ramp: what to do *next*, not a summary of what happened.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `entity_type` | `'task'\|'project'` | yes | |
| `entity_id` | `string` | yes | Task or project ID. |
| `kickoff_note` | `string` | yes | |

**Returns:** `{ updated: true, entity_type, entity_id }`

---

## Task Object Shape

```ts
{
  id:            string,   // "t_xxxxx"
  title:         string,
  notes:         string | null,
  status:        'pending' | 'done',
  due_date:      string | null,   // ISO 8601 date
  recurrence:    string | null,   // iCal RRULE
  task_type:     'action' | 'plan',
  project_id:    string | null,
  kickoff_note:  string | null,
  session_log:   string | null,
  defer_until:   string | null,
  defer_kind:    'none' | 'until' | 'someday',
  focused_until: string | null,
  created_at:    string,          // ISO 8601 datetime
  updated_at:    string
}
```
