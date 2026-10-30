import * as db from './db.js';
import * as sync from './sync.js';
import { $, $$, esc, uid, dateStr, timeStr, parseDate, addDays, toTs, fmtDay, fmtTime, fmtSleep, num, optNum, fmt,
  perGram, scale, sumMacros, recipeInfo, fileToDataURL } from './util.js';
import { barChart, lineChart } from './charts.js';
import { analyzeGut } from './patterns.js';
import { offSearch, offBarcode, startScanner, readLabel } from './lookup.js';

// ---------- constants ----------
const MEALS = [
  { id: 'breakfast', name: 'Breakfast', icon: '🍳', time: '08:00' },
  { id: 'lunch', name: 'Lunch', icon: '🥗', time: '12:30' },
  { id: 'dinner', name: 'Dinner', icon: '🍝', time: '18:30' },
  { id: 'snack', name: 'Snacks', icon: '🍎', time: '15:30' },
];
const mealById = id => MEALS.find(m => m.id === id) || MEALS[3];
const TAGS = ['Dairy', 'Gluten', 'Spicy', 'Fried / greasy', 'Caffeine', 'Artificial sweetener', 'Sugar alcohol',
  'Beans / legumes', 'High fiber', 'Red meat', 'Carbonated', 'Protein powder', 'Onion / garlic', 'Acidic'];
const SYMPTOMS = ['Bloating', 'Cramps', 'Nausea', 'Gas', 'Heartburn', 'Diarrhea', 'Constipation', 'Sharp pain', 'Urgency'];
const CONTEXT = ['Stressed', 'On my period', 'Hard practice', 'Game day', 'Traveling', 'Bad sleep', 'Ate fast'];
const SEVERITY = [
  { v: 1, e: '🙂', t: 'Barely' }, { v: 2, e: '😕', t: 'Mild' }, { v: 3, e: '😣', t: 'Moderate' },
  { v: 4, e: '😖', t: 'Bad' }, { v: 5, e: '😫', t: 'Severe' }];
const DEFAULT_GOALS = { cal: 2400, p: 140, c: 300, f: 75, fiber: 30, water: 100 };

const profile = () => db.get('settings', 'profile');
const goals = () => ({ ...DEFAULT_GOALS, ...(profile()?.goals || {}) });
const firstName = () => (profile()?.name || '').trim().split(/\s+/)[0] || 'there';

const ui = { tab: 'today', date: dateStr(), range: 30, foodQ: '', recipeQ: '', gutWindow: 12 };
let lastToday = dateStr();

function defaultMeal() {
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  if (h < 10.5) return 'breakfast';
  if (h < 14.5) return 'lunch';
  if (h < 17) return 'snack';
  if (h < 21.5) return 'dinner';
  return 'snack';
}
const defaultTime = (date, meal) => date === dateStr() ? timeStr() : mealById(meal).time;
const isStandalone = () => window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;

// ---------- small UI helpers ----------
const main = $('#main');
const appEl = $('#app');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

