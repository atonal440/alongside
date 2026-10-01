# shared/parse/time.ts

Time helpers and the duty-local recurrence-zone boundary.

## Types and schema

**`Timezone`** — Branded IANA timezone shared by recurrence anchors and planning intent.

**`TimezoneSchema` / `parseTimezone(input)`** — Accept exact `UTC` or membership
in the runtime's canonical `Intl.supportedValuesOf('timeZone')` list, plus
Intl-validated IANA fixed-offset `Etc/GMT±N` identifiers, and return the brand. Noncanonical aliases are rejected. Nullability is a
caller concern; recurrence treats null and explicit `UTC` identically.

## Functions

**`nowUtc()`** — Returns the current timestamp as a branded `IsoDateTime`.

The module also re-exports `parseIsoDate`, `parseIsoDateTime`, and `parseIanaTimezone`.

Legacy host-local `todayInTz` and `nowInTz` remain removed. Structured planning
resolution lives in `shared/temporal/`; it shares `Timezone` and explicitly
reports request/workspace/UTC fallback selection. See
[temporal foundation](../temporal-foundation.md).
