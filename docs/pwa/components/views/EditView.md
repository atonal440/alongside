# pwa/src/components/views/EditView.tsx

## Components

**`EditView`** — Edit form for a single task. Fields: title (text), notes (textarea), due date (date input), recurrence (select), defer state (`None` / `Until…` / `Someday`, with a required date input for `Until…`), kickoff note (textarea), session note (textarea), and relationship management. Saves via `updateTaskAction` on submit and navigates back to `DetailView`. Existing `Until…` deferrals keep their original timestamp when the date itself is unchanged.
