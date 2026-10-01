# Guarded task membership, type and legacy schedule

`task.project.set`, `task.type.set` and `task.legacy-schedule.set` extend the
v2 protocol to the remaining editable fields used by the current
task UI. They replace specific semantic values, not arbitrary managed patches.
Read the task with `get_entity` and retain its numeric revision before planning.
All commands preserve conversational content, lifecycle, attention, creation time
and duty/occurrence identity unless a field is explicitly listed below.

## Membership and task type

```json
{
  "contractVersion": 2,
  "commandId": "c_membership001",
  "actor": "user",
  "commands": [{
    "kind": "task.project.set",
    "id": "t_example",
    "expectedRevision": 3,
    "expectedStructuralRevision": 12,
    "project": { "id": "p_example", "expectedRevision": 2 }
  }]
}
```

`project` is required: null detaches the task; an object selects a project and
its expected revision. The structural revision guards membership assumptions,
including changes between task/project reads and changes before commit. Selected
project existence/revision and task revision are also asserted in-batch. Assigning
the same project is still an accepted write and advances the task revision.

Membership follows existing compatibility behavior: archived projects may be
selected, and done tasks may change membership. This does not reopen either
entity. It changes only the task's project pointer and update time; neither the
project row nor links are rewritten. Hierarchy/project-consistency rules will
extend this planner when hierarchy lands in Slice 3.

`task.type.set` requires `id`, numeric `expectedRevision` and `taskType` equal to
`action` or `plan`. It changes only task type/update time and needs no structural
precondition. It can edit a done task while preserving done status.

## Legacy schedule compatibility

```json
{
  "contractVersion": 2,
  "commandId": "c_legacydate001",
  "actor": "user",
  "commands": [{
    "kind": "task.legacy-schedule.set",
    "id": "t_example",
    "expectedRevision": 4,
    "values": {
      "dueDate": "2026-10-12",
      "dueAllDay": true,
      "recurrence": "FREQ=WEEKLY"
    }
  }]
}
```

All three values are required. `dueDate` accepts a legacy calendar date or an
explicit offset-bearing instant, normalized to minute UTC. Bare dates keep the
legacy noon-UTC representation. Normalized UTC years must be 0100–9999 to fit
the existing row codec. `dueAllDay` is explicitly true, false or null; null
preserves legacy ambiguity. Classification is never inferred from noon or the
host zone. A bare date with false explicitly represents that noon-UTC instant
as timed; callers should usually use true for date-only intention.

`recurrence` is null or an existing date-only RRULE. Timed recurrence is rejected;
recurrence requires a due date with true/null all-day classification and must
produce a valid next occurrence. Clearing `dueDate` requires both `dueAllDay`
and `recurrence` to be null. Unknown keys, missing values and inappropriate
combinations fail before writes. Final values pass the existing domain codec.

This compatibility command replaces only `due_date`, `due_all_day`, `recurrence`
and update time. It does not create hard deadlines, availability, hierarchy
constraints or future explicit date-role records. Done tasks remain done. Legacy
completion/spawning behavior is unchanged; no background series engine is enabled.

## Atomicity and retained intention

Preview produces a versioned before/after diff without writes. Apply commits its
receipt, mutation, audit/feed and ledger triggers together. Membership counts
nine prepared SQL statements for assignment and seven for detachment; type and
legacy schedule count six. All guards, existence checks and history are included.
Late failures roll back both data and bookkeeping.

Unrelated writes may commit concurrently with type/schedule edits, which depend
only on their own row. Membership uses a conservative structural guard and
rejects unrelated workspace changes too. Selected-project conflicts report that
project's `currentEntity`; structural conflicts include the current aggregate
revision. Task edits/deletion return task revision conflicts, with a tombstone
when deleted. Retain intention and explicitly rebase with a fresh command ID.

Exact ID/payload replay returns the original committed before/after result after
later changes or deletion. Transient errors keep the same ID/payload; changing
payload under an old ID conflicts. Revision exhaustion is durable. Existing
settings, creation, content, state and completion receipts continue parsing.

## Rollout boundary

No migration is required. REST/MCP share command parsing/planning, and the PWA
API parses the same versioned results. This adds online protocol support, not a
conversion of the PWA queue. Deletion/link commands, bounded mixed graph batches,
full workspace sync/restore and retained offline overlays remain subsequent
increments; broad reliability/delta capability gates remain false. Future explicit
date-role writes stay in Slice 3 with their own constraints and provenance.

This family also composes in [bounded mixed batches](reliable-batches.md),
with grouped compound effects and distinct written identities.
