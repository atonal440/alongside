# pwa/src/idb/decode.ts

Read-boundary parser for the `tasks`, `projects`, and `links` IndexedDB stores. Treats IDB as the untrusted boundary it is: rows written by older app versions, interrupted migrations, or devtools edits are parsed, repaired if possible, and quarantined if not, before any data reaches React state or the sync upload path.

## Why this exists

Reads in the IDB modules previously cast `req.result` directly to `Task[]` and friends. Those casts are lies: the raw bytes may reflect a shape from an older schema, a partial migration, or external edits. A malformed row that reaches `readinessScore` or an action creator can crash render logic silently, and will be synced back to the server as gospel.

This module moves the parse boundary to the IDB read: every row is verified before it leaves the store.

## Policy

**Repair → re-parse → quarantine; never throw; never silently delete.**

For each raw record:

1. Try `parseTaskRow` / `parseProjectRow` / `parseTaskLinkRow` (field-level, from `shared/wire/rows.ts`).
2. On parse failure, run the **repair pipeline**: apply `migrateLegacyDeferShape` (converts the legacy `snoozed_until` field to `defer_until` + `defer_kind`) and re-parse. Only add new repair steps when you can demonstrate the shape in a test.
3. After a successful field parse, apply **cross-field checks** mirroring `taskFromRow` in `worker/src/domain/task.ts`: `defer_kind`/`defer_until` consistency, recurrence requiring `due_date`, done tasks neither deferred nor focused, deferred tasks not focused. These violations quarantine — there is no canonical way to guess which field is the lie.
4. On a successful parse + cross-field pass: include the row. If it was repaired, write it back (`put`) so the next boot doesn't pay the repair cost.
5. On second parse failure or cross-field violation: **quarantine** — exclude from returned rows, leave the record in the store untouched. Deleting user data on a parse bug in *our* schema would be worse than the drift; leaving it lets a fixed build recover it.

## Report hook

```ts
onDecodeReport(fn: (report: DecodeReport) => void): void
```

Registers a module-level callback fired whenever a store decode yields any repaired or quarantined rows. The IDB read functions (`idbGetAllTasks`, `idbGetAllProjects`, `idbGetAllLinks`) return `Task[]`/`Project[]`/`TaskLink[]` unchanged — callers don't need to handle a new return type. The report is emitted via this hook instead.

`AppContext` registers the handler before the boot `Promise.all`, accumulates totals across the three stores, and dispatches one `SET_TOAST` if any rows were quarantined.

## Cross-field rules (kept in sync with `taskFromRow`)

| Condition | Error path | Code |
|-----------|-----------|------|
| `defer_kind === 'none'` and `defer_until !== null` | `defer_until` | `invalid_state` |
| `defer_kind === 'someday'` and `defer_until !== null` | `defer_until` | `invalid_state` |
| `defer_kind === 'until'` and `defer_until === null` | `defer_until` | `required` |
| `recurrence !== null` and `due_date === null` | `due_date` | `required` |
| `status === 'done'` and `defer_kind !== 'none'` | `defer_kind` | `invalid_state` |
| `status === 'done'` and `focused_until !== null` | `focused_until` | `invalid_state` |
| `defer_kind !== 'none'` and `focused_until !== null` | `focused_until` | `invalid_state` |

If D1 CHECK constraints for these rules land in the worker, consider unifying — for now the checks live here in parallel.

## Migration rule

New IDB schema versions that change row shapes **must** come with a repair-pipeline entry in `decodeTaskRows` (or the appropriate decoder) so that old rows can be repaired rather than quarantined on first boot after an upgrade. Add the repair step alongside the migration, and write a test for it.

## Performance

`getAll` + parse runs on every boot and every action-creator re-read. The dataset is personal-task-manager sized (hundreds, not millions) and valibot parses are microseconds — no caching layer is needed. If profiling reveals a real cost, the fix is reducing per-action `idbGetAllTasks` re-reads (an existing inefficiency), not weakening the boundary.
