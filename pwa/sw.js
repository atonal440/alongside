const CACHE_NAME = 'alongside-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only cache GET requests for app shell
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Network first for HTML, cache first for assets
      if (event.request.headers.get('accept')?.includes('text/html')) {
        return fetch(event.request).catch(() => cached);
      }
      return cached || fetch(event.request);
    })
  );
});

// Background sync for offline writes
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-tasks') {
    event.waitUntil(syncTasks());
  }
});

async function syncTasks() {
  // The main app handles sync via its own logic
  const clients = await self.clients.matchAll();
  for (const client of clients) {
    client.postMessage({ type: 'sync-requested' });
  }
}
