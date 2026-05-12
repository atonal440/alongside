---
tags: [overview, pwa]
---

# PWA — Code Structure and Design Principles

The alongside PWA is a React + TypeScript single-page application built with Vite. It is **offline-first**: the local IndexedDB is the primary data store and the source of truth for the UI. The Cloudflare Worker is authoritative over the long term but the app functions fully without a network connection and catches up when one is available.

## Data model

All data lives in four IndexedDB object stores (mirroring the worker's D1 schema):

| Store | Contents |
|---|---|
| `tasks` | Every task row including deferred and completed ones |
| `projects` | All projects including archived ones |
| `links` | Task dependency edges (`from_task_id`, `to_task_id`, `link_type`) |
| `pendingOps` | Serialized API calls queued while offline |

The IDB schema is initialized by [[idb-db|pwa/src/idb/db.ts]] on first open; each store is managed by its own module ([[idb-tasks|idb/tasks.ts]], [[idb-projects|idb/projects.ts]], [[idb-links|idb/links.ts]], [[pendingOps|idb/pendingOps.ts]]). These modules are plain async functions with no React dependency — they are imported by action creators and the sync hook, not by components.

React state (AppState) holds in-memory copies of the same arrays plus all UI state. It is always derived from IDB on boot and kept in sync by the action creators.

## State management

Global state lives in a single `useReducer` with no external library. The shape is defined in [[reducer|pwa/src/context/reducer.ts]] as `AppState`:

```
AppState {
  tasks, projects, links   — full IDB data in memory
  currentView              — which view is active ('suggest' | 'all' | 'review' | 'detail' | 'edit')
  selectedTaskId           — detail/edit target
  selectedProjectId        — project filter for AllView
  statusFilter             — ready | deferred | someday | done (AllView chips)
  syncStatus               — idle | syncing | online | offline
  toastMessage             — transient notification text
  apiBase, authToken       — worker config from localStorage
}
```

[[AppContext|pwa/src/context/AppContext.tsx]] provides `state` and `dispatch` to the entire tree. Components read from `state` and call action creators (not `dispatch` directly) for writes.

## Write path: action creators

All writes go through [[actions|pwa/src/context/actions.ts]]. Each action creator follows the same pattern:

1. Write to IDB immediately
2. Dispatch to React state (optimistic update)
3. Attempt the corresponding REST call via `apiFetch`
4. If offline or the call fails, enqueue a `PendingOp` in IDB for later replay
5. On success, update IDB and React state with the server's response (handles ID remapping for newly created tasks)

This keeps the UI responsive regardless of network state. Temp IDs (local nanoids) are remapped to server IDs when the server confirms creation; subsequent pending ops that reference the temp ID are also updated so the flush order is consistent.

## Sync lifecycle

[[useSync|pwa/src/hooks/useSync.ts]] is called once in `AppShell` and manages the full sync lifecycle:

1. On mount: browser timezone sync → `flushPendingOps` → `syncFromServer`
2. Every 30 seconds: repeat
3. On service worker sync message: repeat

[[sync|pwa/src/api/sync.ts]] implements these functions. Browser timezone sync writes the local IANA timezone to the worker before queued writes are flushed, so offline completions cannot trigger duty migration with the default UTC timezone. `flushPendingOps` drains the pending ops queue in chronological order. `syncFromServer` replaces local IDB with a full server pull (tasks, projects, links, duties) and dispatches `SET_*` actions to refresh React state. Conflict resolution is last-write-wins on `updated_at`.

## View model: taskFlow

Task rendering decisions are centralized in [[taskFlow|pwa/src/utils/taskFlow.ts]]. Instead of scattering conditional logic across components, every view calls `deriveTaskFlow(task, context)` and receives a normalized `TaskFlow` object with:

- **`mode`** — `done | focused | someday | deferred | blocked | ready`
- **`statusLabel`** — human-readable status string
- **`metaLabel`** — the single copy source for card meta slots (null for ready/focused, "Until MM/DD" for deferred, "Someday" for someday, statusLabel for others)
- **`actions`** — which action buttons to show on this surface (`focus`, `defer`, `complete`, `reopen`, `edit`, `delete`)
- **`readiness`** — numeric score from [[design|pwa/src/utils/design.ts]] for sorting and score bars

`TASK_FLOW_CHART` is the declarative state table that maps mode → per-surface actions. Adding a new action or mode means editing this table, not hunting through view components.

## Component layers

Components are organized into four groups:

**`components/views/`** — Full-page view containers. Each view owns its layout and coordinates child components. Five views:

| View | Purpose |
|---|---|
| [[SuggestView]] | Default "Today" view — single focused task card + ready queue sidebar |
| [[AllView]] | Task browser — filter chips, sort, search, detail panel |
| [[ReviewView]] | End-of-day close-out — four panels (Current Focus, Done Today, Carry Forward, Next Suggestion) |
| [[DetailView]] | Read-only task detail with dependency visualization |
| [[EditView]] | Task edit form |

**`components/task/`** — Reusable task renderers. Used by multiple views:

| Component | Purpose |
|---|---|
| [[TaskCard]] | Full-detail card (main Suggest card, list items in AllView) |
| [[CompactCard]] | Smaller card for queue sidebar items and dependency rows |
| [[TaskStack]] | Groups a task with its blocked dependents in a list |
| [[TaskMeta]] | Metadata row (project, due date, deferral badge) rendered inside cards |
| [[DeferMenu]] | Inline popover for deferring a task (Tomorrow / Next week / 2 weeks / Someday / pick date) |

**`components/layout/`** — App chrome:

| Component | Purpose |
|---|---|
| [[Header]] | Top bar with nav and search icon |
| [[NavBar]] | Primary view navigation (Today / All / Review) |
| [[Sidebar]] | Settings and logout panel |
| [[SyncStatus]] | Network/sync indicator |

**`components/common/`** — Generic UI primitives:

| Component | Purpose |
|---|---|
| [[SearchBar]] | Global command palette (Cmd K / /) |
| [[AddBar]] | Inline task creation input |
| [[Toast]] | Transient notification overlay |
| [[Markdown]] | Sanitized markdown renderer for task notes |
| [[EmptyState]] | Consistent empty-state placeholder |
| [[SettingsBanner]] | Worker config entry form shown before login |

## Utilities

| Utility | Purpose |
|---|---|
| [[taskFlow]] | View model — `deriveTaskFlow`, `TASK_FLOW_CHART` |
| [[suggestQueue]] | Ordered ready-task list for the Today view and Review panel |
| [[linkMaps]] | Builds `Map<taskId, Task[]>` lookup maps from the flat links array |
| [[design]] | `readinessScore`, `taskSort`, `isBlocked` — shared scoring/sort logic |
| [[genId]] | Nanoid wrapper for locally-generated temp IDs |

## Key design decisions

**IDB is a module layer, not hooks.** The `pwa/src/idb/` modules are pure async functions with no React dependency. They are called from action creators and the sync hook — never from component render paths. This makes them independently testable and avoids the complexity of React-aware IDB abstractions.

**Action creators own the full write path.** No component talks directly to IDB or the API. The action creator pattern (IDB write → dispatch → API attempt → queue if offline) is the only write path, which makes it easy to reason about consistency guarantees.

**Views derive display state from `AppState` in render, not from additional fetches.** Each view calls `useMemo` on the relevant slice of `state.tasks`/`state.links`/`state.projects`. There are no per-view data-fetching hooks.

**`taskFlow` is the view model layer.** Keeping rendering logic out of components and into `deriveTaskFlow` prevents mode-specific conditional branches from accumulating in card and view components. Components receive an already-interpreted `TaskFlow` and render it.

**Optimistic updates with temp IDs.** Task creation assigns a client-generated nanoid immediately. The pending op queue preserves references to the temp ID; when the server response arrives with a real ID, the action creator remaps both IDB records and any queued ops before they flush.

**Service worker via Workbox `injectManifest`.** The [[sw|pwa/src/sw.ts]] strategy keeps full control of SW logic (cache strategy, background sync message) while using Workbox for precaching and asset versioning.
