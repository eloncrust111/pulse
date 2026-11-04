// Draws a week/month summary as a 1080×1350 PNG that can be saved to Photos.
const W = 1080, H = 1400;
const C = {
  bg: '#F4F2FC', card: '#FFFFFF', ink: '#1B1640', muted: '#6E6893', line: '#E6E2F5',
  purple: '#1E1656', purple2: '#2D2080', purple3: '#5340C9', lav: '#EEEBFB',
  p: '#7B5CFF', c: '#2A9FD6', f: '#F0A23A', warn: '#F07A3A', good: '#22B07D',
};
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif';
const font = (w, s) => `${w} ${s}px ${FONT}`;

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function card(ctx, x, y, w, h) {
  ctx.save();
  ctx.shadowColor = 'rgba(30, 22, 86, .08)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
  ctx.fillStyle = C.card; rr(ctx, x, y, w, h, 28); ctx.fill();
  ctx.restore();
}
function text(ctx, s, x, y, { f = font(600, 28), c = C.ink, a = 'left' } = {}) {
  ctx.font = f; ctx.fillStyle = c; ctx.textAlign = a; ctx.fillText(s, x, y);
}
const n0 = v => v == null || !isFinite(v) ? '–' : Math.round(v).toLocaleString();
const hm = m => m == null ? '–' : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;

function loadImg(src) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}

