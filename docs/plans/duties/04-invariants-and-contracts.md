# Foundation 04 — Canonical Invariants, Contracts, and Op Catalog

> Planning update, 2026-09-30: this file remains canonical **within the historical
> duties plan**. For the expanded product, [power-user-todo.md](../power-user-todo.md)
> takes precedence for unimplemented work, including occurrence history,
> date types, catch-up, lookahead, and archival. Reconcile affected contracts
> before reusing the older work orders; landed migrations remain the baseline.

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
| D6 | Minute-resolution UTC on every stored scheduling timestamp; tasks preserve all-day intent separately in `due_all_day`. | `02` |
| D7 | Per-duty **anchor zone** (`timezone`) expands the rule; instants stored are always UTC; no global tz/date resolver. Null and explicit `UTC` have identical expansion semantics. | `02` |
| D8 | The series anchor — `rrule` + `dtstart` + `timezone` — is **immutable**; reschedule/re-zone = `end_duty` + `create_duty`. | `02`, INV-A |
| D9 | Historical `next` / current `latest` materializes the newest missed occurrence and retains existing unfinished work; `all` spawns each (capped). | `00` §3 |
| D10 | Delete-duty **orphans** every instance (keeps tasks), stops future spawns. | `00`, INV-H |
| D11 | Duty recurrence uses a parallel `SeriesRrule` profile; the legacy infinite/date-only task profile remains unchanged until Stage 10. | `01`, Stage 2 |
| D12 | Duty `dtstart` is always a real time. Duties have no all-day flag, accept no bare-date anchor, and perform no noon/all-day inference. | `02`, Stage 2 |

## 2. Schema of record

**`duties`** — `id` (`d_…`), `title`, `notes`, `kickoff_note`,
`task_type`(`action|plan`), `project_id`(FK→projects), `rrule`,
`dtstart`(minute-resolution UTC datetime, **immutable and always timed**; never a
bare date and never inferred as noon/all-day), `timezone`(nullable IANA,
**immutable**; null or explicit `UTC`⇒UTC expansion),
`status`(`active|paused|ended`), `catch_up`(`next|all`),
`last_spawned_at`(cursor, nullable), `next_occurrence_at`(nullable — see INV-C),
`created_at`, `updated_at`.

