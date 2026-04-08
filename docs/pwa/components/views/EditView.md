# pwa/src/components/views/EditView.tsx

## Components

**`EditView`** — Edit form for a single task. Fields: title (text), notes (textarea), due date (date input), recurrence (text, RRULE-like), kickoff note (textarea), and project (select). Also has a link-management section for adding/removing "blocks" relationships to other tasks. Saves via `updateTaskAction` on submit and navigates back to `DetailView`.
