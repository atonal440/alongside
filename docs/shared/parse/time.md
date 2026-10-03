# shared/parse/time.ts

`Timezone`, `TimezoneSchema`, and `parseTimezone` are compatibility aliases
for the shared `IanaTimezone` brand and codec in primitives. Recurrence and
structured planning therefore accept the same named zones.

The codec accepts exact UTC, runtime-enumerated names, and correctly cased,
slash-separated identifiers accepted by Intl, including IANA aliases such as
Asia/Kolkata, Europe/Kyiv, US/Eastern, and Etc/GMT+5. It preserves the supplied
spelling: canonical names vary with runtime ICU data. Unknown identifiers,
lowercase names, bare abbreviations such as EST/GMT, and numeric offsets reject.
Nullability is a caller concern; recurrence treats null and explicit UTC alike.

`nowUtc()` returns the current branded instant. The module re-exports
`parseIsoDate`, `parseIsoDateTime`, and `parseIanaTimezone`.

Structured planning resolution lives in `shared/temporal/` and reports
request/workspace/UTC fallback selection. See
[temporal foundation](../temporal-foundation.md). Host-local todayInTz/nowInTz
remain removed.
