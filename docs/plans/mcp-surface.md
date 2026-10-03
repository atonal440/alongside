# MCP surface: organizing a growing set of verbs

Status: proposal, not implemented. Updated 2026-10-03.

This plan refines §10 ("REST and MCP surface") of
[the power-user plan](power-user-todo.md). That document still owns the
semantics of each operation. This one owns how operations are grouped into MCP
tools, what an LLM sees in `tools/list`, and how the current 35 tools migrate.

## Problem

`tools/list` currently returns 35 tools from three layers that were built at
different times:

- **21 original tools** in `worker/src/mcp.ts` (`add_task`, `update_task`,
  `complete_task`, …). They write directly through `db.*` helpers. They have
  no command ID, expected revision or replay receipt, so a retried call after a
  lost response can duplicate work, and a concurrent edit is silently
  overwritten.
- **3 foundation tools** in `worker/src/foundation.ts` (`get_capabilities`,
  `resolve_time`, `preview_legacy_dates`).
- **11 command and sync tools** in `worker/src/commands.ts`. Some are for the
  LLM (`preview_changes`, `apply_changes`, `get_entity`). Others are the PWA's
  sync protocol (`get_workspace_snapshot`, `get_workspace_delta`,
  `get_entity_version`) or rare administrative actions (`restore_workspace`).

Four problems follow:

1. **Two write paths for the same nouns.** `update_task` and
   `task.content.set` both change a task, with different guarantees.
2. **Growth.** Slices 3–7 propose roughly 40 more operations (subtasks, date
   roles, blocks, reminders, series, tags, saved queries, timers, undo). One
   tool per operation would pass 70 tools.
3. **Context cost and choice quality.** Every tool's name, description and
   schema is loaded into the model's context on every turn. Models choose less
   reliably among many similar tools.
4. **No permission tiers.** No tool sets the MCP `readOnlyHint` or
   `destructiveHint` annotations. A host can't distinguish "read my tasks" from
   "replace the whole workspace".

## Principles

1. **A small, stable set of tools; a growing set of commands.** New operations
   become command kinds inside `apply_changes` (`task.*`, `project.*`,
   `link.*`, later `block.*`, `reminder.*`, `series.*`, `tag.*`). They don't
   become new tools.
2. **Tool boundaries follow trust, not nouns.** Hosts approve per tool, and
   annotations are per tool. So tools are split by risk tier: reads,
   low-risk conversational writes, the general command tool, and admin.
3. **One write path.** Every mutation, whether from a quick verb or a batch,
   goes through the command planner, receipts and revision guards. Quick verbs
   are convenience entry points, not a second implementation.
4. **Find, then context, then change.** That's the loop an LLM runs. Make the
   find and context reads rich enough that special-purpose read tools become
   presets.
5. **Machine protocols stay off the LLM's list.** Sync bootstrap, deltas and
   version lookups serve the PWA over REST.
6. **Reveal detail on demand.** The full command schema is fetched per family
   when needed. It isn't shipped in every `tools/list` response.

## Target surface

About 18 tools by default. That count stays flat while the command catalog
grows from today's 18 kinds to roughly 60.

| Tier | Tool | Annotations | Purpose |
| --- | --- | --- | --- |
| Read | `get_capabilities` | read-only | Contracts, limits, server time, zone, settings summary, command catalog version |
| Read | `resolve_time` | read-only | Unchanged |
| Read | `start_session` | read-only | Orientation: focused and suggested tasks, preferences, returning-after-gap |
| Read | `find` | read-only | Entity-typed search with filters, presets, sorting and cursor paging |
| Read | `get_context` | read-only | Any entity plus a bounded neighborhood and current revisions |
| Read | `get_agenda` (slice 4) | read-only | A time window: blocks, targets and deadlines, reminders, free slots |
| Read | `get_history` | read-only | Action log and command audit; candidate targets for undo |
| Change | `preview_changes` | read-only | Turns loose intent into a fully pinned command envelope, with a diff |
| Change | `apply_changes` | destructive | Applies a pinned envelope atomically; replays on retry |
| Change | `undo_changes` (slice 7) | destructive | Revision-guarded undo of a command ID |
| Quick verb | `add_task` | — | Compiles to `task.create`, plus scheduling and project commands |
| Quick verb | `update_task` | — | Partial patch compiled to the matching `task.*.set` commands |
| Quick verb | `complete_task` | — | `task.complete`, with a server-minted successor for recurrence |
| Quick verb | `defer_task` | — | `task.defer.set` |
| Quick verb | `focus_task` | — | `task.focus.set` |
| Plan | `preview_schedule` (slice 4) | read-only | Returns proposed placements as a ready-to-apply command batch |
| Help | `describe_commands` | read-only | Schema, examples and error codes for one command family |
| Display | `show_tasks` | read-only | Renders the task widget for task IDs or a project |

