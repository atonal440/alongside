# shared/parse/time.ts

Time helpers built on the branded primitive date/time types.

## Functions

**`nowUtc()`** — Returns the current timestamp as a branded `IsoDateTime`.

**`todayInTz(tz, date?)`** — Returns the calendar date for a given IANA timezone.

**`nowInTz(tz)`** — Returns both the timezone-local date and current UTC date-time.

The module also re-exports `parseIsoDate`, `parseIsoDateTime`, and `parseIanaTimezone`.
