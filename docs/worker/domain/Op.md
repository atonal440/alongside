# worker/src/domain/Op.ts

Operation and plan types for the mutation pipeline.

## Types

**`Op`** — Discriminated union for task, project, link, preference, log, and wipe mutations. `worker/src/storage/apply.ts` exhaustively translates these into D1 statements.

**`PreCheck`** — Read-only assertions that must pass before a plan is applied.

**`Plan`** — Ordered mutation plan plus pre-checks.

## Functions

**`emptyPlan()`** — Returns an empty plan for tests and planner composition.
