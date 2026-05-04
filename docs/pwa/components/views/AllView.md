# pwa/src/components/views/AllView.tsx

## Components

**`AllView`** — The "All Tasks" view. Displays tasks under one of four status chips (Ready / Deferred / Someday / Done) with running counts; the Ready tab additionally splits into ready and blocked groups. Supports task creation from the filter input, sorting by readiness/due/project, project filtering, and task actions from the detail panel including a `Defer` action that opens an inline `DeferMenu`. List item meta slots render `TaskFlow.metaLabel` as a badge when present, otherwise they fall back to the readiness score track.

The detail panel renders task note previews with the shared `Markdown` component, which sanitizes task-authored markdown before injecting HTML.

**Narrow-viewport layout (≤ 680 px):** the wrapper receives the `.has-detail` CSS class when `state.detailTaskId` is set. CSS rules in the `@media (max-width: 680px)` block hide the list column when `.has-detail` is present and hide the detail panel when it is absent, so only one panel is visible at a time. A `← Back` button rendered inside `.detail-breadcrumb` (hidden on desktop via `display: none`) clears `detailTaskId` and pushes the updated nav state, returning the user to the list.

## See Also

- [[DeferMenu]] — inline defer popover in the task detail panel
- [[TaskStack]] — used where task rows have in-section blocking relationships
- [[taskFlow]] — `deriveTaskFlow` drives status chips and `metaLabel` badge copy
- [[readiness]] — Ready/Blocked split uses `isReady` and `hasActiveBlocker`
- [[Markdown]] — sanitized notes renderer used in the detail panel
