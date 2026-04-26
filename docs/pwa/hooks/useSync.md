# pwa/src/hooks/useSync.ts

## Functions

**`useSync()`** — Manages server synchronization lifecycle. When worker config is present, runs an initial `flushPendingOps` + `syncFromServer` cycle, sets up a 30 s periodic sync interval, and listens for service-worker sync messages. When config is missing, it leaves the app in `idle` and does not attempt network sync. Updates `syncStatus` in app state throughout (`'syncing'` → `'online'` or `'offline'`). Returns nothing — side-effect only hook called once in `AppShell`.
