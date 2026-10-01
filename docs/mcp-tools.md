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
| `due_date` | `string` | no | ISO 8601 date or datetime. A bare date (e.g. `2026-04-15`) is all-day, stored at noon UTC; a full datetime is a genuine deadline at that moment. |
| `recurrence` | `string` | no | Infinite date-only RRULE (e.g. `FREQ=WEEKLY;INTERVAL=1`, `FREQ=MONTHLY;BYDAY=3FR`). |
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
| `due_date` | `string` | no | ISO 8601 date or datetime — same all-day/timed rule as `add_task`. |
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

**Supported RRULE subset:** infinite date-only `DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY` rules with optional `INTERVAL=N`, plus date-level filters (`BYDAY`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, `BYSETPOS`, `WKST`). `COUNT`, `UNTIL`, time parts, recurrence sets, and exception dates are not supported. RRULE calendar semantics are used: invalid target dates are skipped rather than clipped, and the rule must produce a next occurrence after the task's current `due_date`.

---

### `defer_task`

Hide a task. Use `kind: 'until'` (with a future ISO date in `until`) to defer temporarily; use `kind: 'someday'` to defer indefinitely with no specific date. Deferred tasks do not appear in `get_ready_tasks` or active lists.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |
| `kind` | `'until'\|'someday'` | yes | `'until'` requires `until`; `'someday'` rejects it. |
| `until` | `string` | when `kind='until'` | ISO 8601 timestamp when task should resurface. |

**Returns:** `{ ...Task, action_log_entry }`

---

### `reopen_task`

Revert a completed or deferred task back to active `pending`. Clears `defer_kind`/`defer_until` and `focused_until`.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |

**Returns:** `{ ...Task, action_log_entry }`

---

### `focus_task`

Put a non-deferred pending task front-of-mind for a bounded time window. Deferred tasks must be reopened before they can be focused.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |
| `hours` | `number` | no | Positive finite number, maximum 24. Defaults to 3. |

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

Create a new project and optionally link existing tasks to it. Task assignment is applied in the same batch as project creation; duplicate task ids are counted once, and a missing task id rejects the whole operation.

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
  due_date:      string | null,   // ISO 8601 datetime, minute resolution
  due_all_day:   boolean | null,  // all-day vs. timed; null (predates field) reads as all-day
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

## Temporal foundation (v2)

