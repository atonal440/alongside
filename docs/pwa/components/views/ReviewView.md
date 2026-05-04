# pwa/src/components/views/ReviewView.tsx

The end-of-day Review view. Provides a structured close-out surface for active work sessions. Renders four panels in a grid layout; each panel is populated from local state with no separate data fetch.

## Panels

| Panel | Contents |
|---|---|
| **Current Focus** | Tasks whose `focused_until` timestamp is still in the future, sorted latest-first. Each row offers Mark complete and Edit notes actions. |
| **Done Today** | Up to 4 tasks completed today (matched by `updated_at` date prefix). Offers Edit notes to add a closing session note. |
| **Carry Forward** | Pending tasks that have a `session_log` note or an expired `focused_until` — work that was started but not finished. Prompts to add or edit a carry-forward note so context survives the session boundary. |
| **Next Suggestion** | The top item from `suggestQueue` that is not already in the Current Focus panel. Offers a Focus next action that sets `focused_until` and navigates to the Today view. |

When all four panels are empty, a minimal empty state prompts the user to focus a task or finish something before using the Review view.

## Components

**`ReviewView`** — Root export. Derives all panel data from `AppState` using `useMemo`; calls `completeTaskAction` and `focusTaskAction` from the context actions module for mutations.

**`ReviewPanel`** — Internal wrapper rendering a titled section with a consistent layout. Accepts `title` and `children`.

**`ReviewTask`** — Internal row component for a single task within a panel. Displays project name, task title, and an optional `session_log` preview. Accepts up to two labeled action buttons.

## See Also

- [[SuggestView]] — Today view; navigated to when "Focus next" is activated
- [[suggestQueue]] — provides the Next Suggestion task
- [[actions]] — `completeTaskAction`, `focusTaskAction`
- [[TaskCard]] — heavier card used in other views; ReviewTask is a lighter panel-specific variant
