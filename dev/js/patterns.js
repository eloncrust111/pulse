import { toTs } from './util.js';

// Looks for foods (and food tags) that are followed by a stomach episode more
// often than her usual rate. Pattern-spotting only, not a diagnosis.
export function analyzeGut(entries, episodes, getTags, { windowH = 12, minTimes = 3 } = {}) {
  const eps = episodes.map(e => toTs(e.date, e.time)).sort((a, b) => a - b);
  const W = windowH * 3600e3;
  const followed = ts => eps.some(t => t > ts && t - ts <= W);

  const foods = new Map(), tags = new Map();
  let total = 0, hits = 0;
  for (const e of entries) {
    if (e.kind === 'quick') continue;
    const hit = followed(toTs(e.date, e.time));
    total++; if (hit) hits++;
    const key = e.kind + ':' + e.refId;
    let g = foods.get(key);
    if (!g) foods.set(key, g = { key, name: e.name, brand: e.brand, eaten: 0, hit: 0 });
    g.eaten++; if (hit) g.hit++;
    for (const t of getTags(e)) {
      let tg = tags.get(t);
      if (!tg) tags.set(t, tg = { name: t, eaten: 0, hit: 0 });
      tg.eaten++; if (hit) tg.hit++;
    }
  }
  const base = total ? hits / total : 0;
  const score = g => ({ ...g, rate: g.hit / g.eaten, lift: base ? (g.hit / g.eaten) / base : 0 });
  const suspects = list => [...list.values()].filter(g => g.eaten >= minTimes).map(score)
    .filter(g => g.hit >= 2 && g.lift >= 1.4).sort((a, b) => b.lift - a.lift || b.hit - a.hit);
  const safe = [...foods.values()].filter(g => g.eaten >= 5 && g.hit === 0).sort((a, b) => b.eaten - a.eaten);

  return { base, total, episodes: episodes.length, foods: suspects(foods).slice(0, 8), tags: suspects(tags).slice(0, 6), safe: safe.slice(0, 6) };
}

// Best-guess food tags from a name, used when a food has no tags set.
const TAG_WORDS = [
  ['Dairy', /milk|cheese|yogh?urt|cream|whey|butter|latte|queso|mozzarella|cheddar|parmesan|kefir|cottage|cappuccino|alfredo/i],
  ['Gluten', /bread|pasta|bagel|wheat|flour|tortilla|cracker|cereal|pizza|muffin|pretzel|croissant|noodle|cookie|cake|\bbuns?\b|toast|waffle|pancake|barley|\brye\b|spaghetti|ramen|sandwich|wrap\b/i],
  ['Spicy', /spicy|hot sauce|jalape|sriracha|chil+i|cayenne|buffalo|habanero|curry|hot cheetos|takis/i],
  ['Fried / greasy', /fried|fries|chips|bacon|burger|pizza|wings|nugget|donut|doughnut|tempura|cheetos|takis/i],
  ['Caffeine', /coffee|espresso|latte|cold brew|energy|celsius|red bull|monster|pre-?workout|matcha|\btea\b|cappuccino|americano|\bbang\b|alani|ghost/i],
  ['Artificial sweetener', /\bdiet\b|zero sugar|sugar[- ]free|sucralose|aspartame|splenda|\bzero\b|celsius|alani/i],
  ['Sugar alcohol', /erythritol|xylitol|sorbitol|maltitol|protein bar|keto|quest|\bone bar|barebells|halo top/i],
  ['Beans / legumes', /\bbeans?\b|lentil|chickpea|hummus|edamame|\bpeas?\b|tofu/i],
  ['High fiber', /fiber|\bbran\b|\boats?\b|oatmeal|chia|flax|broccoli|cauliflower|brussels|cabbage|kale|raspberr|fiber one/i],
  ['Red meat', /beef|steak|burger|pork|lamb|sausage|bacon|brisket|jerky|salami|pepperoni|carne/i],
  ['Carbonated', /soda|sparkling|seltzer|la ?croix|\bcoke\b|sprite|kombucha|celsius|carbonated|bubly|poppi|olipop|red bull|monster/i],
  ['Protein powder', /whey|protein powder|protein shake|casein|isolate|premier protein|fairlife|core power|\bscoop/i],
  ['Onion / garlic', /onion|garlic|shallot|scallion|leek/i],
  ['Acidic', /orange|lemon|\blime|grapefruit|tomato|marinara|salsa|pineapple|vinegar|citrus|ketchup/i],
];
export function guessTags(name = '') {
  const gf = /gluten[- ]?free|\bgf\b/i.test(name);
  return TAG_WORDS.filter(([t, re]) => re.test(name) && !(gf && t === 'Gluten')).map(([t]) => t);
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Compares days that had an event (felt off, stomach trouble) with other
// logged days, metric by metric. Only returns differences big enough to notice.
export function compareDays(rows, isFlag, metrics, { minFlag = 3, minOther = 3 } = {}) {
  const out = [];
  for (const m of metrics) {
    const f = [], o = [];
    for (const r of rows) {
      const v = r[m.k];
      if (v == null || Number.isNaN(v)) continue;
      (isFlag(r) ? f : o).push(v);
    }
    if (f.length < minFlag || o.length < minOther) continue;
    const a = mean(f), b = mean(o);
    const rel = b ? (a - b) / Math.abs(b) : 0;
    if (Math.abs(rel) < (m.min ?? 0.12)) continue;
    out.push({ ...m, flag: a, other: b, rel, n: f.length });
  }
  return out.sort((x, y) => Math.abs(y.rel) - Math.abs(x.rel));
}
