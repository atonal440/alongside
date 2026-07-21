# shared/parse/time.ts

Time helpers and the duty-local recurrence-zone boundary.

## Types and schema

**`Timezone`** — Branded IANA timezone used only as a duty's recurrence anchor
zone.

**`TimezoneSchema` / `parseTimezone(input)`** — Accept exact `UTC` or membership
in the runtime's canonical `Intl.supportedValuesOf('timeZone')` list and return
the duty-specific brand. Noncanonical aliases are rejected. Nullability is a
caller concern; recurrence treats null and explicit `UTC` identically.

## Functions

**`nowUtc()`** — Returns the current timestamp as a branded `IsoDateTime`.

The module also re-exports `parseIsoDate`, `parseIsoDateTime`, and `parseIanaTimezone`.

There is intentionally no global or user-wide date resolver. Stage 2 removed
`todayInTz` and `nowInTz`; zoned calendar conversion occurs only inside the
series recurrence primitives using each duty's own `Timezone`.
