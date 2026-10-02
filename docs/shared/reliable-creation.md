# Stable task and project creation

Slice 2d's first increment extends `preview_changes`/`apply_changes` with one
`task.create` or `project.create` command. Callers mint the entity ID before
submitting it, so a retry or offline reference does not depend on a temporary
ID later being replaced by the server. A caller command ID and permanent
receipt distinguish replay from a new intention. `planning.set` continues to
work with its original envelope/results.

This is a narrow transition: creation is reliable, while lifecycle changes, link commands, mixed graph batches, workspace delta sync
and the optimistic IDB command overlay remain later increments. Broader
`reliableCommands` and `deltaSync` capability gates stay false, and the existing
PWA task queue continues using legacy operations. *(Superseded: the PWA queue now sends reliable commands and `reliableCommands`/`deltaSync` are true; see [the PWA command queue](../pwa/sync/canonical-workspace.md#reliable-command-queue).)*

## Read the planning basis together

`get_entity` and `POST /api/v2/entity` take `{entity: "task"|"project", id}`.
They return the current row, its ledger version and the workspace structural
revision in one SQL snapshot. A missing identity has null `row` and `version`;
a deleted identity has null `row` and a version with `deletedAt`. A live row
has a version whose `deletedAt` is null. Parsers enforce this pairing and ID
agreement. Unlike reading a legacy row and its version in separate requests,
this read cannot attach a newer revision to older content.

For creation, read the caller-minted identity and use its structural revision.
`expectedRevision: null` requires **no ledger history**, including tombstones;
creation does not resurrect a deleted ID. Only replay of the original command
returns its original creation result. To create different work, mint a new
entity ID and command ID.

```json
{
  "contractVersion": 2,
  "commandId": "c_capture01",
  "actor": "llm",
  "reason": "Capture the proposed work",
  "commands": [{
    "kind": "task.create",
    "id": "t_capture01",
    "clientRef": "draft",
    "expectedRevision": null,
    "expectedStructuralRevision": 12,
    "values": {
      "title": "Draft the proposal",
      "notes": null,
      "kickoffNote": "Start from the outline",
      "taskType": "action",
      "project": null
    }
  }]
}
```

Standalone envelopes contain one command; creation also composes in
[bounded mixed batches](reliable-batches.md). All value fields shown are
required; null explicitly represents no notes, kickoff note or project. A task
creates in pending status with no dates, recurrence, deferral, focus or duty
identity. Those fields are not arbitrary creation patches. Explicit date roles
remain Slice 3 work; legacy date/recurrence creation stays available through
legacy adapters. A project uses the same title/notes/kickoffNote fields and
creates in active status, without taskType/project.

To assign a new task to an existing project, provide
`project: {id: "p_example", expectedRevision: 3}` from a coherent project read.
Planning rejects missing/changed projects and changes between the creation and
project snapshots. Apply guards that project revision/existence and the
workspace structural revision inside the transaction. The structural guard is
conservative: even an unrelated legacy notes edit can require rebase. This
prioritizes correctness while more specific graph commands are introduced.

Task/project IDs use their existing prefixed shared parsers. An optional
`clientRef` is 1–64 ASCII letters/digits/underscore/hyphen, starting with a
letter; constructor/prototype and prototype-mutating keys are reserved.
Results return `{clientRef: stableId}` in `refs`. This map is scoped to the
single command, not a global registry or cross-command graph reference syntax.
Titles trim on input before hashing; notes/kickoff text retains its content.

## Atomic creation and original-result replay

A preview writes nothing. It returns a diff with `before: null` and
`after: {row, revision: 1}`, stable ID/ref mapping, hash and exact prepared SQL
count. An unassigned task/project requires six statements: identity and
aggregate guards, receipt, row insert, audit and command feed. A project-bound
task additionally requires project revision and existence guards (eight).
Trigger programs advance versions inside the row insert's transaction.

Apply revalidates and commits all of these in one batch. Same command ID and
canonical payload returns the original receipt, even after a later legacy edit
or deletion. The receipt is an execution result, not a claim about the current
row; use `get_entity` for current content. A lost response or concurrent
identical execution never inserts again or advances versions again.

Same command ID with a different payload returns `command_id_conflict`.
An already-recorded entity identity returns `revision_conflict`; a changed
workspace returns `structural_conflict`. Errors include parsed current content/
versions and the expected revision where relevant. Retain the intention,
inspect current state and explicitly rebase with a fresh command ID; never
silently replace versions. Exhaustion is durable; transient storage failures
retain the original ID/payload for retry. The PWA API parses these errors,
although offline retained-intent handling is still a later increment.
[Guarded content edits](reliable-content.md) extend the protocol with
revision-checked conversational text replacement; creation itself is unchanged.

## Feed compatibility and rollout

Migration 012 expands the existing command feed to settings, tasks and projects.
It preserves existing rows and the sequence allocator, even if historical
entries were manually removed. No settings receipts/results are rewritten.
Creation records and audit commit with their receipts. The feed still omits
legacy writers and is not a public delta endpoint or full sync cursor; that
coverage must land before delta sync is advertised.

Legacy v1 export/import retains its scope. It does not export or clear replay
receipts. A replay after a restore still returns its historical execution
result and does not resurrect a missing task. Full workspace export/import,
restore epochs, old-client write negotiation and retained offline intention
remain required before treating all task workflows as reliable.
