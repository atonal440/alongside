# Reliable dependency and related links

V2 `link.add` and `link.remove` use the same strict command envelope,
side-effect-free preview and receipt-first apply protocol as task commands.
They protect a planned edge from stale graph writes and return its original
result after a lost response or later deletion of an endpoint. The PWA's
existing offline queue still uses legacy endpoints during this rollout.

## Identity and planning

`get_link` (MCP), `POST /api/v2/link` (REST), and `api.link` (PWA) accept an
exact key: `{entity: "link", from: "t_first1", to: "t_second", linkType: "blocks"}`.
The response contains `contractVersion: 2`, the key, `row`, `version`, and
`structuralRevision`. The edge, ledger and structural counter come from one
SQL snapshot. Unknown edges have null row/version; deleted edges have a null
row and retained `{revision, deletedAt}`; live edges have a row and null
`deletedAt`. Reusing a deleted edge continues its revision sequence.

Commands require `from`, `to`, `linkType`, `expectedRevision`, and
`expectedStructuralRevision`. Add uses null revision only for a never-recorded
identity, or the numeric tombstone revision to revive it. Remove requires the
current live numeric revision. The structural revision covers endpoint changes,
other edges and all legacy task/project/duty writes conservatively.

New additions reject self-links. Related additions require ascending endpoint
IDs using JavaScript string ordering, and reject an existing reversed edge.
Reads/removal accept the exact stored orientation, including reversed legacy
related links. To replace a reversed link, inspect and explicitly remove that
identity, then read fresh revisions and add the canonical edge. No migration
rewrites historical identities, and normalization never silently changes a
command payload or replay key.

For example, after reading an unknown edge at structural revision 12:

```json
{
  "contractVersion": 2,
  "commandId": "c_link001",
  "actor": "user",
  "commands": [{
    "kind": "link.add",
    "from": "t_first1",
    "to": "t_second",
    "linkType": "blocks",
    "expectedRevision": null,
    "expectedStructuralRevision": 12
  }]
}
```

## Atomic behavior and results

The planner reads endpoints, reverse-edge presence and cycle reachability with
the edge snapshot. Apply guards the edge revision and aggregate revision inside
the same transaction as the insert/delete, receipt, audit and feed. Adds also
guard both endpoint existences and blocks acyclicity. Plain inserts avoid the
legacy replacement operation's delete/insert trigger behavior. A related add
uses 8 SQL statements, a blocks add 9, and removal 6, including guards/history.
Failures roll everything back; preview writes nothing and is not a lock.

Link diff IDs are the exact JSON tuple string `[from,to,linkType]`. Adds return
`after: {revision, row}`. Removes return `after: {revision, deleted: true}`.
`before` is null for an unknown edge, `{revision, row}` for a live edge, or
`{revision, row: null}` for tombstone revival. Diffs do not promise the storage
trigger's deletion timestamp; read the ledger for `deletedAt`. Links have no
clientRef: their caller-selected composite identity is already stable.

`revision_conflict` and `structural_conflict` carry parsed `currentLink`;
structural conflicts also carry `expectedStructuralRevision`. Already-live
adds, missing removes/endpoints, and reversed related duplicates return
`invalid_transition`; for a reverse duplicate, `currentLink` identifies that
reverse edge. Blocks cycles return `graph_cycle`. These are durable errors:
retain intent, inspect the current graph, and explicitly rebase with a new
command ID. Reusing the successful original ID with the same normalized payload
returns its exact receipt even after later graph changes or endpoint deletion.
Different payloads conflict. Revision exhaustion never resets a counter.

Migration 013 broadens the command feed for link identities and deletion
images, preserving old entries and its allocator even when history was removed.
Generated Drizzle state remains a diff helper; deployed SQL is in
`worker/migrations/013_link_commands.sql`. This command feed does not yet cover
all legacy writers or serve a public delta endpoint. Task/project deletion,
bounded mixed graph batches, full workspace sync/restore and retained offline
command overlays remain subsequent increments; broad capability gates stay off.
