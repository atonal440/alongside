# worker/src/wire/importPayload.ts

Wire parser for `POST /api/import` payloads. The parser treats import JSON as untrusted input and returns a normalized export-v1 shape before the domain import planner can build storage operations.

## Schemas

**`ProjectRowSchema`** — Validates project row fields from an export file: project id, non-empty title, bounded notes/kickoff text, status, and timestamps.

**`TaskRowSchema`** — Validates task row fields with branded ID, enum, date, timestamp, and RRULE parsers. It accepts the pre-006 legacy `snoozed_until` field and normalizes it into `defer_kind = 'until'` plus `defer_until`; current defer fields win when present.

**`TaskLinkRowSchema`** — Validates link endpoint IDs and link type.

**`ActionLogRowSchema`** — Validates imported action-log rows, including numeric id, known tool name, optional task id, bounded title/detail, and timestamp.

**`ImportV1Schema`** — Validates the top-level export/import shape: `version`, `exported_at`, `projects`, `tasks`, `links`, `preferences`, and optional `action_log`.

## Functions

**`parseImport(input)`** — Parses unknown JSON through `ImportV1Schema` and returns a `Result<ParsedImportPayload, ValidationError[]>`. Structural and field-level failures are reported with a `payload` path prefix.
