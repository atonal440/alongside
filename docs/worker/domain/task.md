# worker/src/domain/task.ts

Domain task shapes for the worker type-safety migration.

## Types

**`DeferState`** — Atomic defer state: none, someday, or until a branded timestamp.

**`Focus`** — Atomic focus state: unfocused or focused until a branded timestamp.

**`Recurrence`** — One-shot or recurring task recurrence state.

**`TaskBase`** — Fields common to pending and done task domain values.

**`PendingTaskDomain`**, **`DeferredPendingTaskDomain`**, **`DoneTaskDomain`**, **`TaskDomain`** — Lifecycle-specific task union. Future planners should accept the narrowest lifecycle type they can operate on.

## Functions

**`recurrenceFromRow(dueDate, recurrence)`** — Parses the row-shaped recurrence fields into the `Recurrence` union. It validates `due_date` when present, parses the RRULE into branded `Rrule` plus `RruleParts`, and rejects `recurrence != null` without a due date.

**`taskFromRow(row)`** — Converts a raw task row into `TaskDomain`, validating branded ids, ISO dates, timestamps, task type/status, nullable bounded strings, defer state, focus state, and recurrence state.

**`pendingTaskFromRow(row)`** — Converts a row into `PendingTaskDomain` or returns an `AppError`. Used by completion so already-done tasks fail at the lifecycle boundary instead of being completed again.
