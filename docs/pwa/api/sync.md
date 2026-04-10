# pwa/src/api/sync.ts

Two-phase sync logic between IndexedDB and the Cloudflare Worker. Called by `useSync` on interval and after service worker background sync messages.

## Types

**`SyncResult`** — `{ online: boolean; tasks?: Task[]; projects?: Project[]; links?: TaskLink[] }`. Returned by `syncFromServer` to indicate what was fetched.

## Functions

**`flushPendingOps(config, dispatch)`** — Reads all `PendingOps` from IndexedDB and replays them against the server in chronological order using `apiFetch`. On success, deletes each op and dispatches the server's response to update React state. Handles temp-ID remapping: if a `POST /api/tasks` succeeds, the server's real `id` replaces the locally generated nanoid in both IndexedDB and any subsequent pending ops that reference it.

**`syncFromServer(config, dispatch)`** — Fetches the full task, project, and link lists from the server (using `/api/projects/sync` to include archived projects), clears the corresponding IndexedDB stores, writes the server records in, and dispatches `SET_TASKS` / `SET_PROJECTS` / `SET_LINKS` to refresh React state. Returns a `SyncResult` indicating online status and the fetched data.