**Admin set (opt-in, not in the default list):** `export_workspace`,
`restore_workspace`, and, until the slice 3 date backfill ships,
`preview_legacy_dates`. Serve these from a separate MCP endpoint (for example
`/mcp/admin`) that the user connects only when they need it. MCP has no
built-in tool groups, so a second endpoint is the portable way to keep
restore out of everyday sessions.

## The command language

Command kinds use `noun.verb` names, as they do today (`task.defer.set`,
`link.add`). A family is the noun prefix. `describe_commands({ family: 'task' })`
returns the input schema, one or two examples and the error codes for that
family. `apply_changes` keeps a compact schema that names the families and
points to `describe_commands` for details.

### Preview pins the envelope

Today both `preview_changes` and `apply_changes` take the same strict envelope:
a caller-minted command ID, minted entity IDs (`t_…`, `p_…`) and expected
entity and structural revisions. That is right for the PWA. It's a lot for an
LLM, which has to read every revision first and invent unique IDs.

Proposed change: `preview_changes` also accepts **loose intent**, meaning entity
IDs, client refs and values, with no revisions or minted IDs. It reads the
current state, mints IDs, fills in every expected revision and command ID, and
returns:

- the **pinned envelope**, exactly as `apply_changes` accepts it;
- the diff, warnings and ref map, as today.

