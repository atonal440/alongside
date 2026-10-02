# Reliable planning-settings commands

Slice 2b gives the temporal foundation its first explicit configuration writer.
It accepts one `planning.set` command: a complete replacement of timezone,
buffer and weekday working hours. Single task/project creation now extends the protocol; see
[reliable creation](reliable-creation.md). Date and graph writers remain later
increments. `get_capabilities.features.reliableCommands` and `deltaSync` therefore
remain false for the broader task workflow. *(Superseded: the PWA queue now sends reliable commands and `reliableCommands`/`deltaSync` are true; see [the PWA command queue](../pwa/sync/canonical-workspace.md#reliable-command-queue).)*

## Preview and apply

Read `get_planning_settings` first. Null means the workspace has not been
configured; use `expectedRevision: null` for its first configuration. An
existing settings object supplies the numeric expected revision, including
zero on a manually configured legacy row.

```json
{
  "contractVersion": 2,
  "commandId": "c_setup2026",
  "actor": "user",
  "reason": "Use my working timezone and weekday hours",
  "commands": [{
    "kind": "planning.set",
    "expectedRevision": null,
    "values": {
      "timezone": "America/Los_Angeles",
      "bufferMinutes": 15,
      "workingHours": [{"weekday": 1, "start": "09:00", "end": "17:00"}]
    }
  }]
}
```

`preview_changes` returns before/after values, canonical SHA-256 payload hash,
command ID, server time and the exact generated SQL count. It writes nothing.
`apply_changes` accepts the same envelope and revalidates the expected revision
inside the transactional SQL batch. A preview is not a lock. Applied results
return the changed revision and the same normalized diff; no confirmation
ceremony is required for an authorized settings change.

The command ID must be caller-minted `c_` plus 5–64 ASCII ID characters.
`actor` is `user`, `llm` or `import`; it describes provenance rather than an
authentication role. The bearer token still controls authorization. Optional
reason text is bounded at 1000 characters. Unknown keys and explicit nulls are
rejected except the documented null expected revision. Managed revisions are
never supplied inside `values`.

Working hours use Monday=1 through Sunday=7, with at most 28 intervals.
Intervals must have end after start and cannot overlap on one weekday;
adjacency is valid. Ordering is normalized before hashing. Overnight intervals
and 24:00 endpoints are unsupported by the current minute-time contract.
Empty working hours represent no configured working windows, not an implicit
always-available schedule.

## Replay and conflicts

The canonical payload includes the full parsed envelope, including actor,
reason and expected revision; JSON property order and working-hour order do
not change identity. Clock time is not part of the input hash.

Same ID and payload returns the original committed result, even if later
commands changed settings. Same ID with different intent returns
`command_id_conflict`. Keep the exact original ID/payload after a timeout or
503. A replay does not append another audit/feed entry or advance revisions.
Previewing an already committed identical envelope returns `already_applied`;
call apply with that envelope to retrieve the original result.

`revision_conflict` includes the submitted expected revision and parsed
`currentSettings`. Retain the intention, inspect the current state and submit
a new command ID after rebasing. Do not replace the expected revision silently.
Safe-integer revision exhaustion returns an explicit error instead of wraparound.

## Atomic storage and read consistency

Migration 010 adds permanent `command_receipts`, `command_audit` and an initial
settings-only `change_feed` (expanded for reliable creation in migration 012). The shared Plan executor counts the revision guard,
receipt, settings row, working-hour replacement, audit and feed before I/O.
Everything commits in one D1 batch. A guard failure or late SQL failure rolls
back all of it. Concurrent identical execution rereads the committed receipt
after either a planning conflict or SQL collision; a response lost after commit
also resolves from that receipt.

Settings reads use one SQL statement for both the singleton and working hours,
so readers cannot combine the old revision with a new interval set. Stored
settings and receipt JSON pass shared parsers before becoming domain values.
The feed, including creation entries, remains internal groundwork: there is no full-workspace delta endpoint or
receipt expiry in this release. Aggregate graph/calendar revisions and deletion
tombstones land with their command families.

## Portable preferences and client compatibility

`export_planning_settings` returns a versioned `planning_settings` document,
an export instant and values without revision, receipts, secrets or credentials.
For non-null values, restore by submitting them in `planning.set` with a fresh
command ID, `actor: import`, and the destination's current expected revision.
Null reports an unconfigured source; clearing existing settings is not yet a
supported command. This preferences document is not a full-workspace backup.

Legacy v1 export/import keeps its existing scope and does not export, reset or
delete these settings or their receipts. Full v2 workspace restore and import
epoch handling remain later Slice 2 work.

The PWA API module parses settings, exports, previews, applied results and
structured conflict values. No settings form, IDB store or offline settings
queue is introduced here; callers use these methods online. Existing task
local-first writes and pending operations continue unchanged. Their migration
to retained command overlays remains required before advertising task command
reliability.
