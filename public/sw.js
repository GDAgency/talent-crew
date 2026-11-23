/* Talent & Crew service worker: keeps the app shell and viewed receipt photos
   on the device so the app opens and works with no signal. */
// Paths are relative to where this file is served: / for the public site, /admin/ for the office.
const BASE = new URL("./", self.location).pathname;
const SHELL_CACHE = "tc-shell-v3";
const PHOTO_CACHE = "tc-photos-v1";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "styles.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "fonts/Archivo-normal-500-800-latin-ext.woff2",
  "fonts/Archivo-normal-500-800-latin.woff2",
  "fonts/fonts.css",
  "fonts/IBMPlexMono-normal-400-latin-ext.woff2",
  "fonts/IBMPlexMono-normal-400-latin.woff2",
  "fonts/IBMPlexMono-normal-500-latin-ext.woff2",
  "fonts/IBMPlexMono-normal-500-latin.woff2",
  "fonts/InstrumentSans-normal-400-600-latin-ext.woff2",
  "fonts/InstrumentSans-normal-400-600-latin.woff2"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL_CACHE && k !== PHOTO_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Receipt photos never change once stored: serve from the device when we have them.
  if (url.pathname.startsWith(BASE + "api/photos/")) {
    e.respondWith((async () => {
      const cache = await caches.open(PHOTO_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  // Live data goes straight to the server (also another site's, e.g. /admin/api/ seen from /).
  if (url.pathname.includes("/api/")) return;

  // Page loads: only this site's own page. Anything else (e.g. /admin, the office, which the
  // server redirects to /admin/) goes to the server, or the wrong app would open there.
  if (req.mode === "navigate" && url.pathname !== BASE && url.pathname !== BASE + "index.html") return;

  // App shell: answer from the device instantly, refresh the copy in the background.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const key = req.mode === "navigate" ? new URL("index.html", self.registration.scope).href : req;
    const hit = await cache.match(key);
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  })());
});
