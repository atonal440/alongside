# Foundation 04 — Canonical Invariants, Contracts, and Op Catalog

Part of `docs/plans/duties.md`. This is the **single source of truth** for the
facts that would otherwise be restated across many stage docs and drift out of
sync: the schema of record, the domain invariants, the calendar-primitive
signatures, the duty op catalog, and — the capstone — the **operations ×
invariants matrix** that says which mutation must preserve which invariant and
how.

**Authority rule:** where any stage or foundation doc disagrees with this file,
**this file wins** and the other is the stale one to fix. Implementing agents
should treat §3–§7 as the contract and the stage docs as the how-to. Nearly every
finding in this plan's review was a fact written in N places with one copy lagging
a fix; keeping the fact in *one* place is how that class is prevented rather than
re-caught.

## 1. Decisions registry

| # | Decision | Where reasoned |
|---|---|---|
| D1 | First-class `duties` table; tasks are instances via `duty_id`/`occurrence_at`. | master, `00` |
| D2 | Triggering = cron `scheduled()` + lazy-on-read, one idempotent `materializeDueDuties(now)`. | `00` §5 |
| D3 | Server authoritative for spawning; the PWA never materializes locally. | master P6 |
| D4 | Completion is decoupled from spawning; `completeTaskPlan` no longer spawns. | `00` §7 |
| D5 | Phased: single-task first (Stages 1–8), task-graph template later (Stage 9). | master |
| D6 | Minute-resolution UTC on every stored scheduling timestamp; no date-only fields. | `02` |
| D7 | Per-duty **anchor zone** (`timezone`) expands the rule; instants stored are always UTC; no global tz. | `02` |
| D8 | The series anchor — `rrule` + `dtstart` + `timezone` — is **immutable**; reschedule/re-zone = `end_duty` + `create_duty`. | `02`, INV-A |
| D9 | `catch_up: next` orphans stale opens + spawns one current; `all` spawns each (capped). | `00` §3 |
| D10 | Delete-duty **orphans** every instance (keeps tasks), stops future spawns. | `00`, INV-H |

## 2. Schema of record

**`duties`** — `id` (`d_…`), `title`, `notes`, `kickoff_note`,
`task_type`(`action|plan`), `project_id`(FK→projects), `rrule`,
`dtstart`(UTC datetime, **immutable**), `timezone`(nullable IANA, **immutable**;
null⇒UTC expansion), `status`(`active|paused|ended`), `catch_up`(`next|all`),
`last_spawned_at`(cursor, nullable), `next_occurrence_at`(nullable — see INV-C),
`created_at`, `updated_at`.

**`tasks`** += `duty_id`(FK→duties, nullable) and `occurrence_at`(nullable UTC
datetime). Paired: both set or both null (INV-E). `due_date` is now a UTC datetime
(D6). *Phase 2 adds* `template_node_key` (non-null on every duty instance, null on
one-off tasks).

**`action_log`** += `duty_id`(nullable).

**Indexes:** `UNIQUE(duty_id, occurrence_at)` [Phase 2: `(duty_id, occurrence_at,
template_node_key)`]; index on `next_occurrence_at` for the due-gate.

## 3. Domain invariants

The authoritative statements `dutyFromRow` and the planners enforce:

- **INV-A — Anchor immutable.** `rrule`, `dtstart`, `timezone` are fixed at
  creation. `updateDutyPlan` edits template fields + `catch_up` **only**; any
  attempt to change the anchor is rejected. Reschedule/re-zone = `end_duty` +
  `create_duty`.
- **INV-B — Cursor validity.** `last_spawned_at` is `null`, or an actual
  occurrence of the rule (expanded at `dtstart` in `timezone`) with value ≥
  `dtstart`. A cursor before the anchor or off the calendar is a corrupt row.
- **INV-C — `next_occurrence_at` semantics.** For a spawnable duty (`active`, not
  exhausted) it is **non-null** and equals the next *un-spawned* occurrence —
  which **may be in the future** (a not-yet-due active duty keeps it populated;
  nothing recomputes it if nulled, so nulling-while-merely-not-due is a bug). It
  is `null` **iff** the duty is `paused`, `ended`, or an `active` series that has
  genuinely run out (transient, healed by the next materialize). The due-gate keys
  on it: `status='active' AND next_occurrence_at IS NOT NULL AND
  next_occurrence_at <= now` — **never** `last_spawned_at < now`.
