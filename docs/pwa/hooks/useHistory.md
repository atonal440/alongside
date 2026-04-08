# pwa/src/hooks/useHistory.ts

Bidirectional sync between React app state and the browser History API, enabling back/forward navigation within the SPA.

## Functions

**`pushNav(view, taskId?)`** — Pushes a new History entry with `{ view, taskId }` as state and updates the URL hash, so the current view is bookmarkable and the back button works.

**`replaceNav(view, taskId?)`** — Same as `pushNav` but replaces the current History entry instead of adding one (used for redirects within the same logical screen).

**`useHistory()`** — Hook that registers a `popstate` listener on mount. When the user presses Back or Forward, reads the History state and dispatches `SET_VIEW` (and `SET_SELECTED_TASK` if applicable) to restore the correct view. Cleaned up on unmount.
