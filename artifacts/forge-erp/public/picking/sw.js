// Forge Picker — service worker.
// Strategy:
//  • Pre-cache the picker shell so the installed PWA boots offline.
//  • Network-first for navigation/HTML so the latest app shell wins online.
//  • Stale-while-revalidate for static assets (JS/CSS/icons).
//  • Network-first with offline fallback for API GETs scoped to this PWA.
//  • POST/PUT/PATCH/DELETE are NEVER cached — the app's IndexedDB queue is
//    responsible for replaying them when connectivity returns.
const VERSION = "v3";
const SHELL_CACHE = `forge-picker-shell-${VERSION}`;
const STATIC_CACHE = `forge-picker-static-${VERSION}`;
const API_CACHE = `forge-picker-api-${VERSION}`;

const SCOPE_PATH = new URL(self.registration.scope).pathname;
const SHELL_URLS = [SCOPE_PATH, `${SCOPE_PATH}manifest.webmanifest`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => ![SHELL_CACHE, STATIC_CACHE, API_CACHE].includes(k))
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

function isStaticAsset(url) {
  return /\.(?:js|mjs|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // mutations replayed via IndexedDB queue

  const url = new URL(req.url);
  // Only intercept same-origin requests.
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirstShell(req));
    return;
  }
  if (isApiRequest(url)) {
    event.respondWith(networkFirstApi(req));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirstShell(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(SCOPE_PATH, res.clone()).catch(() => undefined);
    return res;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match(req)) || (await cache.match(SCOPE_PATH));
    if (cached) return cached;
    return new Response("<h1>Offline</h1><p>Reconnect to load the picker.</p>", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    });
  }
}

async function networkFirstApi(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(req, res.clone()).catch(() => undefined);
    }
    return res;
  } catch {
    const cache = await caches.open(API_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => undefined);
      return res;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
