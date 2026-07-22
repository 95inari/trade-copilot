// Trade Co-Pilot PWA Service Worker
// アプリシェルをキャッシュしてオフライン起動を可能にする。
// 外部API（J-Quants・プロキシ）はキャッシュしない（鮮度が命のため）。
const CACHE_NAME = "trade-copilot-v9";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./engine.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients[0];
      if (client) return client.focus();
      return self.clients.openWindow("./");
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // 同一オリジンのGETのみ対象。ネットワーク優先で常に最新を使い、
  // オフライン時のみキャッシュにフォールバックする
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))),
  );
});
