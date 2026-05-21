# worker/src/domain/ops/import.ts

Import planner for turning a parsed export payload into a typed storage `Plan`.

## Types

**`ImportPlanResult`** — `Result<Plan, AppError>` alias for import planners.

**`ImportPlanner<Payload>`** — Interface for future import payload-to-plan conversion.

**`ImportPayload`** — Domain-facing parsed import shape. It keeps row-shaped `Project`, `Task`, `TaskLink`, and `ActionLog` values plus the preference key/value record; the wire parser is responsible for converting unknown JSON into this shape.

## Functions

**`planImport(payload)`** — Validates cross-row integrity and returns one restore plan: `wipe`, then project inserts, task inserts, link upserts, preference upserts, and action-log inserts. It rejects duplicate project/task/link keys, task project references to missing projects, links to missing tasks, invalid task row/domain states, and unknown or invalid preference values before storage statements are built.
