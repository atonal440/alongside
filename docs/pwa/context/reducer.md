# pwa/src/context/reducer.ts

Pure state management logic. No side effects, no async — just types and the reducer function.

## Exports

**`AppState`** (interface) — Complete global UI state: `tasks`, `projects`, `links` (arrays from IndexedDB), `currentView` (which view is active), `selectedTaskId`, `syncStatus` (`'synced' | 'syncing' | 'offline'`), `toast` (optional message string), and `apiConfig` (base URL + auth token).

**`AppAction`** (type) — Discriminated union of every action the reducer handles. Includes `LOAD_INITIAL`, `SET_TASKS`, `SET_PROJECTS`, `SET_LINKS`, `ADD_TASK`, `UPDATE_TASK`, `DELETE_TASK`, `SET_VIEW`, `SET_SYNC_STATUS`, `SET_TOAST`, `SET_API_CONFIG`, and others.

**`getInitialState()`** — Reads `apiConfig` from `localStorage` and returns the default `AppState` with empty arrays and `currentView: 'suggest'`.

**`reducer(state, action)`** — Processes each `AppAction` and returns a new `AppState`. Handles all task/project/link list mutations and UI state transitions. Used exclusively in `AppContext.tsx`.
