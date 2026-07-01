# Stage 8 — PWA Duties UI

Part of `docs/plans/duties.md`. Prerequisites: Stage 7 (PWA duty data layer).
Read `docs/plans/pwa-type-safety.md`'s form-boundary notes first.

## Goal

Surface duties in the PWA: a Duties view listing duties with their schedule and
status, a duty editor (create/edit), pause/resume/end/delete controls, and a
"from duty" badge on spawned task instances so the user can tell an instance from
a one-off. This completes Phase 1 — duties are usable end to end.

## Context for a cold start

- App shell + view switching: `pwa/src/App.tsx`; views in
  `pwa/src/components/views/` (`EditView.tsx`, `DetailView.tsx`, …). The reducer's
  `SET_VIEW` maps view names (`reducer.ts`; note `'session' → 'review'`).
- The current recurrence UI is a **raw RRULE text input** in `EditView`
  (`pwa/src/components/views/EditView.tsx:168-181`) with `fieldErrors.recurrence`
  handling. Duties reuse this raw-RRULE pattern (an RRULE builder is explicitly
  out of scope — master "Out of Scope").
- Task meta rendering: `pwa/src/components/task/TaskMeta.tsx:15` already prints
  "Recurring" when `task.recurrence` is set; `DetailView.tsx:89` similar. These
  move to a duty-aware "from duty" badge.
- Design helpers (labels, colors, sorting) live in `pwa/src/utils/design.ts`;
  task-card action logic in `pwa/src/utils/taskFlow.ts` (`AGENTS.md` conventions —
  reuse these, don't fork).
- Forms parse at submit via `parseDutyForm` (Stage 7). Never pass raw
  `input.value` into domain types (`AGENTS.md`).
- This is Alongside's design language moment — `alongside-ideas.md` wants "a
  consistent and distinctive UI design" and "focus on one or two tasks at a time,
  avoid big lists." Keep the Duties view calm and small; it's a management
  surface, not a daily driver.

## Steps

### 1. Duties view (`pwa/src/components/views/DutiesView.tsx`, new)

- A list of duties grouped by `status` (active first; paused and ended
  collapsible). Each row shows title, a human-readable cadence summary derived
  from the RRULE (e.g. "Weekly", "Monthly · 3rd Friday", "Daily · 12 left" for
  finite), next occurrence (an instant, formatted in the viewer's local zone —
  presentation only, per Decision 4), and the catch-up policy.
- A cadence-summary helper in `pwa/src/utils/design.ts` that turns
  `SeriesRruleParts` into a short label. Keep it best-effort and total (never
  throws; falls back to the raw rrule string).
- Per-row actions via the existing action-affordance pattern: Edit, Pause/Resume,
  End, Delete (Delete confirms and warns instances remain).
- Wire the view into `App.tsx` and the reducer's view set; add a nav affordance.

### 2. Duty editor (`pwa/src/components/views/DutyEditView.tsx`, new)

- Fields: title, notes, kickoff_note, task_type, project_id, **rrule** (raw text,
  reusing `EditView`'s recurrence input + error affordance), **dtstart** (a
  local date/time picker that resolves to a UTC instant at submit — Decision 4;
  default the time to a sensible hour, e.g. 09:00, when the user picks only a
  date — this default is now *honest* because the anchor zone keeps it stable),
  **timezone** (an IANA anchor-zone select, defaulting to the browser's
  `Intl.DateTimeFormat().resolvedOptions().timeZone`, with an explicit "UTC / no
  anchor" option; set ⇒ "daily at 9" stays 9am across DST — Decision 4),
  **catch_up** (next/all toggle).
- Submit runs `parseDutyForm` (Stage 7); field errors render inline like
  `EditView`'s `fieldErrors.recurrence` (`EditView.tsx:180`).
- **Editing an existing duty:** `rrule` and `dtstart` are **read-only** (immutable
  — Pillar 5). Show them disabled with a "Reschedule" affordance that ends this
  duty and opens a fresh create form. `timezone`, `catch_up`, and template fields
  are editable; note that a timezone change re-anchors only *future* occurrences.
- Optimistic save through the Stage 7 async action; offline-safe.

### 3. Spawned-instance badge (`pwa/src/components/task/TaskMeta.tsx`, `DetailView.tsx`)

- When a task has `duty_id`, render a "from duty" badge (and its
  `occurrence_at`) instead of / in addition to the legacy "Recurring" label.
  For legacy tasks that still carry `recurrence` but no `duty_id` (shouldn't exist
  post-migration, but be defensive), keep the old "Recurring" label.
- Optional: link the badge to the parent duty in the Duties view.
- Remove reliance on `task.recurrence` for the "Recurring" label once `duty_id`
  is the signal; keep a fallback for one release.

### 4. Task creation no longer offers recurrence

- Remove or disable the raw `recurrence` input from the task `EditView` create
  path (`EditView.tsx:168`) — recurrence is now created via a duty. Editing an
  existing legacy recurring task can keep showing it read-only, or offer a
  "convert to duty" affordance (nice-to-have; can defer). At minimum, the create
  path must not let a user set `recurrence` on a plain task, matching the Stage 6
  server rejection.

### 5. Tests (`pwa/test/components/`, jsdom)

- `DutiesView`: renders duties grouped by status; cadence summary for daily /
  weekly / monthly-nth / finite; delete confirmation copy warns instances remain.
- `DutyEditView`: invalid rrule shows the field error and does not submit; valid
  submit dispatches the create/update action with branded values.
- `TaskMeta`: a task with `duty_id` shows the "from duty" badge; a legacy
  recurrence-only task shows "Recurring"; a plain task shows neither.
- `design.ts` cadence summary: table-driven, total (never throws), fallback to
  raw rrule for an unrecognized shape.

### 6. Docs

Update `docs/pwa/overview.md` with the Duties view and editor, and note the
recurrence input's removal from task creation.

## Acceptance criteria

- `npm --prefix pwa run typecheck` / `test` / `build` pass; component suites green.
- A user can create, edit, pause, resume, end, and delete a duty in the UI, fully
  offline (writes queue), and instances appear after sync.
- Spawned instances are visually distinguishable from one-off tasks.
- Task creation no longer exposes a recurrence field.
- Root `npm run verify` passes.
- Check off Stage 8 in the implementation todo. **Phase 1 is complete here.**
