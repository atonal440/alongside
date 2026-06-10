# Stage 8 — IndexedDB Read-Boundary Parsing

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–5. Independent of stages 6–7; can run in parallel with them.

## Goal

Treat IndexedDB as the untrusted boundary it is. Reads (`req.result as Task[]` and friends) get parsed through the shared row schemas with a repair-then-quarantine policy, so rows written by older app versions, interrupted migrations, or devtools edits cannot crash render logic or get synced back to the server. Stage 4 already did this for `pending_ops`; this stage covers `tasks`, `projects`, and `links`.

## Context for a cold start

- Read sites: `pwa/src/idb/tasks.ts:8`, `pwa/src/idb/projects.ts`, `pwa/src/idb/links.ts` — all `getAll()` + cast. Consumers: `pwa/src/context/actions.ts` (per-mutation re-reads), `pwa/src/api/sync.ts`, and the initial load in `pwa/src/App.tsx` / `pwa/src/context/AppContext.tsx` (find the actual boot path before editing).
- Schemas: `shared/wire/rows.ts` from stage 2 (`parseTaskRow`, `parseProjectRow`, `parseTaskLinkRow`). Parsed outputs are assignable to row types (stage-2 guarantee).
- Existing in-place repair precedent: the v3 migration in `pwa/src/idb/db.ts` (`migrateLegacyDeferShape`).
- Two failure populations to design for: (a) *known legacy shapes* — mechanically repairable; (b) *arbitrary drift* — unrepairable junk.

## Design

### Policy: repair, then quarantine, never throw, never silently delete

New `pwa/src/idb/decode.ts`:

```ts
export interface DecodeReport { repaired: number; quarantined: { store: string; key: unknown; issues: ValidationError[] }[] }
export function decodeTaskRows(raw: unknown[]): { rows: Task[]; report: DecodeReport };
// + decodeProjectRows, decodeLinkRows
```

- Each raw record: try `parseTaskRow`; on failure, run the repair pipeline (start with `migrateLegacyDeferShape`, extracted/exported from `db.ts` so it has one definition; add repairs only for shapes you can actually demonstrate in a test) and re-parse; on second failure, quarantine.
- The shared row schemas are **field-level only** (stage 2 deliberately kept them relocation-pure). After a successful field parse, apply decode-local cross-field checks mirroring `taskFromRow` in `worker/src/domain/task.ts` — read its error paths and copy the rules exactly: `defer_kind === 'until'` ⇔ `defer_until` set (null otherwise), recurrence requires `due_date`, done tasks are neither deferred nor focused, deferred tasks are not focused. Violations **quarantine** (there is no canonical repair — guessing which field is the lie would corrupt data). Keep these checks in `decode.ts`, not in `shared/wire/` — the worker enforces the same rules via `taskFromRow` and, eventually, D1 CHECKs; if those CHECK constraints land, consider unifying then.
- **Quarantined rows are excluded from the returned set but left untouched in the store.** Deleting user data on a parse bug in *our* schema would be worse than the drift; leaving it lets a fixed build recover it. Log one structured `console.error` per boot with the report. (If a quarantined task id is referenced by links, those links will dangle — `shared/readiness.ts` `hasActiveBlocker` already tolerates missing tasks; verify the other consumers do too and note findings.)
- Repaired rows are written back (`put`) so repair happens once, not on every read.

### Where to decode

Decode at the IDB module boundary — `idbGetAllTasks` etc. return `{ rows, report }` or keep returning `Task[]` and emit reports through a registered callback; pick the design that keeps the dozen call sites simple (a module-level `onDecodeReport` hook + unchanged return type is the smaller diff; document the choice). Writes (`idbPutTask`) take typed rows already and stay as-is — the type system upstream (stages 3–6) is what guarantees written rows are valid; don't double-parse on write.

Surface to the user only when material: if any rows were quarantined, one toast — "N items couldn't be loaded; they're preserved and may recover after an update" — not per-row noise. Wire that through the boot path's dispatch.

### Performance note

`getAll` + parse for the full store runs on every boot and every action-creator re-read. The dataset is personal-task-manager sized (hundreds, not millions) and valibot parses are microseconds; do **not** add caching layers here. If profiling during review shows a real cost, the fix is reducing the per-action `idbGetAllTasks` re-reads (an existing inefficiency), not weakening the boundary — file it in the todo as future work if observed.

## Tests (`pwa/test/idb/decode.test.ts`, fake-indexeddb)

- Round-trip: fixture rows decode clean, report empty.
- Legacy repair: plant a `snoozed_until`-era task → repaired, re-parse clean, written back (second read needs no repair), report counts it.
- Quarantine: plant a task with `status: 'archived'` and one with `updated_at: 'yesterday'` → excluded from rows, still present in the raw store, report lists keys + issues.
- Cross-field quarantine: `defer_kind: 'until'` with `defer_until: null`; `recurrence` set with `due_date: null`; done task with `focused_until` in the future — each excluded with the matching issue, store untouched.
- Mixed store: 2 valid + 1 reparable + 1 junk → exactly the right 3 returned.
- Link/project decoders: one happy + one quarantine case each.
- Boot integration: seed a drifted store, run the real load path (whatever `AppContext`/`App` uses), assert state contains only valid rows and the toast/report fired once.

## Docs

Update `docs/pwa/idb/` — the boundary contract (reads are parsed, writes are trusted-by-type), the repair/quarantine policy and its rationale, and the rule that new IDB migrations must come with a repair-pipeline entry when they change row shapes.

## Acceptance criteria

- `grep -rn "as Task\[\]\|as Project\[\]\|as TaskLink\[\]\|as PendingOp\[\]" pwa/src/idb` → empty.
- A hand-planted malformed row in a dev browser no longer reaches React state or the sync upload path, and survives in IDB (manual check, noted in PR).
- All suites + `npm run verify` green; todo file updated.
