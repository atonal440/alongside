# shared/parse/primitives.ts

Valibot-backed primitive parsers and branded primitive types. These are the foundation for parsing untrusted data at worker boundaries.

## Types

**`ValidationError`** — Structured parse error with `path`, `code`, and `message`.

**`IsoDate`** — Branded `YYYY-MM-DD` calendar date.

**`IsoDateTime`** — Branded ISO date-time requiring `Z` or an explicit offset.

**`IanaTimezone`** — Branded IANA timezone name. Accepts canonical `UTC` in addition to zones returned by the runtime's IANA timezone list.

**`NonEmptyString<Max>`**, **`BoundedString<Max>`**, **`PositiveInt<Max>`**, **`PositiveFiniteNumber<Max>`** — Branded constrained scalar types.

## Schemas And Parsers

Exports Valibot schemas and parser helpers for each primitive, plus `parseSchema` for converting Valibot `safeParse` output into the shared `Result` shape.

`validationError` and `valibotIssueToValidationError` normalize parse errors for REST/MCP response mapping.
