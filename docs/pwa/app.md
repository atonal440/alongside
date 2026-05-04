# pwa/src/App.tsx

Top-level React components. The root of the component tree.

## Components

**`AppShell`** — The main application shell rendered inside `AppProvider`. Reads current view state from `AppContext` and conditionally renders the active view component (`SuggestView`, `AllView`, `ReviewView`, `DetailView`, or `EditView`). Also renders the `Header`, `SyncStatus` indicator, and `Toast` overlay. Registers the service worker on mount.

**`App`** — Root export. Wraps `AppShell` in `AppProvider` so the entire tree has access to global state. This is the component passed to `ReactDOM.render` in `main.tsx`.
