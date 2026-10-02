# Portable workspace exports

`GET /api/v2/export`, MCP `export_workspace` with `{}` and PWA
`api.exportWorkspace` return a version 2 portable document:

```json
{
  "version": 2,
  "exported_at": "2026-10-01T10:00:00.000Z",
  "tasks": [],
  "projects": [],
  "links": [],
  "duties": [],
  "preferences": [],
  "planning_settings": null,
  "action_log": [],
  "command_audit": []
}
```

The export formats one coherent workspace snapshot, including every current
user-data family and both provenance stores. It performs one database read and
no writes. `exported_at` is the document-generation time. Tasks/projects/links/
duties keep their current IDs, content, scheduling/state fields and timestamps;
preferences retain their typed key/value rows. Planning settings contain only
`timezone`, `bufferMinutes` and complete `workingHours`, or null before setup.
Historical preference choices and the retired `snooze_task` log name survive
without reinterpretation. Historical logs/audit may refer to deleted entities.

Only live entities become portable rows. OAuth codes, credentials, replay
receipts/hashes, sync metadata/cursors, entity revision ledgers and tombstones
remain outside the document. Audit before/after images are user provenance;
they do not contain the receipt's replay result or authorize replay on restore.
Portable planning values omit managed revisions. User-authored contents are
preserved as stored; this export does not redact text.

Both Worker and PWA parse the complete portable document. Identity uniqueness,
row types, planning intervals and live references must agree. Unknown document
or portable row fields are rejected instead of silently discarding future user
data. The source snapshot returns separate D1 rows, so aggregate workspace size
does not hit D1's individual-row/value limit.

## Restoring a version 2 export

`POST /api/v2/restore`, MCP `restore_workspace` and PWA `api.restoreWorkspace`
take `{contractVersion:2, mode, expectedCursor, document}`, where `document` is an
unmodified export and `expectedCursor` is the `{epoch, sequence}` from a current
snapshot (or `previousCursor` of an earlier preflight). Restore **replaces** the
workspace: every task, project, link, duty, preference, planning setting and action
log row is deleted and the document's rows are inserted.

Use it in two steps with identical input:

1. `mode:"preflight"` parses the document, runs the semantic checks (duty
   occurrence pairing/uniqueness, no self-links, acyclic `blocks` graph), builds the
   real SQL plan and counts it. It returns what would be replaced and restored and
   writes nothing.
2. `mode:"apply"` runs the same plan as one atomic D1 batch.

The batch starts with a guard that aborts everything unless the sync metadata is
still at `expectedCursor`, so a writer that commits after preflight (or between the
Worker's read and the batch) produces a 409 `restore_cursor_conflict` and changes
nothing; re-export, review and preflight again. Next it advances the **epoch** by one,
then wipes, then inserts in dependency order. Because the epoch advances before any
row write, all restore feed events belong to the new epoch: every cursor from the
old epoch gets `sync_reset_required`/`epoch_changed` and must re-bootstrap, and
deleted-then-restored identities keep monotonic revisions. The result's
`resultingCursor` is the first cursor of the new epoch.

Results contain `previousCursor`, `resultingCursor` (null for preflight), `nextEpoch`,
`replaces` and `restores` per-family counts, `notRestored`, `requiredStatements`
and `limit:100`. The PWA parser rejects a response whose mode, cursor, restored
counts or audit count differ from the request.

**Boundaries.** A restore is one atomic batch, so it is bounded by the 100-statement
limit (about 80 rows once the guard, epoch, wipe and planning statements are
counted). Larger documents fail with 413 `capacity_exceeded` before any write; they
are never split into wipe-then-chunk. Incoming `command_audit` is validated and
counted in `notRestored.command_audit` but not stored: audit rows reference replay
receipts, which stay local and are not portable. Existing receipts, audit, OAuth
state, entity revisions and tombstones are untouched, so old command IDs keep their
original results. Planning settings get revision `previous + 1`.

Staged restores for larger workspaces, archival storage of incoming audit and v1
input with migration diagnostics remain separate increments; the legacy
`POST /api/import` is unchanged. The PWA does not yet call restore from any UI, and
canonical IDB/offline reconciliation still follows.
