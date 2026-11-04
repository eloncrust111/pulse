// Pulse notification sender (Cloudflare Worker, free plan).
// The app sends its schedule here; once a minute this checks the phone's local
// time and sends an empty push when something is due. The phone's service worker
// decides what the notification says, so no personal data is stored here beyond
// the times. Setup: see SETUP.md, "Notifications".

const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const MAX_SUBS = 20;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const loadSubs = async env => JSON.parse(await env.SUBS.get('subs') || '[]');
const saveSubs = (env, subs) => env.SUBS.put('subs', JSON.stringify(subs));

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/results') return json(JSON.parse(await env.SUBS.get('results') || '{}'));
    if (url.pathname !== '/sub') return json({ ok: true, name: 'pulse-push' });
    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const endpoint = body?.sub?.endpoint || body?.endpoint;
    let host;
    try { host = new URL(endpoint).hostname; } catch { return json({ error: 'bad endpoint' }, 400); }
    if (!PUSH_HOSTS.test(host)) return json({ error: 'unknown push service' }, 400);
    let subs = (await loadSubs(env)).filter(s => s.endpoint !== endpoint);
    if (req.method === 'POST') {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 80).map(cleanItem).filter(Boolean);
      subs.unshift({ endpoint, tz: String(body.tz || 'America/Los_Angeles').slice(0, 60), items, wins: body.wins !== false, seen: Date.now() });
      subs = subs.slice(0, MAX_SUBS);
    }
    await saveSubs(env, subs);
    return json({ ok: true });
  },

  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    ctx.waitUntil(tick(env, now));
    if (now.getUTCMinutes() % 10 === 0) ctx.waitUntil(checkResults(env, now));
  },
};

function cleanItem(i) {
  if (!i || !/^\d{2}:\d{2}$/.test(i.at)) return null;
  return { id: String(i.id || '').slice(0, 40), at: i.at, date: /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : undefined,
    skip: Array.isArray(i.skip) ? i.skip.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 14) : undefined,
    ttl: Math.min(Math.max(+i.ttl || 3600, 30), 86400) };
}

export function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const dueItems = (items, { date, time }) => items.filter(i => i.at === time && (i.date ? i.date === date : !(i.skip || []).includes(date)));

export async function tick(env, now = new Date(), send = sendPush) {
  const subs = await loadSubs(env);
  const gone = new Set();
  for (const s of subs) {
    let local;
    try { local = localNow(s.tz, now); } catch { local = localNow('America/Los_Angeles', now); }
    const due = dueItems(s.items, local);
    if (!due.length) continue;
    const status = await send(env, s.endpoint, Math.min(...due.map(i => i.ttl)));
    if (status === 404 || status === 410) gone.add(s.endpoint);
  }
  if (gone.size) await saveSubs(env, subs.filter(s => !gone.has(s.endpoint)));
}

// ---------- Web Push with VAPID, no payload ----------
const b64u = {
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)),
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};
let keyCache;
async function signingKey(env) {
  if (keyCache) return keyCache;
  const pub = b64u.dec(env.VAPID_PUBLIC);
  const d = b64u.dec(env.VAPID_PRIVATE);
  const pad = new Uint8Array(32); pad.set(d, 32 - d.length);
  keyCache = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64u.enc(pad), x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return keyCache;
}
export async function vapidJwt(env, aud, now = Date.now()) {
  const enc = o => b64u.enc(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://eloncrust111.github.io/pulse/' })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(env), new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64u.enc(sig)}`;
}
async function sendPush(env, endpoint, ttl) {
  try {
    const jwt = await vapidJwt(env, new URL(endpoint).origin);
    const r = await fetch(endpoint, { method: 'POST', headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`, TTL: String(ttl), Urgency: 'high', 'Content-Length': '0' } });
    return r.status;
  } catch { return 0; }
}

// ---------- game results ----------
// Every 10 minutes, read the Pilots' own calendar feed. A new win sends
// everyone a push; the phone fetches /results and shows the congrats.
const FEED_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; pulse-push)', Accept: 'application/json' };
const FEED = 'https://portlandpilots.com/services/responsive-calendar.ashx?type=events&sport=9&location=all&date=';
export function parseResults(days) {
  const out = {};
  for (const day of days || []) for (const e of day?.events || []) {
    const r = e.result;
    if (e.sport?.shortname !== 'wbball' || !r || !/^[WLT]$/.test(r.status || '')) continue;
    out[String(e.date).slice(0, 10)] = { r: r.status, us: +r.team_score, them: +r.opponent_score, opp: e.opponent?.title || '', at: e.at_vs || 'vs', start: e.date };
  }
  return out;
}
export async function checkResults(env, now = new Date(), send = sendPush, get = url => fetch(url, { headers: FEED_HEADERS }).then(r => r.json())) {
  // The feed lists a week starting at the date given, so start from yesterday
  // to catch a game that ended last night.
  const [y, m, d] = new Date(new Date(localNow('America/Los_Angeles', now).date + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10).split('-');
  let found;
  try { found = parseResults(await get(FEED + `${+m}/${+d}/${y}`)); } catch { return; }
  const saved = JSON.parse(await env.SUBS.get('results') || '{}');
  const fresh = Object.keys(found).filter(k => !saved[k]);
  if (!fresh.length) return;
  fresh.forEach(k => { saved[k] = found[k]; });
  await env.SUBS.put('results', JSON.stringify(saved));
  // Only cheer for games that just ended, not ones found late.
  const wins = fresh.filter(k => found[k].r === 'W' && now - new Date(found[k].start + '-08:00') < 12 * 3600e3);
  if (!wins.length) return;
  for (const s of await loadSubs(env)) if (s.wins !== false) await send(env, s.endpoint, 3 * 3600);
}
