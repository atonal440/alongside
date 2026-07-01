# Stage 6 — REST and MCP Duty Surfaces

Part of `docs/plans/duties.md`. Prerequisites: Stages 1–5. Read
`01-type-system.md`'s WIRE layer first.

## Goal

Expose duties through the worker's two public surfaces — REST (`/api/duties*`)
for the PWA and MCP tools for Claude — using the typed wire specs and plan
builders from earlier stages. Resolve the `docs/mcp-tools.md` drift
(`recurring` task_type, `supersedes` link_type), surface `duty_id` on tasks, and
deprecate task-level `recurrence` input so duties are the one way to make
something recur.

## Context for a cold start

- REST: `worker/src/api.ts` (routing + handlers) parses through typed route specs
  in `worker/src/wire/rest.ts` (`worker/src/wire/rest.ts:71,81` show the task
  create/update bodies referencing `RruleSchema`). Path parsing is spec-driven,
  not regex (type-driven-safety Stage: REST route schemas).
- MCP: `worker/src/mcp.ts` — JSON-RPC dispatch with a tool registry; tool schemas
  described once (`mcp.ts:149` add_task, `mcp.ts:443` recurrence arg cast). Tool
  names are registered in `TOOL_NAMES` (`shared/parse/enums.ts:11`).
- Plan builders `createDutyPlan` / `updateDutyPlan` / `setDutyStatusPlan` /
  `deleteDutyPlan` land in Stage 4; `DB` needs thin methods wrapping them
  (mirroring `DB.addTask` / `DB.updateTask`).
- `DB.completeTask` lost its `next` return in Stage 4 — clean up the readers here.
- **Action-log reality check:** today only **MCP** tools write `action_log`
  entries (e.g. `worker/src/mcp.ts:438-449`); **REST** mutations do *not* —
  `worker/src/api.ts:125` just calls `db.addTask` and returns the row. So duty
  action-logging on REST is **new** behavior, not "mirroring existing policy."
  Decide deliberately: log duty mutations from the MCP tools (parity with other
  MCP tools) and, if REST parity is wanted, add it explicitly. `action_log.duty_id`
  (added in Stage 1) lets a duty entry reference the duty with a null `task_id`.
- **Response-shape reality check:** existing REST endpoints return **raw rows**
  (or arrays of rows), not `{ entity, action_log_entry }` envelopes — the PWA sync
  layer expects rows. Keep duty REST consistent with that (see Step 2), and let
  the MCP tools carry `action_log_entry` the way other MCP tools already do.

## Steps

### 1. DB methods (`worker/src/db.ts`)

