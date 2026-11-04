// Bump this on every deploy so activate() purges the old cache and clients
// pick up the new app shell instead of serving a stale bundle.
const CACHE = "neondominion-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(["./", "./index.html", "./manifest.webmanifest", "./favicon.svg", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png"]);
      // Cache the hashed build assets (and the fonts the CSS references) so the first visit works offline.
      const html = await (await fetch("./")).text();
      const assets = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => new URL(m[1], self.registration.scope).href);
      const fonts = [];
      for (const url of assets.filter((u) => u.endsWith(".css"))) {
        const css = await (await fetch(url)).text();
        for (const m of css.matchAll(/url\(([^)]+\.woff2)\)/g)) fonts.push(new URL(m[1].replace(/["']/g, ""), url).href);
      }
      await cache.addAll([...new Set([...assets, ...fonts])]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Hashed assets and static files are immutable by name: cache-first is safe and
// keeps offline play instant. The app shell (navigations, index.html, sw.js)
// is network-first so a new deploy is picked up immediately, falling back to
// cache only when offline.
function isAppShell(req) {
  if (req.mode === "navigate") return true;
  const path = new URL(req.url).pathname;
  return /\/(index\.html|sw\.js|manifest\.webmanifest|favicon\.svg)$/.test(path);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  if (isAppShell(req)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          const cached = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
          if (cached) return cached;
          return (await cache.match("./index.html")) || Response.error();
        }
      })(),
    );
    return;
  }

  // Cache-first for immutable assets, with a background fill on miss.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return cached || Response.error();
      }
    })(),
  );
});
