/* App shell cache only. Desk data (the tunnel) is never cached: it is cross-origin and is passed straight through. */
const V = "desk-shell-v12.1";
const SHELL = ["./", "index.html", "app.css", "chart.js", "app.js", "manifest.json", "icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;           // data: network only
  if (u.pathname.endsWith("/config.json")) return;                                       // config: network only
  // shell: network first so a new publish shows at once, cache when offline
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