**`tasks`** += `duty_id`(FK→duties, nullable) and `occurrence_at`(nullable UTC
datetime). Paired: both set or both null (INV-E). `due_date` is now a UTC datetime
(D6), with `due_all_day` as the separate nullable intent marker for task due dates;
that task-only marker is not part of duties. *Phase 2 adds* `template_node_key`
(non-null on every duty instance, null on one-off tasks).

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
- **INV-G — Retain occurrence provenance.** Catch-up selects which missed
  occurrences to generate; it does not detach, defer, complete, or re-date
  existing instances. Historical opens remain attached backlog. The public
  product policy is canonical in [power-user-todo.md §7](../power-user-todo.md#7-recurrence-retain-duties-add-occurrence-identity).
- **INV-H — FK integrity, no dangles.** `project.delete` nulls **both**
  `duties.project_id` and `tasks.project_id`. `delete_duty` orphans **all**
  instances (`duty.orphan_all`) before `duty.delete`. `wipe` deletes `duties` in FK
  order. No `duty_id`/`project_id` FK ever dangles or blocks a delete.
- **INV-I — Non-empty series.** A persisted duty has ≥1 occurrence from `dtstart`.
  Because emptiness is anchor-dependent (e.g. `UNTIL` before the first `BYDAY`
  match), the check lives in `createDutyPlan` (reject `firstOcc == null`), not in
  `parseSeriesRrule`.
- **INV-J — Bounded plans.** Every mutation's `Plan` is O(1) statements in the
  instance count: bulk deletion/archival operations,
  `maxPerRun` cap for `catch_up: all`. Never one statement per instance.
- **INV-K — Idempotent spawn (three layers).** (1) `UNIQUE(duty_id, occurrence_at)`
  → no duplicate instances; (2) monotonic `last_spawned_at` (`duty.update_cursor`
  compare-and-set) → no cursor regression; (3) `next_occurrence_at` gate + benign
  unique-conflict handling plus a **live-cursor predicate on each insert** →
  a late/duplicate run is a no-op. Guarding only the cursor update is insufficient: an older plan could insert a stale instance after a newer plan commits.
- **INV-L — Materialize is guarded on live status.** A materialize plan built while
  a duty was `active` must **no-op if the duty is no longer `active`** by the time
  it applies (a `pause_duty`/`end_duty` committed in between). `duty.exists` is not
  enough — it still passes for a paused/ended row, so a stale plan would spawn after
  the user stopped the duty and could write a non-null `next_occurrence_at` onto an
  `ended` row (violating INV-D). The materialize batch's writes must therefore be
  **conditional on `status='active'`** (a status guard on the insert + cursor ops,
  atomic with them), not merely on existence.

## 4. Calendar-primitive signatures (`shared/parse/recurrence.ts`)

The implemented profile, finite-bound semantics, APIs, and work limits are
canonical in [the recurrence reference](../../shared/parse/recurrence.md). Stage
work orders must reference that contract rather than copying it. In particular,
filtered sub-day rules are unsupported, and a search-budget error is not proof
of exhaustion. Use `isSeriesOccurrence` to validate a cursor and
`nextOccurrenceAfter` to validate its expected successor. Never enumerate the
whole history to decode a duty.

The shared timezone codec is canonical in [the time reference](../../shared/parse/time.md).

## 5. Op catalog (`worker/src/domain/Op.ts` + `apply.ts`)

| Op | Shape | Statement / semantics |
|---|---|---|
| `duty.insert` | `{ row }` | INSERT a duty row. |
| `duty.update` | `{ id, patch, ifStatus? }` | UPDATE template fields + `catch_up` (+ `status` via `setDutyStatusPlan`). **Never** `rrule`/`dtstart`/`timezone` (INV-A). `ifStatus: 'active'` — set **only** by the materializer's exhaustion→`ended` op — appends `AND status='active'` (INV-L); status-transition plans (`pause`/`resume`/`end_duty`) never set it (resume must apply to a `paused` row). |
| `duty.update_cursor` | `{ id, lastSpawnedAt, nextOccurrenceAt, updatedAt }` | Monotonic **and status-guarded** (materialize-only op): `SET last_spawned_at=:new, next_occurrence_at=:next … WHERE id=:id AND status='active' AND (last_spawned_at IS NULL OR last_spawned_at<:new)`. Stale or no-longer-active = no-op (INV-K, INV-L). |
| `duty.orphan_all` | `{ id, updatedAt }` | `UPDATE tasks SET duty_id=NULL, occurrence_at=NULL … WHERE duty_id=:id`. Any status; before `duty.delete` (INV-H). [Phase 2: also sets `template_node_key=NULL`.] |
| `duty.delete` | `{ id }` | DELETE the duty (after `orphan_all`). |
| precheck `duty.exists` | `{ id }` | Guarded existence check; `not_found` if missing. |

**Materialization guards.** The executor already implements
`duty.update_cursor` and duty-instance `task.insert`. Inserts require a live
active duty whose cursor is null or strictly before the inserted occurrence.
They use targeted `ON CONFLICT(duty_id,occurrence_at) DO NOTHING`; unrelated
constraint failures still roll back the whole batch. Cursor advancement follows
all inserts in that same batch and is conditional on active status and forward
progress. Replaying an older plan after a newer one commits therefore changes
neither tasks nor cursor. No catch-up op mutates existing instances.

Later exhaustion transitions must also be conditional on live active status.
Duty planners/drivers and their revision guards remain future work; these
executor primitives do not enable generation by themselves. See
[the executor contract](../../worker/storage/apply.md).

Non-duty ops that duties force a change to: **`project.delete`** also nulls
`duties.project_id` (INV-H); **`wipe`** also deletes `duties` in FK order:
`task_links → action_log → tasks → duties → projects → user_preferences`.

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
| materialize `next` | INV-G (retains existing work) + INV-K (live-cursor insert guard + unique index); INV-C (advance cursor + `next_occurrence_at`); INV-J (bounded inserts); **INV-L (status guard — no spawn if paused/ended between plan-build and apply)**. |
| materialize `all` | INV-J (`maxPerRun` cap **passed into `occurrencesBetween` as `limit`** — expand at most `maxPerRun`, never `SERIES_OCCURRENCE_CAP`; remainder next run) + INV-K + **INV-L (status guard)**. |
| materialize → exhausted | INV-D (`status='ended'`, `next_occurrence_at=NULL`); the `null`-cursor `COUNT=1`/future-`dtstart` case is **not** ended prematurely; **INV-L (only from a still-active row)**. |
| complete instance (`completeTask`) | INV-F (spawns nothing — the materializer owns recurrence); session_log→next kickoff carried by the materializer. |
| backfill (Stage 4) | INV-B (cursor = `due_date` only if it is an occurrence, else `null` + `next_occurrence_at=firstOcc`); INV-F (paired with retiring completion-spawn); validate each row via `dutyFromRow`. |
| `project.delete` | INV-H (null `duties.project_id` **and** `tasks.project_id`). |
| import `wipe`/restore | INV-H (delete `duties` in FK order; restore projects→duties→tasks); INV-E (round-trip `duty_id`/`occurrence_at`). **Ships with the Stage 4/5 cut-over, not Stage 6** — duties exist from the backfill, so export/wipe must handle them from that moment (`03` State C). |
| task write w/ `recurrence` | INV-F + `03` I4(b): MCP rejects; REST tolerates through the transition — but **only auto-creates a duty when `duty_id` is null** (unattached legacy task). If the task already has a `duty_id`, the `recurrence` field is **ignored (no-op)**, or a second schedule is created for the same task. The auto-created duty is seeded **exactly like the Stage 4 backfill** (INV-B: cursor = `due_date` only if it is an occurrence, else null cursor + `next_occurrence_at=firstOcc`) — share that helper, or an off-calendar `due_date` fails `dutyFromRow` and turns the tolerated write into the durable 4xx this path exists to prevent. |

## 7. How to keep this canonical

- A stage doc should **state the how-to and reference the invariant/signature/op by
  its ID here**, not restate the rule. If you must restate for readability, add
  "(canonical: `04` INV-x)" so a future drift is obvious.
- When a review or implementation forces a change to any INV/op/signature, change
  it **here first**, then grep the stage docs for stale copies. `04` is the diff
  that matters.
- The operations × invariants matrix (§6) is the check to run when adding or
  changing a mutation: does every ✓ cell's guard still hold?
