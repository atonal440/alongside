# worker/src/storage/apply.ts

Typed mutation plan executor for D1.

## Types

**`ApplySummary`** — Minimal result summary with applied operation count.

**`ApplyResult`** — `Result<ApplySummary, AppError>`.

**`PlanApplier`** — Interface for applying a typed `Plan`.

## Functions

**`applyPlan(d1, plan)`** — Runs every precheck before mutation, converts each `Op` into D1 prepared statements, and executes the statements in planner-provided order. `task.exists` and `project.exists` return typed `not_found` errors before any batch runs. `link.blocks_acyclic` uses a recursive D1 query to reject a new `blocks` edge when the target can already reach the source. It also emits an in-batch cycle guard so concurrent graph changes can abort the mutation batch instead of creating a cycle. Custom prechecks currently return `invariant_violation` until a future slice gives them semantics.

The executor also emits in-batch existence guards for task/project prechecks and task/project update/delete targets, so a row that disappears between precheck and mutation aborts the batch and is reported as `not_found` instead of becoming a silent zero-row write.

Every logical plan is one transactional D1 batch, capped at
`MAX_ATOMIC_STATEMENTS = 100`. The executor first prepares the actual SQL and
counts every statement, including assertions, implicit existence guards, wipe
side effects and action logs. Preparation/binding performs no database I/O.
Oversized plans return `capacity_exceeded` with `requiredStatements` and `limit`
before prechecks or mutations run. There is no multi-batch chunking path.

`checkPlanCapacity(d1, plan)` uses the same SQL renderer as apply, allowing an
import dry-run to validate exactly the plan that would execute. Empty update
patches produce no SQL. Future receipt/feed/side-effect ops count automatically
when added to that renderer. Oversized replacement imports require a separately
designed staging protocol; splitting a replacement into several wipes loses
data and is not a supported workaround.

Task and project update SQL is built from fixed allowlists, so unexpected patch keys are ignored instead of becoming column names.

Project deletes clear `tasks.project_id` before deleting the project row, matching the current "delete the project, keep the tasks" storage behavior and avoiding a foreign-key failure for non-empty projects.

## Duty materialization guards

A duty-backed task insert requires both duty_id and occurrence_at. It executes
only while the live duty is active and last_spawned_at is null or strictly before
that occurrence. ON CONFLICT(duty_id, occurrence_at) DO NOTHING makes an occurrence
replay benign without hiding unrelated primary-key or constraint errors.

The duty.update_cursor op atomically changes last_spawned_at and next_occurrence_at
only for an active duty and a strictly newer cursor. A materialization plan must
order inserts before its cursor update in the same batch. Older plans therefore
cannot insert behind a newer committed cursor or regress either cursor field.
Historical tasks retain identity and state. Duty planners and drivers are future
work; later revision/ledger contracts must build on these guards.

`task.restore` is an unconditional insert used by both legacy and v2 import.
Restoring historical rows must bypass active-status and live-cursor predicates;
it still enforces ordinary database constraints and transactional rollback.
Both insert paths reject unpaired duty_id/occurrence_at during preparation,
before any wipe or other mutation executes.
