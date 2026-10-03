# Bounded mixed command batches

V2 preview/apply now accept 2–20 creation, content, attention/state, membership,
type, legacy-schedule and link commands in one envelope. A mixed envelope
requires `expectedStructuralRevision`; every graph command inside it uses that
same base structural revision. Standalone commands retain their existing shapes
and forbid the envelope-level revision. Settings remain standalone; completion and deletion include their derived
effects in grouped mixed results.

## Planning a batch

Create referenced projects/tasks earlier in the command array. Clients choose
stable IDs in advance and pass those IDs to later commands. Unique scoped
`clientRef` values map to created IDs in the combined result; they do not serve
as implicit substitutions in other input fields. Selected-project revisions
refer to its state after preceding commands: a newly created project has
revision 1; an existing project edited earlier has its next revision.

Several commands may write one task or project (same-identity composition).
They apply in declared order to the planner's virtual state and commit as one
net change: the identity's original before image, its final after image, a
single SQL guard on the first command's expected revision, and a single revision
step. A later command on that identity names the revision after the first write:
current + 1 for an existing entity, 1 for one created in the batch, however many
commands precede it. So a dated task is `task.create` followed by
`task.legacy-schedule.set` with `expectedRevision: 1`, and a title-and-due-date
edit of an existing task at revision 4 is `task.content.set` at 4 followed by
`task.legacy-schedule.set` at 5. Their SQL merges into one statement per
identity, with projects inserted before tasks that name them whatever the
declared order.

Not composable, and rejected before any write: a link written twice; deleting
an identity that the same batch created; any write after a delete; and an
identity that a delete's lifecycle effect also writes (a detached member or
cascaded link). Read-only references may refer to an entity that another
command changes. Duplicate clientRefs, missing guards and unsupported compound
families are explicit validation errors.

Two tasks and an edge can be created together:

```json
{
  "contractVersion": 2,
  "commandId": "c_batch01",
  "actor": "user",
  "expectedStructuralRevision": 12,
  "commands": [
    {
      "kind": "task.create", "id": "t_first1", "clientRef": "first",
      "expectedRevision": null, "expectedStructuralRevision": 12,
      "values": {"title": "First", "notes": null, "kickoffNote": null,
        "taskType": "action", "project": null}
    },
    {
      "kind": "task.create", "id": "t_second", "clientRef": "second",
      "expectedRevision": null, "expectedStructuralRevision": 12,
      "values": {"title": "Second", "notes": null, "kickoffNote": null,
        "taskType": "action", "project": null}
    },
    {
      "kind": "link.add", "from": "t_first1", "to": "t_second",
      "linkType": "blocks", "expectedRevision": null,
      "expectedStructuralRevision": 12
    }
  ]
}
```

## Final graph and atomic storage

The planner simulates distinct writes in declared order through the existing
semantic planners. Snapshot reads must share the original aggregate revision;
virtual revisions describe proposed prefix effects only. SQL revision guards
use the original ledger values, including null guards for new identities.
References to new entities rely on ordered inserts and foreign keys rather
than an existence guard that would reject them before insertion.

Blocks-cycle validation uses the resulting graph: it subtracts removals and
includes all new edges. Reversing an edge is therefore valid in either declared
add/remove order when the final graph is acyclic. Canonical related additions
can similarly replace a reversed legacy identity in one batch. The planner
still validates each removed edge's actual identity/revision. Storage executes
edge removals first, keeps remaining mutations in declared order, and runs
blocks guards after all staged edges inside the transaction. No intermediate
state escapes the atomic batch.

A mixed result adds `batch: true`, contains one diff per written identity in
command order, and includes every scoped reference. Existing standalone receipts
remain readable. One receipt, one audit entry and every feed image commit with
all mutations and final guards. Same ID/payload returns the original combined
result after lost responses, concurrent identical calls or later deletion;
different payloads conflict.

Generated SQL—including deduplicated guards, existence checks, final graph
checks and all feed images—must fit 100 statements. Preview reports the actual
count. Oversized preview/apply returns versioned HTTP 413 `capacity_exceeded`
with exact `requiredStatements` and `limit`; nothing is partially applied or
silently chunked. A 20-command envelope can exceed capacity, so command count
alone is not sufficient acceptance.

Stale graph/entity diagnostics identify the actual command index and contain
stored current images, never uncommitted virtual images. Preserve the complete
intent, inspect current state, and explicitly rebase with a new command ID.
Semantic failures and cycles are durable; network/storage failures keep the
same ID and payload for replay. Preview writes nothing and is not a lock.

No migration or capability gate changes accompany this increment. The legacy
PWA queue remains usable; compound lifecycle batches, workspace sync/restore,
retained offline overlays and capability negotiation follow.

## Compound lifecycle effects

Completion and task/project deletion now also compose in mixed batches.
Settings remain standalone. Existing transition rules, stable recurrence
successor IDs, deletion identity and duty-ownership rejection still apply.
Identities written by a delete's lifecycle effect stay write-once: editing a
project member and then detaching it through project deletion is rejected
before writing. Completing a task and then editing it composes like any other
pair.

New mixed results include `changeGroups`, one positive image count per command
in declared order. Counts cover the flat `changes` array exactly. For example,
`[2,1]` can describe completion plus successor followed by an unrelated edit,
or task deletion plus link tombstone followed by an unrelated edit. Each group
must independently satisfy the standalone result contract, including complete
field preservation for project-detached members and completed tasks. Completion
also checks successor inheritance, the next legacy recurrence date, cleared
session state and server timestamps. Groups retain boundaries even
when the whole result has more images than input commands.

A composed result has no `changeGroups`. It carries `commandChanges` instead: for
each command in declared order, the ascending indexes into `changes` it
contributed to. Some change must be shared by two commands (otherwise the batch
was not composed and uses `changeGroups`), every change must be named, and a
composed result may hold a single change. Per-command standalone checks do not
apply to a composed result; the flat identity and revision rules do. The worker
and the shared codec deploy together, and the PWA needs the new codec only
before it sends composed commands.

Receipts from the first mixed-batch release, which lack `changeGroups`, remain
readable for simple non-lifecycle images. New lifecycle results require grouped
provenance. Scoped reference uniqueness covers both creation and recurring
successor refs. A recurring successor may be linked by a later command using
its stable ID without a second creation.

Lifecycle planning overlays prefix effects on coherent bounded source reads.
An explicitly removed incident edge is omitted from a later task cascade;
an explicitly moved member is omitted from a later project detachment. Shared
cascade edges are deleted once when their endpoints are both deleted. Every
result image advances its entity and the aggregate once. Each lifecycle scope
must pass its existing bounded planner, then the complete combined plan must
fit 100 generated statements including all derived feed images and final guards.
A 29-member project deletion plus unrelated type change uses 98 statements;
30 members use 101 and are rejected atomically.
