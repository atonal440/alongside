# Revisions across the legacy writer transition

Slice 2c installs revision tracking before enabling reliable task commands.
Legacy task/project/link writes do not yet accept expected revisions, so they
retain their existing behavior. However, every committed task, project, link,
and duty row write now advances a ledger revision and a workspace structural
revision. A future guarded command can detect intervening legacy writes instead
of trusting client timestamps or requiring every writer to have already moved
to the new protocol.

## Storage owns the bookkeeping

Migration 011 creates `entity_versions` and the singleton `workspace_versions`.
SQLite triggers maintain both in the row writer's transaction. This includes
Drizzle's direct insert/update paths, the Plan executor, raw deletes, bulk
project detachment, recurrence-created tasks, v1 replacement imports, and link
foreign-key cascades. No extra Worker-to-D1 round trip performs bookkeeping.
Constraint failures and batch rollback also roll back the versions.

Rows present when tracking is installed start at revision zero. Newly inserted
rows start at one. Every SQL row update advances the revision, even if the
values compare equal; a write that matches no rows advances nothing. The
structural revision conservatively advances on all these row transitions,
including notes/focus changes. It is a conflict guard, not a count of commands,
a calendar revision, or a sync cursor. REPLACE may cause an additional delete
transition when recursive triggers are enabled; callers must treat revisions
as opaque increasing values rather than predict their arithmetic.

Primary identities cannot be updated in place. A link's identity is the JSON
array `[from_task_id,to_task_id,link_type]`, encoded identically by shared code
and SQLite; separator concatenation would be ambiguous. Link endpoint order
continues to have its legacy meaning until the graph command rollout.

Deletion retains the ledger row with an incremented revision and a server UTC
`deleted_at`. This is a deletion record for sync/concurrency, not task soft
delete or historical row content. Recreating the same identity increments its
existing ledger revision and clears `deleted_at`, preventing delete/recreate
from looking like the original revision. V1 import does not clear the ledger.
No automatic tombstone purge is enabled. Deletions from before migration 011
cannot be recovered by this ledger.

The revision CHECKs enforce safe integers. Exhaustion aborts and rolls back the
writer; never reset a counter to make a write succeed. Schema initialization is
repeatable without resetting versions or reviving tombstones. The Drizzle
snapshot models the ledger tables; hand-written SQL additionally owns trigger
programs and backfill. Wrangler applies only numbered `migrations/` files.

## Coherent version lookup

`get_entity_version` and `POST /api/v2/entity-version` accept one strict key:

```json
{"entity":"task","id":"t_example"}
```

Task/project/duty keys use `entity` plus the corresponding prefixed `id`. Links
use `{"entity":"link","from":"t_example","to":"t_another","linkType":"blocks"}`
(or `related`). Unknown keys and query parameters are rejected.

```json
{
  "contractVersion": 2,
  "key": {"entity":"task","id":"t_example"},
  "structuralRevision": 12,
  "version": {"revision": 3, "deletedAt": null}
}
```

The entity and aggregate version come from one SQL statement. `version: null`
means this identity has no recorded history; a non-null `deletedAt` means the
identity is currently deleted. Shared parsers validate inputs and stored/read
outputs; the PWA API client parses the response before returning branded data.
The lookup contains no task/project content and is not a full data snapshot.
Reading a legacy task separately may race: future command planning must acquire
content and its versions together and revalidate inside apply.

## Guarded Plans and transition limits

`entity.revision` asserts the ledger revision, including retained tombstones.
Expected null requires no ledger history, not merely absence from the live
row table. `workspace.structural_revision` asserts the singleton counter, so
inserted/deleted blockers invalidate a structural plan even when none of its
original rows were edited. Both have friendly prechecks and SQL assertions
inside the same D1 batch; only the in-batch check closes the race. The generated
100-statement budget includes one prepared SQL statement for each guard.
Trigger programs execute within those statements; they add row work and must
be considered when budgeting large data operations, but do not add prepared
statements to the Worker batch.

Slice 2c introduced version reads and internal Plan guards.
[Stable creation](reliable-creation.md) now adds single task/project creation
and coherent content/version reads alongside `planning.set`. The full task command protocol,
canonical snapshot/delta feed, import epoch, optimistic IDB overlay, retained
conflict intent and old-client write negotiation remain subsequent Slice 2
increments. `reliableCommands` and `deltaSync` capability gates remain false. *(Superseded: the PWA queue now sends reliable commands and `reliableCommands`/`deltaSync` are true; see [the PWA command queue](../pwa/sync/canonical-workspace.md#reliable-command-queue).)*
Calendar guards must land with their corresponding writers before reservations
are enabled.
