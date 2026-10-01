# Guarded focus, deferral and project state

The v2 command endpoint now supports `task.focus.set`, `task.defer.set`,
`task.reopen`, `project.archive` and `project.reopen`. These commands add
receipt-backed concurrency protection to existing transitions; they do not
change the legacy recurrence or readiness model. Read the entity with
`get_entity`, retain that numeric revision, and send exactly one command in
the existing v2 envelope.

```json
{
  "contractVersion": 2,
  "commandId": "c_focus001",
  "actor": "user",
  "commands": [{
    "kind": "task.focus.set",
    "id": "t_example",
    "expectedRevision": 3,
    "focusedUntil": "2026-10-05T18:22:00Z"
  }]
}
```

## Inputs and transition effects

Every command requires `kind`, `id` and `expectedRevision`. Unknown keys,
managed-field patches, client references and missing required values are
rejected. Additional input and behavior:

| Command | Additional input | Effect |
| --- | --- | --- |
| `task.focus.set` | Required `focusedUntil`: explicit instant or null | Non-null focus clears deferral; null clears only focus. Pending tasks only. |
| `task.defer.set` | Required `defer`: `{kind:"none"}`, `{kind:"someday"}` or `{kind:"until",until:<instant>}` | Active deferral clears focus. `none` clears deferral and preserves focus. Pending tasks only. |
| `task.reopen` | None | Done or deferred pending tasks become pending with no deferral/focus. |
| `project.archive` | None | Active project becomes archived; its tasks and links stay intact. |
| `project.reopen` | None | Archived project becomes active; its tasks and links stay intact. |

Focus and timed deferral accept offset-bearing ISO instants, normalized to
minute UTC before hashing/storage. Bare dates and unzoned wall times are
rejected; use `resolve_time` to resolve local intent first. Past instants remain
valid under the existing expiry/readiness semantics. No timer or notification
is scheduled. The resulting row must also fit the existing task-row codec.

Setting a pending task's existing focus/deferral value is an accepted write and
advances its revision. Already active/archived projects cannot be reopened/
archived respectively; reopening an ordinary pending task is also rejected.
These invalid transitions return HTTP 409 `invalid_transition` with parsed
`currentEntity`, `retryable:false` and a recovery hint. They commit no receipt.
A stale entity revision takes precedence over transition validation.

Task commands preserve title/context, project membership, task type, due date,
recurrence, duty/occurrence identity and creation time. Reopening a completed
legacy recurring task preserves its already-created successor. It neither
retracts that successor nor changes the legacy policy if the task is completed
again. Reliable completion and explicit successor identity follow separately;
this increment does not introduce a new recurrence engine.

## Atomicity, conflicts and replay

A coherent row/version read supplies the planner's before image. Preview
returns one versioned before/after diff and writes nothing. The six generated
SQL statements cover the entity revision guard, receipt, existence guard/row
update, audit and command feed. Apply checks the expected revision inside the
same transaction, so an intervening legacy or reliable writer aborts the
command without a partial state change. Storage triggers advance entity and
workspace revisions together.

These transitions depend on their own row and do not require a structural
precondition. Unrelated changes may commit concurrently. Archive affects how
members are viewed, but does not enumerate or mutate their rows. Graph and
membership changes will use structural guards in subsequent increments.

A conflict returns `currentEntity`, including a retained tombstone after
deletion. Preserve the intended change and explicitly rebase with a new command
ID; never silently update its expected revision. Entity/aggregate exhaustion
is durable, including exhaustion by an unrelated writer during the race window.

A lost response or transient error retains the original command ID/payload.
Replay returns the exact committed before/after result after later edits or
deletion, without reapplying the transition. Another payload under the same ID
conflicts. Equivalent offset/second representations that normalize to the same
minute have the same canonical payload. Receipts describe historical execution;
read `get_entity` for current state.

## Rollout boundary

No migration is required. Existing settings, creation and content commands and
stored results continue parsing. REST and MCP share planners and wire schemas;
the PWA API parses new command results and transition/conflict diagnostics.
The PWA queue still uses legacy operations. Broad `reliableCommands` and
`deltaSync` remain false pending completion/deletion/graph batches, workspace
sync/restore and retained offline intention. Future task statuses, terminal
timestamps and soft deletion belong to their planned later slice.
