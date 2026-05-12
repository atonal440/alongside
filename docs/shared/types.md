# shared/types.ts

Thin re-export layer consumed by both the worker and the PWA via the `@shared/types` path alias. Core entity types (`Task`, `Project`, `TaskLink`, `ActionLog`, `Duty`) are derived from the Drizzle schema in `shared/schema.ts` using `$inferSelect`, so they stay automatically in sync with the database schema.

## Types

**`Task`** — Re-exported from `shared/schema.ts`. Core task entity; see schema doc for fields.

**`Project`** — Re-exported from `shared/schema.ts`. Project entity grouping related tasks.

**`TaskLink`** — Re-exported from `shared/schema.ts`. Directed dependency edge between two tasks.

**`ActionLog`** — Re-exported from `shared/schema.ts`. A single action log row.

**`Duty`** — Re-exported from `shared/schema.ts`. A schedule-driven task template; materializes into real tasks on its `next_fire_at` cadence.

**`PendingOp`** — PWA-only concept (no DB table). A write operation queued in IndexedDB for later sync when the app is offline. Fields: `id`, `method` (HTTP verb), `path`, `body`, `local_id`, `created_at`.

**`TaskCreate`** — Input shape for creating a public one-shot task. `title` required; `notes`, `due_date`, `task_type`, `project_id`, and `kickoff_note` optional. Task-level `recurrence` is intentionally excluded because new recurring work is represented by duties.

**`DutyTaskCreate`** — Internal task creation shape used only by duty materialization. Extends `TaskCreate` with required `duty_id` and `duty_fire_at` idempotency keys.

**`TaskUpdate`** — Input shape for updating a task. All fields optional. Includes `focused_until`, `defer_until`, and `defer_kind`. `recurrence` remains only for clearing legacy rows; new schedules belong on duties.

**`ProjectCreate`** — Input shape for creating a project. `title` required; `kickoff_note` and `notes` optional.

**`ProjectUpdate`** — Input shape for updating a project. All fields optional (`title`, `notes`, `kickoff_note`, `status`).

**`DutyCreate`** — Input shape for creating a duty. `title` and `recurrence` required; `notes`, `kickoff_note`, `task_type`, `project_id`, `due_offset_days`, `active`, `next_fire_at`, and `first_fire_date` optional. `first_fire_date` is a YYYY-MM-DD convenience input that the worker resolves to `next_fire_at` (midnight in user tz); direct `next_fire_at` inputs are stored as canonical UTC ISO instants.

**`DutyUpdate`** — Input shape for updating a duty. All fields optional (`title`, `notes`, `kickoff_note`, `task_type`, `project_id`, `recurrence`, `due_offset_days`, `active`, `next_fire_at`). Direct `next_fire_at` inputs are stored as canonical UTC ISO instants.
