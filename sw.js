// Offline support. App files: network first (so updates show up right away),
// falling back to cache. Libraries from CDNs: cache first.
const CACHE = 'pulse-v18';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/util.js', 'js/charts.js', 'js/patterns.js', 'js/lookup.js', 'js/sync.js', 'js/share-image.js', 'js/games.js', 'js/health.js', 'js/notify.js', 'js/demo.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'];
const CDN = ['cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'pulse-notify').map(k => caches.delete(k))))
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

// ---------- notifications ----------
// Pushes arrive empty; what to show comes from the schedule the app saved.
const pad2 = n => String(n).padStart(2, '0');
async function dueNow() {
  try {
    const r = await (await caches.open('pulse-notify')).match('notify.json');
    const { items = [] } = r ? await r.json() : {};
    const d = new Date(), today = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const mins = d.getHours() * 60 + d.getMinutes();
    let due = [], bestGap = Infinity;
    for (const i of items) {
      if (i.date ? i.date !== today : (i.skip || []).includes(today)) continue;
      const [h, m] = i.at.split(':').map(Number), gap = mins - (h * 60 + m);
      if (gap < 0 || gap > (i.close ? 1 : 20)) continue;
      if (gap < bestGap) { due = [i]; bestGap = gap; } else if (gap === bestGap) due.push(i);
    }
    return due;
  } catch { return []; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
// A win the server just found: fetch the score and cheer once.
async function newWin() {
  try {
    const c = await caches.open('pulse-notify');
    const cfg = await (await c.match('notify.json'))?.json() || {};
    if (!cfg.pushUrl || cfg.wins === false) return null;
    const res = await (await fetch(cfg.pushUrl.replace(/\/$/, '') + '/results')).json();
    const seen = await (await c.match('win-seen.json'))?.json() || [];
    const hit = Object.entries(res).filter(([d, g]) => g.r === 'W' && !seen.includes(d) && Date.now() - new Date(g.start) < 12 * 3600e3).pop();
    if (!hit) return null;
    await c.put('win-seen.json', new Response(JSON.stringify([...seen, hit[0]])));
    const g = hit[1];
    return { id: 'win', title: '🏆 Pilots win!', body: `Congrats on the W ${g.at} ${g.opp}, ${g.us}-${g.them} 🎉` };
  } catch { return null; }
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const reg = self.registration;
    (await reg.getNotifications({ tag: 'wish' })).forEach(n => n.close());
    const due = await dueNow(), win = await newWin();
    if (win) due.push(win);
    if (!due.length) due.push({ id: 'pulse', title: 'Pulse', body: 'Tap to open' });
    for (const i of due) await reg.showNotification(i.title, { body: i.body, tag: i.close ? 'wish' : i.id, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { at: Date.now() } });
    // The 11:11 one only stays for its minute.
    const wish = due.find(i => i.close);
    if (wish) { await wait(wish.close * 1000); (await reg.getNotifications({ tag: 'wish' })).forEach(n => n.close()); }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list =>
    list.length ? list[0].focus() : self.clients.openWindow('./')));
});
