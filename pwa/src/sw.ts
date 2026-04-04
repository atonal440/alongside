import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';

// Workbox injects the precache manifest list at build time
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// SyncEvent is a background sync API — not yet in standard TS lib
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);

// Network-first for HTML navigation
registerRoute(
  ({ request }: { request: Request }) => request.mode === 'navigate',
  new NetworkFirst({ cacheName: 'alongside-html' }),
);

// Cache-first for static assets
registerRoute(
  ({ request }: { request: Request }) => ['script', 'style', 'image'].includes(request.destination),
  new CacheFirst({ cacheName: 'alongside-assets' }),
);

// Background sync: post message to all clients, main app handles the actual sync
self.addEventListener('sync', ((event: SyncEvent) => {
  if (event.tag === 'sync-tasks') {
    event.waitUntil(
      self.clients.matchAll().then((clients: readonly Client[]) =>
        clients.forEach((c: Client) => c.postMessage({ type: 'sync-requested' })),
      ),
    );
  }
}) as EventListener);
