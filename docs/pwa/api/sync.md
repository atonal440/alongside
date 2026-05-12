# pwa/src/api/sync.ts

Two-phase sync logic between IndexedDB and the Cloudflare Worker. Called by `useSync` on interval and after service worker background sync messages.

## Types

**`SyncResult`** — `{ online: boolean; tasks?: Task[]; projects?: Project[]; links?: TaskLink[]; duties?: Duty[] }`. Returned by `syncFromServer` to indicate what was fetched.

## Functions

**`syncBrowserTimezone(config)`** — Reads the browser's IANA timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone` and sends it to `PUT /api/preferences/timezone` once per page load (and again if it changes). This runs before queued writes are flushed so duty migration triggered by offline completions uses the user's local calendar.

**`flushPendingOps(config, dispatch)`** — Reads all `PendingOps` from IndexedDB and replays them against the server in chronological order using `apiFetch`. On success, deletes each op and dispatches the server's response to update React state. Handles temp-ID remapping: if a `POST /api/tasks` succeeds, the server's real `id` replaces the locally generated nanoid in both IndexedDB and any subsequent pending ops that reference it.

**`syncFromServer(config, dispatch)`** — Fetches the full task, project, link, and duty lists from the server (using `/api/projects/sync` to include archived projects), clears the corresponding IndexedDB stores, writes the server records in, and dispatches `SET_TASKS` / `SET_PROJECTS` / `SET_LINKS` / duties to refresh React state. Returns a `SyncResult` indicating online status and the fetched data.

## See Also

- [[useSync]] — hook that calls these functions on interval and on service worker messages
- [[pendingOps|pwa/src/idb/pendingOps.ts]] — IDB store that `flushPendingOps` drains
- [[idb-tasks|pwa/src/idb/tasks.ts]], [[idb-links|pwa/src/idb/links.ts]], [[idb-projects|pwa/src/idb/projects.ts]] — stores that `syncFromServer` overwrites
- [[client|pwa/src/api/client.ts]] — `apiFetch` used internally for each pending op
