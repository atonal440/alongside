# pwa/src/context/AppContext.tsx

React context wiring. Provides global app state and dispatch to the entire component tree.

## Exports

**`AppContext`** — React context object typed as `{ state: AppState; dispatch: Dispatch<AppAction> }`. Consumed via `useAppState` hook (not directly).

**`AppProvider`** — Provider component. On mount, loads all tasks, projects, and links from IndexedDB and dispatches `LOAD_INITIAL` to populate state. Wraps children in `AppContext.Provider` with the `useReducer`-managed state and dispatch. This is the only place `useReducer` is called.
