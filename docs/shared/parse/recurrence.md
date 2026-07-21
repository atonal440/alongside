# shared/parse/recurrence.ts

Typed RRULE parsing and occurrence expansion. The module intentionally exposes
two profiles while legacy task recurrence is being migrated to duties.

## Legacy task profile

**`Rrule` / `RruleParts` / `RruleSchema`** — Infinite, date-only RRULEs with
`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, optional `INTERVAL`, and date filters
`BYDAY`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, `BYSETPOS`, and
`WKST`. `COUNT`, `UNTIL`, time parts, recurrence sets, and exceptions remain
invalid in this legacy profile.

**`parseRrule(input)`** — Parses a legacy rule and returns its branded source and
parts.

**`nextOccurrence(parts, from)`** — Computes the next `IsoDate` strictly after
`from`. Invalid calendar targets follow RRULE skip semantics rather than clipping.

## Duty series profile

**`SeriesRrule` / `SeriesRruleFreq` / `SeriesRruleParts` /
`SeriesRruleSchema`** — A separate timed profile for fixed-anchor duties.
Frequencies are `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`, `HOURLY`, and
`MINUTELY`. It supports the legacy date-filter keys plus `COUNT`, `UNTIL`,
`BYHOUR`, and `BYMINUTE`. `COUNT` and `UNTIL` are mutually exclusive;
`SECONDLY`, `BYSECOND`, recurrence sets, and exceptions are rejected.

`UNTIL` accepts only basic UTC datetime text (`YYYYMMDDTHHMMSSZ`). The parser
validates it and stores `parts.until` as canonical minute-resolution UTC
(`YYYY-MM-DDTHH:MM:00Z`); bare dates, extended ISO, offsets, and local forms are
not accepted. UNTIL inclusively bounds the final resolved UTC instants. `COUNT`
counts resolved valid instants, so a nonexistent wall-clock candidate skipped in
a DST gap does not consume a count slot.

**`parseSeriesRrule(input)`** — Validates series rule shape and returns the branded
source plus parsed parts. Whether the anchored rule has at least one occurrence is
checked later, when `dtstart` is available.

**`occurrencesBetween(parts, dtstart, timezone, after, through, limit?)`** —
Returns ascending canonical UTC instants after the exclusive cursor and through
the inclusive boundary. A null cursor includes the first actual occurrence at or
after `dtstart`.

**`nextOccurrenceAfter(...)`**, **`latestOccurrenceAtOrBefore(...)`**, and
**`isSeriesExhausted(...)`** provide the corresponding fixed-anchor lookups.

All series primitives treat null and explicit `UTC` as the same expansion mode.
For another IANA zone they expand floating wall-clock values and resolve them with
`Intl.DateTimeFormat`, independently of the host process timezone. A nonexistent
spring-gap time is skipped; a repeated fall-fold time selects the earliest
matching UTC instant.

**`SERIES_OCCURRENCE_CAP`** is 10,000 and also bounds `COUNT`. Without an
explicit `limit`, an expansion that would exceed it throws
**`SeriesExpansionLimitError`**. An explicit limit must be an integer from 0
through the cap and returns at most that many results without hitting the public
runaway guard.
