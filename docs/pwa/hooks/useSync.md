# pwa/src/hooks/useSync.ts

## Functions

**`useSync()`** — Manages server synchronization lifecycle. On mount, runs an initial `flushPendingOps` + `syncFromServer` cycle. Sets up a `setInterval` for periodic sync (default 30 s). Listens for `SYNC_PENDING_OPS` messages from the service worker to trigger an immediate flush when background sync fires. Updates `syncStatus` in app state throughout (`'syncing'` → `'synced'` or `'offline'`). Returns nothing — side-effect only hook called once in `AppShell`.