const sheets = [];
function openSheet({ title = '', body = '', footer = '', full = false, lock = false, onMount }) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop"></div>
    <div class="sheet ${full ? 'full' : ''}" role="dialog" aria-label="${esc(title)}">
      <div class="sheet-grab"></div>
      <div class="sheet-head"><button class="icon-btn" data-x="close" aria-label="Close">✕</button><h2>${title}</h2><div class="sheet-head-r"></div></div>
      <div class="sheet-body">${body}</div>
      ${footer ? `<div class="sheet-foot">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(wrap);
  const api = {
    el: wrap,
    $: s => wrap.querySelector(s),
    $$: s => [...wrap.querySelectorAll(s)],
    on(evt, sel, fn) { wrap.addEventListener(evt, e => { const t = e.target.closest(sel); if (t && wrap.contains(t)) fn(t, e); }); },
    close() { closeSheet(api); },
    onClose: null,
  };
  if (!lock) wrap.querySelector('.sheet-backdrop').onclick = () => api.close();
  api.on('click', '[data-x="close"]', () => api.close());
  sheets.push(api);
  document.body.classList.add('noscroll');
  requestAnimationFrame(() => wrap.classList.add('open'));
  onMount?.(api);
  return api;
}
function closeSheet(api) {
  const i = sheets.indexOf(api);
  if (i < 0) return;
  sheets.splice(i, 1);
  api.onClose?.();
  api.el.classList.remove('open');
  setTimeout(() => api.el.remove(), 280);
  if (!sheets.length) document.body.classList.remove('noscroll');
}
function closeAllSheets() { [...sheets].reverse().forEach(closeSheet); }

function confirmSheet(msg, yes = 'Delete', danger = true) {
  return new Promise(res => {
    let answered = false;
    const s = openSheet({
      title: 'Are you sure?',
      body: `<p class="center">${msg}</p>`,
      footer: `<button class="btn ghost grow" data-x="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'} grow" data-x="yes">${yes}</button>`,
    });
    s.on('click', '[data-x="no"]', () => s.close());
    s.on('click', '[data-x="yes"]', () => { answered = true; res(true); s.close(); });
    s.onClose = () => { if (!answered) res(false); };
  });
}

const thumb = (photo, fallback) => photo ? `<img class="thumb" src="${photo}" alt="">` : `<span class="thumb ph">${fallback}</span>`;
const macroLine = m => `<span class="mp">${fmt(m.p)}P</span> <span class="mc">${fmt(m.c)}C</span> <span class="mf">${fmt(m.f)}F</span>`;

function ring(val, goal) {
  const r = 54, c = 2 * Math.PI * r, pct = Math.min(val / (goal || 1), 1);
  return `<svg viewBox="0 0 128 128" class="ring"><circle cx="64" cy="64" r="${r}" class="ring-bg"/>
    <circle cx="64" cy="64" r="${r}" class="ring-fg ${val > goal * 1.05 ? 'over' : ''}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 64 64)"/></svg>`;
}

function macroBar(label, k, v, goal) {
  const pct = Math.min(100, (v / (goal || 1)) * 100), left = goal - v;
  return `<div class="mb"><div class="mb-top"><span>${label}</span><span><b>${fmt(v)}</b> / ${fmt(goal)}g</span></div>
    <div class="mb-track"><i class="bg-${k}" style="width:${pct}%"></i></div>
    <div class="mb-left">${left > 0.5 ? fmt(left) + 'g left' : 'Goal hit ✓'}</div></div>`;
}

// ---------- data helpers ----------
const dayEntries = date => db.list('entries').filter(e => e.date === date).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
const getFood = id => db.get('foods', id);

function itemFor(kind, obj) {
  if (kind === 'food') return { kind, id: obj.id, name: obj.name, brand: obj.brand || '', per: perGram(obj),
    servingG: num(obj.servingG), servingLabel: obj.servingLabel || '', photo: obj.photo };
  const info = recipeInfo(obj, getFood);
  return { kind, id: obj.id, name: obj.name, brand: 'Recipe', per: info.per, servingG: info.servingG,
    servingLabel: info.servingG ? 'serving' : '', photo: obj.photo };
}

function lastGrams(kind, id) {
  let best = null;
  for (const e of db.list('entries')) {
    if (e.kind === kind && e.refId === id && (!best || (e.date + e.time) > (best.date + best.time))) best = e;
  }
  return best?.grams ?? null;
}

function entryTags(e) {
  if (e.kind === 'food') return getFood(e.refId)?.tags || [];
  if (e.kind === 'recipe') {
    const r = db.get('recipes', e.refId);
    return [...new Set((r?.ingredients || []).flatMap(i => getFood(i.foodId)?.tags || []))];
  }
  return [];
}

function fmtIn(v) { return v == null || v === '' ? '' : String(Math.round(v * 10) / 10); }

// ---------- rendering ----------
const screens = { today: screenToday, foods: screenFoods, recipes: screenRecipes, trends: screenTrends, me: screenMe };
let renderQueued = false;
function render() {
  renderQueued = false;
  if (!appEl.classList.contains('ready')) return;
  main.innerHTML = screens[ui.tab]();
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('#fab').hidden = ui.tab !== 'today';
}
const queueRender = () => { if (!renderQueued) { renderQueued = true; queueMicrotask(render); } };
function go(tab) { ui.tab = tab; render(); window.scrollTo(0, 0); }

function header(title, sub = '', extra = '') {
  return `<header class="top"><div class="top-row"><div><h1>${title}</h1>${sub ? `<div class="top-sub">${sub}</div>` : ''}</div>${extra}</div></header>`;
}

// ===== TODAY =====
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function screenToday() {
  const d = ui.date, g = goals(), ents = dayEntries(d), t = sumMacros(ents.map(e => e.macros));
  const day = db.get('days', d) || {};
  const left = g.cal - t.cal;
  return `
  <header class="top today-top">
    <div class="hello">${greeting()}, ${esc(firstName())} 💜</div>
    <div class="datenav">
      <button class="dn-btn" data-act="day" data-n="-1" aria-label="Previous day">‹</button>
      <label class="datebtn">${fmtDay(d)}${d !== dateStr() ? '' : `<span class="date-sub">${parseDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`}
        <input type="date" value="${d}" data-change="pickDate" aria-label="Pick a date"></label>
      <button class="dn-btn" data-act="day" data-n="1" aria-label="Next day">›</button>
    </div>
    ${d !== dateStr() ? `<button class="pill-btn" data-act="today">Back to today</button>` : ''}
  </header>
  <section class="card hero">
    <div class="hero-row">
      <div class="hero-ring">${ring(t.cal, g.cal)}<div class="ring-center"><div class="big">${fmt(Math.abs(left))}</div><div class="small">${left >= 0 ? 'cal left' : 'cal over'}</div></div></div>
      <div class="hero-side">
        <div class="kv"><span>Eaten</span><b>${fmt(t.cal)}</b></div>
        <div class="kv"><span>Goal</span><b>${fmt(g.cal)}</b></div>
        ${day.burned ? `<div class="kv"><span>Burned</span><b>${fmt(day.burned)}</b></div>` : ''}
        <div class="kv"><span>Fiber</span><b>${fmt(t.fiber)}<small>/${fmt(g.fiber)}g</small></b></div>
      </div>
    </div>
    <div class="mbs">${macroBar('Protein', 'p', t.p, g.p)}${macroBar('Carbs', 'c', t.c, g.c)}${macroBar('Fat', 'f', t.f, g.f)}</div>
  </section>
  ${MEALS.map(m => mealCard(m, ents.filter(e => e.meal === m.id), d)).join('')}
  ${waterCard(day, g)}
  ${bodyCard(day)}
  ${gutCard(d)}
  <div class="spacer"></div>`;
}

function mealCard(m, ents, date) {
  const tot = sumMacros(ents.map(e => e.macros));
  const yest = !ents.length && db.list('entries').some(e => e.date === addDays(date, -1) && e.meal === m.id);
  return `<section class="card meal">
    <div class="meal-head"><div class="meal-title"><span class="meal-ico">${m.icon}</span>${m.name}</div>${ents.length ? `<div class="meal-cal">${fmt(tot.cal)} cal</div>` : ''}</div>
    ${ents.map(e => `<button class="entry" data-act="editEntry" data-id="${e.id}">
        <div class="e-main"><div class="e-name">${esc(e.name)}</div>
        <div class="e-sub">${e.grams ? fmt(e.grams) + ' g · ' : ''}${macroLine(e.macros)}</div></div>
        <div class="e-cal">${fmt(e.macros.cal)}</div></button>`).join('')}
    <div class="meal-actions">
      <button class="add-btn" data-act="add" data-meal="${m.id}">＋ Add food</button>
      ${yest ? `<button class="ghost-btn" data-act="copyMeal" data-meal="${m.id}">↺ Same as yesterday</button>` : ''}
    </div></section>`;
}

function waterCard(day, g) {
  const w = day.water || 0, pct = Math.min(100, w / (g.water || 1) * 100);
  return `<section class="card water">
    <div class="card-head"><h3>💧 Water</h3><span class="muted"><b class="tx">${fmt(w)}</b> / ${fmt(g.water)} oz</span></div>
    <div class="w-track"><i style="width:${pct}%"></i></div>
    <div class="w-btns"><button data-act="water" data-oz="-8" aria-label="Remove 8 oz">−</button>
      <button data-act="water" data-oz="8">+8</button><button data-act="water" data-oz="16">+16</button><button data-act="water" data-oz="32">+32</button></div>
  </section>`;
}

function bodyCard(d) {
  const items = [
    ['😴', 'Sleep', d.sleepMin != null ? fmtSleep(d.sleepMin) : null],
    ['💚', 'Recovery', d.recovery != null ? d.recovery + '%' : null],
    ['⚡', 'Strain', d.strain != null ? d.strain : null],
    ['🔥', 'Burned', d.burned != null ? fmt(d.burned) : null],
    ['💓', 'HRV', d.hrv != null ? d.hrv + ' ms' : null],
    ['👟', 'Steps', d.steps != null ? fmt(d.steps) : null],
    ['⚖️', 'Weight', d.weight != null ? d.weight + ' lb' : null],
    ['🔋', 'Energy', d.energy ? d.energy + '/5' : null],
  ].filter(i => i[2] != null);
  return `<section class="card tap" data-act="body">
    <div class="card-head"><h3>Recovery & sleep</h3><span class="link">${items.length ? 'Edit' : 'Log'}</span></div>
    ${items.length ? `<div class="stat-grid">${items.map(i => `<div class="stat"><span class="stat-ico">${i[0]}</span><div><div class="stat-v">${esc(i[2])}</div><div class="stat-l">${i[1]}</div></div></div>`).join('')}</div>
      ${d.notes ? `<p class="note">“${esc(d.notes)}”</p>` : ''}`
    : `<p class="muted small">Add last night's sleep, your Whoop recovery & strain, calories burned, steps — and a quick journal note.</p>`}
  </section>`;
}

function gutCard(date) {
  const eps = db.list('stomach').filter(e => e.date === date).sort((a, b) => a.time.localeCompare(b.time));
  return `<section class="card gut">
    <div class="card-head"><h3>Gut check</h3>${eps.length ? `<span class="muted small">${eps.length} logged</span>` : ''}</div>
    ${eps.map(e => { const s = SEVERITY[e.severity - 1] || SEVERITY[2]; return `<button class="entry" data-act="editGut" data-id="${e.id}">
      <div class="e-main"><div class="e-name">${s.e} ${s.t} · ${fmtTime(e.time)}</div><div class="e-sub">${esc((e.symptoms || []).join(', ') || 'No symptoms picked')}</div></div><div class="chev">›</div></button>`; }).join('')}
    <button class="gut-btn" data-act="gut">😖 My stomach hurts — log it</button>
    ${!eps.length ? `<p class="muted small center">Log it when it happens. After a few, Trends will point out foods that might be the cause.</p>` : ''}
  </section>`;
}

// ===== FOODS =====
function foodSub(f) {
  return `${f.brand ? esc(f.brand) + ' · ' : ''}${fmt(num(f.cal))} cal / ${fmt(num(f.servingG))} g${f.servingLabel ? ' (' + esc(f.servingLabel) + ')' : ''}`;
}
function sortedFoods(q = '') {
  q = q.trim().toLowerCase();
  return db.list('foods').filter(f => !q || (f.name + ' ' + (f.brand || '')).toLowerCase().includes(q))
    .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || a.name.localeCompare(b.name));
}
function foodListHTML() {
  const list = sortedFoods(ui.foodQ);
  if (!db.list('foods').length) return `<div class="empty"><div class="empty-ico">🏷️</div><b>Save your go-to brands once</b>
    <p>Snap the nutrition label (or scan the barcode) and Pulse remembers it forever. Then just type how many grams you weighed — the math is done for you.</p>
    <button class="btn primary" data-act="newFood">＋ Add your first food</button></div>`;
  if (!list.length) return `<p class="muted center">No foods match “${esc(ui.foodQ)}”.</p>`;
  return list.map(f => `<button class="row" data-act="food" data-id="${f.id}">${thumb(f.photo, '🥣')}
    <div class="row-main"><div class="row-name">${esc(f.name)}${f.fav ? ' <span class="star">★</span>' : ''}</div><div class="row-sub">${foodSub(f)}</div></div><span class="chev">›</span></button>`).join('');
}
function screenFoods() {
  return `${header('My Foods', `${db.list('foods').length} saved`)}
  <div class="pad">
    <div class="action-grid">
      <button class="action" data-act="newFood"><span>📷</span>Snap label</button>
      <button class="action" data-act="scan"><span>▦</span>Scan barcode</button>
      <button class="action" data-act="online"><span>🔎</span>Search online</button>
    </div>
    <div class="search"><input type="search" placeholder="Search my foods" value="${esc(ui.foodQ)}" data-input="foodQ" autocomplete="off"></div>
    <div class="list" id="foodList">${foodListHTML()}</div>
  </div>`;
}

// ===== RECIPES =====
function recipeListHTML() {
  const q = ui.recipeQ.trim().toLowerCase();
  const all = db.list('recipes');
  if (!all.length) return `<div class="empty"><div class="empty-ico">🍲</div><b>Your recipe book</b>
    <p>Build a recipe from your saved foods, weigh the finished dish, and log any amount of it in grams — macros calculated automatically.</p>
    <button class="btn primary" data-act="newRecipe">＋ New recipe</button></div>`;
  const list = all.filter(r => !q || r.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return list.map(r => {
    const info = recipeInfo(r, getFood);
    const per = info.servings ? scale(info.total, 1 / info.servings) : scale(info.per, 100);
    return `<button class="row" data-act="recipe" data-id="${r.id}">${thumb(r.photo, '🍲')}
      <div class="row-main"><div class="row-name">${esc(r.name)}</div>
      <div class="row-sub">${fmt(per.cal)} cal ${info.servings ? '/ serving' : '/ 100 g'} · ${macroLine(per)}</div></div><span class="chev">›</span></button>`;
  }).join('') || `<p class="muted center">No recipes match.</p>`;
}
function screenRecipes() {
  return `${header('Recipes', `${db.list('recipes').length} saved`, `<button class="top-btn" data-act="newRecipe">＋ New</button>`)}
  <div class="pad">
    ${db.list('recipes').length ? `<div class="search"><input type="search" placeholder="Search recipes" value="${esc(ui.recipeQ)}" data-input="recipeQ"></div>` : ''}
    <div class="list" id="recipeList">${recipeListHTML()}</div>
  </div>`;
}

// ===== TRENDS =====
function streak() {
  const days = new Set(db.list('entries').map(e => e.date));
  let d = dateStr(), n = 0;
  if (!days.has(d)) d = addDays(d, -1);
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

function screenTrends() {
  const n = ui.range, today = dateStr();
  const dates = Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
  const by = {};
  for (const e of db.list('entries')) (by[e.date] ||= []).push(e.macros);
  const totals = dates.map(d => by[d] ? sumMacros(by[d]) : null);
  const logged = totals.filter(Boolean);
  const avg = k => logged.length ? logged.reduce((s, t) => s + t[k], 0) / logged.length : 0;
  const g = goals();
  const days = dates.map(d => db.get('days', d) || {});
  const labels = dates.map(d => { const x = parseDate(d); return `${x.getMonth() + 1}/${x.getDate()}`; });
  const v = k => totals.map(t => t ? t[k] : 0);
  const dv = k => days.map(d => d[k] ?? null);

  const avgP = avg('p'), avgC = avg('c'), avgF = avg('f');
  const kc = avgP * 4 + avgC * 4 + avgF * 9 || 1;
  const both = dates.map((d, i) => totals[i] && days[i].burned ? [totals[i].cal, days[i].burned] : null).filter(Boolean);
  const avgIn = both.length ? both.reduce((s, b) => s + b[0], 0) / both.length : 0;
  const avgOut = both.length ? both.reduce((s, b) => s + b[1], 0) / both.length : 0;
  const sleepVals = days.map(d => d.sleepMin != null ? d.sleepMin / 60 : 0);
  const sleepLogged = sleepVals.filter(Boolean);
  const recov = dv('recovery').filter(x => x != null);
  const weights = dv('weight');

  // top foods in range
  const counts = new Map();
  db.list('entries').forEach(e => { if (e.date >= dates[0] && e.kind !== 'quick') { const c = counts.get(e.name) || { n: 0, cal: 0 }; c.n++; c.cal += e.macros.cal; counts.set(e.name, c); } });
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5);

  return `${header('Trends', `🔥 ${streak()}-day logging streak`)}
  <div class="pad">
    <div class="seg range">${[7, 30, 90].map(r => `<button class="${ui.range === r ? 'on' : ''}" data-act="range" data-r="${r}">${r === 7 ? 'Week' : r === 30 ? 'Month' : '3 months'}</button>`).join('')}</div>

    <section class="card">
      <div class="card-head"><h3>Calories</h3><span class="muted small">${logged.length}/${n} days logged</span></div>
      <div class="big-stats"><div><b>${fmt(avg('cal'))}</b><span>avg / day</span></div><div><b>${fmt(g.cal)}</b><span>goal</span></div><div><b>${logged.filter(t => Math.abs(t.cal - g.cal) <= g.cal * 0.1).length}</b><span>days on target</span></div></div>
      ${barChart({ values: v('cal'), labels, dates, goal: g.cal, colorFn: x => x > g.cal * 1.1 ? 'var(--warn)' : 'var(--purple-3)' })}
      <p class="muted tiny center">Tap a bar to open that day. Dashed line = goal.</p>
    </section>

    <section class="card">
      <div class="card-head"><h3>Protein</h3><span class="muted small">avg ${fmt(avgP)} g · goal ${fmt(g.p)} g</span></div>
      ${barChart({ values: v('p'), labels, dates, goal: g.p, color: 'var(--p)' })}
    </section>

    <section class="card">
      <h3>Average macro split</h3>
      ${logged.length ? `<div class="split"><i class="bg-p" style="flex:${avgP * 4}"></i><i class="bg-c" style="flex:${avgC * 4}"></i><i class="bg-f" style="flex:${avgF * 9}"></i></div>
      <div class="split-legend">
        <div><span class="dot bg-p"></span>Protein <b>${fmt(avgP)} g</b> <small>${Math.round(avgP * 400 / kc)}%</small></div>
        <div><span class="dot bg-c"></span>Carbs <b>${fmt(avgC)} g</b> <small>${Math.round(avgC * 400 / kc)}%</small></div>
        <div><span class="dot bg-f"></span>Fat <b>${fmt(avgF)} g</b> <small>${Math.round(avgF * 900 / kc)}%</small></div>
      </div>` : `<div class="chart-empty">Nothing logged in this range yet</div>`}
    </section>

    <section class="card">
      <div class="card-head"><h3>Fuel vs. burn</h3></div>
      ${both.length ? `<div class="big-stats"><div><b>${fmt(avgIn)}</b><span>avg eaten</span></div><div><b>${fmt(avgOut)}</b><span>avg burned</span></div><div><b class="${avgIn - avgOut < -300 ? 'warn-t' : ''}">${avgIn - avgOut > 0 ? '+' : ''}${fmt(avgIn - avgOut)}</b><span>difference</span></div></div>
      ${lineChart({ series: [{ values: totals.map((t, i) => t && days[i].burned ? t.cal : null), color: 'var(--purple-3)' }, { values: days.map((d, i) => totals[i] && d.burned ? d.burned : null), color: 'var(--warn)' }], labels })}
      <div class="legend"><span><i class="dot" style="background:var(--purple-3)"></i>Eaten</span><span><i class="dot" style="background:var(--warn)"></i>Burned</span></div>
      ${avgIn - avgOut < -300 ? `<p class="tip">You're averaging ${fmt(avgOut - avgIn)} cal under what you burn. Under-fueling can hurt recovery & performance — worth a chat with your dietitian.</p>` : ''}`
      : `<p class="muted small">Log calories burned (from Whoop) on days you log food to compare them here.</p>`}
    </section>

    <section class="card">
      <div class="card-head"><h3>Sleep</h3><span class="muted small">${sleepLogged.length ? 'avg ' + fmtSleep(sleepLogged.reduce((a, b) => a + b, 0) / sleepLogged.length * 60) : ''}</span></div>
      ${barChart({ values: sleepVals, labels, dates, goal: 8, color: 'var(--lav)', fmtY: x => x + 'h' })}
    </section>

    <section class="card">
      <div class="card-head"><h3>Recovery</h3><span class="muted small">${recov.length ? 'avg ' + Math.round(recov.reduce((a, b) => a + b, 0) / recov.length) + '%' : ''}</span></div>
      ${barChart({ values: dv('recovery').map(x => x || 0), labels, dates, colorFn: x => x >= 67 ? 'var(--good)' : x >= 34 ? 'var(--mid)' : 'var(--bad)', fmtY: x => x + '%' })}
    </section>

    <section class="card">
      <div class="card-head"><h3>Strain</h3></div>
      ${barChart({ values: dv('strain').map(x => x || 0), labels, dates, color: 'var(--c)', fmtY: x => Math.round(x * 10) / 10 })}
    </section>

    ${weights.filter(x => x != null).length >= 2 ? `<section class="card"><div class="card-head"><h3>Weight</h3></div>${lineChart({ series: [{ values: weights, color: 'var(--purple-3)' }], labels, fmtY: x => Math.round(x) })}</section>` : ''}

    ${top.length ? `<section class="card"><h3>Most-logged foods</h3>${top.map(([name, c]) => `<div class="kv-row"><span>${esc(name)}</span><span class="muted">${c.n}×</span></div>`).join('')}</section>` : ''}

    ${gutTrends(dates)}
  </div>`;
}

function gutTrends(dates) {
  const all = db.list('stomach');
  const inRange = all.filter(e => e.date >= dates[0]);
  const a = analyzeGut(db.list('entries'), all, entryTags, { windowH: ui.gutWindow });
  const pct = x => Math.round(x * 100) + '%';
  const sym = new Map();
  inRange.forEach(e => (e.symptoms || []).forEach(s => sym.set(s, (sym.get(s) || 0) + 1)));
  return `<section class="card gut-trends">
    <div class="card-head"><h3>🔍 Stomach pattern finder</h3></div>
    <div class="big-stats"><div><b>${inRange.length}</b><span>episodes this range</span></div><div><b>${inRange.length ? (inRange.reduce((s, e) => s + e.severity, 0) / inRange.length).toFixed(1) : '–'}</b><span>avg severity /5</span></div></div>
    ${sym.size ? `<p class="small">Most common: ${[...sym.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(s => `<b>${esc(s[0])}</b> (${s[1]})`).join(', ')}</p>` : ''}
    ${a.episodes < 3 ? `<p class="muted small">Log at least 3 stomach episodes (and keep logging food) and this will start pointing out possible trigger foods.</p>` : `
      <div class="win">Look at food eaten within
        ${[4, 12, 24].map(w => `<button class="chip sm ${ui.gutWindow === w ? 'on' : ''}" data-act="gutWin" data-w="${w}">${w}h</button>`).join('')} before it hurt</div>
      <p class="muted small">Normally, ${pct(a.base)} of what you eat is followed by stomach trouble within ${ui.gutWindow}h.</p>
      ${a.foods.length ? `<h4>Possible triggers</h4>${a.foods.map(f => `<div class="suspect"><div><b>${esc(f.name)}</b><div class="muted tiny">Eaten ${f.eaten}× · trouble after ${f.hit} of them</div></div><span class="badge">${pct(f.rate)}</span></div>`).join('')}`
        : `<p class="small">No clear trigger foods yet — keep logging! 👍</p>`}
      ${a.tags.length ? `<h4>Possible trigger types</h4><div class="chips">${a.tags.map(t => `<span class="chip sm warnchip">${esc(t.name)} · ${pct(t.rate)}</span>`).join('')}</div>` : ''}
      ${a.safe.length ? `<h4>Seem safe for you</h4><div class="chips">${a.safe.map(s => `<span class="chip sm safechip">${esc(s.name)}</span>`).join('')}</div>` : ''}
      <p class="muted tiny">Patterns, not proof. Tag foods (dairy, gluten…) to spot trigger types. Bring this to your athletic trainer or dietitian.</p>`}
    <button class="btn soft full" data-act="gutHistory">See all stomach logs</button>
  </section>`;
}

// ===== ME =====
function screenMe() {
  const p = profile() || {}, g = goals();
  const cloud = sync.enabled && sync.currentUser();
  const gi = (k, label, unit) => `<div class="field"><label>${label}</label><div class="unit-in"><input inputmode="decimal" value="${g[k]}" data-change="goal" data-k="${k}"><span>${unit}</span></div></div>`;
  const statusTxt = { idle: 'Ready', syncing: 'Syncing…', ok: 'All backed up ✓', error: 'Sync problem — will retry', offline: 'Offline — will sync later' }[sync.status];
  return `${header('Me')}
  <div class="pad">
    <section class="card profile">
      <div class="avatar">${esc(firstName()[0]?.toUpperCase() || '?')}</div>
      <div class="grow"><input class="name-in" value="${esc(p.name || '')}" placeholder="Your name" data-change="name" aria-label="Your name">
      <div class="muted small">${cloud ? esc(cloud.email) : 'Saved on this phone'}</div></div>
    </section>

    <section class="card">
      <h3>Daily goals</h3>
      <div class="grid2">${gi('cal', 'Calories', 'cal')}${gi('p', 'Protein', 'g')}${gi('c', 'Carbs', 'g')}${gi('f', 'Fat', 'g')}${gi('fiber', 'Fiber', 'g')}${gi('water', 'Water', 'oz')}</div>
      <p class="muted tiny">Use the targets from your team dietitian. Changes save automatically.</p>
      <button class="btn soft full" data-act="calcMacros">Fill fat & carbs from my calories + protein</button>
    </section>

    <section class="card">
      <h3>Appearance</h3>
      <div class="seg">${['system', 'light', 'dark'].map(t => `<button class="${(p.theme || 'system') === t ? 'on' : ''}" data-act="theme" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    </section>

    <section class="card">
      <h3>Account & backup</h3>
      ${cloud ? `<div class="kv-row"><span>Cloud sync</span><span class="muted">${statusTxt}</span></div>
        <div class="btn-row"><button class="btn soft grow" data-act="syncNow">Sync now</button><button class="btn ghost grow" data-act="signOut">Sign out</button></div>`
      : `<p class="small muted">Your data lives on this phone. Download a backup now and then so you never lose it.</p>`}
      <div class="btn-col">
        <button class="btn soft" data-act="backup">⬇︎ Download backup</button>
        <label class="btn soft">⬆︎ Restore from backup<input type="file" accept=".json,application/json" hidden data-change="restore"></label>
        <button class="btn soft" data-act="csvDays">📊 Export daily summary (spreadsheet)</button>
        <button class="btn soft" data-act="csvFood">🧾 Export food log (spreadsheet)</button>
      </div>
      <p class="muted tiny">${db.list('foods').length} foods · ${db.list('recipes').length} recipes · ${new Set(db.list('entries').map(e => e.date)).size} days logged</p>
    </section>

    ${!isStandalone() ? `<section class="card install"><h3>📲 Put Pulse on your home screen</h3>
      <ol><li>Open this page in <b>Safari</b></li><li>Tap the <b>Share</b> button <span class="kbd">⬆︎</span></li><li>Scroll and tap <b>Add to Home Screen</b></li><li>Tap <b>Add</b> — it opens full-screen like a real app</li></ol></section>` : ''}

    <p class="muted tiny center">Pulse v1.0 · Go Pilots 💜</p>
  </div>`;
}

// ---------- global events ----------
const acts = {
  tab: d => go(d.tab),
  day: d => { ui.date = addDays(ui.date, +d.n); render(); },
  today: () => { ui.date = dateStr(); render(); },
  add: d => openPicker({ meal: d.meal || defaultMeal(), date: ui.date }),
  editEntry: d => editEntry(d.id),
  copyMeal: d => copyMeal(d.meal),
  water: d => addWater(+d.oz),
  body: () => openBody(ui.date),
  gut: () => openGut({ date: ui.date }),
  editGut: d => openGut({ ep: db.get('stomach', d.id) }),
  gutHistory: () => openGutHistory(),
  newFood: () => openFoodForm({ onSaved: f => openFoodDetail(f.id) }),
  food: d => openFoodDetail(d.id),
  scan: () => scanFlow({ onFood: f => openFoodDetail(f.id) }),
  online: () => openOnline({ onSaved: f => openFoodDetail(f.id) }),
  newRecipe: () => openRecipeForm({}),
  recipe: d => openRecipeDetail(d.id),
  range: d => { ui.range = +d.r; render(); },
  gotoDay: d => { ui.date = d.d; go('today'); },
  gutWin: d => { ui.gutWindow = +d.w; render(); },
  theme: d => { saveProfile({ theme: d.t }); applyTheme(); },
  calcMacros: () => {
    const g = goals(), fat = Math.round(g.cal * 0.27 / 9);
    saveProfile({ goals: { ...g, f: fat, c: Math.max(0, Math.round((g.cal - g.p * 4 - fat * 9) / 4)) } });
    toast('Fat ≈ 27% of calories, carbs fill the rest');
  },
  syncNow: () => sync.syncNow(),
  signOut: async () => { if (await confirmSheet('Sign out of Pulse on this phone?', 'Sign out', false)) { await sync.signOut(); location.reload(); } },
  backup: () => exportBackup(),
  csvDays: () => exportDaysCSV(),
  csvFood: () => exportFoodCSV(),
};
const inputs = {
  foodQ: el => { ui.foodQ = el.value; $('#foodList').innerHTML = foodListHTML(); },
  recipeQ: el => { ui.recipeQ = el.value; $('#recipeList').innerHTML = recipeListHTML(); },
};
const changes = {
  pickDate: el => { if (el.value) { ui.date = el.value; render(); } },
  goal: el => { const g = goals(); g[el.dataset.k] = num(el.value); saveProfile({ goals: g }); },
  name: el => saveProfile({ name: el.value.trim() }),
  restore: el => restoreBackup(el.files[0]),
};
const outsideSheet = el => !el.closest('.sheet-wrap');
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && outsideSheet(el) && acts[el.dataset.act]) acts[el.dataset.act](el.dataset, el, e);
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el && outsideSheet(el)) inputs[el.dataset.input]?.(el, e);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el && outsideSheet(el)) changes[el.dataset.change]?.(el, e);
});