The LLM passes the pinned envelope to `apply_changes` unchanged. Safety is
preserved: if anything changed between preview and apply, the guards return a
`revision_conflict`. Retrying a lost `apply_changes` with the same envelope
replays the receipt, as it does today. Strict envelopes (the PWA's path) are
still accepted by both tools.

### Quick verbs

Quick verbs exist for the most frequent conversational actions, where a
two-call preview and apply would be friction. Each one:

- accepts today's argument shape, so existing prompts and skills keep working;
- reads current revisions itself and builds the same commands
  `apply_changes` would run, so the guards, receipts and audit are identical;
- accepts an optional `commandId` (replay-safe retries) and an optional
  `expectedRevision` (refuse if stale). Without them it behaves like today:
  last writer wins, but through the planner;
- makes retries with the same `commandId` replay, not conflict (see
  [Quick-verb replay](#quick-verb-replay));
- returns the command result (revisions, side effects) plus the existing
  `action_log_entry` for the widget. The action-log row is written inside the
  same atomic plan and stored in the receipt (see
  [Quick-verb replay](#quick-verb-replay)).

`update_task` is a partial patch, but the commands replace whole field
groups. `task.content.set` replaces title, notes, kickoff note and session log
together. `task.legacy-schedule.set` requires `dueDate`, `dueAllDay` and
`recurrence` together. So for every group a patch touches, the quick verb
merges the patch into that group's current values before building the
command. That keeps today's behavior: changing only `due_date` keeps the
recurrence, and changing only `recurrence` keeps the due date and its all-day
flag. A new `due_date` resolves `due_all_day` the same way the legacy path
does (`resolveDueDate`). The merged values must also pass the command's
cross-field checks: clearing the due date requires no recurrence, and a
recurrence can't sit on a timed due date. Any patch the legacy path accepted
but those checks reject is a behavior change; list it and test it.
Regression tests cover due-only, recurrence-only and all-day-only patches.
`status: "pending"` becomes
`task.reopen` only when the task is done. On a task that is already pending
it is omitted, as it is effectively a no-op today. If omitting it leaves no
command at all (a call carrying only `status: "pending"` on a pending task),
the call is a read: the verb returns the current task with
`action_log_entry: null`. It writes nothing, so it creates no receipt, no
audit row and no action-log entry. A `commandId` passed with it isn't
recorded, and reusing that ID later starts a new command. Command envelopes
and results can't be empty, so this case never reaches the planner. `task.reopen` rejects
pending tasks that aren't deferred, and on a deferred one it would also clear
the deferral, which the legacy patch never did. `add_task` puts the project and task type into `task.create`
itself. A due date or recurrence needs `task.legacy-schedule.set` on the same
task, because `task.create` is deliberately undated.

### One write per identity

Both verbs can therefore need several commands on one task: `add_task` with a
due date (`task.create` + `task.legacy-schedule.set`), and `update_task` with
fields from more than one group (for example title and due date:
`task.content.set` + `task.legacy-schedule.set`). Today's batch planner
rejects that. It allows each identity to be written only once per mixed batch
(`worker/src/domain/batchCommands.ts`, documented in
[bounded mixed batches](../shared/reliable-batches.md)). So phase C needs one
of these first:

- **Same-identity composition in the planner (recommended).** Commands on one
  identity apply in declared order to the planner's virtual state. They
  produce one net change for that identity: the original before image, the
  final after image, one SQL entity guard on the first command's expected
  revision, and one revision increment. Later commands on that identity give
  the predicted revision after the earlier ones, as batches already do for a
  selected project edited earlier in the same envelope. This fixes both verbs,
  and future multi-field intents, with one planner change.
- **Wider create command.** Let `task.create` accept the legacy schedule
  values. This fixes `add_task` only. `update_task` would still need
  composition or a different split.

Composition also changes the result shape, and the shared result codec
rejects it today. `validDiffIdentity` in `shared/wire/commands.ts` requires a
batch result to hold at least two distinct changes, and one positive
`changeGroups` count per command summing to `changes.length`. A scheduled
`add_task` is two commands with one net change, so its preview, its result and
its stored receipt would all fail that check. The worker parses stored
receipts with the same codec on replay, so retries would fail too. Composition
therefore ships together with a revised result contract:

- a composed result may hold a single change;
- each command records which change carries its effect (for example a
  per-command index into `changes`), replacing the rule that every command
  owns at least one change of its own;
- receipts written before the revision still parse under the old rules.

The worker and the shared codec deploy together, so MCP retries are covered
by one deploy. The PWA only parses results of commands it sent itself, so it
needs the new codec only before it starts sending composed commands. Synced
command-audit rows are unaffected: their codec validates each change on its
own, not the batch grouping.

Whichever option is chosen, it lands with tests before the quick verbs move:
a created task with a due date and recurrence, a multi-group `update_task`,
the single receipt and diff per identity, replay of a composed receipt,
parsing of pre-revision receipts, and rejection when the first command's
revision guard is stale.

Add a quick verb only when the logs show the model struggling with the
`apply_changes` path for that action.

### Quick-verb replay

A quick verb builds its envelope from live state, so rebuilding it on a retry
gives a different envelope. The minted task or successor ID changes, and the
expected revisions have moved on if the first attempt committed. Receipts
compare a hash of the payload, so a retry that hashed the rebuilt envelope
would return `command_id_conflict` instead of the original result. Four
rules prevent that:

- **Look up the receipt before compiling.** With a `commandId`, the server
  checks `command_receipts` first and returns the stored result if the
  request matches. It reads state and builds commands only when no receipt
  exists.
- **Hash the request, not the compiled envelope.** The receipt's payload hash
  covers the quick verb's name and its canonicalized arguments. A different
  request reusing the ID is still a conflict.
- **Derive minted IDs from the `commandId`.** Task and successor IDs come from
  a deterministic function of the `commandId` and their position in the
  batch. Two identical requests racing before either commits plan the same
  identities, so the existing identity guard rejects the second, and its retry
  then replays the receipt.
- **Make the action-log entry part of the command.** Today `logAction`
  inserts the `action_log` row after the change, as a separate unreceipted
  write. The quick verb instead adds the insert to the same atomic plan
  (counted toward plan capacity) and stores the entry it returns in the receipt.
  A replay returns the same `action_log_entry` without writing a second row,
  and a failed command leaves no log entry behind. `apply_changes` follows the
  same rule if it writes action-log entries.

  This changes what a receipt stores. `command_receipts.result_json` is
  replayed through the strict `ChangesResultSchema`, which holds only the
  generic command result. A retried tool must return exactly what the first
  call returned, and each legacy tool has its own response shape. For
  example, `link_tasks` returns both task titles, and `delete_task` returns
  `{ deleted, task_id, title, action_log_entry }`. Re-reading entities on
  replay would return current values, not the original ones. So receipts get
  a versioned stored shape:
  `{ "receiptVersion": 2, "tool": <name>, "result": <ChangesResult>, "response": <the tool's complete response> }`.
  The response includes the `action_log_entry` projection
  (`{ tool_name, title, detail }`), not the full `action_log` row.

  Every field of the response must be known at plan time, so it can be
  serialized into `result_json` before the batch runs. That rules out
  autoincrement values such as `action_log.id`: it doesn't exist yet, and
  reading the next ID in advance would race with concurrent inserts. Titles
  and other entity fields come from the planning read, which the batch's
  revision guards hold steady until commit. A replay returns `response`
  verbatim. Each tool has a response codec, and a receipt without
  `receiptVersion` parses as version 1: a bare `ChangesResult`, as
  `apply_changes` stores today. Boundary tests cover replaying both versions,
  a `link_tasks` replay after one endpoint is renamed (it still returns the
  original titles), and rejecting a version 2 receipt whose response doesn't
  match its tool's codec. The parity matrix checks each tool's stored response
  against the legacy handler's.

Without a `commandId`, the server mints a fresh one and none of this
applies: each call is a new command, as today.

### Adapter parity

Every retained tool that becomes a command adapter (the quick verbs and the
deprecated mutating tools) must behave as it does today for every input it
accepts today. Commands are stricter than the legacy handlers in several
places, so each adapter needs explicit rules. Review has found these so far:

| Legacy input | Command behavior | Adapter rule |
| --- | --- | --- |
| Partial `update_task` / `update_project` patch | `task.content.set`, `project.content.set` and `task.legacy-schedule.set` replace whole field groups | Merge each touched group with current values (see above) |
| `update_project` with only `project_id`, or any patch that compiles to nothing | Envelopes need at least one command | Read: return the current entity, write nothing |
| `update_task` with `status: "pending"` on a pending task | `task.reopen` rejects it | Omit the command (see above) |
| `update_task` with `focused_until: null` on a done task | `task.focus.set` rejects non-pending tasks | Omit: completion already cleared focus. A non-null value already matches, because legacy uses `focusTaskPlan`, which also clears the deferral and rejects non-pending tasks |
| `link_tasks` for a link that already exists | `link.add` rejects an existing link | Read: return the existing link, write nothing |
| `unlink_tasks` for a link that doesn't exist | `link.remove` rejects an absent link | Read: return success, write nothing |
| `create_project` with more than 19 `task_ids` | Envelopes and batch results cap at 20 commands | Decide in phase C: raise the command bound as far as the 100-statement capacity check allows (recommended, because statements are the real limit), or reject with a clear error and record it as a behavior change |

Any call that resolves to a read under these rules writes nothing, so it
creates no receipt and no action-log entry, and a `commandId` passed with it
isn't recorded.

That table is a starting point, not a complete list. **Phase C's first
deliverable is a full parity matrix**, built from the legacy handlers in
`worker/src/mcp.ts` and `worker/src/db.ts`. For every retained mutating tool,
it covers each class of accepted input (each field, combination, and entity
state such as done, deferred or missing), with the legacy result and the
adapter result side by side. Each row gets a test that runs the same input
through the legacy handler and the adapter and compares the outcome. Any row
where they differ is an explicit, documented behavior change, approved
before the adapter replaces the legacy handler.

## Reads

**`find`** takes `entity` (`task` and `project` now; `series`, `block` and
`reminder` as their slices land) and a typed filter for that entity. For tasks:
status, project or subtree, tags, date role and range, readiness and blocked
reason, waiting, recurrence and free text. Presets cover common queries:
`ready` is today's `get_ready_tasks`. Saved queries (slice 7) are named presets
stored as a validated filter AST. Results use stable cursor paging and
deterministic sorting.

**`get_context`** takes one target: a task, project, link key, series, or
`settings`. `depth: 0` returns exactly today's `get_entity` (row plus entity
and structural revision). The default depth adds the neighborhood from §10 of
the master plan: ancestors, children with a continuation cursor, effective
dates and where they come from, prerequisites and dependents, reminders,
blocks, session entries and recurrence origin. A project's context includes its
ready tasks, which covers today's `get_project_context`.

**`get_history`** merges the action log and command audit. It keeps the
action-log widget's `_meta`.

## Display and workflows

`show_tasks` accepts either `task_ids` or `project_id` and renders the same
task dashboard resource that `show_project` uses today. Other read tools can
gain an optional `render` flag later if inline widgets prove useful beyond
these two cases.

`start_session` stays a tool because hosts don't consistently support MCP
prompts. Its static guidance (`SESSION_INSTRUCTIONS`) moves to the
`instructions` field of the `initialize` result, which hosts include once per
connection instead of per call. The tool keeps the dynamic part: focused and
suggested tasks, preferences and the returning-after-gap flag.

Today `start_session` also writes. It seeds missing default preferences with
`INSERT OR IGNORE`, and it stores `last_session_at`. Those writes have no
command ID or receipt, so they would break the rule that every MCP write goes
through the command path. Make it genuinely read-only instead:

- **Defaults at read time.** Merge `DEFAULT_PREFERENCES` into the returned
  preferences in memory rather than inserting rows. A preference row exists
  only once someone sets it.
- **Gap from history.** Compute `returning_after_gap` from the newest
  action-log or command-audit entry, not a stored timestamp. "No activity for
  seven days" is the signal the flag is meant to capture anyway.

Retire the `last_session_at` key once nothing reads it, keeping it readable in
existing preference rows and exports.

## Mapping from current tools

Phases refer to [Rollout](#rollout).

| Current tool | Becomes | Phase | Notes |
| --- | --- | --- | --- |
| `start_session` | `start_session` | A, read-only by C | Static instructions move to `initialize.instructions`; preference seeding and `last_session_at` writes removed |
| `show_tasks` | `show_tasks` | — | Unchanged |
| `show_project` | `show_tasks({ project_id })` | D | Same widget resource; keep the old name until D |
| `list_projects` | `find({ entity: 'project', filter: { status } })` | B, removed D | |
| `list_tasks` | `find({ entity: 'task', filter: { statuses, text } })` | B, removed D | The widget calls `list_tasks`; switch it before removal |
| `get_ready_tasks` | `find({ entity: 'task', preset: 'ready', filter: { project } })` | B, removed D | |
| `add_task` | Quick verb on `task.create` (+ `task.legacy-schedule.set`) | C | Argument shape unchanged; needs same-identity composition |
| `update_task` | Quick verb on `task.*.set` / `task.reopen` | C | Partial patch merged before `task.content.set`; needs same-identity composition |
| `complete_task` | Quick verb on `task.complete` | C | Server mints the successor ID; the widget calls this name |
| `defer_task` | Quick verb on `task.defer.set` | C | |
| `focus_task` | Quick verb on `task.focus.set` | C | `hours` converted to `focusedUntil` |
| `reopen_task` | `apply_changes` `task.reopen` | C, removed D | The widget calls this name: keep it as an app-only tool if the host supports MCP Apps tool visibility, otherwise keep it listed |
| `delete_task` | `apply_changes` `task.delete` | B, removed D | Destructive tier |
| `create_project` | `apply_changes` `project.create` + `task.project.set` × N | B, removed D | |
| `update_project` | `apply_changes` `project.content.set` / `.archive` / `.reopen` | B, removed D | |
| `delete_project` | `apply_changes` `project.delete` | B, removed D | Destructive tier |
| `get_project_context` | `get_context({ project })` | B, removed D | |
| `link_tasks` | `apply_changes` `link.add` | B, removed D | Candidate quick verb if planning sessions use it heavily |
| `unlink_tasks` | `apply_changes` `link.remove` | B, removed D | |
| `update_preference` | `apply_changes` `preference.set` (new kind) | C, removed D | Needs a reliable preference command first |
| `get_action_log` | `get_history` | B, removed D | Keep the action-log widget `_meta` |
| `get_capabilities` | `get_capabilities` | A | Adds the tool-surface and command catalog versions |
| `resolve_time` | `resolve_time` | — | Unchanged |
| `preview_legacy_dates` | Admin endpoint | A, alias removed D | Retire after the slice 3 backfill |
| `preview_changes` | `preview_changes` | B | Gains loose intent and returns a pinned envelope |
| `apply_changes` | `apply_changes` | — | Compact schema; details via `describe_commands` |
| `get_entity` | `get_context({ …, depth: 0 })` | B, removed D | |
| `get_link` | `get_context({ link })` | B, removed D | |
| `get_entity_version` | REST only (`/api/v2/entity-version`) | A, alias removed D | `get_context` returns revisions |
| `get_planning_settings` | `get_context({ settings })` | B, removed D | `get_capabilities` also summarizes the zone |
| `export_planning_settings` | Admin `export_workspace({ scope: 'settings' })` | A, alias removed D | |
| `get_workspace_snapshot` | REST only (`/api/v2/sync/snapshot`) | A, alias removed D | PWA sync protocol |
| `get_workspace_delta` | REST only (`/api/v2/sync/delta`) | A, alias removed D | PWA sync protocol |
| `export_workspace` | Admin endpoint | A, alias removed D | |
| `restore_workspace` | Admin endpoint | A, alias removed D | Destructive tier while the alias remains |

`docs/mcp-tools.md` also documents an `update_kickoff_note` tool that is not
registered in `TOOLS`. Remove that section when the reference is next updated.

## Where planned operations land

| Planned in power-user §10 | Lands as |
| --- | --- |
| `get_task_context` | `get_context({ task })` |
| `create_subtasks`, `move_task`, `reorder_tasks`, cancel | `task.*` command kinds |
| `set_task_date`, `remove_task_date` | `task.date.set` / `task.date.remove` with an explicit role |
| Block create/update/cancel | `block.*` command kinds |
| `find_free_time` | `get_agenda({ freeSlots: true })` |
| `preview_schedule` | Plan tool that returns a pinned `block.*` batch |
| Work log, timer start/stop | `worklog.*` / `timer.*` command kinds |
| Reminder create/pause/resume/snooze/acknowledge | `reminder.*` command kinds |
| Reminder, inbox and delivery queries | `find({ entity: 'reminder' })`, `get_context({ reminder })` |
| Channel enroll/test/disable | Admin endpoint: they handle device credentials |
| Series create/update/pause/resume/end, exceptions, templates | `series.*` command kinds; duty names accepted as aliases |
| Preview occurrences | `get_context({ series, occurrences })` |
| Tags | `tag.*` command kinds; `find` filter |
| Saved queries | `query.*` command kinds; `find({ preset })` |
| `undo_changes` | Change tier tool |
| Export/import dry run | Admin endpoint |

## Compatibility constraints

- **The widget calls tools by name.** `worker/src/app-ui.ts` calls
  `complete_task`, `reopen_task` and `list_tasks`. Switch the widget before
  removing any of those names.
- **The action log records tool names.** `action_log.tool_name` is validated
  against `TOOL_NAMES` in `shared/parse/enums.ts`, and the sync codec already
  keeps the retired `snooze_task` readable. Removed names must stay readable
  in history. New entries should record the command kind (or the quick verb
  that produced it) rather than introducing more tool names.
- **Widen the action-log codec before writing new values.** The PWA parses
  every synced `action_log` row through `SyncActionLogRowSchema`
  (`shared/wire/sync.ts`), which accepts only `ToolNameSchema` or
  `snooze_task`. A row whose `tool_name` is a command kind such as
  `task.complete` fails that parse, so every snapshot or delta page containing
  it is rejected at the response boundary and each pull fails the same way.
  Sync stays stuck until the client is updated.
  The 426 write gate doesn't help, because it only blocks writes and an old
  PWA still reads. So the codec must accept a versioned action-name union
  (current tool names, retired names and command kinds), with parser tests.
- **Deploying the new PWA isn't enough on its own.** A tab that is already
  open, or an offline-first install still running a cached build, keeps the
  old parser until it reloads. So old readers must be stopped from reading,
  not just offered an update. The widened build announces a new client
  protocol (`pwa/3`). Before the worker emits the first command-kind row, the
  snapshot and delta endpoints start returning 426 `upgrade_required` to any
  request whose `X-Alongside-Client` header announces a PWA protocol below 3,
  whether or not it carries `Origin`. Browsers omit `Origin` on same-origin
  GET requests, so the write gate's Origin check alone would let an old tab
  through if the PWA and API ever share an origin. The Origin heuristic
  remains only for browser builds that announce nothing. `pwa/2` clients already treat
  any 426 as "reload to update", keeping queued work, so they recover without
  data loss. The alternative is a backward-compatible projection: serve old
  readers a legacy tool name in place of each command kind. It avoids the
  reload, but it means maintaining a lossy name mapping inside the sync
  feed.
- **External skills use tool names.** The `alongside-daily` skill and any
  saved prompts call today's names. Quick verbs keep their names. Removed tools
  need a deprecation window.
- **The PWA doesn't use MCP.** It syncs over REST, so taking the sync tools off
  MCP changes nothing for it.
- **Capability negotiation.** `get_capabilities` reports a `toolSurface`
  version, so skills and clients can detect the new surface.

## Rollout

- **A: Tiering and cleanup (no new semantics).** Add `readOnlyHint` and
  `destructiveHint` to every tool. Stand up the admin endpoint for export,
  restore, settings export and legacy-date preview, and confirm REST covers
  snapshot, delta and entity-version. Removing names from the default
  endpoint would break existing MCP callers immediately, so every moved tool
  (`get_workspace_snapshot`, `get_workspace_delta`, `get_entity_version`,
  `export_workspace`, `restore_workspace`, `export_planning_settings`,
  `preview_legacy_dates`) stays listed there as a deprecated alias. Each alias
  behaves exactly as before, with a description naming its new home. They are
  removed in phase D with the other deprecated tools, once logs show no
  callers. Move static session instructions to `initialize`. Add
  `toolSurface` to capabilities.
- **B: New reads and pinning preview.** Add `find` (task, project),
  `get_context`, `get_history`, `describe_commands`, and loose-intent
  `preview_changes`. Mark the tools they replace as deprecated in their
  descriptions ("Deprecated: use `find`"). Widen the shared action-log codec
  to the versioned action-name union (with tests), and raise the PWA's
  announced client protocol to 3 in the same build.
- **C: One write path.** First build the parity matrix (see
  [Adapter parity](#adapter-parity)) and the versioned receipt shape. Then add
  same-identity composition to the batch planner, with the revised result contract (see
  [One write per identity](#one-write-per-identity)). Then rebuild the quick
  verbs on the command planner, with receipt-first replay and
  command-derived IDs. Also rebuild every other mutating tool that is still
  listed (`reopen_task`, `delete_task`, `create_project`, `update_project`,
  `delete_project`, `link_tasks`, `unlink_tasks`, `update_preference`) as a
  thin adapter that compiles to the same commands, with the same
  receipt-first replay and receipted action-log entry. Deprecated tools
  still count as MCP writes until phase D removes them. Add the
  `preference.set` command. Make
  `start_session` read-only. Turn on the sync read gate for browser clients
  below protocol 3, and only then record command kinds in the action log.
  Switch the widget to `find` and `apply_changes`. After this phase, MCP no
  longer writes through the legacy path. The one deliberate exception is
  `restore_workspace` (see below).
- **Restore stays outside the receipt guarantee.** `restore_workspace` in
  `apply` mode writes without a command ID or receipt, on both the admin
  endpoint and its default-endpoint alias. It is already safe against lost
  responses another way. It is guarded by the caller's `expectedCursor`, and
  it advances the sync epoch. A retry after a commit whose response was lost
  returns 409 `restore_outcome_unknown` rather than applying twice, and the
  caller reads a snapshot to see what is live
  ([workspace portability](../shared/workspace-portability.md)). The phase C
  claims therefore exclude it explicitly. Making restore receipted (a
  `commandId` and a stored result, so a retry replays) is a possible later
  improvement, but it's not needed for safety.
- **D: Remove deprecated tools** once logs show no remaining callers, keeping
  the action-log history readable.
- **Slices 3–7** then add command kinds, `get_agenda`, `preview_schedule` and
  `undo_changes` to this surface instead of adding tools.

Phase A is independent of the power-user slices and can land at any time.
Doing B and C before slice 3 means slice 3's date roles and hierarchy are
built once, on the command path, and not added to the legacy verbs as well.

## Acceptance

- The default `tools/list` stays at or below about 20 tools through slice 7.
- Every MCP write except `restore_workspace` produces a command receipt.
  Restore relies on its cursor guard and `restore_outcome_unknown` instead.
  Retrying a quick verb with the
  same `commandId` replays rather than duplicating, including after the first
  attempt committed and for verbs that mint IDs (`add_task`, recurring
  `complete_task`). A replay writes no second action-log row and returns the
  original `action_log_entry`.
- `update_task` with `status: "pending"` on an already-pending task still
  succeeds, alone or with other fields, and doesn't clear a deferral. Alone,
  it writes nothing and returns `action_log_entry: null`.
- After phase C, no MCP tool handler calls a legacy `db.*` mutation or
  `logAction` directly, apart from the documented `restore_workspace`
  exception.
- The phase C parity matrix exists, every row has a passing test, and every
  behavior difference in it is documented and approved.
- Version 1 receipts (bare results) and version 2 receipts (with the
  tool's stored response) both replay, and a replayed response matches the
  original exactly.
- Every tool removed from the default endpoint was first listed there as a
  deprecated alias for the whole deprecation window.
- `update_task` with only `due_date`, only `recurrence` or only `due_all_day`
  keeps the other schedule fields, as it does today.
- A PWA snapshot or delta containing command-kind action-log rows parses and
  syncs, and a client announcing protocol 2 gets 426 from the sync endpoints
  instead of a page it can't parse, with or without an `Origin` header.
- `add_task` with a due date or recurrence, and `update_task` with fields from
  several groups, each commit as one atomic command with one diff per task.
- An LLM can complete a multi-step change (create a project, move three
  tasks, link two) with one `preview_changes` and one `apply_changes`, without
  reading revisions by hand.
- Read-only tools carry `readOnlyHint`; delete and restore are reachable only
  through destructive-tier tools.

## Open questions

- **One `find` or one per entity?** One tool scales better once series,
  blocks and reminders exist. Per-entity tools have simpler schemas for hosts
  that only partly support JSON Schema unions. Start with one and split only if
  a host struggles.
- **How many quick verbs?** Five is the starting point. Logs should decide
  whether `link_tasks` or `create_project` earns one.
- **Admin endpoint or a preference flag?** A second endpoint keeps restore out
  of every session. A flag is simpler to set up but leaves the tools listed.
- **Deprecation window length for phase D.** It depends on how often external
  skills and saved prompts are updated.
