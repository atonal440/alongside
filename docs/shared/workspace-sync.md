# Workspace sync bootstrap

`GET /api/v2/sync/snapshot`, MCP `get_workspace_snapshot` with `{}`, and PWA
`api.workspaceSnapshot` return one consistent view of current user data:

```json
{
  "contractVersion": 2,
  "cursor": { "epoch": 0, "sequence": 0 },
  "structuralRevision": 0,
  "entities": []
}
```

Each entity contains `entity`, `key`, `revision`, `deletedAt` and `row`. The eight
current families are task, project, link, duty, preference, planning_settings,
action_log and command_audit. Deleted identities retain their revision and
non-null deletion timestamp with a null row. An identity absent from the ledger
is never recorded. Link keys are canonical JSON tuples of endpoint IDs and type;
log keys are decimal IDs; settings use `workspace`. Existing live entities may
have revision zero after migration. Settings have a separate sync revision for
the complete settings/hours projection, alongside their reliable command revision.

A single SQL statement reads all source rows, both retained version ledgers,
structural revision and sync metadata together. It returns separate entity query
rows with repeated cursor metadata, avoiding D1's single-row/value size limit.
An empty workspace returns one metadata-only query row. It explicitly projects current
columns so retired upgrade-only columns cannot leak. Both Worker and PWA parse
all families, identity/deletion agreement, unique identities and live references.
Historical logs may reference deleted tasks or duties and retain the retired
`snooze_task` tool name. Read codecs preserve previously advertised preference
values (`sort_by=urgency|manual`, `session_log=manual`,
`interruption_style=minimal`, `planning_prompt=manual`) without rewriting
provenance or widening current write validation. Credentials, OAuth codes,
command receipts and operational metadata are excluded. This is a sync bootstrap,
not a portable backup or restore input.

## Every writer participates

Migration `014_workspace_sync.sql` installs a feed independent of the reliable
command feed. Source task/project/link/duty writes already advance
`entity_versions`; observing those ledger writes avoids depending on SQLite's
ordering of sibling source triggers. Auxiliary rows have a separate retained
ledger. Preferences, settings/hours and both provenance stores advance it on
insert, update and delete. All source rows, ledgers and feed records commit or
roll back together. This covers legacy adapters, reliable commands, direct SQL,
FK cascades and import replacement; no-op writes still advance revisions.

Feed images include full current rows, deletion timestamps, retained revisions
and an import epoch. Settings include the ordered working-hours projection.
Transactions may emit intermediate images of the same identity: the future delta
reader must use its fixed upper watermark and reconcile complete pull results,
not treat each intermediate settings image as a separate user command. A replayed
receipt performs no new writes and emits no new events.

Sequence numbers use a non-reused SQLite allocator bounded to JavaScript's safe
integer range. Sequence or revision exhaustion aborts the whole write, including
outer `OR IGNORE` writers. Missing sync metadata also fails closed. Epoch,
watermark and retention floor are monotonic; metadata cannot be replaced or
deleted. Removing any feed record advances the retention floor conservatively
without removing entity tombstones or receipts. No automatic history purge is
installed. Migration backfills auxiliary revisions at zero without rewriting
source data or inventing historical feed entries; schema reinstallation preserves
existing cursors and feed history.

## Rollout boundary

This increment provides bootstrap and all-writer capture. Fixed-watermark delta
pagination, explicit cursor reset/expiry responses, restore epoch transitions,
canonical IDB state and retained offline intentions follow in separate increments.
`reliableCommands` and `deltaSync` capability gates remain false until the complete
protocol and PWA rollout are ready. The existing PWA queue still uses legacy sync.
