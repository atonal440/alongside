# pwa/src/components/common/AddBar.tsx

## Components

**`AddBar`** — A single-line text input with a submit button for creating new tasks. Parses input with `parseQuickAddTitle` at submit time; shows an inline `role="alert"` error for empty or over-200-character titles. On success calls `onAdd(title: NonEmptyString<200>)` and clears the input. Used at the bottom of `AllView` and `SuggestView`.

## Props

| Prop | Type | Description |
|------|------|-------------|
| `onAdd` | `(title: NonEmptyString<200>) => void` | Called with a validated, trimmed title on submit |
| `placeholder` | `string?` | Input placeholder text |

## Validation

Input is parsed by `parseQuickAddTitle` from `domain/taskForm`. Title must be non-empty after trimming and ≤ 200 characters. Error messages are rendered as `<span role="alert">` and cleared on the next keystroke.

## See Also

- [[taskForm]] — `parseQuickAddTitle` performs the boundary parse
- [[AllView]], [[SuggestView]] — host AddBar
