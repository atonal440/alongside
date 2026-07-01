# Stage 2 — Series Recurrence Primitives

Part of `docs/plans/duties.md`. Prerequisite: Stage 1. Read
`00-recurrence-and-triggering.md` §2, `01-type-system.md`'s "Series recurrence"
section, and `02-timestamp-model.md` first.

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
  primitive used by the Stage 1 backfill — leave it working until Stage 10.
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
- Drop the infinite requirement, but still require **at least one** occurrence
  from the probe/DTSTART (an empty series is invalid).

Return `{ rrule: SeriesRrule; parts: SeriesRruleParts }`; add `SeriesRruleSchema`
(valibot pipe) alongside `RruleSchema`.

### 2. `occurrencesBetween`

```ts
export function occurrencesBetween(
  parts: SeriesRruleParts, dtstart: IsoDateTime,
  after: IsoDateTime | null, through: IsoDateTime,
): IsoDateTime[]
```

- Build the rule with `dtstart` as the **fixed anchor instant** (not `after`).
  This is the core difference from `nextOccurrence`.
- Enumerate occurrences `> after` (or `>= dtstart` when `after === null`) and
  `<= through`. Respect the rule's own `COUNT`/`UNTIL` so a finite rule stops.
- Return `IsoDateTime[]`, ascending. Hard-cap the length (e.g. 10 000, matching
  the `COUNT` cap) as a runaway guard; throw/log on cap hit.
- Edge cases to test: `after === dtstart` excludes `dtstart`; `after` between two
  occurrences returns from the next; `through < dtstart` → `[]`; a `COUNT` rule
  used up before `through` returns only the survivors; a sub-day rule
  (`FREQ=HOURLY` / minute intervals) enumerates within a day.

### 3. `isSeriesExhausted`

```ts
export function isSeriesExhausted(
  parts: SeriesRruleParts, dtstart: IsoDateTime, after: IsoDateTime,
): boolean
```

True iff the rule is finite (`count`/`until`) **and** has no occurrence strictly
after `after` (`rule.after(fromInstant, false) === null`). Infinite rules → always
`false`. This flips a duty to `ended` (Stage 4).

### 4. No timezone resolver

Decision 4 removes the `todayInZone` / per-user "today" resolution an earlier
draft placed here — there is nothing to add. The materializer receives a UTC
`now` computed by the trigger edge (Stage 5) as `Date.now()`; this module never
sees a timezone. A `Timezone` brand, if present, is used only for PWA
presentation (Stage 8), not here.

### 5. Tests (`worker/test/` — deep-coverage stage)

- `parseSeriesRrule`: accepts `FREQ=DAILY;COUNT=30`,
  `FREQ=WEEKLY;UNTIL=…Z`, a time-of-day rule (`FREQ=DAILY` from a datetime
  `DTSTART` at 09:00Z), and all the infinite forms; rejects `COUNT=0`,
  `COUNT=99999`, `COUNT`+`UNTIL` together, and an empty series.
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
- No timezone/`today` resolver exists in this module.
- Root `npm run verify` passes.
- Check off Stage 2 in the implementation todo.
