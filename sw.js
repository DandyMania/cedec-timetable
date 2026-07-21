// Offline support. The venue Wi-Fi is unreliable, so the app must open from
// cache first and refresh in the background when a network happens to be there.

const VERSION = 'v1';
const SHELL = `cedec2026-shell-${VERSION}`;
const DATA = `cedec2026-data-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './search.js',
  './manifest.webmanifest',
  './icon.svg',
];

// Only the current year is precached; archive years load on demand and are
// kept by the same stale-while-revalidate rule once visited.
const DATA_ASSETS = ['./data/2026/sessions.json', './data/2026/meta.json', './data/years.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      await shell.addAll(SHELL_ASSETS);
      const data = await caches.open(DATA);
      await data.addAll(DATA_ASSETS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, DATA]);
      for (const key of await caches.keys()) {
        if (!keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

/** Serve from cache immediately, then refresh the entry in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached ?? (await network) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const cached = await cache.match('./index.html');
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put('./index.html', response.clone());
            return response;
          })
          .catch(() => null);
        return cached ?? (await network) ?? Response.error();
      })(),
    );
    return;
  }

  const isData = url.pathname.includes('/data/');
  event.respondWith(staleWhileRevalidate(request, isData ? DATA : SHELL));
});
