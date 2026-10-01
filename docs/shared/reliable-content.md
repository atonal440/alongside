# Guarded task and project content edits

`task.content.set` and `project.content.set` extend the v2
protocol with a complete replacement of the entity's conversational text.
They prevent a stale conversation from overwriting a newer user's edit,
including edits through legacy REST/MCP/PWA adapters. A successful write
increments the entity revision, records the before/after content and commits
its receipt, audit and feed together.

Read the row and its version with `get_entity` first. Supply that numeric
`expectedRevision`; never compare display timestamps or silently refresh the
revision after a conflict.

```json
{
  "contractVersion": 2,
  "commandId": "c_editnotes01",
  "actor": "user",
  "commands": [{
    "kind": "task.content.set",
    "id": "t_example",
    "expectedRevision": 3,
    "values": {
      "title": "Draft the proposal",
      "notes": null,
      "kickoffNote": "Start with the outline",
      "sessionLog": "Collected background sources"
    }
  }]
}
```

All value fields are required. Null clears that field; omission does not mean
preserve it in this full-content command. A project uses title/notes/kickoffNote
without sessionLog. Titles trim before hashing; other text retains its content.
Bounds remain title 200, notes/sessionLog 10,000 and kickoffNote 2,000 characters.
Unknown fields are rejected. These commands do not accept clientRef mappings.

Content edits preserve status, dates, recurrence, project membership, task type,
focus, deferral, duty/occurrence identity and creation time. Done tasks remain
done and archived projects remain archived. Managed/lifecycle/graph fields
need their own semantic commands in later increments. The final row passes
the existing domain codec before planning storage.

## Preview, race handling and replay

Preview uses a coherent content/version read and writes nothing. The diff has
`before: {row, revision}` and `after: {row, revision}` with an increment of one;
`refs` is empty. The prepared SQL count is six: entity revision assertion,
receipt, existence guard plus row update, audit and feed. Apply asserts the
revision inside the transactional batch, so another writer winning between
planning and commit aborts the entire command.

Unrelated concurrent edits are allowed: a content edit's only semantic basis
is its entity, so it does not require a workspace structural guard. Its own
write still advances the workspace revision through the storage trigger,
invalidating structural plans that used an older snapshot.

`revision_conflict` includes parsed current row/version data, or a tombstone
when the entity was deleted. Keep the intended text, inspect the difference and
explicitly rebase with a fresh command ID. Semantic rejection and conflict
retention in the offline queue remain later work; these online APIs already
return the diagnostics needed for it.

A timeout or transient storage error must retain the exact command ID/payload.
Replay returns the original committed before/after result after later edits or
deletion, without reapplying it or advancing versions. Changing the payload
under the same command ID conflicts. The receipt is historical execution
information; use `get_entity` to inspect current content.

Entity/aggregate revision exhaustion is durable. If an unrelated writer uses
the final aggregate revision after planning, post-failure diagnostics report
exhaustion rather than recommend endless retries. Failed row/audit/feed work
rolls back receipts and trigger bookkeeping together.

## Rollout boundary

No migration is required; the creation increment's task/project command feed
and the ledger already support these edits. Existing settings/creation results
and receipts continue parsing unchanged. REST/MCP use the same command envelope,
and the PWA API parses versioned before/after rows and conflicts.

The existing PWA queue still uses legacy operations. Broader `reliableCommands`
and `deltaSync` remain false until lifecycle/link/batch commands, consistent
sync, restore epochs and retained offline intent land. This release does not
enable undo: recorded before/after values are groundwork for later guarded
compensating commands, not permission to overwrite intervening work.

This family also composes in [bounded mixed batches](reliable-batches.md),
with grouped compound effects and distinct written identities.
