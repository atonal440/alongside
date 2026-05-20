# shared/parse/recurrence.ts

Typed RRULE support for the worker type-safety migration.

## Types

**`Rrule`** — Branded supported RRULE string.

**`RruleParts`** — Parsed recurrence parts: the branded source RRULE, `freq` (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`), and bounded positive `interval`.

## Functions

**`parseRrule(input)`** — Parses a supported RRULE and returns both the branded string and parsed parts.

**`nextOccurrence(parts, from)`** — Computes the next ISO date from parsed recurrence parts and a branded `IsoDate` using `rrule` under the Alongside profile boundary.

## Schema

**`RruleSchema`** — Valibot schema for infinite date-only RRULE strings. The supported subset includes `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, optional `INTERVAL`, and date-level filters (`BYDAY`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, `BYSETPOS`, `WKST`). `COUNT`, `UNTIL`, `BYHOUR`, `BYMINUTE`, `BYSECOND`, recurrence sets, and exceptions are rejected until recurrence has a series anchor model. Occurrence generation follows RRULE skip semantics for invalid dates instead of clipping to the last day of a month or year.