- **INV-D — `ended` is terminal, not "exhausted".** `status='ended'` ⇒
  `next_occurrence_at IS NULL`. That is the **only** requirement. `ended` is
  reached by exhaustion *or* by `end_duty` (the reschedule path), and infinite
  duties are never "exhausted", so requiring exhaustion here would break manual
  ending and reschedule-by-end.
- **INV-E — Instance identity.** A task has `duty_id` **iff** it has
  `occurrence_at` (both set, or both null). Duty instances have both; one-off and
  *orphaned* tasks have neither. `UNIQUE(duty_id, occurrence_at)` guarantees one
  instance per `(duty, occurrence)`.
- **INV-F — Exactly one spawner, always.** Across the whole rollout, recurrence is
  served by *either* legacy completion-spawn *or* the materializer — never zero
  (stall) and never both (double-spawn). See `03` I1/I2 and the Stage 4↔5 atomic
  cut-over.
- **INV-G — One current instance under `next`.** `catch_up: next` leaves exactly
  one current pending instance; stale opens (`occurrence_at < latest`) are
  orphaned; **the current occurrence is never orphaned** (the `< latest` bound
  makes replay race-safe).
- **INV-H — FK integrity, no dangles.** `project.delete` nulls **both**
  `duties.project_id` and `tasks.project_id`. `delete_duty` orphans **all**
  instances (`duty.orphan_all`) before `duty.delete`. `wipe` deletes `duties` in FK
  order. No `duty_id`/`project_id` FK ever dangles or blocks a delete.
- **INV-I — Non-empty series.** A persisted duty has ≥1 occurrence from `dtstart`.
  Because emptiness is anchor-dependent (e.g. `UNTIL` before the first `BYDAY`
  match), the check lives in `createDutyPlan` (reject `firstOcc == null`), not in
  `parseSeriesRrule`.
- **INV-J — Bounded plans.** Every mutation's `Plan` is O(1) statements in the
  instance count: bulk `duty.orphan_stale`/`duty.orphan_all` for orphaning,
  `maxPerRun` cap for `catch_up: all`. Never one statement per instance.
- **INV-K — Idempotent spawn (three layers).** (1) `UNIQUE(duty_id, occurrence_at)`
  → no duplicate instances; (2) monotonic `last_spawned_at` (`duty.update_cursor`
  compare-and-set) → no cursor regression; (3) `next_occurrence_at` gate + benign
  unique-conflict handling → a late/duplicate run is a no-op. See `00` §4.

## 4. Calendar-primitive signatures (`shared/parse/recurrence.ts`)

All are anchor-zone-aware — every one takes the duty's `timezone` (null ⇒ UTC
expansion). Passing UTC-only for a zoned duty silently drifts it across DST.

```ts
occurrencesBetween(parts, dtstart: IsoDateTime, timezone: Timezone | null,
                   after: IsoDateTime | null, through: IsoDateTime): IsoDateTime[]
nextOccurrenceAfter(parts, dtstart: IsoDateTime, timezone: Timezone | null,
                    after: IsoDateTime | null): IsoDateTime | null   // null ⇒ exhausted
latestOccurrenceAtOrBefore(parts, dtstart: IsoDateTime, timezone: Timezone | null,
                           instant: IsoDateTime): IsoDateTime | null // newest ≤ instant; catch_up:next
isSeriesExhausted(parts, dtstart: IsoDateTime, timezone: Timezone | null,
                  after: IsoDateTime | null): boolean
```

`nextOccurrence(parts, from)` — the legacy, single-arg, UTC-only primitive —
survives **only** for the migration/legacy-recurrence path (Stage 1 A2 shim,
Stage 4 backfill), removed in Stage 10.

## 5. Op catalog (`worker/src/domain/Op.ts` + `apply.ts`)

