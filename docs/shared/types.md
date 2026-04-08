# shared/types.ts

Shared TypeScript types imported by both the worker and the PWA via the `@shared/*` path alias. This is the single source of truth for core data shapes.

## Types

**`Task`** — Core task entity. Holds all fields stored in D1 and IndexedDB: `id`, `title`, `status` (`active | done | snoozed | pending`), `due_date`, `recurrence`, `notes`, `kickoff_note`, `project_id`, `session_id`, `created_at`, `updated_at`.

**`Project`** — Project entity grouping related tasks. Fields: `id`, `title`, `kickoff_note`, `status` (`active | done`), `created_at`, `updated_at`.

**`TaskLink`** — Directed dependency edge between two tasks. Fields: `from_task_id`, `to_task_id`, `link_type` (`blocks`).

**`PendingOp`** — A write operation queued in IndexedDB for later sync when the app is offline. Holds `id`, `method` (HTTP verb), `path`, `body`, `created_at`, and `attempts`.

**`TaskCreate`** — Subset of `Task` fields accepted when creating a task. `title` is required; everything else is optional.

**`TaskUpdate`** — Subset of `Task` fields accepted when updating a task. All fields optional.

**`ProjectCreate`** — Subset of `Project` fields accepted when creating a project. `title` required, `kickoff_note` optional.

**`ProjectUpdate`** — Subset of `Project` fields accepted when updating a project. All fields optional.
