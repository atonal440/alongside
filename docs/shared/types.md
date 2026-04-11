# shared/types.ts

Shared TypeScript types imported by both the worker and the PWA via the `@shared/*` path alias. This is the single source of truth for core data shapes.

## Types

**`Task`** — Core task entity. Fields: `id`, `title`, `notes`, `status` (`pending | active | done | snoozed`), `due_date`, `recurrence`, `created_at`, `updated_at`, `snoozed_until`, `focused_until`, `task_type` (`action | plan`), `project_id`, `kickoff_note`, `session_log`.

**`Project`** — Project entity grouping related tasks. Fields: `id`, `title`, `notes`, `kickoff_note`, `status` (`active | archived`), `created_at`, `updated_at`.

**`TaskLink`** — Directed relationship edge between two tasks. Fields: `from_task_id`, `to_task_id`, `link_type` (`blocks | related`).

**`PendingOp`** — A write operation queued in IndexedDB for later sync when the app is offline. Holds `id`, `method` (HTTP verb), `path`, `body`, `local_id`, `created_at`.

**`TaskCreate`** — Subset of `Task` fields accepted when creating a task. `title` is required; everything else is optional.

**`TaskUpdate`** — Subset of `Task` fields accepted when updating a task. All fields optional. Includes `focused_until`.

**`ProjectCreate`** — Subset of `Project` fields accepted when creating a project. `title` required; `kickoff_note` and `notes` optional.

**`ProjectUpdate`** — Subset of `Project` fields accepted when updating a project. All fields optional (`title`, `notes`, `kickoff_note`, `status`).
