# pwa/src/components/views/SuggestView.tsx

## Components

**`SuggestView`** — The default "Today" view. Shows a single ready task from `suggestQueue`, presented as a large `TaskCard`, with a side queue for picking another ready task. Search opens matching tasks in the real detail view so done, deferred, or blocked results do not fall back to the first ready queue item. The task action bar replaces the old transient skip with a `Defer` button that opens a `DeferMenu` (1d / 1w / 2w / Someday / pick date), so dismissing a card always commits a durable state change. Search-command defer actions can target any matching task; when the target is outside the ready queue, `SuggestView` renders a command-scoped `DeferMenu` instead of relying on the current card. Task actions call the local-first context actions and sync later when offline. Queue item meta slots use `TaskFlow.metaLabel` for badge copy and otherwise show the readiness score track.

## See Also

- [[suggestQueue]] — provides the ordered ready-task list for the main card and side queue
- [[DeferMenu]] — opened when the user picks Defer from the task action bar
- [[SearchBar]] — command-targeted defer can open a `DeferMenu` for any matching task
- [[ReviewView]] — navigated to when the user opens the Review tab
- [[taskFlow]] — `metaLabel` used for queue item badge copy; `TASK_FLOW_CHART` drives action set