// Swipe left/right on Today to change days.
let touch = null;
main.addEventListener('touchstart', e => { if (ui.tab === 'today' && e.touches.length === 1) touch = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
main.addEventListener('touchend', e => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch[0], dy = e.changedTouches[0].clientY - touch[1];
  touch = null;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 40) { ui.date = addDays(ui.date, dx < 0 ? 1 : -1); render(); }
}, { passive: true });

function saveProfile(patch) {
  const p = { ...(profile() || { id: 'profile' }), ...patch, id: 'profile' };
  db.put('settings', p);
}
function applyTheme() {
  const t = profile()?.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// ---------- day actions ----------
function addWater(oz) {
  const d = { ...(db.get('days', ui.date) || { id: ui.date, date: ui.date }) };
  d.water = Math.max(0, (d.water || 0) + oz);
  db.put('days', d);
}
function copyMeal(meal) {
  const src = dayEntries(addDays(ui.date, -1)).filter(e => e.meal === meal);
  db.putMany('entries', src.map(e => ({ ...e, id: uid(), date: ui.date, time: defaultTime(ui.date, meal) })));
  toast(`Copied ${src.length} item${src.length === 1 ? '' : 's'} from yesterday`);
}
function editEntry(id) {
  const e = db.get('entries', id);
  if (!e) return;
  if (e.kind === 'quick') return openQuick({ entry: e });
  const obj = db.get(e.kind === 'food' ? 'foods' : 'recipes', e.refId);
  const item = obj ? itemFor(e.kind, obj) : { kind: e.kind, id: e.refId, name: e.name, brand: e.brand, per: e.per, servingG: 0 };
  openAmount({ item, entry: e, meal: e.meal, date: e.date });
}

// ---------- food picker (log & ingredient modes) ----------
function recentItems() {
  const seen = new Set(), out = [];
  const ents = db.list('entries').sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  for (const e of ents) {
    if (e.kind === 'quick') continue;
    const key = e.kind + ':' + e.refId;
    if (seen.has(key)) continue;
    seen.add(key);
    const obj = db.get(e.kind === 'food' ? 'foods' : 'recipes', e.refId);
    if (obj) out.push({ kind: e.kind, obj, last: e });
    if (out.length >= 40) break;
  }
  return out;
}

function openPicker({ meal, date, mode = 'log', onPick }) {
  let tab = mode === 'log' && recentItems().length ? 'recent' : 'foods', q = '', added = 0, addedCal = 0;
  const s = openSheet({
    title: mode === 'log' ? `Add to ${mealById(meal).name}` : 'Add ingredient', full: true,
    body: `<div class="search sticky"><input id="pq" type="search" placeholder="Search my foods${mode === 'log' ? ' & recipes' : ''}" autocomplete="off"></div>
      <div class="tool-row">
        <button class="tool" data-x="new"><span>📷</span>New food</button>
        <button class="tool" data-x="scan"><span>▦</span>Scan</button>
        <button class="tool" data-x="online"><span>🔎</span>Online</button>
        ${mode === 'log' ? `<button class="tool" data-x="quick"><span>⚡</span>Quick add</button>` : ''}
      </div>
      <div class="seg" id="ptabs"></div>
      <div class="list" id="plist"></div>`,
    footer: mode === 'log' ? `<div class="added grow" id="addedTxt">Tap a food, type the grams, done.</div><button class="btn primary" data-x="close">Done</button>` : '',
  });
  const tabs = mode === 'log' ? [['recent', 'Recent'], ['foods', 'My Foods'], ['recipes', 'Recipes']] : [['foods', 'My Foods']];
  function draw() {
    s.$('#ptabs').innerHTML = q || tabs.length < 2 ? '' : tabs.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-x="tab" data-t="${k}">${l}</button>`).join('');
    s.$('#ptabs').hidden = !!q || tabs.length < 2;
    let rows = [];
    if (q) {
      rows = sortedFoods(q).map(f => ['food', f, foodSub(f)]);
      if (mode === 'log') rows.push(...db.list('recipes').filter(r => r.name.toLowerCase().includes(q.toLowerCase())).map(r => ['recipe', r, 'Recipe']));
    } else if (tab === 'recent') {
      rows = recentItems().map(r => ['' + r.kind, r.obj, `Last: ${fmt(r.last.grams)} g · ${fmt(r.last.macros.cal)} cal`]);
    } else if (tab === 'foods') {
      rows = sortedFoods().map(f => ['food', f, foodSub(f)]);
    } else {
      rows = db.list('recipes').sort((a, b) => a.name.localeCompare(b.name)).map(r => ['recipe', r, 'Recipe']);
    }
    s.$('#plist').innerHTML = rows.length ? rows.map(([k, o, sub]) => `<button class="row" data-x="pick" data-k="${k}" data-id="${o.id}">
        ${thumb(o.photo, k === 'recipe' ? '🍲' : '🥣')}<div class="row-main"><div class="row-name">${esc(o.name)}${o.fav ? ' <span class="star">★</span>' : ''}</div><div class="row-sub">${sub}</div></div><span class="row-plus">＋</span></button>`).join('')
      : `<div class="empty small"><p>${q ? `Nothing saved called “${esc(q)}”.` : tab === 'recipes' ? 'No recipes yet.' : 'No saved foods yet.'}</p>
         <button class="btn primary" data-x="new">📷 Add it from the label</button>${q ? `<button class="btn soft" data-x="online">🔎 Search online for “${esc(q)}”</button>` : ''}</div>`;
  }
  const picked = (kind, obj) => {
    if (mode === 'ingredient') { onPick(obj); s.close(); return; }
    openAmount({ item: itemFor(kind, obj), meal, date, onAdded: e => {
      added++; addedCal += e.macros.cal;
      s.$('#addedTxt').innerHTML = `<b>✓ ${added} added</b> · ${fmt(addedCal)} cal`;
      s.$('#pq').value = ''; q = ''; draw();
    } });
  };
  s.on('input', '#pq', el => { q = el.value.trim(); draw(); });
  s.on('click', '[data-x="tab"]', el => { tab = el.dataset.t; draw(); });
  s.on('click', '[data-x="pick"]', el => picked(el.dataset.k, db.get(el.dataset.k === 'food' ? 'foods' : 'recipes', el.dataset.id)));
  s.on('click', '[data-x="new"]', () => openFoodForm({ prefill: q ? { name: q } : {}, onSaved: f => picked('food', f) }));
  s.on('click', '[data-x="scan"]', () => scanFlow({ onFood: f => picked('food', f) }));
  s.on('click', '[data-x="online"]', () => openOnline({ q, onSaved: f => picked('food', f) }));
  s.on('click', '[data-x="quick"]', () => openQuick({ meal, date }));
  draw();
}

// ---------- amount sheet ----------
function openAmount({ item, entry = null, meal, date, onAdded }) {
  let unit = 'g', curMeal = meal;
  const startG = entry ? entry.grams : (lastGrams(item.kind, item.id) ?? (item.servingG || 100));
  const quick = [];
  const lg = lastGrams(item.kind, item.id);
  if (lg) quick.push([lg, `Last time · ${fmt(lg)} g`]);
  if (item.servingG) {
    const sl = item.kind === 'food' && item.servingLabel ? item.servingLabel : 'serving';
    quick.push([item.servingG, `${/^\d/.test(sl) ? '' : '1 '}${esc(sl)} · ${fmt(item.servingG)} g`]);
  }
  quick.push([100, '100 g']);
  const s = openSheet({
    title: entry ? 'Edit entry' : 'How much?',
    body: `<div class="amt-food">${thumb(item.photo, item.kind === 'recipe' ? '🍲' : '🥣')}<div><div class="amt-name">${esc(item.name)}</div><div class="muted small">${esc(item.brand || '')}</div></div></div>
      <div class="amt-input"><input id="amt" type="text" inputmode="decimal" value="${fmtIn(startG)}" autocomplete="off" aria-label="Amount">
        <div class="seg unit">${`<button data-x="unit" data-u="g" class="on">grams</button>`}${item.servingG ? `<button data-x="unit" data-u="s">servings</button>` : ''}</div></div>
      <div class="chips">${quick.map(([g, l]) => `<button class="chip sm" data-x="q" data-g="${g}">${l}</button>`).join('')}</div>
      <div class="amt-prev" id="prev"></div>
      <div class="field"><label>Meal</label><div class="chips">${MEALS.map(m => `<button class="chip ${m.id === meal ? 'on' : ''}" data-x="meal" data-m="${m.id}">${m.icon} ${m.name}</button>`).join('')}</div></div>
      <div class="field"><label>Time eaten</label><input id="etime" type="time" value="${entry?.time || defaultTime(date, meal)}"></div>`,
    footer: `${entry ? `<button class="btn ghost danger-t" data-x="del">Delete</button>` : ''}<button class="btn primary grow" data-x="save" id="saveBtn"></button>`,
  });
  const inp = s.$('#amt');
  const grams = () => unit === 'g' ? num(inp.value) : num(inp.value) * item.servingG;
  function update() {
    const g = grams(), m = scale(item.per, g);
    s.$('#prev').innerHTML = `<div class="prev-cal"><b>${fmt(m.cal)}</b> cal</div>
      <div class="prev-m"><div><b class="mp">${fmt(m.p)}g</b><span>protein</span></div><div><b class="mc">${fmt(m.c)}g</b><span>carbs</span></div><div><b class="mf">${fmt(m.f)}g</b><span>fat</span></div><div><b>${fmt(m.fiber)}g</b><span>fiber</span></div></div>
      ${unit === 's' ? `<div class="muted tiny center">= ${fmt(g)} g</div>` : ''}`;
    s.$('#saveBtn').textContent = entry ? 'Save' : `Add to ${mealById(curMeal).name}`;
  }
  s.on('input', '#amt', update);
  s.on('click', '[data-x="unit"]', el => {
    const g = grams();
    unit = el.dataset.u;
    s.$$('[data-x="unit"]').forEach(b => b.classList.toggle('on', b === el));
    inp.value = fmtIn(unit === 'g' ? g : g / item.servingG);
    update();
  });
  s.on('click', '[data-x="q"]', el => { const g = num(el.dataset.g); inp.value = fmtIn(unit === 'g' ? g : g / item.servingG); update(); });
  s.on('click', '[data-x="meal"]', el => { curMeal = el.dataset.m; s.$$('[data-x="meal"]').forEach(b => b.classList.toggle('on', b === el)); update(); });
  s.on('click', '[data-x="del"]', () => { db.remove('entries', entry.id); s.close(); toast('Removed'); });
  s.on('click', '[data-x="save"]', () => {
    const g = grams();
    if (!(g > 0)) { inp.focus(); return toast('Type how many grams'); }
    const e = entry ? { ...entry } : { id: uid(), date, kind: item.kind, refId: item.id };
    Object.assign(e, { name: item.name, brand: item.kind === 'food' ? item.brand : '', grams: g, per: item.per,
      macros: scale(item.per, g), meal: curMeal, time: s.$('#etime').value || timeStr() });
    db.put('entries', e);
    s.close();
    toast(entry ? 'Saved' : `Added · ${fmt(e.macros.cal)} cal`);
    onAdded?.(e);
  });
  update();
  inp.focus();
  inp.select();
}

function openQuick({ entry = null, meal = defaultMeal(), date = ui.date }) {
  const m = entry?.macros || {};
  let curMeal = entry?.meal || meal;
  const s = openSheet({
    title: entry ? 'Edit quick add' : 'Quick add',
    body: `<p class="muted small">For when you just know the numbers (restaurant, team meal, etc).</p>
      <div class="field"><label>What was it?</label><input id="qn" value="${esc(entry?.name || '')}" placeholder="e.g. Team dinner"></div>
      <div class="grid2">
        <div class="field"><label>Calories</label><input id="qcal" inputmode="decimal" value="${fmtIn(m.cal)}"></div>
        <div class="field"><label>Protein (g)</label><input id="qp" inputmode="decimal" value="${fmtIn(m.p)}"></div>
        <div class="field"><label>Carbs (g)</label><input id="qc" inputmode="decimal" value="${fmtIn(m.c)}"></div>
        <div class="field"><label>Fat (g)</label><input id="qf" inputmode="decimal" value="${fmtIn(m.f)}"></div>
      </div>
      <div class="field"><label>Meal</label><div class="chips">${MEALS.map(x => `<button class="chip ${x.id === curMeal ? 'on' : ''}" data-x="meal" data-m="${x.id}">${x.icon} ${x.name}</button>`).join('')}</div></div>`,
    footer: `${entry ? `<button class="btn ghost danger-t" data-x="del">Delete</button>` : ''}<button class="btn primary grow" data-x="save">${entry ? 'Save' : 'Add'}</button>`,
  });
  s.on('click', '[data-x="meal"]', el => { curMeal = el.dataset.m; s.$$('[data-x="meal"]').forEach(b => b.classList.toggle('on', b === el)); });
  s.on('click', '[data-x="del"]', () => { db.remove('entries', entry.id); s.close(); });
  s.on('click', '[data-x="save"]', () => {
    let p = num(s.$('#qp').value), c = num(s.$('#qc').value), f = num(s.$('#qf').value), cal = num(s.$('#qcal').value);
    if (!cal) cal = p * 4 + c * 4 + f * 9;
    if (!cal) return toast('Add at least calories');
    const e = entry ? { ...entry } : { id: uid(), date, kind: 'quick', time: defaultTime(date, curMeal) };
    Object.assign(e, { name: s.$('#qn').value.trim() || 'Quick add', grams: null, meal: curMeal, macros: { cal, p, c, f, fiber: 0, sugar: 0, sodium: 0 } });
    db.put('entries', e);
    s.close();
    toast(entry ? 'Saved' : `Added · ${fmt(cal)} cal`);
  });
}

// ---------- food form ----------
function openFoodForm({ food = null, prefill = {}, onSaved } = {}) {
  const f = food ? { ...food } : { id: uid(), name: '', brand: '', servingG: '', servingLabel: '', cal: '', p: '', c: '', f: '', fiber: '', sugar: '', sodium: '', tags: [], fav: false, photo: '', barcode: '', ...prefill };
  let photoFile = null, tags = new Set(f.tags || []);
  const fld = (k, label, unit = '', ph = '') => `<div class="field"><label for="ff-${k}">${label}</label><div class="unit-in"><input id="ff-${k}" data-k="${k}" inputmode="decimal" value="${esc(f[k] ?? '')}" placeholder="${ph}"><span>${unit}</span></div></div>`;
  const s = openSheet({
    title: food ? 'Edit food' : 'New food', full: true, lock: true,
    body: `
      <label class="photo-box ${f.photo ? 'has' : ''}" id="pbox">${f.photo ? `<img src="${f.photo}" alt="Label photo">` : `<span class="pb-ico">📷</span><b>Snap the nutrition label</b><span class="muted small">Saved with the food so you never retake it</span>`}
        <input type="file" accept="image/*" hidden id="photoIn"></label>
      <button class="btn soft full" id="ocrBtn" data-x="ocr" ${photoFile || f.photo ? '' : 'hidden'}>✨ Fill in the numbers from the photo</button>
      <div class="muted small center" id="ocrMsg"></div>
      <div class="field"><label for="ff-name">Name *</label><input id="ff-name" data-t="name" value="${esc(f.name)}" placeholder="e.g. Fage 0% Greek Yogurt" autocomplete="off"></div>
      <div class="field"><label for="ff-brand">Brand</label><input id="ff-brand" data-t="brand" value="${esc(f.brand || '')}" placeholder="optional" autocomplete="off"></div>
      <h4 class="sec">Nutrition facts <span class="muted">— copy straight from the label</span></h4>
      <div class="grid2">
        ${fld('servingG', 'Serving size *', 'g', '28')}
        <div class="field"><label for="ff-sl">Serving name</label><input id="ff-sl" data-t="servingLabel" value="${esc(f.servingLabel || '')}" placeholder="1 cup, 2 tbsp"></div>
        ${fld('cal', 'Calories *', 'cal')}${fld('p', 'Protein', 'g')}${fld('c', 'Total carbs', 'g')}${fld('f', 'Total fat', 'g')}
        ${fld('fiber', 'Fiber', 'g')}${fld('sugar', 'Total sugars', 'g')}${fld('sodium', 'Sodium', 'mg')}
      </div>
      <div class="calc-hint" id="hint"></div>
      <h4 class="sec">Tags <span class="muted">— helps find stomach triggers</span></h4>
      <div class="chips">${TAGS.map(t => `<button class="chip sm ${tags.has(t) ? 'on' : ''}" data-x="tag" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="ff-fav" ${f.fav ? 'checked' : ''}> ★ Favorite (shows at the top)</label>
      ${food ? `<button class="btn ghost danger-t full" data-x="del">Delete this food</button>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save food</button>`,
  });
  const val = k => s.$(`[data-k="${k}"]`).value;
  function hint() {
    const g = num(val('servingG')), cal = num(val('cal'));
    const est = num(val('p')) * 4 + num(val('c')) * 4 + num(val('f')) * 9;
    let h = '';
    if (g && cal) h = `That's <b>${fmt(cal / g * 100)} cal per 100 g</b>.`;
    if (cal && est && Math.abs(est - cal) > Math.max(25, cal * 0.25)) h += ` <span class="warn-t">Heads up: macros add up to ~${fmt(est)} cal — double-check the numbers.</span>`;
    s.$('#hint').innerHTML = h;
  }
  s.on('input', '[data-k]', hint);
  s.on('change', '#photoIn', async el => {
    const file = el.files[0];
    if (!file) return;
    photoFile = file;
    try {
      f.photo = await fileToDataURL(file, 900, 0.7);
      s.$('#pbox').classList.add('has');
      s.$('#pbox').innerHTML = `<img src="${f.photo}" alt="Label photo"><input type="file" accept="image/*" hidden id="photoIn">`;
      s.$('#ocrBtn').hidden = false;
      runOCR();
    } catch (e) { toast(e.message); }
  });
  async function runOCR() {
    const msg = s.$('#ocrMsg'), btn = s.$('#ocrBtn');
    let src = photoFile;
    if (!src && f.photo) src = await (await fetch(f.photo)).blob();
    if (!src) return;
    btn.disabled = true;
    try {
      const r = await readLabel(src, t => { msg.textContent = t; });
      const found = Object.entries(r).filter(([, v]) => v != null);
      found.forEach(([k, v]) => { const i = s.$(`[data-k="${k}"]`); if (i) { i.value = v; i.classList.add('filled'); } });
      msg.innerHTML = found.length ? `Filled ${found.length} numbers — <b>please double-check them</b> against the label.` : `Couldn't read the label clearly. Try a straight-on, well-lit photo — or just type the numbers.`;
      hint();
    } catch (e) {
      msg.textContent = 'Label reader needs internet the first time. You can type the numbers instead.';
    } finally { btn.disabled = false; }
  }
  s.on('click', '[data-x="ocr"]', runOCR);
  s.on('click', '[data-x="tag"]', el => { const t = el.dataset.t; tags.has(t) ? tags.delete(t) : tags.add(t); el.classList.toggle('on'); });
  s.on('click', '[data-x="del"]', async () => {
    if (!(await confirmSheet(`Delete “${esc(f.name)}”? Past log entries stay.`))) return;
    db.remove('foods', f.id); closeAllSheets(); toast('Food deleted');
  });
  s.on('click', '[data-x="save"]', () => {
    s.$$('[data-t]').forEach(i => { f[i.dataset.t] = i.value.trim(); });
    s.$$('[data-k]').forEach(i => { f[i.dataset.k] = optNum(i.value) ?? ''; });
    f.tags = [...tags];
    f.fav = s.$('#ff-fav').checked;
    if (!f.name) return toast('Give it a name');
    if (!(num(f.servingG) > 0)) return toast('Add the serving size in grams');
    if (f.cal === '') return toast('Add the calories');
    db.put('foods', f);
    // If she fixed a typo on the label, update today's entries for this food.
    const per = perGram(f);
    const todays = db.list('entries').filter(e => e.kind === 'food' && e.refId === f.id && e.date === dateStr());
    if (food && todays.length) db.putMany('entries', todays.map(e => ({ ...e, name: f.name, brand: f.brand, per, macros: scale(per, e.grams) })));
    s.close();
    toast(food ? 'Saved' : 'Food saved 🎉');
    onSaved?.(f);
  });
  hint();
}

function openFoodDetail(id) {
  const f = getFood(id);
  if (!f) return;
  const per = perGram(f), serv = scale(per, num(f.servingG)), h = scale(per, 100);
  const row = (l, k, u) => `<tr><td>${l}</td><td>${fmt(serv[k])}${u}</td><td>${fmt(h[k])}${u}</td></tr>`;
  const s = openSheet({
    title: '', full: true,
    body: `${f.photo ? `<img class="detail-img" src="${f.photo}" alt="Nutrition label">` : ''}
      <h2 class="detail-name">${esc(f.name)}</h2>
      <div class="muted center">${esc(f.brand || '')}</div>
      ${(f.tags || []).length ? `<div class="chips center-chips">${f.tags.map(t => `<span class="chip sm">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="card calc">
        <label for="cg">How much did you weigh?</label>
        <div class="unit-in big"><input id="cg" inputmode="decimal" placeholder="0"><span>g</span></div>
        <div id="cres" class="muted center small">Type grams to see the exact macros</div>
      </div>
      <table class="nut"><thead><tr><th></th><th>Per serving<br><small>${fmt(num(f.servingG))} g${f.servingLabel ? ' · ' + esc(f.servingLabel) : ''}</small></th><th>Per 100 g</th></tr></thead>
      <tbody>${row('Calories', 'cal', '')}${row('Protein', 'p', ' g')}${row('Carbs', 'c', ' g')}${row('Fat', 'f', ' g')}${row('Fiber', 'fiber', ' g')}${row('Sugar', 'sugar', ' g')}${row('Sodium', 'sodium', ' mg')}</tbody></table>
      ${f.barcode ? `<p class="muted tiny center">Barcode ${esc(f.barcode)}</p>` : ''}`,
    footer: `<button class="btn ghost" data-x="edit">Edit</button><button class="btn primary grow" data-x="log">Log it</button>`,
  });
  s.$('.sheet-head-r').innerHTML = `<button class="icon-btn star-btn ${f.fav ? 'on' : ''}" data-x="fav" aria-label="Favorite">★</button>`;
  s.on('input', '#cg', el => {
    const g = num(el.value), m = scale(per, g);
    s.$('#cres').innerHTML = g ? `<div class="prev-cal"><b>${fmt(m.cal)}</b> cal</div><div>${macroLine(m)} · ${fmt(m.fiber)}g fiber</div>` : 'Type grams to see the exact macros';
  });
  s.on('click', '[data-x="fav"]', el => { db.put('foods', { ...getFood(id), fav: !el.classList.contains('on') }); el.classList.toggle('on'); });
  s.on('click', '[data-x="edit"]', () => { s.close(); openFoodForm({ food: getFood(id), onSaved: x => openFoodDetail(x.id) }); });
  s.on('click', '[data-x="log"]', () => {
    const g = num(s.$('#cg').value);
    const e0 = itemFor('food', getFood(id));
    s.close();
    const meal = defaultMeal();
    openAmount({ item: e0, meal, date: ui.date, onAdded: () => go('today') });
    if (g) { const a = $('#amt'); a.value = g; a.dispatchEvent(new Event('input', { bubbles: true })); }
  });
}

// ---------- barcode & online ----------
function scanFlow({ onFood }) {
  let stop = null;
  const s = openSheet({
    title: 'Scan barcode',
    body: `<div id="reader" class="reader"></div><p class="muted small center" id="scanMsg">Starting camera…</p>
      <div class="field"><label>Or type the barcode number</label><div class="inline"><input id="bc" inputmode="numeric" placeholder="e.g. 0894700010045"><button class="btn primary" data-x="go">Look up</button></div></div>`,
  });
  s.onClose = () => stop?.();
  async function handle(code) {
    code = code.trim();
    if (!code) return;
    const mine = db.list('foods').find(f => f.barcode === code);
    if (mine) { s.close(); toast('Found in My Foods'); return onFood(mine); }
    s.$('#scanMsg').textContent = 'Looking it up…';
    try {
      const found = await offBarcode(code);
      s.close();
      if (found) { toast('Found it — check the numbers & save'); openFoodForm({ prefill: found, onSaved: onFood }); }
      else { toast("Not in the database — snap the label instead"); openFoodForm({ prefill: { barcode: code }, onSaved: onFood }); }
    } catch {
      s.$('#scanMsg').textContent = 'Lookup needs internet. Try again or add it manually.';
    }
  }
  s.on('click', '[data-x="go"]', () => handle(s.$('#bc').value));
  startScanner('reader', handle)
    .then(fn => { stop = fn; s.$('#scanMsg').textContent = 'Point the camera at the barcode'; if (!sheets.includes(s)) fn(); })
    .catch(() => { s.$('#reader').hidden = true; s.$('#scanMsg').textContent = "Camera isn't available — type the number below."; });
}

function openOnline({ q = '', onSaved }) {
  const s = openSheet({
    title: 'Search online', full: true,
    body: `<form class="inline" id="osf"><input id="oq" type="search" placeholder="Brand + product, e.g. Chobani vanilla" value="${esc(q)}" autocomplete="off"><button class="btn primary">Search</button></form>
      <p class="muted tiny">From Open Food Facts (free food database). Always check against your package — then it's saved to My Foods.</p>
      <div class="list" id="ores"></div>`,
  });
  let results = [];
  async function run() {
    const term = s.$('#oq').value.trim();
    if (!term) return;
    s.$('#ores').innerHTML = `<p class="muted center">Searching…</p>`;
    try {
      results = await offSearch(term);
      s.$('#ores').innerHTML = results.length ? results.map((r, i) => `<button class="row" data-x="r" data-i="${i}"><span class="thumb ph">🌐</span>
        <div class="row-main"><div class="row-name">${esc(r.name)}</div><div class="row-sub">${esc(r.brand)}${r.brand ? ' · ' : ''}${fmt(num(r.cal))} cal / ${fmt(num(r.servingG))} g</div></div><span class="row-plus">＋</span></button>`).join('')
        : `<p class="muted center">No results. Try fewer words, or snap the label instead.</p>`;
    } catch (e) {
      s.$('#ores').innerHTML = `<p class="muted center">${esc(e.message || 'Search failed — check your connection.')}</p>`;
    }
  }
  s.on('submit', '#osf', (el, e) => { e.preventDefault(); s.$('#oq').blur(); run(); });
  s.on('click', '[data-x="r"]', el => { const r = results[+el.dataset.i]; s.close(); openFoodForm({ prefill: r, onSaved }); });
  if (q) run(); else s.$('#oq').focus();
}

// ---------- recipes ----------
function openRecipeForm({ recipe = null }) {
  const r = recipe ? JSON.parse(JSON.stringify(recipe)) : { id: uid(), name: '', ingredients: [], cookedG: '', servings: '', steps: '', notes: '', photo: '' };
  const s = openSheet({
    title: recipe ? 'Edit recipe' : 'New recipe', full: true, lock: true,
    body: `<label class="photo-box small ${r.photo ? 'has' : ''}" id="rpb">${r.photo ? `<img src="${r.photo}" alt="">` : `<span class="pb-ico">📸</span><span class="muted small">Add a photo (optional)</span>`}<input type="file" accept="image/*" hidden id="rph"></label>
      <div class="field"><label>Recipe name *</label><input id="rn" value="${esc(r.name)}" placeholder="e.g. Overnight oats" autocomplete="off"></div>
      <h4 class="sec">Ingredients</h4>
      <div id="ings"></div>
      <button class="btn soft full" data-x="addIng">＋ Add ingredient</button>
      <div class="grid2 mt">
        <div class="field"><label>Finished weight</label><div class="unit-in"><input id="rcg" inputmode="decimal" value="${esc(r.cookedG)}" placeholder="optional"><span>g</span></div></div>
        <div class="field"><label>Servings</label><input id="rsv" inputmode="decimal" value="${esc(r.servings)}" placeholder="optional"></div>
      </div>
      <p class="muted tiny">Tip: weigh the finished dish (minus the pot) so you can log any amount by grams. Cooking changes weight, so this keeps it accurate.</p>
      <div class="totals" id="rtot"></div>
      <div class="field"><label>Instructions</label><textarea id="rst" rows="5" placeholder="Steps…">${esc(r.steps)}</textarea></div>
      <div class="field"><label>Notes</label><textarea id="rno" rows="2" placeholder="How it went, swaps, etc.">${esc(r.notes)}</textarea></div>
      ${recipe ? `<button class="btn ghost danger-t full" data-x="del">Delete recipe</button>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save recipe</button>`,
  });
  function readFields() {
    r.name = s.$('#rn').value.trim(); r.cookedG = optNum(s.$('#rcg').value) ?? ''; r.servings = optNum(s.$('#rsv').value) ?? '';
    r.steps = s.$('#rst').value; r.notes = s.$('#rno').value;
  }
  function drawIngs() {
    s.$('#ings').innerHTML = r.ingredients.length ? r.ingredients.map((i, n) => `<div class="ing">
        <div class="ing-name">${esc(getFood(i.foodId)?.name || i.name)}</div>
        <div class="unit-in sm"><input data-x="ig" data-n="${n}" inputmode="decimal" value="${fmtIn(i.grams)}" placeholder="0"><span>g</span></div>
        <button class="icon-btn" data-x="rm" data-n="${n}" aria-label="Remove">✕</button></div>`).join('')
      : `<p class="muted small">Add ingredients from My Foods. Don't have one saved yet? You can add it from the label right there.</p>`;
    totals();
  }
  function totals() {
    readFields();
    const info = recipeInfo(r, getFood);
    s.$('#rtot').innerHTML = r.ingredients.length ? `<div class="tot-row"><span>Whole recipe</span><b>${fmt(info.total.cal)} cal</b><span>${macroLine(info.total)}</span></div>
      ${info.servings ? `<div class="tot-row"><span>Per serving</span><b>${fmt(info.total.cal / info.servings)} cal</b><span>${macroLine(scale(info.total, 1 / info.servings))}</span></div>` : ''}
      <div class="tot-row"><span>Per 100 g</span><b>${fmt(info.per.cal * 100)} cal</b><span>${macroLine(scale(info.per, 100))}</span></div>
      <div class="muted tiny">Raw ingredients weigh ${fmt(info.rawG)} g${r.cookedG ? ` · finished ${fmt(num(r.cookedG))} g` : ''}</div>` : '';
  }
  s.on('input', '[data-x="ig"]', el => { r.ingredients[+el.dataset.n].grams = num(el.value); totals(); });
  s.on('input', '#rcg, #rsv', totals);
  s.on('click', '[data-x="rm"]', el => { r.ingredients.splice(+el.dataset.n, 1); drawIngs(); });
  s.on('click', '[data-x="addIng"]', () => openPicker({ mode: 'ingredient', onPick: f => {
    r.ingredients.push({ foodId: f.id, name: f.name, grams: '', per: perGram(f) });
    drawIngs();
    setTimeout(() => s.$(`[data-n="${r.ingredients.length - 1}"][data-x="ig"]`)?.focus(), 320);
  } }));
  s.on('change', '#rph', async el => {
    if (!el.files[0]) return;
    r.photo = await fileToDataURL(el.files[0], 900, 0.72);
    s.$('#rpb').classList.add('has');
    s.$('#rpb').innerHTML = `<img src="${r.photo}" alt=""><input type="file" accept="image/*" hidden id="rph">`;
  });
  s.on('click', '[data-x="del"]', async () => {
    if (!(await confirmSheet(`Delete “${esc(r.name)}”?`))) return;
    db.remove('recipes', r.id); closeAllSheets(); toast('Recipe deleted');
  });
  s.on('click', '[data-x="save"]', () => {
    readFields();
    if (!r.name) return toast('Give it a name');
    r.ingredients = r.ingredients.filter(i => num(i.grams) > 0).map(i => ({ ...i, name: getFood(i.foodId)?.name || i.name, per: getFood(i.foodId) ? perGram(getFood(i.foodId)) : i.per }));
    db.put('recipes', r);
    s.close();
    toast('Recipe saved');
    openRecipeDetail(r.id);
  });
  drawIngs();
}

function openRecipeDetail(id) {
  const r = db.get('recipes', id);
  if (!r) return;
  const info = recipeInfo(r, getFood);
  const s = openSheet({
    title: '', full: true,
    body: `${r.photo ? `<img class="detail-img" src="${r.photo}" alt="">` : ''}
      <h2 class="detail-name">${esc(r.name)}</h2>
      <div class="totals">
        ${info.servings ? `<div class="tot-row"><span>Per serving</span><b>${fmt(info.total.cal / info.servings)} cal</b><span>${macroLine(scale(info.total, 1 / info.servings))}</span></div>` : ''}
        <div class="tot-row"><span>Per 100 g</span><b>${fmt(info.per.cal * 100)} cal</b><span>${macroLine(scale(info.per, 100))}</span></div>
        <div class="tot-row"><span>Whole recipe</span><b>${fmt(info.total.cal)} cal</b><span>${macroLine(info.total)}</span></div>
      </div>
      <h4 class="sec">Ingredients</h4>
      ${info.ings.map(i => `<div class="kv-row"><span>${esc(i.name)}</span><span class="muted">${fmt(num(i.grams))} g · ${fmt(i.macros.cal)} cal</span></div>`).join('')}
      ${r.steps ? `<h4 class="sec">Instructions</h4><p class="pre">${esc(r.steps)}</p>` : ''}
      ${r.notes ? `<h4 class="sec">Notes</h4><p class="pre">${esc(r.notes)}</p>` : ''}
      <button class="btn ghost full" data-x="dup">Duplicate (make a variation)</button>`,
    footer: `<button class="btn ghost" data-x="edit">Edit</button><button class="btn primary grow" data-x="log">Log it</button>`,
  });
  s.on('click', '[data-x="edit"]', () => { s.close(); openRecipeForm({ recipe: db.get('recipes', id) }); });
  s.on('click', '[data-x="dup"]', () => { const c = { ...JSON.parse(JSON.stringify(r)), id: uid(), name: r.name + ' (copy)' }; db.put('recipes', c); s.close(); openRecipeForm({ recipe: c }); });
  s.on('click', '[data-x="log"]', () => { s.close(); openAmount({ item: itemFor('recipe', db.get('recipes', id)), meal: defaultMeal(), date: ui.date, onAdded: () => go('today') }); });
}

// ---------- body & sleep ----------
function openBody(date) {
  const d = { ...(db.get('days', date) || { id: date, date }) };
  let energy = d.energy || 0;
  const fld = (k, label, unit, ph = '') => `<div class="field"><label>${label}</label><div class="unit-in"><input data-k="${k}" inputmode="decimal" value="${d[k] ?? ''}" placeholder="${ph}"><span>${unit}</span></div></div>`;
  const s = openSheet({
    title: `Recovery · ${fmtDay(date)}`, full: true, lock: true,
    body: `<h4 class="sec">😴 Sleep (last night)</h4>
      <div class="grid2">
        <div class="field"><label>Hours</label><div class="unit-in"><input id="sh" inputmode="numeric" value="${d.sleepMin != null ? Math.floor(d.sleepMin / 60) : ''}" placeholder="7"><span>h</span></div></div>
        <div class="field"><label>Minutes</label><div class="unit-in"><input id="sm" inputmode="numeric" value="${d.sleepMin != null ? Math.round(d.sleepMin % 60) : ''}" placeholder="45"><span>m</span></div></div>
        ${fld('sleepPerf', 'Sleep performance', '%')}
      </div>
      <h4 class="sec">⌚ Whoop</h4>
      <div class="grid2">${fld('recovery', 'Recovery', '%')}${fld('strain', 'Strain', '/21')}${fld('burned', 'Calories burned', 'cal')}${fld('hrv', 'HRV', 'ms')}${fld('rhr', 'Resting HR', 'bpm')}</div>
      <h4 class="sec">❤️ Apple Health</h4>
      <div class="grid2">${fld('steps', 'Steps', '')}${fld('weight', 'Weight', 'lb')}</div>
      <h4 class="sec">🔋 How do you feel?</h4>
      <div class="chips energy">${[1, 2, 3, 4, 5].map(v => `<button class="chip ${energy === v ? 'on' : ''}" data-x="en" data-v="${v}">${['😴', '😕', '🙂', '😃', '🔥'][v - 1]} ${v}</button>`).join('')}</div>
      <div class="field mt"><label>Journal</label><textarea id="dn" rows="4" placeholder="Practice, soreness, mood, anything…">${esc(d.notes || '')}</textarea></div>`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  s.on('click', '[data-x="en"]', el => { const v = +el.dataset.v; energy = energy === v ? 0 : v; s.$$('[data-x="en"]').forEach(b => b.classList.toggle('on', +b.dataset.v === energy)); });
  s.on('click', '[data-x="save"]', () => {
    s.$$('[data-k]').forEach(i => { d[i.dataset.k] = optNum(i.value); });
    const h = optNum(s.$('#sh').value), m = optNum(s.$('#sm').value);
    d.sleepMin = h == null && m == null ? null : (h || 0) * 60 + (m || 0);
    d.energy = energy || null;
    d.notes = s.$('#dn').value.trim();
    db.put('days', d);
    s.close();
    toast('Saved');
  });
}

// ---------- stomach ----------
function openGut({ ep = null, date = ui.date } = {}) {
  const e = ep ? { ...ep } : { id: uid(), date, time: date === dateStr() ? timeStr() : '12:00', severity: 3, symptoms: [], context: [], notes: '' };
  const sym = new Set(e.symptoms || []), ctx = new Set(e.context || []);
  const s = openSheet({
    title: ep ? 'Edit stomach log' : 'Stomach log', full: true, lock: true,
    body: `<h4 class="sec">How bad is it?</h4>
      <div class="sev">${SEVERITY.map(x => `<button class="${e.severity === x.v ? 'on' : ''}" data-x="sev" data-v="${x.v}"><span>${x.e}</span>${x.t}</button>`).join('')}</div>
      <h4 class="sec">What's going on?</h4>
      <div class="chips">${SYMPTOMS.map(x => `<button class="chip sm ${sym.has(x) ? 'on' : ''}" data-x="sym" data-v="${x}">${x}</button>`).join('')}</div>
      <div class="grid2 mt"><div class="field"><label>Date</label><input type="date" id="gd" value="${e.date}"></div><div class="field"><label>Time</label><input type="time" id="gt" value="${e.time}"></div></div>
      <h4 class="sec">Anything else going on? <span class="muted">(optional)</span></h4>
      <div class="chips">${CONTEXT.map(x => `<button class="chip sm ${ctx.has(x) ? 'on' : ''}" data-x="ctx" data-v="${x}">${x}</button>`).join('')}</div>
      <div class="field mt"><label>Notes</label><textarea id="gn" rows="3" placeholder="What do you think caused it?">${esc(e.notes || '')}</textarea></div>
      <div id="recent"></div>
      ${ep ? `<button class="btn ghost danger-t full" data-x="del">Delete</button>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  function recent() {
    const t = toTs(s.$('#gd').value || e.date, s.$('#gt').value || e.time);
    const list = db.list('entries').map(x => ({ x, ts: toTs(x.date, x.time) })).filter(o => o.ts <= t && t - o.ts <= 12 * 3600e3).sort((a, b) => b.ts - a.ts);
    s.$('#recent').innerHTML = list.length ? `<h4 class="sec">You ate in the 12 hours before</h4>${list.map(o => `<div class="kv-row"><span>${esc(o.x.name)}</span><span class="muted">${fmtTime(o.x.time)}${o.x.date !== (s.$('#gd').value || e.date) ? ' (prev day)' : ''}</span></div>`).join('')}` : '';
  }
  s.on('click', '[data-x="sev"]', el => { e.severity = +el.dataset.v; s.$$('[data-x="sev"]').forEach(b => b.classList.toggle('on', b === el)); });
  s.on('click', '[data-x="sym"]', el => { const v = el.dataset.v; sym.has(v) ? sym.delete(v) : sym.add(v); el.classList.toggle('on'); });
  s.on('click', '[data-x="ctx"]', el => { const v = el.dataset.v; ctx.has(v) ? ctx.delete(v) : ctx.add(v); el.classList.toggle('on'); });
  s.on('change', '#gd, #gt', recent);
  s.on('click', '[data-x="del"]', async () => { if (await confirmSheet('Delete this stomach log?')) { db.remove('stomach', e.id); closeAllSheets(); } });
  s.on('click', '[data-x="save"]', () => {
    Object.assign(e, { date: s.$('#gd').value || e.date, time: s.$('#gt').value || e.time, symptoms: [...sym], context: [...ctx], notes: s.$('#gn').value.trim() });
    db.put('stomach', e);
    s.close();
    toast(ep ? 'Saved' : 'Logged. Feel better 💜');
  });
  recent();
}

function openGutHistory() {
  const all = db.list('stomach').sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const s = openSheet({
    title: 'Stomach logs', full: true,
    body: all.length ? all.map(e => { const sv = SEVERITY[e.severity - 1] || SEVERITY[2]; return `<button class="row" data-x="ep" data-id="${e.id}"><span class="thumb ph">${sv.e}</span>
      <div class="row-main"><div class="row-name">${fmtDay(e.date)} · ${fmtTime(e.time)}</div><div class="row-sub">${sv.t}${(e.symptoms || []).length ? ' · ' + esc(e.symptoms.join(', ')) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div><span class="chev">›</span></button>`; }).join('')
      : `<p class="muted center">No stomach logs yet. That's a good thing!</p>`,
  });
  s.on('click', '[data-x="ep"]', el => { s.close(); openGut({ ep: db.get('stomach', el.dataset.id) }); });
}

// ---------- backup / export ----------
async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportBackup() {
  shareFile(`pulse-backup-${dateStr()}.json`, JSON.stringify({ app: 'pulse', version: 1, exportedAt: new Date().toISOString(), records: db.allRecords() }), 'application/json');
}
async function restoreBackup(file) {
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'pulse' || !Array.isArray(j.records)) throw new Error();
    const n = await db.applyRemote(j.records, { markDirty: true });
    sync.schedule(200);
    toast(`Restored ${n} items`);
  } catch { toast("That doesn't look like a Pulse backup"); }
}
const csvCell = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const toCSV = rows => rows.map(r => r.map(csvCell).join(',')).join('\n');
function exportDaysCSV() {
  const by = {};
  db.list('entries').forEach(e => (by[e.date] ||= []).push(e.macros));
  const dates = new Set([...Object.keys(by), ...db.list('days').map(d => d.id), ...db.list('stomach').map(s => s.date)]);
  const rows = [['date', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'water_oz', 'sleep_hours', 'sleep_perf_pct', 'recovery_pct', 'strain', 'hrv', 'resting_hr', 'calories_burned', 'steps', 'weight_lb', 'energy', 'stomach_episodes', 'journal']];
  [...dates].sort().forEach(d => {
    const t = by[d] ? sumMacros(by[d]) : null, x = db.get('days', d) || {};
    const r1 = v => v == null ? '' : Math.round(v * 10) / 10;
    rows.push([d, t && Math.round(t.cal), t && r1(t.p), t && r1(t.c), t && r1(t.f), t && r1(t.fiber), x.water, x.sleepMin != null ? r1(x.sleepMin / 60) : '',
      x.sleepPerf, x.recovery, x.strain, x.hrv, x.rhr, x.burned, x.steps, x.weight, x.energy, db.list('stomach').filter(s => s.date === d).length, x.notes]);
  });
  shareFile(`pulse-daily-${dateStr()}.csv`, toCSV(rows), 'text/csv');
}
function exportFoodCSV() {
  const rows = [['date', 'time', 'meal', 'food', 'brand', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g']];
  const r1 = v => Math.round((v || 0) * 10) / 10;
  db.list('entries').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .forEach(e => rows.push([e.date, e.time, e.meal, e.name, e.brand, e.grams && r1(e.grams), Math.round(e.macros.cal), r1(e.macros.p), r1(e.macros.c), r1(e.macros.f), r1(e.macros.fiber)]));
  shareFile(`pulse-food-log-${dateStr()}.csv`, toCSV(rows), 'text/csv');
}

// ---------- onboarding & auth ----------
function fullscreen(html) {
  appEl.classList.remove('ready');
  main.innerHTML = html;
  $('#fab').hidden = true;
}

function showWelcome() {
  fullscreen(`<div class="welcome">
    <img src="icons/icon-192.png" class="logo" alt="">
    <h1>Welcome to Pulse</h1>
    <p class="muted">Macros, recovery, recipes & gut health — all in one place.</p>
    <form id="wf" class="card">
      <div class="field"><label>Your name</label><input name="name" autocomplete="given-name" placeholder="First name" required></div>
      <h4 class="sec">Daily goals <span class="muted">— from your dietitian, or a starting guess</span></h4>
      <div class="grid2">
        <div class="field"><label>Calories</label><input name="cal" inputmode="decimal" value="${DEFAULT_GOALS.cal}"></div>
        <div class="field"><label>Protein (g)</label><input name="p" inputmode="decimal" value="${DEFAULT_GOALS.p}"></div>
        <div class="field"><label>Carbs (g)</label><input name="c" inputmode="decimal" value="${DEFAULT_GOALS.c}"></div>
        <div class="field"><label>Fat (g)</label><input name="f" inputmode="decimal" value="${DEFAULT_GOALS.f}"></div>
      </div>
      <p class="muted tiny">You can change these anytime in the Me tab.</p>
      <button class="btn primary big full">Let's go 💜</button>
    </form>
    ${!isStandalone() ? `<p class="muted small center">Tip: in Safari tap Share ⬆︎ → <b>Add to Home Screen</b> to install Pulse like an app.</p>` : ''}
  </div>`);
  $('#wf').onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    saveProfile({ name: fd.get('name').trim(), goals: { ...DEFAULT_GOALS, cal: num(fd.get('cal')), p: num(fd.get('p')), c: num(fd.get('c')), f: num(fd.get('f')) } });
    startApp();
  };
}

function showAuth(mode = 'in', msg = '') {
  fullscreen(`<div class="welcome">
    <img src="icons/icon-192.png" class="logo" alt="">
    <h1>Pulse</h1>
    <p class="muted">Macros, recovery, recipes & gut health — all in one place.</p>
    <form id="af" class="card">
      <div class="seg">${[['in', 'Sign in'], ['up', 'Create account']].map(([k, l]) => `<button type="button" class="${mode === k ? 'on' : ''}" data-m="${k}">${l}</button>`).join('')}</div>
      <div class="field mt"><label>Email</label><input name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label>Password</label><input name="password" type="password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" minlength="6" required placeholder="6+ characters"></div>
      <button class="btn primary big full" id="ab">${mode === 'up' ? 'Create account' : 'Sign in'}</button>
      ${mode === 'in' ? `<button type="button" class="link-btn" id="forgot">Forgot password?</button>` : ''}
      <div class="auth-msg" id="am">${msg}</div>
    </form>
  </div>`);
  $$('#af [data-m]').forEach(b => b.onclick = () => showAuth(b.dataset.m));
  const am = $('#am');
  $('#forgot')?.addEventListener('click', async () => {
    const email = $('#af [name=email]').value.trim();
    if (!email) { am.textContent = 'Type your email above first.'; return; }
    try { await sync.resetPassword(email); am.textContent = 'Check your email for a reset link.'; } catch (e) { am.textContent = e.message; }
  });
  $('#af').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target), email = fd.get('email').trim(), pw = fd.get('password');
    const btn = $('#ab'); btn.disabled = true; am.textContent = '';
    try {
      if (mode === 'up') {
        const r = await sync.signUp(email, pw);
        if (r.needsConfirm) { showAuth('in', '📬 Check your email to confirm your account, then sign in here.'); return; }
        await afterLogin(r.user);
      } else {
        await afterLogin(await sync.signIn(email, pw));
      }
    } catch (err) {
      am.textContent = /invalid login/i.test(err.message) ? 'Wrong email or password.' : err.message;
      btn.disabled = false;
    }
  };
}

function askNewPassword() {
  const s = openSheet({
    title: 'Set a new password', lock: true,
    body: `<div class="field"><label>New password</label><input id="np" type="password" autocomplete="new-password" minlength="6"></div>`,
    footer: `<button class="btn primary grow" data-x="go">Save password</button>`,
  });
  s.on('click', '[data-x="go"]', async () => {
    try { await sync.setPassword(s.$('#np').value); s.close(); toast('Password updated'); } catch (e) { toast(e.message); }
  });
}

async function afterLogin(user) {
  fullscreen(`<div class="welcome"><img src="icons/icon-192.png" class="logo pulse" alt=""><p class="muted">Loading your data…</p></div>`);
  await db.init(user.id);
  await sync.syncNow();
  if (!profile()) showWelcome(); else startApp();
}

function startApp() {
  applyTheme();
  appEl.classList.add('ready');
  render();
  navigator.storage?.persist?.();
}

// ---------- boot ----------
db.onChange(kind => {
  if (kind === 'settings') applyTheme();
  // Don't yank focus away while she's tabbing through the goal fields.
  if (kind === 'settings' && ui.tab === 'me' && main.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return sync.schedule();
  queueRender();
  sync.schedule();
});
sync.onStatus(() => { if (ui.tab === 'me') queueRender(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const t = dateStr();
  if (t !== lastToday) { if (ui.date === lastToday) ui.date = t; lastToday = t; queueRender(); }
  sync.schedule(100);
});
window.addEventListener('online', () => sync.schedule(100));

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    if (sync.enabled) {
      const user = await sync.getUser(askNewPassword);
      if (!user) return showAuth();
      await db.init(user.id);
      sync.schedule(50);
    } else {
      await db.init('local');
    }
    applyTheme();
    if (!profile()) showWelcome(); else startApp();
  } catch (e) {
    console.error(e);
    fullscreen(`<div class="welcome"><h1>Hmm…</h1><p class="muted">Pulse couldn't start: ${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`);
  }
}
boot();
