# shared/parse/recurrence.ts

Typed RRULE parsing and fixed-anchor occurrence searches. Legacy tasks and duties
use separate profiles while the duties rollout is incomplete.

## Accepted rules

Legacy `Rrule` stays infinite and date-only: `DAILY|WEEKLY|MONTHLY|YEARLY`
with `INTERVAL` and supported calendar filters. `parseRrule` and
`nextOccurrence` retain their existing behavior.

Duty `SeriesRrule` is timed and accepts up to 4,096 characters:

- `DAILY|WEEKLY|MONTHLY|YEARLY`: `INTERVAL`, supported calendar filters
  (`BYDAY|BYMONTHDAY|BYYEARDAY|BYWEEKNO|BYMONTH|BYSETPOS|WKST`),
  `BYHOUR`, `BYMINUTE`, and either `COUNT` or `UNTIL`.
- `HOURLY|MINUTELY`: only `INTERVAL` and either `COUNT` or `UNTIL`.
  Filters, including `WKST`, are rejected. Filtered subday calendars need a
  separately designed implementation; some library combinations can loop forever.
- `INTERVAL` is 1–999; `COUNT` is 1–10,000. `SECONDLY`, `BYSECOND`,
  recurrence sets, exceptions, duplicate keys, and simultaneous COUNT/UNTIL reject.

Calendar restrictions remain: ordinal weekdays require monthly/yearly frequency;
weekly rules cannot use BYMONTHDAY; BYYEARDAY/BYWEEKNO require yearly frequency;
ordinal BYDAY cannot combine with BYWEEKNO. BYSETPOS needs another filter.

`UNTIL` accepts basic UTC datetime text (`YYYYMMDDTHHMMSSZ`) and normalizes
its parsed value to minute UTC. It inclusively bounds resolved instants. COUNT
counts valid resolved instants; a DST gap does not consume a slot. Shape parsing
cannot prove a series nonempty without its anchor. Creation must call the calendar
search and handle a search-budget failure separately from an empty finite series.

## Calendar API

All functions take `parts, dtstart, timezone`. The anchor is fixed and timed;
null and explicit UTC use the same expansion mode. Outputs are canonical minute
UTC instants.

- `occurrencesBetween(..., after, through, limit?)`: ascending results in
  `(after, through]`; null after includes the first occurrence at/after DTSTART.
- `nextOccurrenceAfter(..., after)`: the next strictly later occurrence, or
  null when the bounded calendar has no next occurrence.
- `latestOccurrenceAtOrBefore(..., instant)`: last occurrence at/before the
  instant; searches backward by calendar period rather than replaying history.
- `isSeriesOccurrence(..., instant)`: exact instant membership, suitable for
  persisted cursor validation without expanding the preceding history.
- `isSeriesExhausted(..., after)`: true only for finite rules with no next
  occurrence. Infinite rules return false.

COUNT rules replay from the fixed anchor to preserve their ordinal bound, limited
to 10,000 valid occurrences. Other searches jump to the relevant period while
preserving the original INTERVAL phase, calendar masks, and positional selection.

For named zones, floating wall times resolve through Intl independently of host
TZ. Gaps skip; folds choose the earliest matching instant. An explicitly stored
DTSTART in the second fold is preserved as the exact anchor.

## Two separate guards

`SERIES_OCCURRENCE_CAP = 10_000` limits output; exceeding it without an explicit
limit throws `SeriesExpansionLimitError`. Explicit limits are integers 0–10,000
and stop after that many results.

`SERIES_SEARCH_WORK_CAP = 100_000` bounds traversal even when periods yield no
matches. It charges periods, inspected days, and candidate visits and throws
`SeriesSearchLimitError`. An explicit output limit does not bypass this guard.
A caller must report/retry or isolate this failure, never treat it as exhaustion
and end a duty or advance a cursor.

`seriesIterator.ts` owns traversal and reuses rrule's calendar masks and
positional helpers. Both packages pin rrule to 2.8.1 because this small adapter
uses internal modules. Upgrade the pin and build aliases together, and run the
calendar differential fixtures, DST tests, worker dry run, and PWA build.

See [the hardening note](../../plans/duties/slice-2-hardening.md) for the failure
cases and the executable storage guards that accompany this calendar foundation.
