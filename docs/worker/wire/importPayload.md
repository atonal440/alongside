# worker/src/wire/importPayload.ts

Wire parser for `POST /api/import` payloads. The parser treats import JSON as untrusted input and returns a normalized export-v1 shape before the domain import planner can build storage operations.

## Schemas

**`ProjectRowSchema`**, **`TaskLinkRowSchema`** — Re-exported from `shared/wire/rows`. Field-level validation only; see `docs/shared/wire.md`.

**`ImportTaskRowSchema`** *(local, not exported)* — Wraps `taskRowEntries` from `shared/wire/rows` with import-specific legacy tolerance: `defer_kind` and `defer_until` become optional, and the pre-006 `snoozed_until` field is accepted and normalized into the current defer shape (`defer_kind = 'until'`, `defer_until = snoozed_until`). Current defer fields win when both are present.

**`ActionLogRowSchema`** — Validates imported action-log rows: numeric id, known tool name, optional task id, bounded title/detail, and timestamp. Import-only; the PWA does not receive action-log rows.

**`ImportV1Schema`** — Validates the top-level export/import shape: `version`, `exported_at`, `projects`, `tasks` (via `ImportTaskRowSchema`), `links`, `preferences`, and optional `action_log`.

## Functions

**`parseImport(input)`** — Parses unknown JSON through `ImportV1Schema` and returns a `Result<ParsedImportPayload, ValidationError[]>`. Structural and field-level failures are reported with a `payload` path prefix.