`createDuty(input)`, `listDuties(status?)`, `getDuty(id)`, `updateDuty(id, patch)`,
`setDutyStatus(id, status)`, `deleteDuty(id)` — each parses the existing row with
`dutyFromRow`, builds the plan, and `apply`s it, exactly like the task methods.
`createDuty` mints the `MintedDutyId` and may materialize the first occurrence
(Stage 4's `createDutyPlan` option) so a "starting today" duty spawns immediately.

### 2. REST (`worker/src/api.ts` + `worker/src/wire/rest.ts`)

Route specs + handlers:

- `GET  /api/duties?status=active|paused|ended` → `Duty[]` (raw rows, matching the
  existing task-list convention — not an envelope).
- `POST /api/duties` (`DutyCreateBody`: title, notes?, kickoff_note?, task_type?,
  project_id?, rrule, dtstart, `timezone?`, catch_up?) → the created `Duty` row.
- `PATCH /api/duties/:duty_id` (`DutyUpdateBody`: **template fields + `catch_up` +
  `timezone` + `status` only — never `rrule`/`dtstart`**, which are immutable) →
  the updated `Duty` row. A body attempting to set `rrule`/`dtstart` is a
  `validation`/`409` rejection pointing the caller at `end_duty` + `create_duty`.
- `DELETE /api/duties/:duty_id` → `{ deleted: true, duty_id }` (matching the
  existing delete convention).

Bodies reference the shared brands (`SeriesRruleSchema`, `IsoDateTimeSchema`,
`TimezoneSchema`, `DutyStatusSchema`, `CatchUpPolicySchema`) so malformed input is
a `validation` error at the edge. Add `duty_id` + `occurrence_at` to the task REST
payloads (read-only, nullable). Route status changes through `setDutyStatusPlan`
so illegal transitions map to `409`/`invalid_transition`.

### 3. MCP tools (`worker/src/mcp.ts`)

Add and register (`TOOL_NAMES`) these tools, each with a JSON-schema arg spec and
an action-log entry:

- `create_duty` — title (req), notes, kickoff_note, task_type, project_id,
  rrule (req, `SeriesRrule`), dtstart (req, UTC ISO datetime), `timezone?` (IANA
  anchor zone for wall-clock-stable recurrence; omit for UTC), catch_up
  (`next`|`all`, default `next`). Returns the created duty; if it materialized a
  first instance, include it.
- `list_duties` — `status?`. Returns `{ duties }`.
- `update_duty` — `duty_id` (req) + editable fields: template fields, `catch_up`,
  `timezone`. **`rrule`/`dtstart` are not editable** — attempting them is rejected
  with "reschedule by ending this duty and creating a new one." A `timezone`
  change re-anchors future occurrences only.
- `pause_duty` / `resume_duty` / `end_duty` — `duty_id`. Thin wrappers over
  `setDutyStatusPlan`. `resume_duty` on an `ended` duty is rejected ("ended series
  can't resume — create a new duty").
- `delete_duty` — `duty_id`. Hard delete; **orphans instances** (keeps the tasks,
  nulls their `duty_id` *and* `occurrence_at`) and stops future spawns — the
  decided behavior (`00` "Decided"). Tool description: "Deleting a duty stops
  future spawns; already-created tasks remain as standalone tasks."
- Tool descriptions must teach the model the model: a duty is a template + a
  schedule; instances appear automatically; completing an instance does not
  affect the schedule.

Optionally add `show_duties` (an App widget, mirroring `show_tasks`) — but this
can slip to Stage 8/9; mark it optional.

### 4. Deprecate task-level recurrence input

Recurrence now belongs to duties. On the task write surfaces:

- `add_task` / `update_task` (MCP `mcp.ts`) and the REST task create/update
  bodies (`wire/rest.ts:71,81`): **reject** a non-null `recurrence` with a
  `validation` error that points the caller at `create_duty`
  ("Recurring tasks are now Duties — use create_duty"). Do not silently create a
  duty behind the caller's back; be explicit.
- Keep *reading* `recurrence` on tasks (legacy column still exists until Stage
  10) so existing rows render, but no new task write may set it.
- Remove the recurrence arg from the `add_task`/`update_task` JSON schemas and
  their docs so the model stops offering it.

### 5. Clean up the `completeTask` readers

Now that Stage 4 removed the recurrence spawn, update the MCP `complete_task`
and REST complete handlers to drop the `next` field from their responses (or keep
it always-absent for one release and note the removal). Update
`docs/mcp-tools.md`'s `complete_task` accordingly.

### 6. Export / import (don't lose duties)

Duties must round-trip through the export/import pipeline or a backup restore
silently drops every recurring schedule. Today the payload covers only
projects/tasks/links/preferences/action_log (`worker/src/db.ts` `exportAll` and
`worker/src/wire/importPayload.ts:84-88`). Extend both:

- Add `duties: v.array(DutyRowSchema)` to `ExportPayload` and the import schema
  (`ImportV1Schema`); include duties in `exportAll`.
- `planImport` must insert **duties before tasks** (tasks' `duty_id` FK references
  duties) and validate each duty through `dutyFromRow`. Preserve the existing
  wipe-then-restore ordering and the pre-wipe integrity check.
- Version the payload (bump `version`) if the import schema is versioned; a v1
  payload without `duties` imports as "no duties," which is correct.
- Tests: export→import round-trip preserves duties and their instances'
  `duty_id`/`occurrence_at`; an import with a duty a task references but that is
  missing is rejected; a legacy (duty-less) payload still imports.

### 7. Resolve the documented drift

- `docs/mcp-tools.md`: remove the phantom `task_type: 'recurring'` (it never
  existed in schema) and either remove `link_type: 'supersedes'` or file it as a
  separate future item — it is **not** part of duties; do not implement it here.
  Replace the recurrence prose in `add_task`/`complete_task` with the duties
  model and a pointer to the new duty tools.
- Add a full "Duties" section to `docs/mcp-tools.md` documenting every new tool,
  and a "Duty Object Shape" block. Update the tool count in the header
  (`docs/mcp-tools.md:3` says "18 tools").
- Update `docs/api.md` with the `/api/duties*` endpoints and the new task fields.

### 8. Tests (`worker/test/`)

- REST: create/list/patch/delete duty happy paths; malformed rrule/dtstart/status/
  timezone → 4xx `validation`; a PATCH attempting `rrule`/`dtstart` → rejected;
  pause→resume→end transitions; resume-ended → 409; delete orphans instances
  (tasks survive with `duty_id` *and* `occurrence_at` nulled).
- MCP: each tool dispatches and validates; duty mutations write an
  `action_log` entry (with `duty_id`); `add_task`/`update_task` with `recurrence`
  → rejection pointing at `create_duty`.
- Import/export: duty round-trip (Step 6).
- Regression: `complete_task` on any task returns no `next`.

## Acceptance criteria

- `npm --prefix worker run typecheck` / `test` pass; REST + MCP duty suites green.
- `cd worker && wrangler deploy --dry-run` passes.
- `curl` smoke (from `AGENTS.md` pattern): `POST /api/duties` creates a duty;
  `tools/list` includes the duty tools; `add_task` with `recurrence` is rejected.
- `docs/mcp-tools.md` and `docs/api.md` reflect duties and no longer reference the
  phantom `recurring`/`supersedes` values; tool count updated.
- Root `npm run verify` passes.
- Check off Stage 6 in the implementation todo; record the delete-orphans decision.
