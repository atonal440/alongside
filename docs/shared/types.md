# shared/types.ts

Thin re-export layer consumed by both the worker and the PWA via the `@shared/types` path alias. Core entity types (`Task`, `Project`, `TaskLink`, `ActionLog`) are derived from the Drizzle schema in `shared/schema.ts` using `$inferSelect`, so they stay automatically in sync with the database schema.

## Types

**`Task`** — Re-exported from `shared/schema.ts`. Core task entity; see schema doc for fields.

**`Project`** — Re-exported from `shared/schema.ts`. Project entity grouping related tasks.

**`TaskLink`** — Re-exported from `shared/schema.ts`. Directed dependency edge between two tasks.

**`ActionLog`** — Re-exported from `shared/schema.ts`. A single action log row.

**`PendingOp`** — PWA-only concept (no DB table). A write operation queued in IndexedDB for later sync when the app is offline. Fields: `id`, `method` (HTTP verb), `path`, `body`, `local_id`, `created_at`.

**`TaskCreate`** — Input shape for creating a task. `title` required; `notes`, `due_date`, `recurrence`, `task_type`, `project_id`, `kickoff_note` optional.

**`TaskUpdate`** — Input shape for updating a task. All fields optional. Includes `focused_until` and `snoozed_until`.

**`ProjectCreate`** — Input shape for creating a project. `title` required; `kickoff_note` and `notes` optional.

**`ProjectUpdate`** — Input shape for updating a project. All fields optional (`title`, `notes`, `kickoff_note`, `status`).
