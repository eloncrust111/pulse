// Tiny dependency-free SVG charts. Colors are CSS variables applied via style.
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function xLabels(labels, n, L, bw, H) {
  const want = n <= 7 ? n : 4;
  const idx = want === n ? [...Array(n).keys()] : [...Array(want).keys()].map(i => Math.round(i * (n - 1) / (want - 1)));
  return idx.map(i => `<text x="${L + i * bw + bw / 2}" y="${H - 6}" class="xlab" text-anchor="middle">${labels[i]}</text>`).join('');
}

export function barChart({ values, labels, dates, goal = null, color = 'var(--purple-3)', colorFn = null, fmtY = v => Math.round(v), height = 150 }) {
  const W = 340, H = height, L = 34, R = 8, T = 12, B = 22, n = values.length;
  const vmax = Math.max(goal || 0, ...values.map(v => v || 0));
  if (!values.some(v => v)) return `<div class="chart-empty">Nothing logged in this range yet</div>`;
  const max = niceMax(vmax * 1.05);
  const iw = W - L - R, ih = H - T - B, bw = iw / n, gap = Math.min(bw * 0.28, 5);
  const y = v => T + ih - (v / max) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  [0, max / 2, max].forEach(v => {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3.5}" class="ylab" text-anchor="end">${fmtY(v)}</text>`;
  });
  values.forEach((v, i) => {
    const x = L + i * bw;
    if (v) {
      const w = Math.max(bw - gap, 1.2);
      s += `<rect x="${x + gap / 2}" y="${y(v)}" width="${w}" height="${Math.max(ih * v / max, 1)}" rx="${Math.min(4, w / 2)}" style="fill:${colorFn ? colorFn(v, i) : color}"/>`;
    }
    if (dates) s += `<rect x="${x}" y="${T}" width="${bw}" height="${ih}" style="fill:transparent" data-act="gotoDay" data-d="${dates[i]}"/>`;
  });
  if (goal) s += `<line x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}" class="goal"/>`;
  s += xLabels(labels, n, L, bw, H) + '</svg>';
  return s;
}

export function lineChart({ series, labels, height = 150, fmtY = v => Math.round(v), minZero = false }) {
  const W = 340, H = height, L = 34, R = 8, T = 12, B = 22, n = labels.length;
  const all = series.flatMap(s => s.values).filter(v => v != null);
  if (all.length < 1) return `<div class="chart-empty">Nothing logged in this range yet</div>`;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (minZero) lo = 0;
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.15; hi += pad; if (!minZero) lo -= pad;
  const iw = W - L - R, ih = H - T - B, bw = iw / n;
  const x = i => L + i * bw + bw / 2, y = v => T + ih - ((v - lo) / (hi - lo)) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  [lo, (lo + hi) / 2, hi].forEach(v => {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3.5}" class="ylab" text-anchor="end">${fmtY(v)}</text>`;
  });
  for (const se of series) {
    const pts = se.values.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
    if (pts.length > 1) s += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" style="fill:none;stroke:${se.color};stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round"/>`;
    if (pts.length <= 31) pts.forEach(p => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="2.8" style="fill:${se.color}"/>`; });
  }
  s += xLabels(labels, n, L, bw, H) + '</svg>';
  return s;
}
