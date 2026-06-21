# pwa/src/components/task/DeferMenu.tsx

## Components

**`DeferMenu`** — Inline popover offered by `SuggestView` and `AllView`'s detail panel for deferring a task. Presents quick options (Tomorrow, Next week, 2 weeks, Someday) plus a "Pick date…" affordance that reveals an `<input type="date">`. Calls `onChoose` with a `DeferInput` discriminated union; calls `onCancel` when the user dismisses. Accepts an optional `taskTitle` when the menu is opened from a command target outside the currently rendered card. The component itself constructs `IsoDateTime` values from date strings and serves as the form boundary for defer selection — no further parsing needed downstream.

## Props

| Prop | Type | Description |
|------|------|-------------|
| `onChoose` | `(choice: DeferInput) => void` | Emits a typed defer commit |
| `onCancel` | `() => void` | Called on dismiss |
| `taskTitle` | `string?` | Shown in the accessible dialog label and heading |

## Types

**`DeferInput`** (from `domain/taskMutations`) — Discriminated union: `{ kind: 'someday' }` or `{ kind: 'until'; until: IsoDateTime }`. Replaces the old `DeferChoice` export.

## See Also

- [[SuggestView]] — hosts DeferMenu in the task action bar and command-targeted mode
- [[AllView]] — hosts DeferMenu in the task detail panel
- [[actions]] — `deferTaskAction` accepts `DeferInput` directly
- [[taskMutations]] — `DeferInput` definition
- [[taskFlow]] — `defer` action in `TASK_FLOW_CHART` determines when DeferMenu is shown
