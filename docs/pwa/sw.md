# pwa/src/sw.ts

Workbox-powered service worker. Built via `vite-plugin-pwa` using the `injectManifest` strategy, which gives full control over the SW logic while still using Workbox for precaching.

## Behavior

- **Precaching** — All Vite build artifacts are precached at install time via the injected `WB_MANIFEST` placeholder.
- **Cache-first strategy** — Static assets (JS, CSS, images) are served from cache and updated in the background.
- **Network-first strategy** — API requests (`/api/*`) always try the network first, falling back to cache when offline.
- **Background sync** — Listens for `SYNC_PENDING_OPS` messages from the PWA and triggers `flushPendingOps` to flush the IndexedDB queue when connectivity is restored.

No named exports — the service worker file is a standalone script registered by `App.tsx`.
