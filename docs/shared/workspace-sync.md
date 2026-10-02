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
Transactions may emit intermediate images of the same identity: the delta
reader uses its fixed upper watermark and clients reconcile complete pull results,
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

Bootstrap and fixed-watermark delta reads now accompany all-writer capture.
Restore epoch transitions, canonical IDB state and retained offline intentions
follow in separate increments.
`reliableCommands` and `deltaSync` capability gates remain false until the complete
protocol and PWA rollout are ready. The existing PWA queue still uses legacy sync.

## Fixed-watermark delta pulls

`POST /api/v2/sync/delta`, MCP `get_workspace_delta` and PWA `api.workspaceDelta`
accept `{cursor, watermark?, limit?}`. Use the cursor from a successful bootstrap
or completed pull. The limit is 1–500, default 100. On the first page omit
`watermark`; on every continuation pass the first page's unchanged watermark
and the latest returned cursor. A watermark must share the cursor's epoch and
cannot precede its sequence.

Results contain `contractVersion`, `from`, `cursor`, `watermark`, `hasMore` and
`changes`. Each change has `sequence` and the same versioned entity image as
bootstrap. Sequences strictly increase; repeated identities may appear with
increasing revisions. Historical feed images, not current rows, populate the
page. Metadata and bounded separate image query rows share one SQL statement,
so large pages also avoid D1's per-row/value limit. Read failures never advance
a cursor or change storage.

Stage every page until `hasMore:false`, then reconcile the complete pull in one
local transaction. A page can split a source transaction, contain intermediate
settings projections or temporarily omit a referenced row. Do not commit a
partial page as a complete canonical workspace. At the end, the cursor equals
the fixed watermark; writes committed after the first page's watermark belong
to the next pull. Per-entity revision/deletion checks still apply to every image.
The PWA API parser additionally verifies response/request cursor, watermark and
limit agreement.

An unusable cursor returns HTTP 409 with `code:"sync_reset_required"`,
`retryable:false` and `syncReset:{reason,currentCursor,retentionFloor}`. Reasons
are `epoch_changed`, `history_expired`, `cursor_ahead` or `watermark_ahead`.
A cursor at the retention floor is valid; one below it is expired. Retention or
an epoch transition between pages also invalidates the continuation. Discard
staged pages, fetch a new bootstrap and rebase retained local intentions before
writing; retrying the same cursor cannot fix the problem. The current cursor in
a reset diagnostic is information, not a substitute for bootstrap contents.

Delta reads now exist, but versioned restore transitions and canonical/offline
IDB integration remain separate rollout increments. The broad `deltaSync` and
`reliableCommands` capability gates remain false until that integration is ready.