| Op | Shape | Statement / semantics |
|---|---|---|
| `duty.insert` | `{ row }` | INSERT a duty row. |
| `duty.update` | `{ id, patch }` | UPDATE template fields + `catch_up` (+ `status` via `setDutyStatusPlan`). **Never** `rrule`/`dtstart`/`timezone` (INV-A). |
| `duty.update_cursor` | `{ id, lastSpawnedAt, nextOccurrenceAt, updatedAt }` | Monotonic: `SET last_spawned_at=:new, next_occurrence_at=:next … WHERE id=:id AND (last_spawned_at IS NULL OR last_spawned_at<:new)`. Stale = no-op (INV-K). |
| `duty.orphan_stale` | `{ id, before, updatedAt }` | `UPDATE tasks SET duty_id=NULL, occurrence_at=NULL … WHERE duty_id=:id AND status='pending' AND occurrence_at < :before`. `catch_up:next`; excludes current (INV-G). |
| `duty.orphan_all` | `{ id, updatedAt }` | `UPDATE tasks SET duty_id=NULL, occurrence_at=NULL … WHERE duty_id=:id`. Any status; before `duty.delete` (INV-H). |
| `duty.delete` | `{ id }` | DELETE the duty (after `orphan_all`). |
| precheck `duty.exists` | `{ id }` | Guarded existence check; `not_found` if missing. |

Non-duty ops that duties force a change to: **`project.delete`** also nulls
`duties.project_id` (INV-H); **`wipe`** also deletes `duties` in FK order:
`task_links → action_log → tasks → duties → projects → preferences`.

## 6. Operations × invariants matrix

For each mutation: the invariants it must preserve and the guard that does it. A
new operation, or a change to an existing one, is only correct if every ✓ cell's
guard still holds. (Most of this plan's review findings were a missing guard in
one of these cells — e.g. `end_duty`×INV-D, materialize-`next`×INV-G.)

| Operation | Guard(s) — and which invariant each protects |
|---|---|
| `create_duty` (`createDutyPlan(input, ids, now)`) | INV-A (sets anchor once); INV-I (reject `firstOcc==null`); INV-C (`next_occurrence_at=firstOcc`, may be future); materialize first instance iff `firstOcc<=now`. |
| `update_duty` (`updateDutyPlan`) | INV-A (rejects `rrule`/`dtstart`/`timezone`); edits template + `catch_up` only, so INV-B/C untouched. |
| `pause` (`setDutyStatusPlan`) | INV-C (`next_occurrence_at=NULL` while paused). |
| `resume` (`setDutyStatusPlan`) | INV-C (recompute `next_occurrence_at` from cursor); reject if `ended` (terminal). |
| `end_duty` (`setDutyStatusPlan→ended`) | INV-D (`next_occurrence_at=NULL`; **no** exhaustion requirement — works for infinite duties). |
| `delete_duty` (`deleteDutyPlan`) | INV-H (`duty.orphan_all` then `duty.delete`); INV-J (bounded 2 statements). |
| materialize `next` | INV-G (`orphan_stale{before:latest}` excludes current) + INV-K (unique index on the insert); INV-C (advance cursor + `next_occurrence_at`); INV-J (bulk orphan). |
| materialize `all` | INV-J (`maxPerRun` cap; remainder next run) + INV-K (unique index, monotonic cursor). |
| materialize → exhausted | INV-D (`status='ended'`, `next_occurrence_at=NULL`); the `null`-cursor `COUNT=1`/future-`dtstart` case is **not** ended prematurely. |
| complete instance (`completeTask`) | INV-F (spawns nothing — the materializer owns recurrence); session_log→next kickoff carried by the materializer. |
| backfill (Stage 4) | INV-B (cursor = `due_date` only if it is an occurrence, else `null` + `next_occurrence_at=firstOcc`); INV-F (paired with retiring completion-spawn); validate each row via `dutyFromRow`. |
| `project.delete` | INV-H (null `duties.project_id` **and** `tasks.project_id`). |
| import `wipe`/restore | INV-H (delete `duties` in FK order; restore projects→duties→tasks); INV-E (round-trip `duty_id`/`occurrence_at`). |
| task write w/ `recurrence` | INV-F + `03` I4(b): MCP rejects; REST tolerates (upgrade to duty) through the transition — never a hard 4xx while the PWA still sends it. |

## 7. How to keep this canonical

- A stage doc should **state the how-to and reference the invariant/signature/op by
  its ID here**, not restate the rule. If you must restate for readability, add
  "(canonical: `04` INV-x)" so a future drift is obvious.
- When a review or implementation forces a change to any INV/op/signature, change
  it **here first**, then grep the stage docs for stale copies. `04` is the diff
  that matters.
- The operations × invariants matrix (§6) is the check to run when adding or
  changing a mutation: does every ✓ cell's guard still hold?
