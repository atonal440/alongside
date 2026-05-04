# pwa/src/components/task/DeferMenu.tsx

## Components

**`DeferMenu`** — Inline popover offered by `SuggestView` and `AllView`'s detail panel for deferring a task. Presents quick options (Tomorrow, Next week, 2 weeks, Someday) plus a "Pick date…" affordance that reveals an `<input type="date">`. Calls `onChoose` with a `DeferChoice` discriminated union (`{kind: 'until', untilIso}` or `{kind: 'someday'}`); calls `onCancel` when the user dismisses. Accepts an optional `taskTitle` when the menu is opened from a command target outside the currently rendered card.

## Types

**`DeferChoice`** — Discriminated union representing a single defer commit: either `{ kind: 'until', untilIso: string }` or `{ kind: 'someday' }`.

## See Also

- [[SuggestView]] — hosts DeferMenu in the task action bar and command-targeted mode
- [[AllView]] — hosts DeferMenu in the task detail panel
- [[actions]] — `deferTaskAction` called with the `DeferChoice` on confirm
- [[taskFlow]] — `defer` action in `TASK_FLOW_CHART` determines when DeferMenu is shown
