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
and update time. It does not create hard deadlines or availability (use `task.dates.set`), hierarchy (use `task.parent.set`)
constraints or future explicit date-role records. Done tasks remain done. Legacy
completion/spawning behavior is unchanged; no background series engine is enabled.

## Hierarchy

`task.parent.set` places a task under a parent or makes it top level. `parent`
is null or `{id, expectedRevision}`; `position` is a finite number or null (and
is stored as null when `parent` is null). It requires the entity and structural
revisions and counts nine prepared SQL statements.

```json
{
  "kind": "task.parent.set",
  "id": "t_child",
  "expectedRevision": 2,
  "expectedStructuralRevision": 31,
  "parent": { "id": "t_parent", "expectedRevision": 5 },
  "position": 1
}
```

The planner walks up from the new parent through the same reader as every other
command, so inside a mixed batch it sees parents and ancestors created or moved
earlier in that batch. It refuses (as `invalid_transition`, nothing written) a
self parent, a parent in another project, a placement that would make the task
its own ancestor, and a chain deeper than 32 tasks counting the task itself.
The depth check includes the moved task's own subtree (measured level by level).

Rules that depend on subtasks, using the same reader:

- A task with open (pending) subtasks cannot be completed; finish them first,
  or complete children and parent in one batch in that order.
- A task with subtasks cannot be deleted. Project deletion detaches the whole
  subtree together, because a hierarchy always sits in one project.
- A subtask cannot change project on its own, and a task with subtasks cannot
  change project; make it top level (or move the subtree one task at a time
  from the leaves up) first.
- A completion successor of a legacy recurring task starts top level.

The legacy REST routes (complete, project change, delete, project creation with tasks) enforce the same rules with guards inside the same atomic statement or batch, so a subtask attached concurrently cannot slip past a stale read.

`parent_id` has no foreign key (restore inserts rows in one pass), so import and
restore validate the whole document instead: every parent exists, shares the
child's project, and no chain loops or exceeds the depth limit.

Not in this slice: group node roles, an opt-in `all_children_done` completion
policy, cancel cascades, subtree-wide project moves, blocks links between an
ancestor and a descendant, and inherited effective dates.

## Date roles

`task.dates.set` replaces a task's `availableFrom` and `deadline` roles together.
Both values are required; each is null or a point:

```json
{
  "kind": "task.dates.set",
  "id": "t_example",
  "expectedRevision": 4,
  "values": {
    "availableFrom": { "kind": "date", "date": "2026-10-06", "timezone": "America/Los_Angeles" },
    "deadline": { "kind": "instant", "at": "2026-10-09T17:00:00-07:00", "timezone": "America/Los_Angeles" }
  }
}
```

A `date` point keeps its zone: a date `availableFrom` opens at the start of that
local day and a date `deadline` allows completion until the start of the next
local day, never an assumed 24-hour day or `23:59`. An `instant` point is
normalized to minute UTC and keeps the zone it was meant in. A date the zone
skipped entirely (for example 2011-12-30 in `Pacific/Apia`) is refused, and the
window must be non-empty: availability must open strictly before the deadline
boundary. Failures are `invalid_input` with a path under `values`; nothing is
written. The command changes only `available_from`, `deadline` and update time,
may edit a done task, and needs no structural precondition. The target
(`due_date`) is untouched and stays in `task.legacy-schedule.set`; a deadline
earlier or later than the target is kept as entered. It counts six prepared SQL
statements. Loose-intent previews and `update_task` merge a one-role patch into
the stored points. A completion successor of a legacy recurring task starts with
both roles unset, because a deadline names one occurrence.

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
