# pwa/src/components/views/AllView.tsx

## Components

**`AllView`** — The "All Tasks" view. Displays tasks under one of four status chips (Ready / Deferred / Someday / Done) with running counts; the Ready tab additionally splits into ready and blocked groups. Supports task creation from the filter input, sorting by readiness/due/project, project filtering, and task actions from the detail panel including a `Defer` action that opens an inline `DeferMenu`. List item meta slots render `TaskFlow.metaLabel` as a badge when present, otherwise they fall back to the readiness score track.

The detail panel renders task note previews with the shared `Markdown` component, which sanitizes task-authored markdown before injecting HTML.
