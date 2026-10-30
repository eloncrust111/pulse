// Offline support. App files: network first (so updates show up right away),
// falling back to cache. Libraries from CDNs: cache first.
const CACHE = 'fuel-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/util.js', 'js/charts.js', 'js/patterns.js', 'js/lookup.js', 'js/sync.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'];
const CDN = ['cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
