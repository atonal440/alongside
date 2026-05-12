# shared/parse/recurrence.ts

Initial typed RRULE support for the worker type-safety migration.

## Types

**`Rrule`** — Branded supported RRULE string.

**`RruleParts`** — Parsed recurrence parts: `freq` (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`) and bounded positive `interval`.

## Functions

**`parseRrule(input)`** — Parses a supported RRULE and returns both the branded string and parsed parts.

**`nextOccurrence(parts, from)`** — Computes the next ISO date from parsed recurrence parts and a branded `IsoDate`.

## Schema

**`RruleSchema`** — Valibot schema for supported RRULE strings. Full iCal RRULE support is intentionally out of scope for the first worker migration.
