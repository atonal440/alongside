# pwa/src/context/AppContext.tsx

React context wiring. Provides global app state and dispatch to the entire component tree.

## Exports

**`AppContext`** — React context object typed as `{ state: AppState; dispatch: Dispatch<AppAction> }`. Consumed via `useAppState` hook (not directly).

**`AppProvider`** — Provider component. Loads tasks, projects, and links from IndexedDB whenever worker config is present, and clears in-memory data when the app is logged out or unconfigured. Wraps children in `AppContext.Provider` with the `useReducer`-managed state and dispatch. This is the only place `useReducer` is called.
