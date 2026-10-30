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
    if (!g) foods.set(key, g = { name: e.name, brand: e.brand, eaten: 0, hit: 0 });
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
    .filter(g => g.hit >= 2 && g.lift >= 1.25).sort((a, b) => b.lift - a.lift || b.hit - a.hit);
  const safe = [...foods.values()].filter(g => g.eaten >= 5 && g.hit === 0).sort((a, b) => b.eaten - a.eaten);

  return { base, total, episodes: episodes.length, foods: suspects(foods).slice(0, 8), tags: suspects(tags).slice(0, 6), safe: safe.slice(0, 6) };
}
