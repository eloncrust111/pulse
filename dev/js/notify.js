// Notifications. The app works out what's coming up (11:11, bedtime, games...)
// and keeps two copies of that schedule: one in a cache the service worker
// reads when a push arrives, and one on the push server, which only knows the
// times. Nothing personal leaves the phone.
import { CONFIG } from '../config.js';

const CACHE = 'pulse-notify', FILE = 'notify.json';
export const pushReady = () => !!(CONFIG.PUSH_URL && CONFIG.VAPID_PUBLIC);
export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const permission = () => ('Notification' in window ? Notification.permission : 'default');

const keyBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function subscription(create) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub || !create) return sub;
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CONFIG.VAPID_PUBLIC) });
}

export async function turnOn() {
  if (!supported()) throw new Error(installed() ? "This phone can't do notifications" : 'Add Pulse to your Home Screen first');
  if (!pushReady()) throw new Error("Notifications aren't set up yet");
  if (await Notification.requestPermission() !== 'granted') throw new Error('Allow notifications for Pulse in Settings');
  await subscription(true);
  localStorage.removeItem('pulseNotifySent');
}

export async function isOn() {
  if (!supported() || permission() !== 'granted') return false;
  try { return !!(await subscription(false)); } catch { return false; }
}

// items: [{ id, at: 'HH:MM', date?: 'YYYY-MM-DD', skip?: [dates], ttl, title, body, close? }]
export async function saveSchedule(items, { wins = true } = {}) {
  try {
    const c = await caches.open(CACHE);
    await c.put(FILE, new Response(JSON.stringify({ items, wins, pushUrl: CONFIG.PUSH_URL, saved: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* private mode */ }
  if (!pushReady() || !(await isOn())) return;
  const sub = await subscription(false);
  const times = items.map(({ id, at, date, skip, ttl }) => ({ id, at, date, skip, ttl }));
  const body = JSON.stringify({ sub, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, items: times, wins });
  // Only re-send when something changed, or once a day so the server never goes stale.
  let last = {};
  try { last = JSON.parse(localStorage.getItem('pulseNotifySent') || '{}'); } catch {}
  if (last.body === body && Date.now() - last.at < 864e5) return;
  const r = await fetch(CONFIG.PUSH_URL.replace(/\/$/, '') + '/sub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (r.ok) try { localStorage.setItem('pulseNotifySent', JSON.stringify({ body, at: Date.now() })); } catch {}
}

// Take old notifications off the lock screen: anything past its time (11:11
// after a minute, bedtime by morning...) plus ones she already dealt with.
export async function clearStale(done = []) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    (await reg?.getNotifications() || []).forEach(n => {
      const until = n.data?.until ?? (n.tag === 'wish' ? (n.timestamp || 0) + 60e3 : Infinity);
      if (Date.now() > until || done.includes(n.tag)) n.close();
    });
  } catch {}
}

// Game results, read from the push server (it checks the Pilots' feed).
export async function fetchResults() {
  if (!CONFIG.PUSH_URL) return null;
  const r = await fetch(CONFIG.PUSH_URL.replace(/\/$/, '') + '/results');
  return r.ok ? r.json() : null;
}
