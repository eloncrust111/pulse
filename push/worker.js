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
    if (url.pathname === '/ask' && req.method === 'POST') return ask(req, env);
    if (url.pathname === '/photo' && req.method === 'POST') return photo(req, env);
    if (url.pathname === '/ideas' && req.method === 'POST') return ideas(req, env);
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
    // Every minute while a game might be on (so the congrats lands right after
    // the final is posted), otherwise every 30 minutes to keep the schedule fresh.
    ctx.waitUntil((async () => {
      if (now.getUTCMinutes() % 30 === 0 || gameLive(JSON.parse(await env.SUBS.get('games') || '{}'), now)) await checkResults(env, now);
    })());
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
export function parseResults(days, starts = {}) {
  const out = {};
  for (const day of days || []) for (const e of day?.events || []) {
    if (e.sport?.shortname !== 'wbball') continue;
    const r = e.result, date = String(e.date).slice(0, 10);
    if (!r || !/^[WLT]$/.test(r.status || '')) { starts[date] = e.date; continue; }
    out[date] = { r: r.status, us: +r.team_score, them: +r.opponent_score, opp: e.opponent?.title || '', at: e.at_vs || 'vs', start: e.date };
  }
  return out;
}
// Posted times can be in the venue's time zone, so the window is wide:
// from 3 hours before the listed time to 6 hours after.
const startMs = s => new Date(s + '-08:00').getTime();
export const gameLive = (starts, now) => Object.values(starts).some(s => now - startMs(s) > -3 * 3600e3 && now - startMs(s) < 6 * 3600e3);
export async function checkResults(env, now = new Date(), send = sendPush, get = url => fetch(url, { headers: FEED_HEADERS }).then(r => r.json())) {
  // The feed lists a week starting at the date given, so start from yesterday
  // to catch a game that ended last night.
  const [y, m, d] = new Date(new Date(localNow('America/Los_Angeles', now).date + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10).split('-');
  let found;
  const starts = {};
  try { found = parseResults(await get(FEED + `${+m}/${+d}/${y}`), starts); } catch { return; }
  const before = await env.SUBS.get('games') || '{}';
  if (JSON.stringify(starts) !== before) await env.SUBS.put('games', JSON.stringify(starts));
  const saved = JSON.parse(await env.SUBS.get('results') || '{}');
  const fresh = Object.keys(found).filter(k => !saved[k]);
  if (!fresh.length) return;
  fresh.forEach(k => { saved[k] = found[k]; });
  await env.SUBS.put('results', JSON.stringify(saved));
  // Only cheer for games that just ended, not ones found late.
  const wins = fresh.filter(k => found[k].r === 'W' && now - startMs(found[k].start) < 12 * 3600e3);
  if (!wins.length) return;
  for (const s of await loadSubs(env)) if (s.wins !== false) await send(env, s.endpoint, 3 * 3600);
}

// ---------- Ask Pulse ----------
// The app sends a summary of her logs with each question. Nothing is stored.
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const SYSTEM = `You are Pulse, the assistant inside a college athlete's personal health app. You can see everything she has logged (below).
Accuracy comes first. She trusts this, so every claim must be true:
- Every number, date, food and pattern you mention must appear in her data below. Never invent, round wildly or "estimate" a number that isn't there.
- For averages and totals, use the "Averages" lines the app worked out. Don't do your own math across days.
- Be honest about goals. The Averages lines say "on track", "a bit under" or "well under"; use exactly that judgment. Never call something close or good when it's under, and never praise a number that's short. Be kind, but tell her the truth.
- Only call something a pattern if the data shows it on several days. If there are only 1 or 2 data points, say "too early to tell" instead.
- Today isn't over, so never call today's food or water "low" as if it were a finished day; talk about what's left to hit.
- If something she needs isn't logged, say plainly what's missing and what to log. Don't fill the gap with a guess.
- Facts about nutrition, sleep and training must be well established sports science (what a team dietitian would agree with). No fads, no supplements by brand, no exact doses of anything. If you're not sure something is true, leave it out.
- Gluten-free means truly safe for celiac: oats only if certified gluten-free; watch soy sauce, beer, malt, regular bread, pasta and cross-contact.
- Don't contradict the app: tonight's bedtime, sleep need and readiness come from the lines below.
How to answer:
- Use her data. Be specific: name dates, times and numbers. Compare to her goals and to her usual.
- Format, always (she reads this on her phone, so it must be skimmable):
  1. Line 1: the answer in one punchy sentence wrapped in **bold**.
  2. Then 2 or 3 short sections. Each starts with its own line: an emoji and a 2 to 4 word label, like "📊 What I'm seeing", "🧠 Why it matters", "💡 Try this", "🏀 Before the game". Under each, 2 to 4 bullets starting with "- ". Each bullet is one complete, specific sentence (up to about 25 words) that explains the why, not just the what. Bold the key number or action in each bullet.
  3. Last line: one short, upbeat sentence that hypes her up or names the one thing to do today.
  About 120 to 200 words total. Never write a paragraph longer than one sentence.
  The label is alone on its own line, and the bullets go on the lines below it. Example of the shape (not the content):
**You're in a good spot, just short on carbs.**
📊 What I'm seeing
- You've hit **9h+ of sleep 4 of the last 5 nights**, right on your goal.
- Carbs averaged **210g vs your 300g goal** over the last week.
💡 Try this
- Add **a cup of rice or a certified GF bagel** at lunch; carbs refill the muscle fuel you burn at practice.
- Keep tonight's **10:00 PM bedtime** so you get your full sleep goal before the game.
Lock in tonight's bedtime and you're set for tomorrow. 🏀
- Sleep advice must use her own sleep goal and tonight's planned bedtime from the data, never generic numbers like "7 to 8 hours".
- Plain, warm, direct and a little fun, like a smart teammate who knows sports science. No filler, no "As an AI", no disclaimers unless something medical comes up.
- If the data needed isn't logged, say what's missing and what to log.
- For stomach questions, trust the stomach analysis lines: foods she eats almost every day are not suspects unless listed as standing out. Weigh period timing, team meals or food she didn't make (gluten cross-contact), stress and food types like sugar alcohols or caffeine.
- General sports nutrition, sleep and recovery tips are fine. Every food suggestion must be gluten-free (she has celiac).
- Never suggest eating less or losing weight. Never diagnose. For anything medical, severe or persistent, point her to her dietitian, athletic trainer or doctor.
- Period days may have little or no bleeding; treat them as cycle days and look at symptoms and mood.
- Don't use markdown headers or tables. Bold with **like this** is fine.

Her data:
`;
// "Just talk" mode: same facts and safety rules, but a natural conversation.
const CHAT = `You are Pulse, a friendly, smart companion inside a college athlete's personal health app. This is the open chat: she can talk about anything (her day, practice, school, stress, friends, food, sleep, games).
- Talk like a real person texting: natural, warm, direct. Usually 1 to 4 sentences. Go longer (with short bullets) only when she asks for a plan, a list or an explanation.
- Follow the conversation. Answer what she actually said, remember earlier messages, and sometimes ask a short follow-up question.
- Bring up her logged data only when it's relevant, and then be exact: every number, date and food must appear in her data below, use the Averages lines instead of your own math, and say "too early to tell" if there are only 1 or 2 data points.
- Facts about nutrition, sleep and training must be well established sports science. Every food idea must be safe for celiac (oats only if certified gluten-free).
- No cringe: no "queen", no forced hype, no "As an AI". Light humor is fine.
- Never suggest eating less or losing weight. Never diagnose. For anything medical, severe or persistent, point her to her doctor, dietitian or athletic trainer. If she ever mentions wanting to hurt herself, be kind and tell her she can call or text 988 any time.
- Don't use markdown headers or tables. Bold with **like this** sparingly.

Her data:
`;
async function ask(req, env) {
  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const context = String(b.context || '').slice(0, 60000);
  const chat = b.mode === 'chat';
  const messages = (Array.isArray(b.messages) ? b.messages : []).slice(chat ? -16 : -10)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) })).filter(m => m.content);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'no question' }, 400);
  try {
    const r = await env.AI.run(MODEL, { messages: [{ role: 'system', content: (chat ? CHAT : SYSTEM) + context }, ...messages], max_tokens: chat ? 600 : 800, temperature: chat ? 0.5 : 0.2 });
    return json({ answer: String(r?.response || '').trim() });
  } catch (e) {
    return json({ error: 'busy', detail: String(e?.message || e).slice(0, 200) }, 503);
  }
}

