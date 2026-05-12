# worker/src/wire/importPayload.ts

Initial import payload schema scaffold.

## Schemas

**`ImportV1Schema`** — Validates the top-level export/import shape and applies branded parsers to IDs, statuses, timestamps, RRULE strings, and link types.

This is not yet the full import pipeline; legacy transforms and cross-row integrity checks are reserved for the import slice.
