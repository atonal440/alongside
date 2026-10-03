# worker/src/domain/ops/import.ts

Import planner for turning a parsed export payload into a typed storage `Plan`.

## Types

**`ImportPlanResult`** — `Result<Plan, AppError>` alias for import planners.

**`ImportPlanner<Payload>`** — Interface for future import payload-to-plan conversion.

**`ImportPayload`** — Domain-facing parsed import shape. It keeps row-shaped `Project`, `Task`, `TaskLink`, and `ActionLog` values plus the preference key/value record; the wire parser is responsible for converting unknown JSON into this shape.

## Functions

**`planImport(payload)`** — Validates cross-row integrity and returns one restore plan: `wipe`, then project inserts, task restores, link upserts, preference upserts, and action-log inserts. Task restores bypass live duty materialization predicates so historical instances survive regardless of duty status or cursor. It rejects duplicate project/task/link keys, task project references to missing projects, links to missing tasks, invalid task row/domain states, and unknown or invalid preference values before storage statements are built.

`DB.importAll` validates generated SQL capacity before both dry-run counts and
apply. Restore uses one transactional batch, including wipe, and rejects plans
over 100 statements without modifying live data. This retains bounded v1 input;
staged large restore and versioned export/epoch work remain separate follow-ups.

The v1 wire parser defaults legacy missing duty identity fields to null and
rejects unpaired duty_id/occurrence_at before dry-run counts or the wipe batch.