// ---------- Meal photo estimate ----------
// A rough guess from a picture. The app shows it as editable and says it can be off.
const VISION = '@cf/meta/llama-4-scout-17b-16e-instruct';
const PHOTO_PROMPT = `You estimate nutrition from a photo of a meal for a college athlete with celiac disease.
List each separate food you can see. For each, estimate a realistic portion from the plate size and food size, then its calories and macros for THAT portion, using standard USDA-style values.
Be conservative and honest: if you can't tell what something is, say so in the name (e.g. "sauce (unclear)"). Don't invent foods you can't see.
gluten: "likely" if the food usually contains wheat, barley or rye (bread, pasta, breading, flour tortilla, soy sauce, beer batter), "check" if it might (sauces, gravies, fried foods, granola, oats, anything from a restaurant), "safe" only if it is naturally gluten-free and plain (plain meat, rice, potato, fruit, vegetables, eggs).
Reply with ONLY JSON, no other text:
{"items":[{"name":"grilled chicken breast","portion":"about 5 oz","cal":230,"p":43,"c":0,"f":5,"fiber":0,"gluten":"safe"}],"confidence":"low|medium|high","note":"one short sentence on what was hard to judge"}`;
async function photo(req, env) {
  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const img = String(b.image || '');
  if (!img.startsWith('data:image/') || img.length > 2_000_000) return json({ error: 'bad image' }, 400);
  try {
    const r = await env.AI.run(VISION, { messages: [{ role: 'user', content: [{ type: 'text', text: PHOTO_PROMPT + (b.hint ? `\nShe says it is: ${String(b.hint).slice(0, 200)}` : '') }, { type: 'image_url', image_url: { url: img } }] }], max_tokens: 900, temperature: 0.1 });
    let out = parseJSON(r?.response);
    if (Array.isArray(out)) out = { items: out };
    if (!out?.items?.length) return json({ error: 'unclear' }, 422);
    const n = v => Math.max(0, Math.round(+v || 0));
    return json({
      items: out.items.slice(0, 12).map(x => ({ name: String(x.name || 'Food').slice(0, 60), portion: String(x.portion || '').slice(0, 40), cal: n(x.cal), p: n(x.p), c: n(x.c), f: n(x.f), fiber: n(x.fiber), gluten: ['likely', 'check', 'safe'].includes(x.gluten) ? x.gluten : 'check' })),
      confidence: ['low', 'medium', 'high'].includes(out.confidence) ? out.confidence : 'low', note: String(out.note || '').slice(0, 200),
    });
  } catch (e) {
    return json({ error: 'busy', detail: String(e?.message || e).slice(0, 200) }, 503);
  }
}
// Models sometimes wrap JSON in prose or code fences, or return it already parsed.
function parseJSON(t) {
  if (t && typeof t === 'object') return t;
  const m = String(t || '').match(/[[{][\s\S]*[\]}]/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

// ---------- Meal prep ideas ----------
// Names of dishes to look up online, based on what she already makes. No recipes are written here.
async function ideas(req, env) {
  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const prompt = `A college basketball player with celiac disease meal preps on Sundays. Things she already makes or eats a lot: ${String(b.likes || 'nothing logged yet').slice(0, 1500)}.
Suggest 4 meal-prep dishes she'd probably like next: some close to what she already makes, one a little new. Lunches or dinners only. Each must be easy to make naturally gluten-free, keep in the fridge for 4 days, and be high in protein with good carbs for training.
Reply with ONLY JSON: {"ideas":[{"name":"short dish name a recipe site would use","why":"one short sentence tying it to what she makes"}]}`;
  try {
    const r = await env.AI.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 500, temperature: 0.7 });
    const out = parseJSON(r?.response);
    if (!out?.ideas?.length) return json({ error: 'unclear' }, 422);
    return json({ ideas: out.ideas.slice(0, 4).map(x => ({ name: String(x.name || '').slice(0, 60), why: String(x.why || '').slice(0, 140) })).filter(x => x.name) });
  } catch (e) {
    return json({ error: 'busy', detail: String(e?.message || e).slice(0, 200) }, 503);
  }
}
