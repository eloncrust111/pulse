export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const pad = n => String(n).padStart(2, '0');
export const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeStr = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); };
export const toTs = (date, time) => {
  const d = parseDate(date);
  const [h, m] = (time || '12:00').split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
};

export function fmtDay(s) {
  const t = dateStr();
  if (s === t) return 'Today';
  if (s === addDays(t, -1)) return 'Yesterday';
  if (s === addDays(t, 1)) return 'Tomorrow';
  return parseDate(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${pad(m)} ${ap}`;
}

export const fmtSleep = min => min == null ? '–' : `${Math.floor(min / 60)}h ${pad(Math.round(min % 60))}m`;

export const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
export const optNum = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : null; };

// Human-friendly number: whole numbers at 10+, one decimal below that.
export function fmt(n) {
  if (n == null || !isFinite(n)) return '–';
  if (Math.abs(n) >= 10) return Math.round(n).toLocaleString();
  return String(Math.round(n * 10) / 10);
}

export const MK = ['cal', 'p', 'c', 'f', 'fiber', 'sugar', 'sodium'];
export const zero = () => ({ cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 });

// Foods store label values per serving; everything is computed per gram.
export function perGram(food) {
  const g = num(food.servingG) || 100;
  const o = {};
  MK.forEach(k => { o[k] = num(food[k]) / g; });
  return o;
}

export function scale(per, grams) {
  const o = {};
  MK.forEach(k => { o[k] = (per?.[k] || 0) * grams; });
  return o;
}

export function sumMacros(list) {
  const o = zero();
  list.forEach(m => m && MK.forEach(k => { o[k] += m[k] || 0; }));
  return o;
}

export function recipeInfo(r, getFood) {
  const ings = (r.ingredients || []).map(i => {
    const f = getFood(i.foodId);
    const per = f ? perGram(f) : i.per;
    return { ...i, name: f?.name || i.name, per, macros: scale(per, num(i.grams)) };
  });
  const total = sumMacros(ings.map(i => i.macros));
  const rawG = ings.reduce((s, i) => s + num(i.grams), 0);
  const weight = num(r.cookedG) || rawG;
  const per = {};
  MK.forEach(k => { per[k] = weight ? total[k] / weight : 0; });
  const servings = num(r.servings);
  return { ings, total, rawG, weight, per, servings, servingG: servings && weight ? weight / servings : 0 };
}

export function fileToDataURL(file, max = 900, q = 0.72) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that photo')); };
    img.src = url;
  });
}
