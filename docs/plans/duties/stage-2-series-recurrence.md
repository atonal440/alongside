# Stage 2 — Series Recurrence Primitives

Part of `docs/plans/duties.md`. Prerequisite: Stage 1. Read
`00-recurrence-and-triggering.md` §2, `01-type-system.md`'s "Series recurrence"
section, and `02-timestamp-model.md` first.

> **Canonical signatures:** `04-invariants-and-contracts.md` §4 is authoritative
> for the calendar-primitive signatures implemented here — if this doc drifts,
> `04` wins.

## Goal

Add a finite, **time-capable** `SeriesRrule` profile to
`shared/parse/recurrence.ts` and the two instant-based calendar primitives the
materializer needs — `occurrencesBetween` and `isSeriesExhausted`. Everything
works in UTC instants (Decision 4); there is **no** `today` resolver and **no**
timezone in this module. Pure functions only. This is the calendar math the whole
engine stands on, so it gets the heaviest test coverage of any stage.

## Context for a cold start

- `shared/parse/recurrence.ts` today validates an **infinite, date-only** RRULE.
  `SUPPORTED_KEYS` (`recurrence.ts:25`) excludes `COUNT`/`UNTIL`;
  `isNonEmptyInfiniteRule` (`recurrence.ts:156`) requires an unbounded rule;
  `isDateOnlyProfile` (`recurrence.ts:131`) enforces date-only-ness against the
  `rrule` library, whose native mode is datetime. `parseRrule` (`recurrence.ts:186`)
  returns `{ rrule, parts }` with `RruleParts = { source, freq, interval }`.
- `nextOccurrence(parts, from)` (`recurrence.ts:213`) is the legacy strictly-after
  primitive used by the Stage 4 backfill — leave it working until Stage 10.
- Date math uses `Date.UTC` + `toISOString()` (`recurrence.ts:199-211`). Under
  Decision 4 the outputs are full UTC instants (minute resolution), not date-only.
- The `rrule` library is aliased in `wrangler.toml` and the vitest/vite configs.

## Steps

### 1. `SeriesRruleParts` and `parseSeriesRrule`

```ts
export type SeriesRrule = Brand<string, 'SeriesRrule'>;

export interface SeriesRruleParts extends RruleParts {
  count?: PositiveInt<10_000>;
  until?: IsoDateTime;   // UTC instant
}
```

`parseSeriesRrule(input)`:

- Expand against a **datetime `DTSTART`** in UTC — the `rrule` library's native
  mode. **Drop the date-only profile**: time-of-day is now legal, so
  `isDateOnlyProfile` and its date-only rejections are not applied to series
  rules. (Leave the legacy `parseRrule`/`isDateOnlyProfile` untouched for the
  backfill path; series rules simply don't use them.)
- Add `COUNT` and `UNTIL` to a **series-specific** supported-key set (don't mutate
  the shared `SUPPORTED_KEYS` the infinite parser uses).
- `COUNT`: positive integer `1..10_000` (caps materialization loops; document it).
- `UNTIL`: a UTC instant. Reject a bare date with no time only if you choose to
  require explicit times; otherwise normalize a date to midnight UTC. Cross-field
  `UNTIL >= dtstart` is checked in the domain codec (Stage 3), not here.
- Reject a rule with **both** `COUNT` and `UNTIL`.
- Drop the infinite requirement. **Do not** try to reject "empty series" here:
  whether a rule yields any occurrence is **anchor-dependent** (e.g.
  `FREQ=WEEKLY;BYDAY=FR;UNTIL=<a Thursday>` is empty only relative to a specific
  `dtstart`), and `parseSeriesRrule` sees only the rule string, not `dtstart`. The
  non-empty check therefore moves to **create-time**, where `dtstart` is known:
  `createDutyPlan` rejects a duty whose `firstOcc = nextOccurrenceAfter(dtstart,
  …)` is `null` (Stage 4). `parseSeriesRrule` validates only rule *shape*.

Return `{ rrule: SeriesRrule; parts: SeriesRruleParts }`; add `SeriesRruleSchema`
(valibot pipe) alongside `RruleSchema`.

### 2. `occurrencesBetween` and `nextOccurrenceAfter` (anchor-zone aware)

```ts
export function occurrencesBetween(
  parts: SeriesRruleParts, dtstart: IsoDateTime, timezone: Timezone | null,
  after: IsoDateTime | null, through: IsoDateTime,
  limit?: number,   // stop after `limit` results; callers pass maxPerRun (Stage 4) so a
                    // far-behind high-frequency rule can't hit the runaway cap and throw
): IsoDateTime[]

export function nextOccurrenceAfter(
  parts: SeriesRruleParts, dtstart: IsoDateTime, timezone: Timezone | null,
  after: IsoDateTime | null,
): IsoDateTime | null   // null = series exhausted; feeds duties.next_occurrence_at

export function latestOccurrenceAtOrBefore(
  parts: SeriesRruleParts, dtstart: IsoDateTime, timezone: Timezone | null,
  instant: IsoDateTime,
): IsoDateTime | null   // last occurrence <= instant, or null if none yet; used by catch_up:'next'
```

- Build the rule with `dtstart` as the **fixed anchor instant** (not `after`).
  This is the core difference from `nextOccurrence`.
- **Anchor-zone expansion (Phase 1, Decision 4).** When `timezone` is `null`,
  expand in UTC. When set, expand the rule against that IANA zone: generate the
  rule's *wall-clock* occurrences in the zone and convert each to a UTC instant
  using the offset in effect on that date — so consecutive daily occurrences are
  usually 24h apart but 23h/25h across a DST boundary, keeping the wall-clock time
  stable. Return values are **always UTC instants** either way. Use a zone-aware
  path (a small `Intl.DateTimeFormat`/offset helper, or the `rrule` library's tz
  support if reliable in Workers — validate in tests). DST-transition edge cases
  (nonexistent/doubled wall-clock times) fall back to the library's skip/first-
  match behavior; do not add custom handling (master Out of Scope).
- Enumerate occurrences `> after` (or `>= dtstart` when `after === null`) and
  `<= through`. Respect the rule's own `COUNT`/`UNTIL` so a finite rule stops.
- Return `IsoDateTime[]`, ascending. Stop at `limit` when given (callers pass
  `maxPerRun`), else hard-cap length (e.g. 10 000) as a runaway guard and throw/log
  on cap hit. The `limit` matters: a far-behind high-frequency `all` duty must be
  bounded by `maxPerRun` *before* enumeration so it never trips the runaway cap.
  `nextOccurrenceAfter` (rule `.after`) maintains
  `next_occurrence_at`; `latestOccurrenceAtOrBefore` (rule `.before(instant,
  inclusive=true)`) gives the newest due occurrence without enumerating — used by
  `catch_up: 'next'` so it jumps straight to the current occurrence even when the
  duty is far behind.
- Edge cases to test: `after === dtstart` excludes `dtstart`; `after` between two
  occurrences returns from the next; `through < dtstart` → `[]`; a `COUNT` rule
  used up before `through` returns only the survivors; a sub-day rule enumerates
  within a day; a DST-crossing daily rule under a zone keeps constant wall-clock
  time (the whole point).

### 3. `isSeriesExhausted`

```ts
export function isSeriesExhausted(
  parts: SeriesRruleParts, dtstart: IsoDateTime, timezone: Timezone | null,
  after: IsoDateTime | null,
): boolean
```

True iff the rule is finite (`count`/`until`) **and** `nextOccurrenceAfter(...,
after)` is `null`. Note `after` is nullable: when the cursor is `null` (nothing
spawned yet), exhaustion is evaluated as "no occurrence at or after `dtstart`",
so a `COUNT=1` duty whose single occurrence is `dtstart` is **not** exhausted
until that occurrence is spawned. Infinite rules → always `false`. This flips a
duty to `ended` (Stage 4).

### 4. `Timezone` brand (`shared/parse/time.ts`)

Add the `Timezone` brand — IANA membership via `Intl.supportedValuesOf('timeZone')`
— and `parseTimezone`. It is a real Phase-1 input consumed by `occurrencesBetween`
above (rule expansion) and reused PWA-side for display. There is **no** per-user
`todayInZone` resolver and no global timezone preference; the materializer still
takes a plain UTC `now` (Stage 5) and passes each duty's own `timezone` into
`occurrencesBetween`.

### 5. Tests (`worker/test/` — deep-coverage stage)

- `parseSeriesRrule`: accepts `FREQ=DAILY;COUNT=30`,
  `FREQ=WEEKLY;UNTIL=…Z`, a time-of-day rule (`FREQ=DAILY` from a datetime
  `DTSTART` at 09:00Z), and all the infinite forms; rejects `COUNT=0`,
  `COUNT=99999`, and `COUNT`+`UNTIL` together. It does **not** test "empty series"
  — that check is anchor-dependent and lives in `createDutyPlan` (04 INV-I / Stage
  4), so the empty-series rejection is tested there, not here.
- `occurrencesBetween` with `limit`: a far-behind high-frequency rule returns
  exactly `limit` results and does **not** throw on the runaway cap.
- `occurrencesBetween`: table-driven over the Step 2 edge cases; a monthly
  `BYDAY=3FR` proving the anchor is fixed (spawn instants don't drift with
  `after`); a sub-day rule; the runaway cap.
- `isSeriesExhausted`: finite rule before/at/after last occurrence; infinite → false.
- `fast-check` properties: `occurrencesBetween` output is ascending, all in
  `(after, through]`, length ≤ cap; each element round-trips as a valid
  occurrence.
- Regression: `parseRrule` / `nextOccurrence` and the date-only profile behavior
  are **unchanged** (legacy path intact) — the existing recurrence tests pass
  untouched.

### 6. Docs

Update the recurrence reference doc with the series profile, the datetime
`DTSTART` semantics, `COUNT`/`UNTIL` support, and the fact that series rules are
**not** date-only — contrasting with the legacy infinite `parseRrule` that backs
the task column until Stage 10.

## Acceptance criteria

- `npm --prefix worker run typecheck` / `test` pass; new suites green.
- Legacy `parseRrule`/`nextOccurrence` behavior unchanged.
- No global `todayInZone` resolver or user-wide timezone preference exists; the
  only timezone use is the per-duty anchor zone passed into `occurrencesBetween`.
- Root `npm run verify` passes.
- Check off Stage 2 in the implementation todo.
