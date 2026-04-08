# pwa/src/hooks/useAppState.ts

## Functions

**`useAppState()`** — Convenience hook that calls `useContext(AppContext)` and returns `{ state, dispatch }`. Throws if used outside `AppProvider`. All components use this instead of importing `AppContext` directly.
