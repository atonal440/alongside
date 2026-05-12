# pwa/src/components/views/EditView.tsx

## Components

**`EditView`** — Edit form for a single task. Fields: title (text), notes (textarea), due date (date input), defer state (`None` / `Until…` / `Someday`, with a required date input for `Until…`), kickoff note (textarea), session note (textarea), and relationship management. Duty-derived tasks show the parent duty title; other tasks show a note that repeating work should be created as a duty. Saves via `updateTaskAction` on submit and navigates back to `DetailView`. Existing `Until…` deferrals keep their original timestamp when the date itself is unchanged.
