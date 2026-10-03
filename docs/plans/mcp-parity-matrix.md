# MCP adapter parity matrix

Status: legacy side pinned; findings 1–10 approved (2026-10-03). Adapters built and passing for all mutating tools except `update_preference`, which waits for the `preference.set` command. Updated 2026-10-03.

This is the first deliverable of phase C in [the MCP surface plan](mcp-surface.md#adapter-parity). Every retained mutating tool (`add_task`, `complete_task`, `defer_task`, `update_task`, `reopen_task`, `focus_task`, `delete_task`, `create_project`, `update_project`, `delete_project`, `link_tasks`, `unlink_tasks`, `update_preference`) is run on a fixed fixture workspace for each class of input it accepts today: each field, combinations, and entity states (done, deferred, focused, missing).

## How it works

- Rows live in `worker/test/parity/rows.ts`. A row is a tool, an input (`"$alias"` strings become fixture IDs) and a one-line note.
- `harness.ts` builds the fixture, calls the tool through the real MCP handler under a fixed clock, and records an outcome: the response or error, plus a diff of `tasks`, `projects`, `task_links`, `action_log` and `user_preferences`. Minted IDs are normalized to `$new1`, `$new2`, … in order of appearance.
- The legacy handlers' outcomes are pinned in `worker/test/parity/legacy-outcomes.json`. Because adapters keep the tool names, the same test runs unchanged after a handler is replaced: it must reproduce the pinned outcome.
- A row may differ only if `worker/test/parity/approved.ts` lists it with a reason and the outcome the adapter produces. That list is empty today. Nothing is added to it until the difference is approved.
- Error wording is informational. For a refused call the test compares the channel (JSON-RPC error or tool error) and the writes (none expected), not the message.
- To re-record after an intended change to a legacy handler: `PARITY_RECORD=1 npx vitest run test/parity` from `worker/`. This rewrites the pinned file and the table below. A normal run fails if either is stale.

## Differences in force

**G1 (global).** A refused call now returns a structured tool error (`isError`, with a `code` and `recoveryHint`) instead of a bare JSON-RPC error. The parity test compares only "refused, with these writes" for these rows.

Per-row differences live in `worker/test/parity/approved.ts`, each with the adapter's outcome pinned in `approved-outcomes.json`:

- `update_task.status-pending-on-pending`, `status-pending-on-deferred`, `focus-clear-on-done`: finding 2, approved. A call that compiles to no command writes no row, so `updated_at` no longer moves. The call still logs and returns the task.
- `update_task.all-day-only-no-due`: approved 2026-10-03. Legacy stored `due_all_day: true` on a task with no due date, a state the commands cannot represent. The adapter refuses it.
- `update_project.status-unchanged`, `update_project.archive-already-archived`: finding 2, approved. A status the project already has compiles to no command, so `updated_at` no longer moves. The call still logs.
- `link_tasks.existing-related-reversed`: finding 3, approved. A related link that exists in the other orientation counts as present; no second row.
- `link_tasks.related`: proposed. A related link is stored from the lower task ID to the higher regardless of argument order (the command requires ascending endpoints; the link is symmetric). The response still echoes the arguments as given.
- `create_project.thirty-tasks`: finding 5, approved. The command bound is now 100, so the practical limit is the 100-statement atomic plan. Each assigned task costs more statements than before (diff, audit and feed rows), so the ceiling is 23 tasks where the legacy path reached 33. A larger call is refused with `capacity_exceeded` and writes nothing.

## Findings the plan did not list

The plan's table of known gaps holds up (see the rows). Recording the legacy behavior turned up these further cases. The recommendation on each was approved on 2026-10-03, so an adapter may differ from the legacy outcome on exactly these points once the row is added to `approved.ts` with the adapter's real outcome. Findings 6–10 describe behavior the adapters must simply keep or tighten without needing a row.

1. **`update_task` accepts undeclared fields.** `defer_kind` and `defer_until` are not in the tool schema but are applied (`undeclared-defer*` rows): `until` and `someday` go through the same deferral planner as `defer_task`, and `none` clears a deferral directly. Unknown keys such as `colour` are ignored but the call still logs. *Recommend:* keep ignoring unknown keys, and map `defer_kind`/`defer_until` to `task.defer.set` so results stay the same.
2. **Unchanged values still move `updated_at`.** Any non-empty patch bumps `updated_at` even when every value is unchanged (`same-title`, `status-pending-on-pending`, `focus-clear-unfocused`, `update_project.status-unchanged`). Only a call whose patch is empty leaves the row alone. *Recommend:* accept no bump for true no-ops; `updated_at` feeds readiness scoring only through age, so the effect is nil. Needs approval because the PWA shows it.
3. **`link_tasks` can store a related link twice.** A related link whose reverse already exists is added again in the other orientation (`existing-related-reversed`). `link.add` is documented to prevent reversed duplicates. *Recommend:* treat it as the existing-link no-op and return the existing link. Existing duplicate rows stay readable.
4. **`unlink_tasks` is orientation-exact.** Removing a related link in the reverse orientation, or a blocks link the wrong way round, succeeds and removes nothing (`related-reversed`, `wrong-orientation`). `link.remove` also uses the exact stored orientation, so the no-op rule covers it.
5. **`create_project` has no task-count cap.** 20 task IDs work today (`twenty-tasks`). It also moves tasks out of other projects and accepts done tasks, bumping `updated_at` on every member. The plan's 19-task limit is therefore a behavior change unless the command bound is raised.
6. **Raw errors leak.** A nonexistent project on `add_task`/`update_task` surfaces as a SQLite `FOREIGN KEY constraint failed`, and a non-array `task_ids` as a JavaScript `TypeError`. Both are refusals with no writes. Adapters should return structured errors; this passes the comparison rule above.
7. **`delete_task` logs the deleted task's ID.** The `action_log` row keeps `task_id` after the task is gone. A receipted log entry must keep writing it.
8. **`update_preference` accepts the internal key `last_session_at`.** `preference.set` must either keep accepting it or reject it as an approved change. `start_session` stops writing it in phase C.
9. **`update_task` edits done tasks freely** (title, due date, session log) and accepts an archived project as `project_id`. Both depend on how the content and membership commands treat done tasks and archived projects; the adapter rows will show it.
10. **`complete_task` accepts deferred and focused tasks.** Completing clears both the deferral and the focus, in the same write as the status change (`deferred`, `focused` rows).

## Matrix

<!-- matrix:start -->

### `add_task`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `title-only` | `{"title":"New"}` | Minimal call | ok — tasks +1; logs `add_task` | must match |
| `all-plain-fields` | `{"title":"New","notes":"n","kickoff_note":"k","task_type":"plan"}` | Notes, kickoff note and plan type | ok — tasks +1; logs `add_task` | must match |
| `project` | `{"title":"New","project_id":"$proj"}` | Existing project | ok — tasks +1; logs `add_task` | must match |
| `project-missing` | `{"title":"New","project_id":"$noneProject"}` | Project that does not exist | refused (JSON-RPC error): FOREIGN KEY constraint failed | must match |
| `bare-date` | `{"title":"New","due_date":"2026-11-01"}` | Bare date is all-day at noon UTC | ok — tasks +1; logs `add_task` | must match |
| `datetime` | `{"title":"New","due_date":"2026-11-01T15:30:00Z"}` | Timed due date | ok — tasks +1; logs `add_task` | must match |
| `offset-datetime` | `{"title":"New","due_date":"2026-11-01T10:30:00-05:00"}` | Offset datetime is normalized to UTC | ok — tasks +1; logs `add_task` | must match |
| `date-and-recurrence` | `{"title":"New","due_date":"2026-11-01","recurrence":"FREQ=WEEKLY"}` | Recurring all-day task | ok — tasks +1; logs `add_task` | must match |
| `recurrence-without-date` | `{"title":"New","recurrence":"FREQ=WEEKLY"}` | Recurrence requires a due date | refused (JSON-RPC error): due_date is required when recurrence is set. | must match |
| `recurrence-on-timed` | `{"title":"New","due_date":"2026-11-01T15:30:00Z","recurrence":"FREQ=WEEKLY"}` | Recurrence cannot sit on a timed due date | refused (JSON-RPC error): Recurring tasks must have an all-day due date; timed recurrence is not supported yet. | must match |
| `bad-recurrence` | `{"title":"New","due_date":"2026-11-01","recurrence":"FREQ=SECONDLY"}` | Unsupported recurrence rule | refused (JSON-RPC error): Expected an infinite date-only RRULE. | must match |
| `impossible-date` | `{"title":"New","due_date":"2026-02-30"}` | Calendar date that does not exist | refused (JSON-RPC error): Expected a valid ISO calendar date (YYYY-MM-DD) or date-time. | must match |
| `bad-date` | `{"title":"New","due_date":"next tuesday"}` | Unparseable due date | refused (JSON-RPC error): Expected a valid ISO calendar date (YYYY-MM-DD) or date-time. | must match |
| `undeclared-due-all-day` | `{"title":"New","due_date":"2026-11-01T15:30:00Z","due_all_day":true}` | due_all_day is not a declared argument and is ignored | ok — tasks +1; logs `add_task` | must match |
| `empty-title` | `{"title":""}` | Empty title | refused (JSON-RPC error): Expected a non-empty string. | must match |
| `long-title` | `{"title":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…` | Title over 200 characters | refused (JSON-RPC error): Expected at most 200 characters. | must match |
| `missing-title` | `{}` | No title | refused (JSON-RPC error): Invalid type: Expected string but received undefined | must match |
| `bad-type` | `{"title":"New","task_type":"chore"}` | Unknown task_type | refused (JSON-RPC error): Invalid type: Expected ("action" \| "plan") but received "chore" | must match |
| `long-notes` | `{"title":"New","notes":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…` | Notes over 10000 characters | refused (JSON-RPC error): Expected at most 10000 characters. | must match |

### `complete_task`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `pending` | `{"task_id":"$pend"}` | Plain pending task | ok — tasks ~1: status (+updated_at); logs `complete_task` | must match |
| `recurring` | `{"task_id":"$weekly"}` | Recurring task mints a successor and logs the recurrence | ok — tasks +1; tasks ~1: status (+updated_at); logs `complete_task` | must match |
| `already-done` | `{"task_id":"$done"}` | Already done | refused (JSON-RPC error): Only pending tasks can use this transition. | must match |
| `deferred` | `{"task_id":"$deferred"}` | Deferred task | ok — tasks ~1: status, defer_until, defer_kind (+updated_at); logs `complete_task` | must match |
| `focused` | `{"task_id":"$focused"}` | Focused task loses its focus | ok — tasks ~1: status, focused_until (+updated_at); logs `complete_task` | must match |
| `blocked` | `{"task_id":"$blocked"}` | Task blocked by an open task | ok — tasks ~1: status (+updated_at); logs `complete_task` | must match |
| `in-project` | `{"task_id":"$member"}` | Project member | ok — tasks ~1: status (+updated_at); logs `complete_task` | must match |
| `missing` | `{"task_id":"$none"}` | Task does not exist | refused (JSON-RPC error): Task not found | must match |

### `defer_task`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `until` | `{"task_id":"$pend","kind":"until","until":"2026-12-01T09:00:00Z"}` | Defer until a future instant | ok — tasks ~1: defer_until, defer_kind (+updated_at); logs `defer_task` | must match |
| `until-past` | `{"task_id":"$pend","kind":"until","until":"2020-01-01T00:00:00Z"}` | Defer until an instant in the past | ok — tasks ~1: defer_until, defer_kind (+updated_at); logs `defer_task` | must match |
| `until-offset` | `{"task_id":"$pend","kind":"until","until":"2026-12-01T09:00:00+02:00"}` | Offset instant is normalized | ok — tasks ~1: defer_until, defer_kind (+updated_at); logs `defer_task` | must match |
| `until-no-zone` | `{"task_id":"$pend","kind":"until","until":"2026-12-01T09:00:00"}` | Timestamp without a zone | refused (JSON-RPC error): Expected a valid ISO date-time with Z or an offset. | must match |
| `until-missing-value` | `{"task_id":"$pend","kind":"until"}` | kind until without until | refused (JSON-RPC error): until is required when kind="until" | must match |
| `someday` | `{"task_id":"$pend","kind":"someday"}` | Defer indefinitely | ok — tasks ~1: defer_kind (+updated_at); logs `defer_task` | must match |
| `someday-with-until` | `{"task_id":"$pend","kind":"someday","until":"2026-12-01T09:00:00Z"}` | someday rejects until | refused (JSON-RPC error): until must be omitted when kind is someday. | must match |
| `bad-kind` | `{"task_id":"$pend","kind":"later"}` | Unknown kind | refused (JSON-RPC error): kind must be "until" or "someday" | must match |
| `redefer` | `{"task_id":"$deferred","kind":"someday"}` | Change an existing deferral | ok — tasks ~1: defer_until, defer_kind (+updated_at); logs `defer_task` | must match |
| `focused` | `{"task_id":"$focused","kind":"someday"}` | Deferring a focused task | ok — tasks ~1: defer_kind, focused_until (+updated_at); logs `defer_task` | must match |
| `done` | `{"task_id":"$done","kind":"someday"}` | Done task | refused (JSON-RPC error): Only pending tasks can use this transition. | must match |
| `missing` | `{"task_id":"$none","kind":"someday"}` | Task does not exist | refused (JSON-RPC error): Task not found | must match |

### `update_task`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `title` | `{"task_id":"$notes","title":"Renamed"}` | Title only keeps notes and kickoff note | ok — tasks ~1: title (+updated_at); logs `update_task` | must match |
| `notes` | `{"task_id":"$notes","notes":"new notes"}` | Notes only keeps title and kickoff note | ok — tasks ~1: notes (+updated_at); logs `update_task` | must match |
| `notes-null` | `{"task_id":"$notes","notes":null}` | null clears notes | ok — tasks ~1: notes (+updated_at); logs `update_task` | must match |
| `kickoff-note` | `{"task_id":"$notes","kickoff_note":"new kickoff"}` | Kickoff note only | ok — tasks ~1: kickoff_note (+updated_at); logs `update_task` | must match |
| `session-log` | `{"task_id":"$notes","session_log":"did things"}` | Session log only | ok — tasks ~1: session_log (+updated_at); logs `update_task` | must match |
| `task-type` | `{"task_id":"$pend","task_type":"plan"}` | Task type only | ok — tasks ~1: task_type (+updated_at); logs `update_task` | must match |
| `empty-title` | `{"task_id":"$pend","title":""}` | Empty title | refused (JSON-RPC error): Expected a non-empty string. | must match |
| `due-only-keeps-recurrence` | `{"task_id":"$weekly","due_date":"2026-10-12"}` | New due date keeps recurrence | ok — tasks ~1: due_date (+updated_at); logs `update_task` | must match |
| `recurrence-only-keeps-due` | `{"task_id":"$weekly","recurrence":"FREQ=MONTHLY"}` | New recurrence keeps due date and all-day flag | ok — tasks ~1: recurrence (+updated_at); logs `update_task` | must match |
| `recurrence-only-no-due` | `{"task_id":"$pend","recurrence":"FREQ=WEEKLY"}` | Recurrence on an undated task | refused (JSON-RPC error): due_date is required when recurrence is set. | must match |
| `recurrence-onto-timed` | `{"task_id":"$timed","recurrence":"FREQ=WEEKLY"}` | Recurrence on a timed due date | refused (JSON-RPC error): Recurring tasks must have an all-day due date; timed recurrence is not supported yet. | must match |
| `due-timed-with-recurrence` | `{"task_id":"$weekly","due_date":"2026-10-12T15:00:00Z"}` | Timed due date on a recurring task | refused (JSON-RPC error): Recurring tasks must have an all-day due date; timed recurrence is not supported yet. | must match |
| `due-null` | `{"task_id":"$dueonly","due_date":null}` | Clear the due date | ok — tasks ~1: due_date, due_all_day (+updated_at); logs `update_task` | must match |
| `due-null-with-recurrence` | `{"task_id":"$weekly","due_date":null}` | Clear the due date but keep recurrence | refused (JSON-RPC error): due_date is required when recurrence is set. | must match |
| `due-null-and-recurrence-null` | `{"task_id":"$weekly","due_date":null,"recurrence":null}` | Clear both | ok — tasks ~1: due_date, due_all_day, recurrence (+updated_at); logs `update_task` | must match |
| `recurrence-null` | `{"task_id":"$weekly","recurrence":null}` | Clear recurrence, keep due date | ok — tasks ~1: recurrence (+updated_at); logs `update_task` | must match |
| `all-day-only` | `{"task_id":"$timed","due_all_day":true}` | Reclassify an existing due date | ok — tasks ~1: due_all_day (+updated_at); logs `update_task` | must match |
| `all-day-only-no-due` | `{"task_id":"$pend","due_all_day":true}` | All-day flag on an undated task | ok — tasks ~1: due_all_day (+updated_at); logs `update_task` | approved difference |
| `all-day-null` | `{"task_id":"$dueonly","due_all_day":null}` | Back to ambiguous | ok — tasks ~1: due_all_day (+updated_at); logs `update_task` | must match |
| `due-with-all-day` | `{"task_id":"$pend","due_date":"2026-11-01T15:00:00Z","due_all_day":true}` | Explicit all-day beats the parsed classification | ok — tasks ~1: due_date, due_all_day (+updated_at); logs `update_task` | must match |
| `bad-due` | `{"task_id":"$pend","due_date":"soon"}` | Unparseable due date | refused (JSON-RPC error): Expected a valid ISO calendar date (YYYY-MM-DD) or date-time. | must match |
| `title-and-due` | `{"task_id":"$notes","title":"Both","due_date":"2026-11-01"}` | Fields from two groups | ok — tasks ~1: title, due_date, due_all_day (+updated_at); logs `update_task` | must match |
| `all-groups` | `{"task_id":"$notes","title":"All","task_type":"plan","due_date":"2026-11-01","project_id":"$proj","session_log":"s"}` | Several groups at once | ok — tasks ~1: title, due_date, due_all_day, task_type, project_id, session_log (+updated_at); logs `update_task` | must match |
| `same-title` | `{"task_id":"$notes","title":"Has fields"}` | A field set to the value it already has | ok — tasks ~1: updated_at only; logs `update_task` | must match |
| `status-pending-on-pending` | `{"task_id":"$pend","status":"pending"}` | No-op status on a pending task | ok — tasks ~1: updated_at only; logs `update_task` | approved difference |
| `status-pending-with-title` | `{"task_id":"$pend","status":"pending","title":"T"}` | No-op status alongside a real field | ok — tasks ~1: title (+updated_at); logs `update_task` | must match |
| `status-pending-on-done` | `{"task_id":"$done","status":"pending"}` | Reopen via status | ok — tasks ~1: status (+updated_at); logs `update_task` | must match |
| `status-pending-on-deferred` | `{"task_id":"$deferred","status":"pending"}` | Status on a deferred task does not clear the deferral | ok — tasks ~1: updated_at only; logs `update_task` | approved difference |
| `status-done` | `{"task_id":"$pend","status":"done"}` | status done is refused | refused (JSON-RPC error): Use completeTask() to mark a task done. | must match |
| `status-bogus` | `{"task_id":"$pend","status":"archived"}` | Unknown status value | refused (JSON-RPC error): Invalid type: Expected ("pending" \| "done") but received "archived" | must match |
| `focus-set` | `{"task_id":"$pend","focused_until":"2026-10-03T18:00:00Z"}` | Focus until a future instant | ok — tasks ~1: focused_until (+updated_at); logs `update_task` | must match |
| `focus-set-on-deferred` | `{"task_id":"$deferred","focused_until":"2026-10-03T18:00:00Z"}` | Focusing a deferred task clears the deferral | ok — tasks ~1: defer_until, defer_kind, focused_until (+updated_at); logs `update_task` | must match |
| `focus-set-on-done` | `{"task_id":"$done","focused_until":"2026-10-03T18:00:00Z"}` | Focus on a done task | refused (JSON-RPC error): Only pending tasks can use this transition. | must match |
| `focus-clear` | `{"task_id":"$focused","focused_until":null}` | Clear focus | ok — tasks ~1: focused_until (+updated_at); logs `update_task` | must match |
| `focus-clear-unfocused` | `{"task_id":"$pend","focused_until":null}` | Clear focus that is not set | ok — tasks ~1: updated_at only; logs `update_task` | must match |
| `focus-clear-on-done` | `{"task_id":"$done","focused_until":null}` | Clear focus on a done task | ok — tasks ~1: updated_at only; logs `update_task` | approved difference |
| `focus-bad` | `{"task_id":"$pend","focused_until":"later"}` | Unparseable focus instant | refused (JSON-RPC error): Expected a valid ISO date-time with Z or an offset. | must match |
| `project-move` | `{"task_id":"$pend","project_id":"$proj"}` | Move into a project | ok — tasks ~1: project_id (+updated_at); logs `update_task` | must match |
| `project-remove` | `{"task_id":"$member","project_id":null}` | null removes the project | ok — tasks ~1: project_id (+updated_at); logs `update_task` | must match |
| `project-missing` | `{"task_id":"$pend","project_id":"$noneProject"}` | Project that does not exist | refused (JSON-RPC error): FOREIGN KEY constraint failed | must match |
| `project-archived` | `{"task_id":"$pend","project_id":"$archived"}` | Archived project | ok — tasks ~1: project_id (+updated_at); logs `update_task` | must match |
| `undeclared-defer` | `{"task_id":"$pend","defer_kind":"someday"}` | defer_kind is not declared but passes straight through | ok — tasks ~1: defer_kind (+updated_at); logs `update_task` | must match |
| `undeclared-defer-until` | `{"task_id":"$pend","defer_kind":"until","defer_until":"2026-12-01T09:00:00Z"}` | Undeclared deferral pair | ok — tasks ~1: defer_until, defer_kind (+updated_at); logs `update_task` | must match |
| `undeclared-defer-none` | `{"task_id":"$deferred","defer_kind":"none","defer_until":null}` | Undeclared clear of a deferral | ok — tasks ~1: defer_until, defer_kind (+updated_at); logs `update_task` | must match |
| `undeclared-unknown-key` | `{"task_id":"$pend","colour":"red"}` | Unknown key | ok — logs `update_task` | must match |
| `empty-patch` | `{"task_id":"$pend"}` | Only task_id: nothing to change, still logs | ok — logs `update_task` | must match |
| `empty-patch-missing` | `{"task_id":"$none"}` | Empty patch on a missing task | refused (JSON-RPC error): Task not found | must match |
| `missing` | `{"task_id":"$none","title":"x"}` | Task does not exist | refused (JSON-RPC error): Task not found | must match |
| `done-title` | `{"task_id":"$done","title":"Edited after done"}` | Edit a done task | ok — tasks ~1: title (+updated_at); logs `update_task` | must match |
| `done-due` | `{"task_id":"$done","due_date":"2026-11-01"}` | Schedule a done task | ok — tasks ~1: due_date, due_all_day (+updated_at); logs `update_task` | must match |

### `reopen_task`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `done` | `{"task_id":"$done"}` | Done task | ok — tasks ~1: status (+updated_at); logs `reopen_task` | must match |
| `deferred` | `{"task_id":"$deferred"}` | Deferred task clears its deferral | ok — tasks ~1: defer_until, defer_kind (+updated_at); logs `reopen_task` | must match |
| `someday` | `{"task_id":"$someday"}` | Someday task | ok — tasks ~1: defer_kind (+updated_at); logs `reopen_task` | must match |
| `pending` | `{"task_id":"$pend"}` | Plain pending task is refused | refused (JSON-RPC error): Only done or deferred pending tasks can be reopened. | must match |
| `missing` | `{"task_id":"$none"}` | Task does not exist | refused (JSON-RPC error): Task not found | must match |

### `focus_task`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `default-hours` | `{"task_id":"$pend"}` | Defaults to 3 hours | ok — tasks ~1: focused_until (+updated_at); logs `focus_task` | must match |
| `hours` | `{"task_id":"$pend","hours":1.5}` | Fractional hours | ok — tasks ~1: focused_until (+updated_at); logs `focus_task` | must match |
| `max-hours` | `{"task_id":"$pend","hours":24}` | Upper bound | ok — tasks ~1: focused_until (+updated_at); logs `focus_task` | must match |
| `null-hours` | `{"task_id":"$pend","hours":null}` | hours: null | refused (JSON-RPC error): hours must be a finite positive number no greater than 24: Invalid type: Expected number b | must match |
| `negative-hours` | `{"task_id":"$pend","hours":-1}` | Negative hours | refused (JSON-RPC error): hours must be a finite positive number no greater than 24: Expected a positive number.; Ex | must match |
| `zero-hours` | `{"task_id":"$pend","hours":0}` | Zero hours | refused (JSON-RPC error): hours must be a finite positive number no greater than 24: Expected a positive number. | must match |
| `too-many-hours` | `{"task_id":"$pend","hours":25}` | Over the bound | refused (JSON-RPC error): hours must be a finite positive number no greater than 24: Expected a value no greater tha | must match |
| `string-hours` | `{"task_id":"$pend","hours":"2"}` | Hours as a string | refused (JSON-RPC error): hours must be a finite positive number no greater than 24: Invalid type: Expected number b | must match |
| `refocus` | `{"task_id":"$focused","hours":1}` | Replace an existing focus | ok — tasks ~1: focused_until (+updated_at); logs `focus_task` | must match |
| `deferred` | `{"task_id":"$deferred"}` | Focusing clears the deferral | ok — tasks ~1: defer_until, defer_kind, focused_until (+updated_at); logs `focus_task` | must match |
| `done` | `{"task_id":"$done"}` | Done task | refused (JSON-RPC error): Only pending tasks can use this transition. | must match |
| `missing` | `{"task_id":"$none"}` | Task does not exist | refused (JSON-RPC error): Task not found | must match |

### `delete_task`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `plain` | `{"task_id":"$pend"}` | Plain task | ok — tasks −1; logs `delete_task` | must match |
| `with-links` | `{"task_id":"$blocker"}` | Link rows go with the task | ok — tasks −1; task_links −1; logs `delete_task` | must match |
| `in-project` | `{"task_id":"$member"}` | Project member | ok — tasks −1; logs `delete_task` | must match |
| `done` | `{"task_id":"$done"}` | Done task | ok — tasks −1; logs `delete_task` | must match |
| `missing` | `{"task_id":"$none"}` | Task does not exist | refused (JSON-RPC error): Task not found | must match |

### `create_project`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `title-only` | `{"title":"New project"}` | Minimal call | ok — projects +1; logs `create_project` | must match |
| `all-fields` | `{"title":"New project","notes":"n","kickoff_note":"k"}` | Notes and kickoff note | ok — projects +1; logs `create_project` | must match |
| `with-tasks` | `{"title":"New project","task_ids":["$pend","$pend2"]}` | Assign existing tasks | ok — tasks ~2: project_id (+updated_at); projects +1; logs `create_project` | must match |
| `duplicate-task-ids` | `{"title":"New project","task_ids":["$pend","$pend"]}` | Duplicate IDs count once | ok — tasks ~1: project_id (+updated_at); projects +1; logs `create_project` | must match |
| `moves-from-other-project` | `{"title":"New project","task_ids":["$member"]}` | Task already in another project | ok — tasks ~1: project_id (+updated_at); projects +1; logs `create_project` | must match |
| `missing-task` | `{"title":"New project","task_ids":["$pend","$none"]}` | One task does not exist | refused (JSON-RPC error): task not found: $none | must match |
| `done-task` | `{"title":"New project","task_ids":["$done"]}` | Done task | ok — tasks ~1: project_id (+updated_at); projects +1; logs `create_project` | must match |
| `nineteen-tasks` | `{"title":"New project","task_ids":["$bulk0","$bulk1","$bulk2","$bulk3","$bulk4","$bulk5","$bulk6","$bulk7","$bulk8","…` | 19 tasks | ok — tasks ~19: project_id (+updated_at); projects +1; logs `create_project` | must match |
| `twenty-tasks` | `{"title":"New project","task_ids":["$bulk0","$bulk1","$bulk2","$bulk3","$bulk4","$bulk5","$bulk6","$bulk7","$bulk8","…` | 20 tasks: more than the old 20-command bound allowed | ok — tasks ~20: project_id (+updated_at); projects +1; logs `create_project` | must match |
| `thirty-tasks` | `{"title":"New project","task_ids":["$bulk0","$bulk1","$bulk2","$bulk3","$bulk4","$bulk5","$bulk6","$bulk7","$bulk8","…` | 30 tasks | ok — tasks ~30: project_id (+updated_at); projects +1; logs `create_project` | approved difference |
| `forty-tasks` | `{"title":"New project","task_ids":["$bulk0","$bulk1","$bulk2","$bulk3","$bulk4","$bulk5","$bulk6","$bulk7","$bulk8","…` | 40 tasks | refused (tool error): Atomic plan requires 121 SQL statements; the limit is 100. | must match |
| `empty-title` | `{"title":""}` | Empty title | refused (JSON-RPC error): Expected a non-empty string. | must match |
| `non-array-task-ids` | `{"title":"New project","task_ids":"x"}` | task_ids is not an array | refused (JSON-RPC error): inputs.entries is not a function or its return value is not iterable | must match |

### `update_project`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `title` | `{"project_id":"$proj","title":"Renamed"}` | Title only keeps notes and kickoff note | ok — projects ~1: title (+updated_at); logs `update_project` | must match |
| `notes` | `{"project_id":"$proj","notes":"new"}` | Notes only | ok — projects ~1: notes (+updated_at); logs `update_project` | must match |
| `notes-null` | `{"project_id":"$proj","notes":null}` | null clears notes | ok — projects ~1: notes (+updated_at); logs `update_project` | must match |
| `kickoff-note` | `{"project_id":"$proj","kickoff_note":"new"}` | Kickoff note only | ok — projects ~1: kickoff_note (+updated_at); logs `update_project` | must match |
| `archive` | `{"project_id":"$proj","status":"archived"}` | Archive keeps members | ok — projects ~1: status (+updated_at); logs `update_project` | must match |
| `reopen` | `{"project_id":"$archived","status":"active"}` | Reopen an archived project | ok — projects ~1: status (+updated_at); logs `update_project` | must match |
| `status-unchanged` | `{"project_id":"$proj","status":"active"}` | Status already active | ok — projects ~1: updated_at only; logs `update_project` | approved difference |
| `archive-already-archived` | `{"project_id":"$archived","status":"archived"}` | Status already archived | ok — projects ~1: updated_at only; logs `update_project` | approved difference |
| `title-and-status` | `{"project_id":"$proj","title":"Both","status":"archived"}` | Content and state together | ok — projects ~1: title, status (+updated_at); logs `update_project` | must match |
| `bad-status` | `{"project_id":"$proj","status":"paused"}` | Unknown status | refused (JSON-RPC error): Invalid type: Expected ("active" \| "archived") but received "paused" | must match |
| `empty-title` | `{"project_id":"$proj","title":""}` | Empty title | refused (JSON-RPC error): Expected a non-empty string. | must match |
| `empty-patch` | `{"project_id":"$proj"}` | Only project_id: nothing to change, still logs | ok — logs `update_project` | must match |
| `empty-patch-missing` | `{"project_id":"$noneProject"}` | Empty patch on a missing project | refused (JSON-RPC error): Project not found | must match |
| `missing` | `{"project_id":"$noneProject","title":"x"}` | Project does not exist | refused (JSON-RPC error): Project not found | must match |

### `delete_project`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `with-members` | `{"project_id":"$proj"}` | Members are kept and detached | ok — tasks ~1: project_id (+updated_at); projects −1; logs `delete_project` | must match |
| `empty` | `{"project_id":"$archived"}` | Project without tasks | ok — projects −1; logs `delete_project` | must match |
| `missing` | `{"project_id":"$noneProject"}` | Project does not exist | refused (JSON-RPC error): Project not found | must match |

### `link_tasks`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `blocks-default` | `{"from_task_id":"$pend","to_task_id":"$pend2"}` | Default type is blocks | ok — task_links +1; logs `link_tasks` | must match |
| `blocks` | `{"from_task_id":"$pend","to_task_id":"$pend2","link_type":"blocks"}` | Explicit blocks | ok — task_links +1; logs `link_tasks` | must match |
| `related` | `{"from_task_id":"$pend2","to_task_id":"$pend","link_type":"related"}` | Related with descending IDs | ok — task_links +1; logs `link_tasks` | approved difference |
| `related-ascending` | `{"from_task_id":"$pend","to_task_id":"$pend2","link_type":"related"}` | Related with the other orientation | ok — task_links +1; logs `link_tasks` | must match |
| `existing-blocks` | `{"from_task_id":"$blocker","to_task_id":"$blocked"}` | Link that already exists | ok — logs `link_tasks` | must match |
| `existing-related` | `{"from_task_id":"$rel1","to_task_id":"$rel2","link_type":"related"}` | Related link that already exists | ok — logs `link_tasks` | must match |
| `existing-related-reversed` | `{"from_task_id":"$rel2","to_task_id":"$rel1","link_type":"related"}` | Related link that exists in the other orientation | ok — task_links +1; logs `link_tasks` | approved difference |
| `reverse-blocks` | `{"from_task_id":"$blocked","to_task_id":"$blocker"}` | Would create a two-task cycle | refused (JSON-RPC error): Adding a blocks link from $blocked to $blocker would create a cycle. | must match |
| `self` | `{"from_task_id":"$pend","to_task_id":"$pend"}` | Task to itself | refused (JSON-RPC error): A task cannot be linked to itself. | must match |
| `missing-from` | `{"from_task_id":"$none","to_task_id":"$pend"}` | Blocking task does not exist | refused (JSON-RPC error): task not found: $none | must match |
| `missing-to` | `{"from_task_id":"$pend","to_task_id":"$none"}` | Blocked task does not exist | refused (JSON-RPC error): task not found: $none | must match |
| `done-endpoint` | `{"from_task_id":"$done","to_task_id":"$pend"}` | Done task as an endpoint | ok — task_links +1; logs `link_tasks` | must match |
| `bad-type` | `{"from_task_id":"$pend","to_task_id":"$pend2","link_type":"duplicates"}` | Unknown link type | refused (JSON-RPC error): Invalid type: Expected ("blocks" \| "related") but received "duplicates" | must match |

### `unlink_tasks`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `blocks-default` | `{"from_task_id":"$blocker","to_task_id":"$blocked"}` | Default type is blocks | ok — task_links −1; logs `unlink_tasks` | must match |
| `related` | `{"from_task_id":"$rel1","to_task_id":"$rel2","link_type":"related"}` | Related link | ok — task_links −1; logs `unlink_tasks` | must match |
| `related-reversed` | `{"from_task_id":"$rel2","to_task_id":"$rel1","link_type":"related"}` | Related link given in the other orientation | ok — logs `unlink_tasks` | must match |
| `absent` | `{"from_task_id":"$pend","to_task_id":"$pend2"}` | No such link | ok — logs `unlink_tasks` | must match |
| `wrong-type` | `{"from_task_id":"$blocker","to_task_id":"$blocked","link_type":"related"}` | Link exists with another type | ok — logs `unlink_tasks` | must match |
| `wrong-orientation` | `{"from_task_id":"$blocked","to_task_id":"$blocker"}` | Blocks link in the other orientation | ok — logs `unlink_tasks` | must match |
| `missing-tasks` | `{"from_task_id":"$none","to_task_id":"$none"}` | Neither task exists | ok — logs `unlink_tasks` | must match |
| `bad-type` | `{"from_task_id":"$pend","to_task_id":"$pend2","link_type":"duplicates"}` | Unknown link type | refused (JSON-RPC error): Invalid type: Expected ("blocks" \| "related") but received "duplicates" | must match |

### `update_preference`

| Row | Input | What it exercises | Legacy outcome | Status |
| --- | --- | --- | --- | --- |
| `sort-by` | `{"key":"sort_by","value":"due"}` | Valid key and value; the row is new | ok — user_preferences +1 | must match |
| `overwrite-existing` | `{"key":"planning_prompt","value":"auto"}` | Replace a row the fixture already holds | ok — user_preferences ~1: value | must match |
| `same-value` | `{"key":"planning_prompt","value":"never"}` | Set a row to the value it already has | ok — no writes | must match |
| `each-key-kickoff` | `{"key":"kickoff_nudge","value":"never"}` | Another key and value set | ok — user_preferences +1 | must match |
| `overwrite` | `{"key":"urgency_visibility","value":"hide"}` | A valid value on a key the fixture has not set | ok — user_preferences +1 | must match |
| `bad-value` | `{"key":"sort_by","value":"colour"}` | Value outside the key's set | refused (JSON-RPC error): sort_by must be one of: readiness, due, project. | must match |
| `bad-key` | `{"key":"favourite_food","value":"x"}` | Unknown key | refused (JSON-RPC error): Invalid type: Expected ("sort_by" \| "urgency_visibility" \| "kickoff_nudge" \| "session_log" | must match |
| `internal-key` | `{"key":"last_session_at","value":"2026-10-01T00:00:00.000Z"}` | Internal key | ok — user_preferences +1 | must match |
| `missing-value` | `{"key":"sort_by"}` | No value | refused (JSON-RPC error): sort_by must be one of: readiness, due, project. | must match |

<!-- matrix:end -->
