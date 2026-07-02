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
- `DB.completeTask` lost its `next` return in Stage 4 (its readers in
  `api.ts`/`mcp.ts` were minimally patched there to keep typecheck green) —
  finalize the outward response shapes and docs here (Step 5).
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
  existing task-list convention — not an envelope). Runs the lazy `ensureDutiesFresh`
  gate first (Stage 5) so a duty due-but-not-yet-spawned is materialized before the
  list is served (else it shows a stale past `next_occurrence_at`).
- `POST /api/duties` (`DutyCreateBody`: title, notes?, kickoff_note?, task_type?,
  project_id?, rrule, dtstart, `timezone?`, catch_up?) → the created `Duty` row.
- `PATCH /api/duties/:duty_id` (`DutyUpdateBody`: **template fields + `catch_up` +
  `status` only — never `rrule`/`dtstart`/`timezone`**, the whole series anchor is
  immutable) → the updated `Duty` row. A body attempting to set
  `rrule`/`dtstart`/`timezone` is a `validation`/`409` rejection pointing the
  caller at `end_duty` + `create_duty`.
- `DELETE /api/duties/:duty_id` → `{ deleted: true, duty_id }` (matching the
  existing delete convention).

Bodies reference the shared brands (`SeriesRruleSchema`, `IsoDateTimeSchema`,
`TimezoneSchema`, `DutyStatusSchema`, `CatchUpPolicySchema`) so malformed input is
a `validation` error at the edge. **Loose-parse trap:** the wire specs use valibot
`v.object`, which *strips* unknown keys — so merely omitting
`rrule`/`dtstart`/`timezone` from `DutyUpdateBody` would silently *ignore* an
attempted anchor edit, not reject it. To make the promised rejection real,
explicitly forbid those keys on update (e.g. check the raw body for them before
parsing, or include them in the schema as always-failing fields) — and do the
same in the MCP `update_duty` arg parser. Add `duty_id` + `occurrence_at` to the
task REST payloads (read-only, nullable). Route status changes through
`setDutyStatusPlan` so illegal transitions map to `409`/`invalid_transition`.

### 3. MCP tools (`worker/src/mcp.ts`)

Add and register (`TOOL_NAMES`) these tools, each with a JSON-schema arg spec and
an action-log entry:

- `create_duty` — title (req), notes, kickoff_note, task_type, project_id,
  rrule (req, `SeriesRrule`), dtstart (req, UTC ISO datetime), `timezone?` (IANA
  anchor zone for wall-clock-stable recurrence; omit for UTC), catch_up
  (`next`|`all`, default `next`). Returns the created duty; if it materialized a
  first instance, include it.
- `list_duties` — `status?`. Returns `{ duties }`.
- `update_duty` — `duty_id` (req) + editable fields: template fields, `catch_up`.
  **`rrule`/`dtstart`/`timezone` are not editable** (the whole series anchor is
  immutable) — attempting any is rejected with "reschedule by ending this duty and
  creating a new one."
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

### 4. Deprecate task-level recurrence input — but don't break the in-flight PWA

Recurrence now belongs to duties. The two write surfaces must be treated
**differently**, because rejecting a field the deployed PWA still sends is a
transition hazard (`duties/03`, State D): the pre-Stage-8 `EditView` still exposes
a recurrence selector, `parseTaskForm` still sends non-null `recurrence`, and
**offline pending ops created before Stage 8 would become durable 4xx failures and
be dropped** if the worker starts hard-rejecting.

- **MCP `add_task`/`update_task` (safe to reject now).** MCP callers are the model,
  not an offline queue. Remove `recurrence` from the tool JSON schema and reject a
  non-null `recurrence` with a `validation` error pointing at `create_duty`
  ("Recurring tasks are now Duties — use create_duty").
- **REST task create/update (must tolerate through the transition).** Do **not**
  hard-reject `recurrence` here while a recurrence-sending PWA is deployed. Handle
  it **idempotently, keyed on `duty_id`** (the old PWA edit form re-sends the task's
  existing `recurrence` on *every* save, including for tasks already backfilled
  with a `duty_id`):
  - task has **no `duty_id`** (an unattached legacy recurring task) → transparently
    **create/attach a duty** so the user's intent is preserved. This is the one
    place we auto-create a duty — justified because the caller is a legacy client
    mid-migration, not an explicit API user. **Seed it exactly like the Stage 4
    backfill** (share that helper): `dtstart` = the task's `due_date`, cursor =
    `due_date` only if it is an occurrence of the anchored rule, else null cursor +
    `next_occurrence_at = firstOcc` (`04` INV-B). Naive `last_spawned_at = due_date`
    seeding fails `dutyFromRow` for an off-calendar `due_date` and turns the
    tolerated write into exactly the durable 4xx this path exists to prevent.
  - task **already has a `duty_id`** (it's a duty instance) → the `recurrence` field
    is a **no-op** (ignore it; do not create a second schedule). Editing an existing
    instance must not spawn a duplicate duty.
- Keep *reading* `recurrence` on tasks (legacy column exists until Stage 10) so
  existing rows render.

**Sequencing.** The clean end-state (REST also rejects task recurrence) lands only
once no deployed client sends it *and* pre-existing pending ops have drained:
Stage 8 removes the PWA recurrence field, and **Stage 10** removes the REST
tolerance alongside dropping the legacy column (same rollout criterion). Stage 6's
REST tolerance and Stage 8's field removal must not leave a window where the worker
rejects what a client still sends.

### 5. Clean up the `completeTask` readers

Now that Stage 4 removed the recurrence spawn, update the MCP `complete_task`
and REST complete handlers to drop the `next` field from their responses (or keep
it always-absent for one release and note the removal). Update
`docs/mcp-tools.md`'s `complete_task` accordingly.

### 6. Export / import (moved to Stage 4)

The duty export/import + `wipe` extension **has moved to Stage 4**, because it
cannot wait for Stage 6: the Stage 4/5 cut-over creates active duties (State C), so
from that moment a backup export that omits duties **silently drops every recurring
schedule**, and an import wipe that skips duties FK-fails or leaves stale rows. It
must ship with the backfill. See Stage 4 §5b and `03` State C.

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
  timezone → 4xx `validation`; a PATCH attempting `rrule`/`dtstart`/`timezone` →
  **explicitly rejected with a 409/validation error** (assert the response, not
  just that the anchor didn't change — the loose body parse would silently strip);
  pause→resume→end transitions; resume-ended → 409; delete orphans instances
  (tasks survive with `duty_id` *and* `occurrence_at` nulled).
- MCP: each tool dispatches and validates; duty mutations write an
  `action_log` entry (with `duty_id`); **MCP** `add_task`/`update_task` with
  `recurrence` → rejection pointing at `create_duty`.
- Recurrence compat (Step 4): **REST** `add_task` with `recurrence` does **not**
  4xx — it transparently creates a duty (verify the duty exists and the task is its
  instance); an offline pending op carrying `recurrence` flushed against this stage
  succeeds rather than becoming a durable failure; an **off-calendar** `due_date`
  (due Monday under `BYDAY=FR`) still upgrades cleanly (backfill-style seeding —
  null cursor, `next_occurrence_at = firstOcc`), not a 4xx.
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
