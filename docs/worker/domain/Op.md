# worker/src/domain/Op.ts

Operation and plan scaffolding for the future mutation pipeline.

## Types

**`Op`** — Discriminated union for task, project, link, preference, log, and wipe mutations.

**`PreCheck`** — Read-only assertions that must pass before a plan is applied.

**`Plan`** — Ordered mutation plan plus pre-checks.

## Functions

**`emptyPlan()`** — Returns an empty plan for tests and future planner scaffolding.