`get_capabilities`, `resolve_time`, and `preview_legacy_dates` are read-only
structured tools. Their inputs/results match the [v2 REST foundation](api.md#v2-temporal-foundation).
Resolve before creating time intent; inspect capability gates before assuming
hierarchy, reminders, command replay or new sync is available. An omitted zone
uses workspace settings or a reported UTC fallback, never the host zone.

A fold returns `ambiguous_local_time` unless earlier/later is explicit. A gap
returns valid offset interpretations to choose from. Date deadlines resolve to
an exclusive next-date boundary; elapsed and calendar offsets have distinct
variants. Invalid input and temporal errors return `isError: true` plus
`structuredContent.error` with code/path/recovery details.

Legacy preview reports targets and ambiguity without writing. Follow
`nextCursor` via `after`; pages explicitly do not promise snapshot consistency.
See [temporal contracts](shared/temporal-foundation.md) for examples and limits.

## Atomic plan capacity

The shared executor accepts at most 100 generated SQL statements per logical
plan, counting guards/logs/side effects. Oversized work returns structured
`capacity_exceeded` diagnostics (`requiredStatements`, `limit`, `retryable:
false`) without applying any part of the plan. Replacement imports cannot be
split into independent wipes; larger restore support requires staging.

## Reliable planning settings (initial v2 command family)

| Tool | Purpose |
| --- | --- |
| `get_planning_settings` | Read complete settings and revision, or null before setup |
| `export_planning_settings` | Export portable preference values without revision or credentials |
| `preview_changes` | Preview a standalone command or bounded mixed batch without writes |
| `apply_changes` | Commit a standalone command or bounded mixed batch with guards/receipt/audit/feed |

Read/export take `{}`. Preview/apply use the strict envelope shown in
[reliable settings commands](shared/reliable-settings-commands.md). Caller IDs
are `c_` plus 5–64 ID characters; expected revision is null for first setup and
numeric thereafter. Same ID/payload returns the original applied result; a
different payload conflicts. A preview is not a lock. Revision conflicts carry
current values and require an explicit rebase with a new ID. Tool errors expose
`isError: true` and versioned `structuredContent.error`.

Settings, single task/project creation/content, task focus/deferral/reopen and
project archive/reopen, reliable completion and task membership/type/legacy-schedule
and link add/remove/deletion commands use this protocol. Offline command overlays and full delta sync remain subsequent increments. Settings export is a
preferences document, not a full backup; restore non-null values through
`planning.set` using `actor: import` and the destination's expected revision.


## Entity version lookup

`get_entity_version` accepts a strict task/project/duty key with `entity` and
`id`, or a link key with `entity: "link"`, `from`, `to` and `linkType`. It returns
the key, workspace `structuralRevision` and `version` from one SQL statement.
A null version has no ledger history; non-null versions have a numeric
`revision` and `deletedAt` (null when live). Retained deletion records survive
v1 restore and ID reuse. This lookup does not fetch row content or provide delta sync; use
`get_entity` to read task/project content and `preview_changes`/`apply_changes`
for supported mutation commands. See [the version contract](shared/entity-versions.md).


`get_entity` accepts `{entity: "task"|"project", id}` and returns row content,
its ledger `version`, and `structuralRevision` in one coherent read. Creation
uses `task.create`/`project.create` with stable caller IDs, expected null identity
revision and expected structural revision. A scoped clientRef maps to the ID;
a task's selected project carries its own expected revision. See
[the creation contract](shared/reliable-creation.md) for complete inputs and
replay/retained-intent instructions. `get_link` reads an exact edge key and its
content/version/structural snapshot. `link.add`/`link.remove` guard edge and
aggregate revisions; related additions require ascending IDs and no reverse
duplicate, while blocks additions reject cycles. Removal keeps a tombstone and
uses the stored orientation. See [reliable links](shared/reliable-links.md).
Mixed task/project/link batches, including lifecycle effects, use the
envelope structural revision and distinct written identities; see
[bounded batches](shared/reliable-batches.md).


`task.content.set` and `project.content.set` replace title/notes/kickoff text
(and task session log) using the current expected entity revision. Managed
fields are rejected. Preview/apply return versioned before/after rows;
conflicts retain parsed current content for explicit rebase. See
[guarded content](shared/reliable-content.md) for inputs, preservation and
replay semantics.


`task.focus.set`, `task.defer.set`, `task.reopen`, `project.archive` and
`project.reopen` use the current entity revision and the same preview/apply
protocol. Focus and timed deferral require explicit instants normalized to
minute UTC; focusing clears deferral and active deferral clears focus, matching
legacy transitions. Clear operations preserve the other value. Reopening clears
focus/deferral; project state preserves member tasks/links. Invalid transitions
return `invalid_transition` with `currentEntity`. See
[guarded state](shared/reliable-state.md) for complete inputs and replay behavior.


`task.complete` completes a pending task through the same protocol, with both
entity and workspace structural revisions. Required `successor` is null for
one-off tasks; legacy recurring tasks require an unused stable successor ID,
optionally with a clientRef. Preview/apply return the completed image and,
when recurring, a successor creation image together. Receipt replay returns
both original images and creates no additional successor. See
[reliable completion](shared/reliable-completion.md) for full inputs, preservation
and compatibility boundaries.


`task.project.set` guards task, structural and selected-project revisions;
required `project` is null to detach or `{id,expectedRevision}` to assign.
`task.type.set` replaces action/plan. `task.legacy-schedule.set` replaces required
`values: {dueDate,dueAllDay,recurrence}` under the existing date/recurrence
contract, with explicit classification and no new hard-deadline meaning.
These commands preserve other managed/context fields and support preview,
atomic apply and exact replay. See
[guarded task fields](shared/reliable-task-fields.md) for inputs and conflicts.


`task.delete` / `project.delete` require numeric entity and structural revisions.
Task deletion includes incident-link tombstones; project deletion includes every
detached member task while preserving context/state/links. Duty ownership blocks
project deletion. Oversized atomic effects return versioned `capacity_exceeded`
with exact `requiredStatements` and `limit: 100`; no split writes occur. See
[reliable deletion](shared/reliable-deletion.md) for capacity, replay and conflicts.


Mixed `preview_changes`/`apply_changes` accept 2–20 supported non-lifecycle
commands, including completion/deletion, with an envelope `expectedStructuralRevision`. Graph commands share
that base revision; create referenced entities earlier and write each identity
once. Results add `batch: true` and all scoped refs. Final dependency graphs
are validated atomically, allowing edge replacement in either add/remove order.
The complete generated SQL must fit 100 statements; settings remain standalone.
New mixed results include `changeGroups`, one image count per command, covering
every successor/cascade/detachment image and enforcing each standalone contract. See [bounded mixed batches](shared/reliable-batches.md).

### `get_workspace_snapshot`

Accepts only `{}` and returns every current user-data family, retained tombstones,
structural revision and matching `{epoch,sequence}` cursor in one consistent read.
Includes duties, preferences, planning settings and historical provenance as well
as tasks/projects/links. Credentials and replay receipts are excluded. See
[workspace sync bootstrap](shared/workspace-sync.md) for exact identity/deletion
contracts and the remaining delta/offline rollout. This is not a restore input.
