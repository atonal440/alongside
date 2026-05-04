# pwa/src/components/common/SearchBar.tsx

Global command palette and search component. Rendered in the app header and accessible from anywhere in the PWA.

## Activation

| Trigger | Effect |
|---|---|
| Click the search icon in the header | Opens the palette |
| `Cmd K` / `Ctrl K` | Opens from any view |
| `/` key | Opens from any view |
| `Escape` | Closes the palette |

## Result groups

| Group | Description |
|---|---|
| **Recent** (no query) | Up to 3 non-done tasks; top 3 projects |
| **Tasks** (with query) | Up to 5 tasks whose title or project name matches |
| **Actions** | Focus / Done / Defer / Edit shortcuts for the first matching task; hovering a different result row shifts the action target |
| **Projects** | Up to 3 projects matching the query |
| **Create** | "Add task" shortcut when the query is non-empty |

## Keyboard navigation

- `Arrow Up` / `Arrow Down` — move the active row
- `Enter` — activate the highlighted row
- Navigating to a task row updates the Actions group target without closing the palette

## Components

**`SearchBar`** — Stateful component. Manages open/closed state, query text, active result index, and the current action-target task. Fires `onCreateTask`, `onOpenTask`, `onOpenProject`, or `onTaskAction` callbacks; the parent wires these to context actions.

**`CommandResultRow`** — Internal row renderer. Renders group labels, a color swatch, title, and a meta badge.

## Types

**`CommandResult`** — Discriminated union: `task | project | create | action`. Each variant carries the data needed to activate it without a secondary lookup.

## See Also

- [[DeferMenu]] — activated by the Defer action result
- [[taskFlow]] — `TaskFlowActionId` type consumed by action results
- [[actions]] — context action creators fired on activation
- [[SuggestView]] — owns a command-targeted `DeferMenu` when the defer action targets an off-queue task
