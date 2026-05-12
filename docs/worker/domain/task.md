# worker/src/domain/task.ts

Domain task shapes for the worker type-safety migration.

## Types

**`DeferState`** — Atomic defer state: none, someday, or until a branded timestamp.

**`Focus`** — Atomic focus state: unfocused or focused until a branded timestamp.

**`Recurrence`** — One-shot or recurring task recurrence state.

**`TaskBase`** — Fields common to pending and done task domain values.

**`PendingTaskDomain`**, **`DeferredPendingTaskDomain`**, **`DoneTaskDomain`**, **`TaskDomain`** — Lifecycle-specific task union. Future planners should accept the narrowest lifecycle type they can operate on.
