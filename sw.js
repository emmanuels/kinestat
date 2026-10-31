/* KinéStat — service worker : application disponible hors ligne */
const CACHE = "kinestat-v1.0.0";
const ASSETS = ["./","./index.html","./app.css","./app.js","./manifest.webmanifest","./tests.json",
  "./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k!==CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method!=="GET" || new URL(req.url).origin!==location.origin) return;
  if(req.mode==="navigate"){
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("./index.html",copy)); return r; })
      .catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if(r.ok){ const copy = r.clone(); caches.open(CACHE).then(c => c.put(req,copy)); }
    return r;
  })));
});
