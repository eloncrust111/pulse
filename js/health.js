// Reads the text the "Pulse Sync" Shortcut copies from Apple Health, e.g.
//   bed: 21:05
//   wake: 05:48
//   rhr: 52 count/min
//   hrv: 81 ms
//   active: 1,240 kcal
//   resting: 1,410 kcal
//   steps: 9,312
// Anything missing, blank or out of range is skipped, never guessed.
export const SHORTCUT_NAME = 'Pulse Sync';

const number = s => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
function clock(s) {
  const all = [...String(s).matchAll(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/gi)];
  if (!all.length) return null;
  const [, hh, mm, ap] = all[all.length - 1];
  let h = +hh;
  if (ap) h = (h % 12) + (/pm/i.test(ap) ? 12 : 0);
  return h < 24 && +mm < 60 ? `${String(h).padStart(2, '0')}:${mm}` : null;
}
// Hours, minutes or seconds; "7 hr 30 min" or "7:30" also work.
function duration(s) {
  s = String(s);
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/i), m = s.match(/(\d+)\s*m(?!s)/i);
  if (h || m) return (h ? parseFloat(h[1]) * 60 : 0) + (m ? +m[1] : 0);
  const c = s.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (c) return +c[1] * 60 + +c[2];
  const n = number(s);
  if (n == null) return null;
  return n > 1440 ? n / 60 : n > 24 ? n : n * 60;
}
const within = (v, lo, hi) => v != null && v >= lo && v <= hi ? v : null;
const round = v => v == null ? null : Math.round(v);

export function parseHealth(text) {
  const raw = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([a-z_ ]+?)\s*[:=]\s*(.+)$/i);
    if (m && m[2].trim()) raw[m[1].toLowerCase().replace(/\s+/g, '_')] = m[2].trim();
  });
  const active = within(number(raw.active), 0, 6000), resting = within(number(raw.resting), 0, 4000);
  const burned = raw.burned != null ? number(raw.burned) : active != null || resting != null ? (active || 0) + (resting || 0) : null;
  const out = {
    bed: raw.bed ? clock(raw.bed) : null,
    wake: raw.wake ? clock(raw.wake) : null,
    sleepMin: raw.sleep ? within(round(duration(raw.sleep)), 60, 900) : null,
    rhr: within(round(number(raw.rhr ?? raw.resting_hr)), 30, 120),
    hrv: within(round(number(raw.hrv)), 5, 250),
    burned: within(round(burned), 500, 9000),
    active: round(active),
    resting: round(resting),
    steps: within(round(number(raw.steps)), 0, 90000),
  };
  return Object.values(out).some(v => v != null) ? out : null;
}
