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

## Rollout boundary

This increment provides coherent full-data export. Version 2 restore, semantic
import preflight, archival audit storage, import-epoch transitions and retained
local-intent reconciliation follow in subsequent increments. Do not send a v2
export to the legacy import endpoint. Existing v1 export/import remains available;
the next restore increment will retain v1 input with migration diagnostics.
