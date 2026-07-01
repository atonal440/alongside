# Stage 3 — Duty Domain and Op/Apply Extensions

Part of `docs/plans/duties.md`. Prerequisites: Stage 1 (schema), Stage 2
(series recurrence). Read `01-type-system.md`'s DOMAIN layer first.

## Goal

Give duties the same domain treatment tasks have: brands (`DutyId`,
`DutyStatus`, `CatchUpPolicy`), a `DutyDomain` discriminated union with a
row codec `dutyFromRow`, the `duty.*` `Op` variants and `duty.exists` precheck,
and their execution in `worker/src/storage/apply.ts`. **No plan builders and no
materialization yet** (that's Stage 4) — this stage is the type-safe substrate.

## Context for a cold start

- Brand/enum patterns: `shared/parse/ids.ts:6-48` (TaskId trio + parser),
  `shared/parse/enums.ts:6-10` (`as const` registries + parsers).
- Domain codec pattern: `taskFromRow` (`worker/src/domain/task.ts:197-334`)
  accumulates `ValidationError[]`, brands each field, enforces cross-field
  invariants, and returns a discriminated union. `DutyDomain` follows the same
  shape but discriminates on `status`.
- `Op` / `PreCheck` / `Plan`: `worker/src/domain/Op.ts`. Row types are
  `$inferSelect` aliases (`Op.ts:5-8`); patches omit `id`/`created_at`
  (`Op.ts:9-10`).
- The executor: `worker/src/storage/apply.ts` turns each `Op` into a
  `D1PreparedStatement` using column arrays (`TASK_INSERT_COLUMNS`
  `apply.ts:26`, `TASK_UPDATE_COLUMNS` following it) and runs prechecks as
  guarded statements. Duties add parallel column arrays and cases.

## Steps

### 1. Brands (`shared/parse/`)

- `ids.ts`: `DutyId`/`ParsedDutyId`/`MintedDutyId`, `DUTY_ID_PATTERN`
  (`/^d_[0-9A-Za-z_-]{5,}$/`), `DutyIdSchema`, `parseDutyId` — copy the `TaskId`
  block verbatim, swapping the prefix.
- `enums.ts`: `DUTY_STATUSES = ['active','paused','ended']`,
  `CATCH_UP_POLICIES = ['next','all']`, their `Brand` types, `parseDutyStatus`,
  `parseCatchUpPolicy`. Re-export from `shared/parse/index.ts`.
- `time.ts`: the `Timezone` brand + `parseTimezone` (if Stage 2 didn't already
  land it) — needed by `dutyFromRow` to brand the nullable `timezone` column.
- Minting: add `mintDutyId()` next to `mintTaskId` (`worker/src/db.ts:86`),
  `d_${nanoid(5)}` branded `MintedDutyId`.

### 2. `DutyDomain` (`worker/src/domain/duty.ts`, new)

Define `DutyTemplate`, `DutySeries`, `DutyBase`, the three status variants, the
`DutyDomain` union, and `dutyFromRow` exactly as sketched in `01-type-system.md`.
`dutyFromRow(row: Duty)`:

- Brand each column (`parseDutyId`, `parseNonEmpty(200, …)` for title,
  `nullableBounded` for notes/kickoff, `parseTaskType`, `nullableProjectId`,
  `parseSeriesRrule` for `rrule`, `parseIsoDateTime` for `dtstart` (a UTC instant
  now — Decision 4), nullable `parseTimezone` for `timezone`, `parseDutyStatus`,
  `parseCatchUpPolicy`, nullable `parseIsoDateTime` for `last_spawned_at` and
  `next_occurrence_at`, `parseIsoDateTime` for timestamps). Reuse the `nullable*`
  helpers from `worker/src/domain/task.ts:93-119` — extract them to a shared
  module if that's cleaner than duplicating.
- Cross-field invariants (accumulate as `ValidationError[]`, same style as
  `taskFromRow`) — expand the rule using the duty's own `timezone`:
  - `parts.until` present ⇒ `until >= dtstart`.
  - `cursor` (last_spawned_at) present ⇒ `cursor >= dtstart` (a cursor *before*
    the anchor is impossible) **and** `cursor` is an actual occurrence of the rule
    (verify via `occurrencesBetween(parts, dtstart, timezone, null, cursor)`
    ending exactly at `cursor`, or an `isOccurrence` helper).
  - `next_occurrence_at` present ⇒ it is a real occurrence of the rule that is
    strictly after `cursor` **when the cursor is set**, or **at or after
    `dtstart`** when the cursor is null (a brand-new/backfilled duty has
    `next_occurrence_at === dtstart`, the un-spawned first occurrence — do not
    require strictly-after here), consistent with the rule + zone.
  - `status === 'ended'` ⇒ `next_occurrence_at IS NULL` **and**
    `isSeriesExhausted(parts, dtstart, timezone, cursor)` is true. A `null`-cursor
    duty is **never** `ended` (its `dtstart` occurrence hasn't been consumed — the
    `COUNT=1`/future-`dtstart` case). Do **not** enforce the converse — an
    exhausted-but-still-`active` row is transient and healed by the next
    materialize.
- Return the status-tagged variant.

Add a thin `dutyFromRowOrThrow` / `parseDutyDomain` wrapper on `DB` mirroring the
task equivalents if the DB layer will want one (Stage 6).

### 3. `Op` and `PreCheck` (`worker/src/domain/Op.ts`)

```ts
export type DutyRow      = Duty;                        // import from @shared/types once re-exported
export type DutyRowPatch = Partial<Omit<DutyRow, 'id' | 'created_at'>>;
```

Add to `Op`: `duty.insert` / `duty.update` / `duty.update_cursor` /
`duty.orphan_open` / `duty.delete`. Add to `PreCheck`: `duty.exists`. Ensure `Duty`
is re-exported from `shared/types.ts` alongside `Task`/`Project`/`TaskLink` so
`Op.ts` can import it via `@shared/types`. Two ops need a dedicated form (not a
generic patch): `duty.update_cursor` so the cursor advance is monotonic SQL, and
`duty.orphan_open { id: DutyId }` so the `catch_up: next` orphan is **one bulk
`UPDATE`** rather than one statement per open instance (Stage 4 / `00` §4).

### 4. Executor (`worker/src/storage/apply.ts`)

- `DUTY_INSERT_COLUMNS` and `DUTY_UPDATE_COLUMNS` arrays mirroring the task ones.
- `case 'duty.insert' | 'duty.update' | 'duty.delete'`: build the
  `INSERT` / `UPDATE … WHERE id = ?` / `DELETE` statements the same way tasks do.
- `case 'duty.update_cursor'`: emit **monotonic** compare-and-set SQL so a stale
  driver cannot regress the cursor (`00` §4):
  ```sql
  UPDATE duties
     SET last_spawned_at = :new,
         next_occurrence_at = :next,
         updated_at = :updatedAt
   WHERE id = :id
     AND (last_spawned_at IS NULL OR last_spawned_at < :new);
  ```
  A no-op update (a slower driver whose `:new` is ≤ the stored cursor) is success,
  not an error — the faster driver already advanced it.
- `case 'duty.orphan_open'`: one bulk statement, unbounded rows but a single
  statement, so the `next` plan stays under the batch limit no matter how many
  open instances exist:
  ```sql
  UPDATE tasks SET duty_id = NULL, occurrence_at = NULL, updated_at = :now
   WHERE duty_id = :id AND status = 'pending';
  ```
- `case 'duty.exists'` precheck: a guarded existence statement, mirroring
  `task.exists` — the `ExistingRowGuard` machinery (`apply.ts:18`, `apply.ts:239`)
  already supports `entity: 'task' | 'project'`; widen it to include `'duty'`.
- The `UNIQUE(duty_id, occurrence_at)` benign-conflict handling is **Stage 4's**
  concern (it's specific to duty-instance `task.insert`), not here.

### 5. Tests (`worker/test/`)

- `dutyFromRow`: a valid active duty round-trips; `until < dtstart` rejected;
  `cursor < dtstart` rejected; `cursor` off-calendar rejected; `status: 'ended'`
  with a still-live infinite rule rejected; a `null`-cursor `COUNT=1` duty is
  **not** rejected as ended; `next_occurrence_at` inconsistent with the rule
  rejected; a valid `timezone` accepted and a bogus one rejected; a `paused` duty
  with a valid cursor accepted.
- `apply`: a `Plan` of `duty.insert` then `duty.update` commits both;
  `duty.update_cursor` advances forward but a **stale** `duty.update_cursor`
  (`:new` ≤ stored) is a no-op (monotonic — the cursor never regresses);
  `duty.exists` precheck fails a plan whose duty is missing (`not_found`);
  `duty.delete` removes the row.
- Brand parsers: `parseDutyId` accepts `d_ab3k9`, rejects `t_...` and `d_` too
  short; `parseDutyStatus`/`parseCatchUpPolicy` reject unknown values.

### 6. Docs

Add `docs/worker/domain/duty.md` (mirror `docs/worker/domain/task.md` if it
exists) describing `DutyDomain`, the invariants `dutyFromRow` enforces, and why
`ended` is a parse-time-checked state. Update the Op/apply doc with the new
variants.

## Acceptance criteria

- `npm --prefix worker run typecheck` / `test` pass; `DutyDomain`, `dutyFromRow`,
  duty ops, and `duty.exists` execution covered.
- `apply` handles a mixed task+duty plan in one batch.
- No plan builders or materialization exist yet (Stage 4).
- Root `npm run verify` passes.
- Check off Stage 3 in the implementation todo.
