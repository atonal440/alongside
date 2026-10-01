# Reliable task and project deletion

`task.delete` and `project.delete` use the v2 command envelope with a stable
command ID, numeric `expectedRevision`, and `expectedStructuralRevision`.
Read the target with `get_entity` / `POST /api/v2/entity` before planning.
Preview returns the entire affected diff without writes. Apply commits the
same semantic effects, revision guards, receipt, audit and feed atomically.

```json
{
  "contractVersion": 2,
  "commandId": "c_delete1",
  "actor": "user",
  "commands": [{
    "kind": "task.delete",
    "id": "t_first1",
    "expectedRevision": 3,
    "expectedStructuralRevision": 12
  }]
}
```

Deleting a task removes its incident blocks/related edges through the existing
foreign-key cascade. The target deletion comes first in the result, followed
by every deleted edge with its exact identity and before image. This includes
legacy reversed related edges. Endpoints other than the deleted task survive;
recurring tasks do not generate a successor on deletion.

Deleting a project preserves its tasks and their links, detaches each member
by setting `project_id: null`, and updates member display timestamps using the
command's `serverNow`. The project deletion comes first in the diff, followed
by every detached task's complete before/after image. Other task fields and
terminal states are preserved. Projects that still own duties return a durable
`invalid_transition`; reliable duty reassignment belongs to the duty rollout.
The command does not erase or silently reassign duty ownership.

## Coherent effects and bounds

One SQL snapshot covers the target, revisions, structural counter, incident
edges or project members, their ledger versions, and duty ownership. It counts
all effects and reads at most 94 images. The planner rejects oversized scope
before expanding operations or issuing a batch. Task deletion requires
`7 + incidentEdges` generated SQL statements. Project deletion requires
`7 + 3 * members`; each member has an existence guard, update and feed image.
Thus 93 incident edges or 31 project members fit the current 100-statement
budget. The next edge/member exceeds it.

REST returns HTTP 413 with a versioned `capacity_exceeded` error containing
exact `requiredStatements` and `limit: 100`. MCP exposes the same parsed error
through `isError` and `structuredContent`. Retain intent and inspect the scope;
never turn one atomic deletion into silently chunked deletes.

Entity and structural guards execute inside the transaction. A concurrent
member, edge, endpoint or other tracked structural write invalidates the
planned graph, including changes absent from the preview. The structural
counter must have room for every cascade/detachment plus the target, and every
affected entity revision must have room for its next version. Exhaustion is a
durable error; counters never reset. Late failures roll back rows, tombstones,
structural revisions and all provenance together.

## Results, conflicts and replay

Deleted task/project/link images use `after: {revision, deleted: true}` and a
live `{revision, row}` before image. Detached tasks use complete before/after
rows with one revision increment. Diffs preserve the data needed for future
compensating operations but do not enable undo yet. Storage deletion timestamps
come from retained ledger records, readable with `get_entity`/`get_link`.

Successful receipt replay returns the original complete result, even after
later writes or endpoint deletion. Same ID with different payload returns
`command_id_conflict`. A stale target returns `revision_conflict` with
`currentEntity`, including retained deletion history; a stale aggregate returns
`structural_conflict` with current values and expected structural revision.
Retain the deletion intent, inspect all affected rows, and explicitly rebase
with a fresh command ID. No timestamp-based overwrite occurs.

No schema migration is needed: migration 013 already supports deletion feed
images and the existing ledger tracks cascades. Legacy PWA writes remain
usable. Bounded mixed graph batches, workspace sync/restore and retained
offline overlays follow; broad reliability/delta gates remain disabled.
