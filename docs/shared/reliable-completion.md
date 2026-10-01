# Reliable completion and stable legacy successors

`task.complete` extends the v2 protocol. It closes a pending task
and, for legacy recurrence, creates exactly one caller-identified successor in
the same transaction. A lost response cannot create another successor: the
receipt returns the original compound result, even after the task is reopened
or either row is deleted.

Read the task with `get_entity`. Supply its numeric revision and the returned
workspace `structuralRevision`. Use a fresh command ID and, for recurrence, a
fresh stable task ID with no live or deleted ledger history:

```json
{
  "contractVersion": 2,
  "commandId": "c_complete001",
  "actor": "user",
  "commands": [{
    "kind": "task.complete",
    "id": "t_example",
    "expectedRevision": 3,
    "expectedStructuralRevision": 12,
    "successor": { "id": "t_successor", "clientRef": "next" }
  }]
}
```

`successor` is required. It must be null for a nonrecurring task and a stable-ID
object for a legacy recurring task; `clientRef` is optional and scoped to this
result. Unknown keys, caller-managed completion times and missing revisions are
rejected. The server records the completion command's event instant in its
receipt/audit and the completed row's `updated_at`. There is no new task
`completed_at` column yet; later edits can change `updated_at`, so query the
historical receipt rather than treat that field as permanent completion history.

## Preserved legacy behavior

Completion requires pending status and clears focus/deferral. It preserves the
completed row's date, recurrence, context, membership and occurrence identity.
The successor follows the existing date-only RRULE from the previous due date,
uses the all-day noon-UTC compatibility representation, and inherits title,
notes, project, task type and recurrence. Its kickoff note is the prior session
log when non-null, otherwise the prior kickoff note. Session log, focus,
deferral and duty/occurrence identity are cleared. Links are not copied.

This is the legacy spawner's reliable entry point, not the future series engine.
No new duty materializer is enabled, and no record is assigned a second spawner.
Reopening still preserves an already-created successor; a subsequent distinct
completion retains the existing legacy policy. The later series migration will
introduce explicit lineage and completion/reopen policies together.

## Atomic preview/apply

Preview is side-effect-free and reuses the completion planner. A one-off diff
contains the versioned task before/after; a recurring result additionally has a
successor creation diff at revision one. The ref map points only to that created
successor. The completion image comes first, then the successor. Existing
single-image results and receipts remain valid.

Apply guards the original task, structural revision and unused successor
identity inside one batch. The structural guard conservatively rejects even an
unrelated intervening workspace write; it also closes changes between the two
coherent entity reads. This protects all assumptions before spawning. Capacity
counts include both rows and feed entries: seven SQL statements for one-off
completion, ten for recurring completion. Receipt, row updates/insertion,
ledger triggers, audit and every feed entry commit together or roll back.

Expected revision failures return `revision_conflict` with `currentEntity`.
Previously used successor IDs also conflict, including retained tombstones;
the error identifies the successor and expected null history. Changed workspace
state returns `structural_conflict` with the current structural revision. An
already-done task returns `invalid_transition`; recurrence/successor mismatch
returns HTTP 400 `invalid_input`. These errors commit no receipt. Preserve
intent and explicitly rebase with a fresh command ID after inspecting state.

Exact replay precedes current-state validation, so the original result remains
available after later changes. Changed payload under the same ID conflicts.
Keep the ID/payload for transient errors; never replace the successor ID merely
because a response was lost. Entity/aggregate exhaustion is durable. A recurring
command needs room for both structural increments and rejects insufficient
capacity before partially completing its original task.

## Rollout boundary

No migration is required. REST/MCP expose `task.complete` through the existing
strict command envelope; the PWA API parses both diff images, revisions and ref
mapping. Result arrays are bounded at two images for this release; mixed command
batches are still rejected. The old task completion adapters remain usable
with their legacy behavior. The old PWA queue is not converted by this change.
Broad reliability/delta gates remain false pending association/deletion/link
commands, bounded graph batches, workspace sync/restore and offline retention.

This family also composes in [bounded mixed batches](reliable-batches.md),
with grouped compound effects and distinct written identities.
