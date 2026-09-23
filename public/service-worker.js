// Minimal service worker — its only real job is to satisfy PWA install
// criteria (a fetch handler must exist) and speed up repeat loads of a few
// static assets (icons, manifest). It deliberately does NOT cache pages,
// exam data, or student marks, so nothing ever shows stale/offline data —
// every navigation and data request always goes to the network.
const CACHE_NAME = "school-app-shell-v1";
const SHELL_ASSETS = ["/manifest.webmanifest", "/icons/default-192.png", "/icons/default-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellAsset = SHELL_ASSETS.includes(url.pathname);

  if (!isShellAsset) return; // let the browser handle everything else normally

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