export async function drawSummary(s) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  // Header
  const g = ctx.createLinearGradient(0, 0, W, 330);
  g.addColorStop(0, C.purple); g.addColorStop(1, C.purple3);
  ctx.fillStyle = g; rr(ctx, 0, -40, W, 370, 48); ctx.fill();
  const logo = await loadImg('icons/icon-192.png');
  if (logo) { ctx.save(); rr(ctx, W - 64 - 96, 64, 96, 96, 24); ctx.clip(); ctx.drawImage(logo, W - 64 - 96, 64, 96, 96); ctx.restore(); }
  text(ctx, s.kicker.toUpperCase(), 64, 100, { f: font(700, 24), c: 'rgba(255,255,255,.7)' });
  text(ctx, s.title, 64, 172, { f: font(800, 64), c: '#fff' });
  text(ctx, s.rangeLabel, 64, 226, { f: font(500, 30), c: 'rgba(255,255,255,.85)' });
  if (s.badge) {
    ctx.font = font(700, 26);
    const bw = ctx.measureText(s.badge).width + 44;
    ctx.fillStyle = 'rgba(255,255,255,.16)'; rr(ctx, 64, 252, bw, 50, 25); ctx.fill();
    text(ctx, s.badge, 86, 286, { f: font(700, 26), c: '#fff' });
  }

  // Stat tiles
  const tiles = [
    ['🔥', 'Avg calories', n0(s.avgCal), s.goalCal ? `goal ${n0(s.goalCal)}` : ''],
    ['🥩', 'Avg protein', s.logged ? n0(s.avgP) + ' g' : '–', s.goalP ? `goal ${n0(s.goalP)} g` : ''],
    ['📅', 'Days logged', `${s.logged}/${s.n}`, s.onTarget != null ? `${s.onTarget} on target` : ''],
    ['😴', 'Avg sleep', hm(s.avgSleep), s.avgRecovery != null ? `recovery ${Math.round(s.avgRecovery)}%` : ''],
  ];
  const tw = (W - 128 - 24) / 2, th = 150;
  tiles.forEach(([e, l, v, sub], i) => {
    const x = 64 + (i % 2) * (tw + 24), y = 360 + Math.floor(i / 2) * (th + 24);
    card(ctx, x, y, tw, th);
    text(ctx, e, x + 28, y + 62, { f: font(400, 40) });
    text(ctx, l, x + 90, y + 54, { f: font(600, 24), c: C.muted });
    text(ctx, v, x + 90, y + 104, { f: font(800, 44) });
    if (sub) text(ctx, sub, x + 90, y + 136, { f: font(500, 21), c: C.muted });
  });

  // Calories chart
  let y = 360 + 2 * (th + 24) + 4;
  const chH = 290;
  card(ctx, 64, y, W - 128, chH);
  text(ctx, 'Calories per day', 96, y + 56, { f: font(700, 30) });
  const vals = s.days.map(d => d.cal || 0);
  const max = Math.max(s.goalCal || 0, ...vals) * 1.1 || 1;
  const cx = 96, cw = W - 128 - 64, cy = y + 90, ch = chH - 150;
  const bw = cw / vals.length, gap = Math.min(bw * 0.3, 14);
  vals.forEach((v, i) => {
    if (!v) return;
    const h = ch * v / max;
    const over = s.goalCal && v > s.goalCal * 1.1;
    ctx.fillStyle = over ? C.warn : C.purple3;
    rr(ctx, cx + i * bw + gap / 2, cy + ch - h, bw - gap, h, Math.min(10, (bw - gap) / 2)); ctx.fill();
  });
  if (s.goalCal) {
    const gy = cy + ch - ch * s.goalCal / max;
    ctx.strokeStyle = C.muted; ctx.setLineDash([10, 8]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, gy); ctx.lineTo(cx + cw, gy); ctx.stroke(); ctx.setLineDash([]);
    text(ctx, 'goal', cx + cw, gy - 10, { f: font(600, 20), c: C.muted, a: 'right' });
  }
  const every = vals.length <= 7 ? 1 : Math.ceil(vals.length / 6);
  s.days.forEach((d, i) => { if (i % every === 0) text(ctx, d.label, cx + i * bw + bw / 2, cy + ch + 36, { f: font(600, 22), c: C.muted, a: 'center' }); });

  // Macro split
  y += chH + 24;
  const mh = 130;
  card(ctx, 64, y, W - 128, mh);
  text(ctx, 'Average macros', 96, y + 46, { f: font(700, 30) });
  const kc = s.avgP * 4 + s.avgC * 4 + s.avgF * 9;
  const bx = 96, bwid = W - 128 - 64, by = y + 64;
  if (kc > 0) {
    ctx.save(); rr(ctx, bx, by, bwid, 22, 11); ctx.clip();
    let x = bx;
    [[s.avgP * 4, C.p], [s.avgC * 4, C.c], [s.avgF * 9, C.f]].forEach(([k, col]) => { const w = bwid * k / kc; ctx.fillStyle = col; ctx.fillRect(x, by, w, 22); x += w; });
    ctx.restore();
    [['Protein', s.avgP, C.p], ['Carbs', s.avgC, C.c], ['Fat', s.avgF, C.f]].forEach(([l, v, col], i) => {
      const lx = bx + i * (bwid / 3);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx + 9, by + 44, 9, 0, 7); ctx.fill();
      text(ctx, `${l} ${n0(v)} g`, lx + 28, by + 53, { f: font(600, 24) });
    });
  } else text(ctx, 'Nothing logged yet', bx, by + 40, { f: font(500, 24), c: C.muted });

  // Bottom row: weight, gut, off days
  y += mh + 24;
  const small = [
    ['⚖️', 'Weight', s.weight || '–'],
    ['🫄', 'Stomach days', String(s.gutDays)],
    ['😵‍💫', 'Off days', String(s.offDays)],
  ];
  const sw = (W - 128 - 48) / 3, sh = 130;
  small.forEach(([e, l, v], i) => {
    const x = 64 + i * (sw + 24);
    card(ctx, x, y, sw, sh);
    text(ctx, e + ' ' + l, x + 24, y + 48, { f: font(600, 22), c: C.muted });
    text(ctx, v, x + 24, y + 100, { f: font(800, v.length > 9 ? 30 : 38) });
  });

  text(ctx, 'Made with Pulse', W / 2, H - 34, { f: font(600, 22), c: C.muted, a: 'center' });
  return new Promise(res => cv.toBlob(res, 'image/png'));
}
