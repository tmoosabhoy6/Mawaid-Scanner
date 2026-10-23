// Lets a gate phone reopen /scanner without a connection. Pages and files always come from the network
// first, so a new version is used as soon as it is deployed; the saved copy is only used when the network fails.
// API requests are never cached: card checks and the card list always go to the server or to the phone's own list.
const CACHE = 'mawaid-scanner-v1';
const FILES = ['/scanner', '/app.js', '/style.css', '/vendor/camera.js', '/vendor/qz-tray.js', '/brand/faiz-e-husaini-logo-white.webp', '/vendor/fonts/readex-pro-latin.woff2'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && FILES.includes(url.pathname)) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request, { ignoreSearch: true }).then(hit => hit || Response.error())));
});
