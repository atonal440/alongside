# MCP Tools Reference

Alongside lists 14 tools on the MCP endpoint at `/mcp` (JSON-RPC POST). All calls require an `Authorization: Bearer {AUTH_TOKEN}` header.

## Endpoints, tiers and annotations

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`, plus `idempotentHint` where true) so a host can approve per tier: reads are `readOnlyHint: true`; conversational writes are non-destructive; `apply_changes` (which carries deletes) and `restore_workspace` are `destructiveHint: true`.

`/mcp/admin` is an opt-in second endpoint with the same bearer token. Connect it only when needed. It lists `export_workspace`, `restore_workspace`, `get_workspace_snapshot` (the cursor read restore needs, and the way to check after a lost restore response whether it committed), `export_planning_settings` and `preview_legacy_dates`. It has no widget resources.

The default `/mcp` list is `get_capabilities`, `resolve_time`, `find`, `get_context`, `get_history`, `describe_commands`, `preview_changes`, `apply_changes`, `show_tasks` and the quick verbs `add_task`, `update_task`, `complete_task`, `defer_task` and `focus_task`. Phase D removed the deprecated tools: calling any other name returns `Unknown tool`. The sync reads `get_workspace_delta` and `get_entity_version` (and the old `get_entity`, `get_link` and `get_planning_settings`) are REST only (`/api/v2/…`); export, restore and the snapshot read are on `/mcp/admin`. `initialize` on `/mcp` carries a short neutral `instructions` field (what the tools are, the retry rule); it prescribes no workflow. `get_capabilities` reports `toolSurface` (`version`, `commandCatalog`, `adminEndpoint`).

---

## Action-log entries from `apply_changes`

Through MCP, `apply_changes` also writes one action-log entry per command, in declared order, in the same atomic batch as the receipt: `tool_name` is the command kind (`task.create`, `link.add`, …), `task_id` is the task for task commands (a deleted task keeps its ID), `title` is the entity's final title (links read `A → B`), and `detail` carries the kind-specific value (the new type, due date, deferral, focus time, `→ recurs <date>` for a completion, the project title for an assignment, the link type). Settings commands (`planning.set`, `preference.set`) write no entry, matching `update_preference`. A replay writes nothing, a failed command leaves nothing, and the REST `POST /api/v2/changes` the PWA uses writes no entries. The rows reach clients through the sync feed, which is why the sync read gate (protocol 3) had to be in force first. The quick verbs and deprecated mutating tools keep recording their own tool names.

## The `preference.set` command

`preference.set` is a standalone command (it cannot join a mixed batch, like `planning.set`): `{ kind: 'preference.set', key, value, expectedRevision }`. `key` is one of the preference keys (including the internal `last_session_at`, which stays accepted); `value` is validated against the key's allowed set. `expectedRevision` is the preference's sync revision, or `null` if it has never been set. The result holds one change, `{ entity: 'preference', id: key, before: { revision, value } | null, after: { revision, value } }`, with `after.revision` one past `before.revision`. The write is guarded in the same batch as the receipt and audit row, and lands in the sync feed through the existing triggers. The legacy command feed (`change_feed`) has no preference rows. It is the only way to set a preference over MCP (the `update_preference` tool was removed in phase D); `describe_commands({ family: 'preference' })` and loose-intent `preview_changes` support it.

## Find, context and loose-intent changes (phase B)

These tools replace the older list/get reads and the by-hand revision bookkeeping. The old tools were removed in phase D.

**`find`** — `{ entity: 'task' | 'project', preset?, filter?, sort?, order?, limit?, cursor? }`. Task filters: `statuses` (default `["pending"]`, deferred tasks included), `text` (title and notes, case-insensitive), `project_id` and `focused` (`true`: only tasks whose focus has not expired; `false`: the rest). `preset: 'ready'` restricts to unblocked, non-deferred pending tasks whose `available_from` has opened (pending-only, so it rejects `statuses`); it no longer implies an order. `sort` is `created` (default), `updated`, `due`, `deadline` or `readiness`; `order` is `asc` or `desc` and defaults to `desc` for `created`, `updated` and `readiness`, `asc` for `due` and `deadline` (undated tasks count as latest). `due` sorts the target date, `deadline` the hard deadline's boundary instant. Projects sort by creation, newest first by default, and take `order` only. `readiness` is a heuristic score (kickoff note, session log, recent edits and near due dates or deadlines raise it; a task that is not yet available ranks with blocked work); nothing in the server picks it unless asked. Project filter: `status` (default `"active"`). Returns `{ entity, items, nextCursor }`; pass `nextCursor` back as `cursor`. Order is deterministic: the chosen sort, then creation, then ID, all in the same direction, except for `readiness`, where `order` applies only to the score and ties break oldest first either way (as `get_ready_tasks` did). The cursor is opaque (the sort key of the last item returned, tagged with the sort and order, so a cursor from a different ordering is rejected), so paging continues correctly even if that item was completed, edited or deleted between pages when sorting by `created` (an edit can change `updated`, `due` and `readiness`, so under those sorts a row edited between pages can move across the cursor, so it may be returned twice or missed); a cursor that isn't a `nextCursor` is rejected with `invalid_input`.

**`get_context`** — `{ entity: 'task' | 'project' | 'link' | 'settings' | 'preferences', … , depth?: 0 | 1 }`. `entity: 'preferences'` returns `{ preferences }`, the stored user preferences with defaults merged in (a key to value map); the server never acts on them. `depth: 0` returns the row plus its entity and structural revisions (what the REST routes `/api/v2/entity`, `/api/v2/link` and `/api/v2/planning-settings` return). The default `depth: 1` adds a `context` object: for a task its `project`, `prerequisites`, `dependents` and `related` tasks; for a project its `ready_tasks` and `task_counts`. Missing or deleted entities come back unchanged (null row), with no context.

**`get_history`** — `{ limit? }`. Action-log rows (`source: 'action_log'`) merged with command-audit rows (`source: 'command'`, with `command_id`, `actor`, `reason`, `changes`), newest first.

**`describe_commands`** — `{ family: 'task' | 'project' | 'link' | 'planning' }`. Returns that family's command schemas, one valid example envelope and the error codes to expect.

**Loose intent for `preview_changes`.** Instead of a strict envelope, send `{ intent: true, contractVersion: 2, commands: [...] }` where each command is its strict form without `expectedRevision`, `expectedStructuralRevision`, creation IDs or `successor`. `commandId` (minted if omitted), `actor` (default `"llm"`) and `reason` are optional. A creation command may carry a `clientRef`; later commands refer to it as `"@clientRef"` in `id`, `from`, `to` and `project`. The server reads current state, mints IDs, fills every guard and previews the result. The response is the usual preview plus `pinnedEnvelope`: the strict envelope to pass to `apply_changes` unchanged. Patches to `*.content.set` and `task.legacy-schedule.set` merge into current values because those commands replace whole field groups. A completion gets a minted `successor` only when the task has a recurrence. If anything changes between preview and apply, `apply_changes` returns `revision_conflict` as for any stale guard. Retrying a lost apply with the same envelope replays the receipt. Strict envelopes are still accepted and return no `pinnedEnvelope`.

## Task CRUD

**Mutating tools on the command path.** `add_task`, `update_task`, `complete_task`, `defer_task` and `focus_task` compile to the same commands `apply_changes` runs, so they share its guards, receipts and audit. Each accepts two optional arguments in addition to the ones listed below:

| Name | Type | Description |
|---|---|---|
| `commandId` | `string` | A `c_…` ID. Retrying with the same ID and the same arguments returns the first call's response verbatim (same minted task ID, same `action_log_entry`) and writes nothing, even if the task has changed since. The same ID with different arguments returns `command_id_conflict`. Without it, every call is a new command. |
| `expectedRevision` | `integer` | Not on `add_task`. Refuse with `revision_conflict` if the task is no longer at this revision (read it with `get_context`). A pinned revision is never retried. |

Without `expectedRevision` a verb reads the current state itself. If another write lands between that read and the commit, it re-reads, rebuilds its commands (re-merging a partial `update_task` patch against the new values) and tries again, up to three attempts, before returning the conflict. IDs for tasks the call creates (`add_task`, a recurring `complete_task`'s successor) derive from the command ID, so two identical requests racing each other plan the same identities and the loser replays the winner.

The response and the action-log row are written in the same atomic batch as the change. A refused call writes neither. A call that changes nothing (`update_task` with only `status: "pending"` on a pending task, or an empty patch) still records its command ID and writes its action-log entry once. Refusals are structured tool errors with a code and a recovery hint, not bare JSON-RPC errors. Where these verbs differ from the old handlers is listed in [the parity matrix](plans/mcp-parity-matrix.md).

### `add_task`

Create a new task.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | Task title. |
| `notes` | `string` | no | Freeform notes. |
| `due_date` | `string` | no | ISO 8601 date or datetime. A bare date (e.g. `2026-04-15`) is all-day, stored at noon UTC; a full datetime is a timed target at that moment. This is the date to aim for, not a hard boundary; use `deadline` for that. |
| `deadline` | `string` | no | Hard deadline. A bare `YYYY-MM-DD` allows completion throughout that local day; an ISO datetime with offset is a moment. Needs `timezone` or a workspace timezone. |
| `available_from` | `string` | no | Earliest permitted start, independent of deferral. `YYYY-MM-DD` opens at the start of that local day. Needs `timezone` or a workspace timezone. |
| `timezone` | `string` | no | IANA zone for `deadline` and `available_from`; defaults to the workspace timezone (`planning.set`). With neither the call is refused. |
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
| `due_date` | `string` | no | ISO 8601 date or datetime — same all-day/timed rule as `add_task`; the target, not a hard deadline. |
| `deadline` | `string \| null` | no | Hard deadline, same forms as on `add_task`; `null` clears it. Changing one of `deadline` and `available_from` keeps the other. |
| `available_from` | `string \| null` | no | Earliest permitted start; `null` clears it. |
| `timezone` | `string` | no | IANA zone for the two roles; defaults to the workspace timezone. |
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

### `focus_task`

Put a non-deferred pending task front-of-mind for a bounded time window. Deferred tasks must be reopened before they can be focused.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | yes | |
| `hours` | `number` | no | Positive finite number, maximum 24. Defaults to 3. |

**Returns:** `{ ...Task, action_log_entry }`

---

## Display (MCP App Widgets)

These tools return a `ui` field that Claude renders as an inline widget using the MCP Apps spec. The widget communicates back to Claude via postMessage JSON-RPC to perform mutations (complete, reopen).

### `show_tasks`

Render a task list widget inline in Claude. Checkboxes in the widget call `complete_task`, or `preview_changes` and `apply_changes` with `task.reopen`, without additional user prompting.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `task_ids` | `string[]` | one of | Tasks to display. |
| `project_id` | `string` | one of | A project to display with its pending tasks. |

Give exactly one of the two.

**Returns:** for `task_ids`, `{ tasks: Task[], projects: Record<projectId, projectTitle> }`; for `project_id`, `{ project: Project, tasks: Task[] }`. Both carry MCP App widget metadata.

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
| `get_context({ entity: "settings" })` | Read complete settings and revision, or null before setup (REST: `GET /api/v2/planning-settings`) |
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

`get_entity_version` (REST only, `POST /api/v2/entity-version`) accepts a strict task/project/duty key with `entity` and
`id`, or a link key with `entity: "link"`, `from`, `to` and `linkType`. It returns
the key, workspace `structuralRevision` and `version` from one SQL statement.
A null version has no ledger history; non-null versions have a numeric
`revision` and `deletedAt` (null when live). Retained deletion records survive
v1 restore and ID reuse. This lookup does not fetch row content or provide delta sync; use
`get_entity` to read task/project content and `preview_changes`/`apply_changes`
for supported mutation commands. See [the version contract](shared/entity-versions.md).


`get_entity` (REST only, `POST /api/v2/entity`; over MCP use `get_context` with `depth: 0`) accepts `{entity: "task"|"project", id}` and returns row content,
its ledger `version`, and `structuralRevision` in one coherent read. Creation
uses `task.create`/`project.create` with stable caller IDs, expected null identity
revision and expected structural revision. A scoped clientRef maps to the ID;
a task's selected project carries its own expected revision. See
[the creation contract](shared/reliable-creation.md) for complete inputs and
replay/retained-intent instructions. `get_link` (REST only, `POST /api/v2/link`) reads an exact edge key and its
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
`task.dates.set` replaces `values: {availableFrom, deadline}`, each a point
(`{kind:'date',date,timezone}` or `{kind:'instant',at,timezone}`) or null. A
date deadline allows completion throughout that local day, a timed one until the
instant; `dueDate` above stays the target. The window must open before the
deadline and a date the zone skipped is refused. Loose intent merges a patch of
one role into the stored points. `add_task` and `update_task` take `deadline`,
`available_from` and `timezone` for the same thing. Tool results show stored
points as these objects; `export_workspace` keeps the stored JSON text so it
restores exactly. A task is not ready (and ranks with blocked work) until its
`available_from` opens, a nearer deadline raises its readiness score, and `find`
can `sort: "deadline"`.
These commands preserve other managed/context fields and support preview,
atomic apply and exact replay. See
[guarded task fields](shared/reliable-task-fields.md) for inputs and conflicts.


`task.delete` / `project.delete` require numeric entity and structural revisions.
Task deletion includes incident-link tombstones; project deletion includes every
detached member task while preserving context/state/links. Duty ownership blocks
project deletion. Oversized atomic effects return versioned `capacity_exceeded`
with exact `requiredStatements` and `limit: 100`; no split writes occur. See
[reliable deletion](shared/reliable-deletion.md) for capacity, replay and conflicts.


Mixed `preview_changes`/`apply_changes` accept 2–100 supported non-lifecycle
commands, including completion/deletion, with an envelope `expectedStructuralRevision`. Graph commands share
that base revision; create referenced entities earlier. Several commands may write one task or project; they compose into one net change (see the bounded-batches note). Results add `batch: true` and all scoped refs. Final dependency graphs
are validated atomically, allowing edge replacement in either add/remove order.
The complete generated SQL must fit 100 statements; settings remain standalone.
New mixed results include `changeGroups`, one image count per command, covering
every successor/cascade/detachment image and enforcing each standalone contract, or `commandChanges` when commands were composed. See [bounded mixed batches](shared/reliable-batches.md).

### `get_workspace_snapshot`

Accepts only `{}` and returns every current user-data family, retained tombstones,
structural revision and matching `{epoch,sequence}` cursor in one consistent read.
Includes duties, preferences, planning settings and historical provenance as well
as tasks/projects/links. Credentials and replay receipts are excluded. See
[workspace sync bootstrap](shared/workspace-sync.md) for exact identity/deletion
contracts and the remaining delta/offline rollout. This is not a restore input.

### `get_workspace_delta`

REST only (`POST /api/v2/sync/delta`). Accepts a bootstrap/completed-pull cursor, optional continuation watermark and
1–500 image limit (default 100). Omit watermark on the first page; pass that
unchanged watermark and each returned cursor through all remaining pages.
Returns ordered historical versioned images, `from`, `cursor`, `watermark` and
`hasMore`. Stage the whole pull before committing canonical state. Mid-pull writes
wait for the next pull. `sync_reset_required` includes current-cursor/floor/reason
diagnostics and requires fresh bootstrap plus retained-intent rebase. See
[workspace sync](shared/workspace-sync.md#fixed-watermark-delta-pulls).

### `export_workspace`

Accepts only `{}` and returns a coherent version 2 portable export of every
current user-data family, including duties, planning values and historical
provenance. Excludes credentials, replay receipts, sync cursors/revisions and
tombstones. Read-only; restore with `restore_workspace`. See
[workspace portability](shared/workspace-portability.md) for exact fields and
legacy compatibility.

### `restore_workspace`

Accepts `{contractVersion:2, mode, expectedCursor, document}` and replaces the
whole workspace from a version 2 export. Always run `mode:"preflight"` first (no
writes), then repeat identical input with `mode:"apply"`. Apply is one atomic batch
guarded by `expectedCursor`, advances the sync epoch so clients must re-bootstrap,
and fails with `restore_cursor_conflict` (409) or `capacity_exceeded` (413) without
changing data. Incoming `command_audit` is validated but not restored. Destructive;
see [workspace portability](shared/workspace-portability.md#restoring-a-version-2-export).
