# pwa/src/context/reducer.ts

Pure state management logic. No side effects, no async — just types and the reducer function.

## Exports

**`AppState`** (interface) — Complete global UI state: `tasks`, `projects`, `links` (arrays from IndexedDB), `currentView` (which view is active), detail/edit selection, project filtering, `statusFilter` (`'ready' | 'deferred' | 'someday' | 'done'` — drives the All view chips), `syncStatus` (`'idle' | 'syncing' | 'online' | 'offline'`), `toastMessage`, and worker config (`apiBase` + `authToken`).

**`StatusFilter`** (type) — `'ready' | 'deferred' | 'someday' | 'done'`. Selected via the chips at the top of `AllView`.

**`AppAction`** (type) — Discriminated union of every action the reducer handles. Includes data replacement, task/project/link upserts and deletes, view/filter/detail/edit state, status filter, sync status, toast messages, worker config, and `LOG_OUT`.

**`getInitialState()`** — Reads worker config from `localStorage` and returns the default `AppState` with empty arrays and `currentView: 'suggest'`. The `alongside_logged_out` marker suppresses dev defaults so an explicit logout stays logged out after refresh.

**`reducer(state, action)`** — Processes each `AppAction` and returns a new `AppState`. Handles all task/project/link list mutations and UI state transitions. `LOG_OUT` clears in-memory task data and worker credentials; the Sidebar logout handler clears IndexedDB before dispatching it so cached tasks, projects, links, and pending ops do not survive across credentials. Used exclusively in `AppContext.tsx`.
