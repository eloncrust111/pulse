import * as db from './db.js';
import * as sync from './sync.js';
import { $, $$, esc, uid, dateStr, timeStr, parseDate, addDays, toTs, fmtDay, fmtTime, fmtSleep, num, optNum, fmt,
  perGram, scale, sumMacros, recipeInfo, fileToDataURL } from './util.js';
import { barChart, lineChart, sleepChart } from './charts.js';
import { analyzeGut, guessTags, compareDays, median } from './patterns.js';
import { offSearch, offBarcode, startScanner, readLabel } from './lookup.js';
import { drawSummary } from './share-image.js';
import { GAMES, gameOn, nextGame, teamLogo } from './games.js';
import { parseHealth, SHORTCUT_NAME } from './health.js';
import * as notify from './notify.js';
import { CONFIG } from '../config.js';
const CONFIG_PUSH = () => CONFIG.PUSH_URL.replace(/\/$/, '');

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
const SYMPTOMS = ['Stomach ache', 'Bloating', 'Cramps', 'Nausea', 'Gas', 'Heartburn', 'Reflux', 'Diarrhea', 'Constipation', 'Sharp pain', 'Urgency'];
const CONTEXT = ['Stressed', 'Period', 'Hard workout', 'Competition', 'Traveling', 'Poor sleep', 'Ate quickly', 'Big meal',
  'Ate late', 'Not enough water', 'Ibuprofen / pain meds', 'Sick', 'Ate food I didn\'t make', 'Possible gluten cross-contact'];
// Gluten status for celiac: 'yes' gluten-free, 'maybe' may contain, 'no' contains gluten, '' not checked.
const GF = {
  yes: { b: '✅', t: 'Gluten-free', cls: 'gf-yes' },
  maybe: { b: '⚠️', t: 'May contain gluten', cls: 'gf-maybe' },
  no: { b: '🚫', t: 'Contains gluten', cls: 'gf-no' },
  '': { b: '❔', t: 'Not checked', cls: 'gf-unk' },
};
const ACTIVITIES = [['practice', '🏀', 'Practice'], ['shoot', '🎯', 'Shoot-around'], ['weights', '🏋️', 'Weights', 'with the team'], ['workout', '💪', 'Workout', 'on your own'], ['rest', '😌', 'Rest day']];
// Older logs said 'lift' for team weights.
const actsOf = day => (day?.activity || []).map(a => a === 'lift' ? 'weights' : a);
const MED_TIMES = ['Morning', 'Night', 'Anytime'];
// Older lists had 'With food' as its own time; that meant morning, with food.
const medWhen = m => m.when === 'With food' ? 'Morning' : m.when || 'Anytime';
const medFood = m => !!m.food || m.when === 'With food';
const WHERE = ['Upper stomach', 'Lower stomach', 'All over'];
const DURATION = ['Under 30 min', '1–2 hours', 'Several hours', 'All day'];
const SEVERITY = [
  { v: 1, e: '🙂', t: 'Very mild' }, { v: 2, e: '😕', t: 'Mild' }, { v: 3, e: '😣', t: 'Moderate' },
  { v: 4, e: '😖', t: 'Bad' }, { v: 5, e: '😫', t: 'Severe' }];
const FEELINGS = [['😵‍💫', 'Dizzy / lightheaded'], ['🥱', 'Tired / drained'], ['🫨', 'Shaky'], ['🤕', 'Headache'],
  ['🌫️', 'Brain fog'], ['🦵', 'Heavy legs'], ['🤢', 'Queasy'], ['😰', 'Anxious / on edge'], ['😔', 'Low mood'],
  ['😤', 'Irritable'], ['🥵', 'Hot / sweaty'], ['🥶', 'Chilled'], ['💓', 'Racing heart'], ['🍽️', 'No appetite'],
  ['🍩', 'Craving sugar'], ['🤷', 'Just off']];
const feelEmoji = t => FEELINGS.find(f => f[1] === t)?.[0] || '';
const OFF_LEVELS = [
  { v: 1, e: '😐', t: 'A little off' }, { v: 2, e: '😕', t: 'Off' }, { v: 3, e: '😟', t: 'Pretty off' },
  { v: 4, e: '😣', t: 'Bad' }, { v: 5, e: '😵', t: 'Really bad' }];
const DEFAULT_GOALS = { cal: 2400, p: 140, c: 300, f: 75, fiber: 30, water: 100 };
// This copy of Pulse is set up for Carly. Set to null to go back to asking each person.
const OWNER = { name: 'Carly', number: '11', glutenFree: true };
// ?demo opens a separate copy filled with sample data (see demo.js).
const DEMO = new URLSearchParams(location.search).has('demo');
// ?new is a throwaway copy that starts at first-time setup every time it opens.
const NEW = !DEMO && new URLSearchParams(location.search).has('new');

const profile = () => db.get('settings', 'profile');
const goals = () => ({ ...DEFAULT_GOALS, ...(profile()?.goals || {}) });
// Calories, protein and water are always tracked; carbs, fat and fiber are optional.
const OPTIONAL_MACROS = [['c', 'Carbs'], ['f', 'Fat'], ['fiber', 'Fiber']];
const tracks = k => profile()?.track?.[k] ?? true;
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
  if (!sheets.length) lockScroll(true);
  sheets.push(api);
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
  if (!sheets.length) lockScroll(false);
}
let lockedY = 0;
function lockScroll(on) {
  const b = document.body;
  if (on) { lockedY = scrollY; b.classList.add('noscroll'); b.style.top = `-${lockedY}px`; }
  else { b.classList.remove('noscroll'); b.style.top = ''; scrollTo(0, lockedY); }
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
const IC = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  barcode: '<path d="M4 5v14M7 5v14M11 5v14M14 5v14M18 5v14M20 5v14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
};
const icon = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
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

// A food's own tags, or ones guessed from its name if none were set.
function foodTags(f) {
  if (!f) return [];
  const t = f.tags?.length ? [...f.tags] : guessTags(f.name + ' ' + (f.brand || ''));
  if (f.gf === 'yes') return t.filter(x => x !== 'Gluten');
  if ((f.gf === 'no' || f.gf === 'maybe') && !t.includes('Gluten')) t.push('Gluten');
  return t;
}

// ---------- gluten (celiac) ----------
const gfOn = () => !!profile()?.glutenFree;
function gfStatus(kind, obj) {
  if (!obj) return '';
  if (kind === 'food') return obj.gf || '';
  const st = (obj.ingredients || []).map(i => getFood(i.foodId)?.gf || '');
  if (!st.length) return '';
  return st.includes('no') ? 'no' : st.includes('maybe') ? 'maybe' : st.every(s => s === 'yes') ? 'yes' : '';
}
const gfPicker = cur => `<div class="gf-pick">${['yes', 'maybe', 'no', ''].map(k => `<button class="${(cur || '') === k ? 'on ' + GF[k].cls : ''}" data-x="gf" data-v="${k}">${GF[k].b}<span>${k === 'yes' ? 'Gluten-free' : k === 'maybe' ? 'May contain' : k === 'no' ? 'Has gluten' : 'Not sure'}</span></button>`).join('')}</div>`;
const looksGlutenish = obj => guessTags(obj?.name || '').includes('Gluten');
function gfBadge(kind, obj) {
  if (!gfOn()) return '';
  const s = gfStatus(kind, obj);
  return s ? `<span class="gf ${GF[s].cls}">${s === 'yes' ? 'GF' : s === 'no' ? 'Gluten' : 'May contain'}</span>` : '';
}
function gfWarning(kind, obj) {
  if (!gfOn() || !obj) return '';
  const s = gfStatus(kind, obj);
  if (s === 'no') return `<p class="tip gf-tip no">🚫 <b>Contains gluten.</b> ${kind === 'recipe' ? 'One of the ingredients is marked as containing gluten.' : 'This food is marked as containing gluten.'}</p>`;
  if (s === 'maybe') return `<p class="tip gf-tip">⚠️ <b>May contain gluten</b> (shared equipment or traces).</p>`;
  if (!s && looksGlutenish(obj)) return `<p class="tip gf-tip">❔ The name sounds like it could have gluten. Check the label and mark it in the food's details.</p>`;
  return '';
}
function entryTags(e) {
  if (e.kind === 'food') return foodTags(getFood(e.refId));
  if (e.kind === 'recipe') {
    const r = db.get('recipes', e.refId);
    return [...new Set([...(r?.ingredients || []).flatMap(i => foodTags(getFood(i.foodId))), ...guessTags(r?.name)])];
  }
  return [];
}

// Foods/recipes that stomach logs point to, keyed 'food:id' / 'recipe:id'.
function gutSuspects() {
  const a = analyzeGut(db.list('entries'), db.list('stomach'), entryTags, { windowH: 12 });
  // Warnings only for strong signals, so everyday staples don't get flagged.
  return new Map(a.episodes >= 3 ? a.foods.filter(f => f.lift >= 1.6 && f.rate >= 0.4).map(f => [f.key, f]) : []);
}

// One row per day with anything logged, for comparing "off" days to normal ones.
function dayRows() {
  const by = {};
  db.list('entries').forEach(e => (by[e.date] ||= []).push(e));
  const dates = new Set([...Object.keys(by), ...db.list('days').map(d => d.id)]);
  return [...dates].sort().map(d => {
    const t = by[d] ? sumMacros(by[d].map(e => e.macros)) : null;
    const x = db.get('days', d) || {}, y = db.get('days', addDays(d, -1)) || {};
    const last = by[d]?.reduce((m, e) => (e.time || '') > m ? e.time : m, '');
    return { date: d, cal: t?.cal, p: t?.p, c: t?.c, f: t?.f, fiber: t?.fiber, water: x.water || null,
      sleep: x.sleepMin != null ? x.sleepMin / 60 : null, recovery: x.recovery, strainPrev: y.strain,
      lastMeal: last ? +last.slice(0, 2) + +last.slice(3, 5) / 60 : null };
  });
}
const hrsMin = h => h == null ? '–' : fmtSleep(h * 60);
const clock = h => fmtTime(`${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round(h % 1 * 60)).padStart(2, '0')}`);
const DAY_METRICS = {
  sleep: { k: 'sleep', e: '😴', label: 'Sleep', fmt: hrsMin, min: 0.08 },
  recovery: { k: 'recovery', e: '💚', label: 'Recovery', fmt: x => Math.round(x) + '%' },
  cal: { k: 'cal', e: '🔥', label: 'Calories eaten', fmt: x => fmt(x) },
  c: { k: 'c', e: '🍞', label: 'Carbs', fmt: x => fmt(x) + ' g' },
  p: { k: 'p', e: '🥩', label: 'Protein', fmt: x => fmt(x) + ' g' },
  f: { k: 'f', e: '🧈', label: 'Fat', fmt: x => fmt(x) + ' g', min: 0.15 },
  fiber: { k: 'fiber', e: '🥦', label: 'Fiber', fmt: x => fmt(x) + ' g', min: 0.2 },
  water: { k: 'water', e: '💧', label: 'Water', fmt: x => fmt(x) + ' oz', min: 0.15 },
  strainPrev: { k: 'strainPrev', e: '⚡', label: "Day-before strain", fmt: x => (Math.round(x * 10) / 10).toString() },
  lastMeal: { k: 'lastMeal', e: '🌙', label: 'Last bite of the day', fmt: clock, min: 0.06 },
};
const diffRows = list => list.map(m => `<div class="diff"><span class="diff-ico">${m.e}</span><div class="grow"><b>${m.label}</b>
  <div class="muted tiny">${m.fmt(m.flag)} on those days vs ${m.fmt(m.other)} other days</div></div>
  <span class="badge ${m.rel > 0 ? 'up' : 'down'}">${m.rel > 0 ? '▲' : '▼'} ${Math.round(Math.abs(m.rel) * 100)}%</span></div>`).join('');

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
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
  checkRings();
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
    <button class="ask-pill" data-act="ask" aria-label="Ask Pulse">✨ Ask</button>
    <div class="hello">${greeting()}, ${esc(firstName())}</div>
    <div class="datenav">
      <button class="dn-btn" data-act="day" data-n="-1" aria-label="Previous day">‹</button>
      <button class="datebtn" data-act="calendar" aria-label="Open calendar">${fmtDay(d)}<span class="date-sub">${icon('calendar')}${d === dateStr() ? parseDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Calendar'}</span></button>
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
        ${tracks('fiber') ? `<div class="kv"><span>Fiber</span><b>${fmt(t.fiber)}<small>/${fmt(g.fiber)}g</small></b></div>` : ''}
      </div>
    </div>
    <div class="mbs">${macroBar('Protein', 'p', t.p, g.p)}${tracks('c') ? macroBar('Carbs', 'c', t.c, g.c) : ''}${tracks('f') ? macroBar('Fat', 'f', t.f, g.f) : ''}</div>
  </section>
  ${goalRings(d, day, t, g)}
  ${winCard(d)}
  ${readinessCard(d)}
  ${weekCard(d)}
  ${gameBanner(d)}
  ${activityRow(d, day)}
  ${gfPrompt()}
  ${prepCard()}
  ${MEALS.map(m => mealCard(m, ents.filter(e => e.meal === m.id), d)).join('')}
  ${waterCard(day, g)}
  ${sleepCard(d, day)}
  ${bodyCard(day)}
  ${profile()?.showWeight ? weightCard(Array.from({ length: 30 }, (_, i) => addDays(d, i - 29)), Array.from({ length: 30 }, (_, i) => { const x = parseDate(addDays(d, i - 29)); return `${x.getMonth() + 1}/${x.getDate()}`; })) : ''}
  ${medsCard(d, day)}
  ${feelCard(d)}
  ${gutCard(d)}
  ${journalCard(day)}
  ${periodRow(d, day)}
  <div class="spacer"></div>`;
}

// ---------- goal rings ----------
// Four small rings that fill as she logs. Closing one gets a little celebration.
function ringsFor(d, day = db.get('days', d) || {}, t = sumMacros(dayEntries(d).map(e => e.macros)), g = goals()) {
  const need = sleepNeed(addDays(d, -1)).min, acts = actsOf(day), meds = medList();
  return [
    { k: 'protein', e: '🥩', l: 'Protein', v: t.p / (g.p || 1), s: `${fmt(t.p)}/${fmt(g.p)}g`, go: 'meal', win: 'Protein goal hit 💪' },
    { k: 'water', e: '💧', l: 'Water', v: (day.water || 0) / (g.water || 1), s: `${fmt(day.water || 0)}/${fmt(g.water)}oz`, go: 'water', win: 'Water goal hit 💧' },
    { k: 'sleep', e: '😴', l: 'Sleep', v: day.sleepMin != null ? day.sleepMin / need : 0, s: day.sleepMin != null ? fmtSleep(day.sleepMin) : '–', go: 'sleep-card', win: 'Sleep goal hit 😴' },
    meds.length ? { k: 'meds', e: '💊', l: 'Meds', v: meds.filter(m => day.meds?.[m.id]).length / meds.length, s: `${meds.filter(m => day.meds?.[m.id]).length}/${meds.length}`, go: 'meds', win: 'Meds all done ✅' }
      : { k: 'train', e: '🏀', l: 'Training', v: acts.length ? 1 : 0, s: acts.length ? '✓' : '–', go: 'train-card', win: 'Training logged 🏀' },
  ];
}
function miniRing(pct, cls) {
  const r = 22, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 52 52" class="mring"><circle cx="26" cy="26" r="${r}" class="mring-bg"/>
    <circle cx="26" cy="26" r="${r}" class="mring-fg ${cls}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(pct, 1))}" transform="rotate(-90 26 26)"/></svg>`;
}
function goalRings(d, day, t, g) {
  const rs = ringsFor(d, day, t, g), closed = rs.filter(r => r.v >= 1).length;
  return `<section class="card rings">
    ${rs.map(r => `<button class="gr ${r.v >= 1 ? 'done' : ''}" data-act="jump" data-to="${r.go}"><div class="gr-ring">${miniRing(r.v, r.k)}<span>${r.v >= 1 ? '✓' : r.e}</span></div><b>${r.l}</b><small>${r.s}</small></button>`).join('')}
    ${closed === rs.length ? `<div class="rings-all">🔥 All rings closed</div>` : ''}
  </section>`;
}
// Remembers which rings were already closed so each one celebrates once a day.
function checkRings() {
  if (ui.tab !== 'today' || ui.date !== dateStr()) return;
  const d = ui.date, rs = ringsFor(d), now = rs.filter(r => r.v >= 1).map(r => r.k);
  ui.ringSeen ||= {};
  const before = ui.ringSeen[d];
  ui.ringSeen[d] = now;
  if (!before) return;
  const fresh = rs.filter(r => r.v >= 1 && !before.includes(r.k));
  if (!fresh.length) return;
  const all = now.length === rs.length;
  celebrate(all ? '🔥 All rings closed today!' : fresh[0].win, all);
}
function celebrate(msg, big = false) {
  if (msg) toast(msg);
  buzz();
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  const W = cv.width = innerWidth * 2, H = cv.height = innerHeight * 2, x = cv.getContext('2d');
  document.body.appendChild(cv);
  const cols = ['#7b5cd6', '#b9a4f5', '#ffd166', '#06d6a0', '#ef476f', '#ffffff'];
  const ps = Array.from({ length: big ? 160 : 70 }, () => ({ x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.35, vx: (Math.random() - 0.5) * 28, vy: -Math.random() * 34 - 10,
    s: 8 + Math.random() * 10, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[Math.random() * cols.length | 0] }));
  let f = 0;
  (function step() {
    x.clearRect(0, 0, W, H);
    ps.forEach(p => { p.vy += 1.1; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); x.restore(); });
    if (++f < 110) requestAnimationFrame(step); else cv.remove();
  })();
}
// A small tap of haptics: vibrate() on Android, and on iPhone (Safari 18+)
// toggling a hidden switch makes the phone tick.
function buzz() {
  try { navigator.vibrate?.([12, 40, 12]); } catch {}
  try {
    const l = document.createElement('label'), i = document.createElement('input');
    i.type = 'checkbox'; i.setAttribute('switch', ''); l.appendChild(i); l.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(l); l.click(); l.remove();
  } catch {}
}

// ---------- game results ----------
// The push server watches the Pilots' feed; results fill in the schedule.
function applyResults(res) {
  Object.entries(res || {}).forEach(([d, r]) => { const g = GAMES.find(x => x.date === d); if (g) g.result = `${r.r} ${r.us}-${r.them}`; });
}
try { applyResults(JSON.parse(localStorage.getItem('pulseResults') || '{}')); } catch {}
async function refreshResults() {
  try {
    const res = await notify.fetchResults();
    if (!res) return;
    const before = JSON.stringify(GAMES.map(g => g.result));
    applyResults(res);
    try { localStorage.setItem('pulseResults', JSON.stringify(res)); } catch {}
    if (JSON.stringify(GAMES.map(g => g.result)) !== before) queueRender();
  } catch {}
}
// While a game is on and the app is open, look for the final every minute.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  const t = dateStr(), g = [gameOn(t), gameOn(addDays(t, -1))].find(x => x && !x.result);
  const since = g ? Date.now() - toTs(g.date, g.time || '12:00') : null;
  if (since != null && since > -3 * 3600e3 && since < 6 * 3600e3) refreshResults();
}, 60e3);
const winSeen = () => { try { return JSON.parse(localStorage.getItem('pulseWinSeen') || '[]'); } catch { return []; } };
// A win on this day or the day before, until she closes it.
function recentWin(date) {
  return [gameOn(date), gameOn(addDays(date, -1))].find(g => g?.result?.startsWith('W') && !winSeen().includes(g.date));
}
const winPartied = () => { try { return JSON.parse(localStorage.getItem('pulseWinParty') || '[]'); } catch { return []; } };
const setWinPartied = d => { try { localStorage.setItem('pulseWinParty', JSON.stringify([...winPartied(), d])); } catch {} };
// Full-screen final score the first time she opens the app after a W.
function winScreen(g) {
  if (document.querySelector('.winscreen')) return;
  // Wait for the welcome splash to finish first.
  if (document.querySelector('.splash')) return setTimeout(() => winScreen(g), 300);
  const [us, them] = (g.result.match(/(\d+)-(\d+)/) || []).slice(1);
  const el = document.createElement('div');
  el.className = 'winscreen';
  el.innerHTML = `<div class="ws-in">
    <div class="ws-k">Final</div>
    <div class="ws-board">
      <div class="ws-team"><img src="icons/icon-192.png" alt=""><b>Pilots</b><span class="ws-score win">${us || 'W'}</span></div>
      <div class="ws-dash">–</div>
      <div class="ws-team"><img src="${teamLogo(g)}" alt=""><b>${esc(g.opp)}</b><span class="ws-score">${them || ''}</span></div>
    </div>
    <div class="ws-t">Pilots win 🏆</div>
    <div class="ws-s">${g.home ? 'At home' : esc(g.where || '')} · ${parseDate(g.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
    <div class="ws-tap">Tap to close</div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  celebrate('', true);
  setTimeout(() => celebrate('', true), 900);
  const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 350); };
  el.addEventListener('click', close);
  setTimeout(close, 7000);
}
function winCard(date) {
  const g = recentWin(date);
  if (!g) return '';
  if (!winPartied().includes(g.date)) { setWinPartied(g.date); setTimeout(() => winScreen(g), 400); }
  return `<section class="card win-card"><button class="pr-x" data-act="winDone" data-d="${g.date}" aria-label="Close">✕</button>
    <div class="win-big">🏆</div><div class="win-t">Pilots win!</div>
    <div class="win-s">${vsAt(g)} ${esc(g.opp)} · ${esc(g.result)}</div>
    <div class="muted small">Congrats, ${esc(firstName())} 🎉</div></section>`;
}

// ---------- games & training days ----------
// The Pilots post every tip-off in Pacific time. Turn each into her phone's own
// time zone, so a 6 PM PT game in Provo reads 7:00 PM once she's there.
const PT = 'America/Los_Angeles', HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
function ptToLocal(date, time) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: PT, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
  const at = new Date(guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess));
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
GAMES.forEach(g => { if (g.time) { g.ptTime = g.time; g.time = ptToLocal(g.date, g.time); } });
const zoneTag = () => HERE === PT ? '' : ' ' + (new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName')?.value || '');
const gameTime = g => g.time ? fmtTime(g.time) + zoneTag() : 'Time TBA';
const vsAt = g => g.home ? 'vs' : '@';
// Plain minutes since midnight (toMin is shifted for bedtimes, so not used here).
const dayMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
// Game-day nudge, shown when she taps the card: just the one thing that matters
// right now, timed back from tip-off (standard sports-dietitian timing: carb-heavy,
// low-fat meal 3-4 h out, a small carb snack ~1 h out, carbs + protein within an
// hour after). It leans on her own logs: what she ate before past games, foods she
// eats a lot, foods her stomach logs flag (skipped), and her recent water/protein.
const dayClock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function herFoods(test, bad) {
  const by = new Map();
  db.list('entries').filter(e => e.date >= addDays(dateStr(), -45) && !bad.has(e.name)).forEach(e => { const x = by.get(e.name) || { n: 0, m: e.macros }; x.n++; by.set(e.name, x); });
  return [...by.entries()].filter(([, x]) => x.n >= 2 && test(x.m)).sort((a, b) => b[1].n - a[1].n).map(([n]) => n).slice(0, 4);
}
function gameNudge(date, g) {
  const t = dateStr(), tip = dayMin(g.time), now = date === t ? dayMin(timeStr()) : -1;
  const seed = [...g.date].reduce((a, c) => a + c.charCodeAt(0), 0);
  const pick = (list, k = 0) => list[(seed + k) % list.length];
  const at = m => fmtTime(dayClock(Math.max(0, m)));
  const bad = new Set([...gutSuspects().values()].map(f => f.name));
  const gl = goals(), recent = Array.from({ length: 7 }, (_, i) => addDays(t, -1 - i));
  const avg = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
  const water = avg(recent.map(d => db.get('days', d)?.water).filter(x => x != null));
  const prot = avg(recent.map(d => db.list('entries').filter(e => e.date === d)).filter(e => e.length).map(e => sumMacros(e.map(x => x.macros)).p));
  const lastNight = db.get('days', date)?.sleepMin;
  // What she ate 2.5-5 h before earlier tip-offs this season, best first.
  const before = new Map();
  GAMES.filter(x => x.time && x.date < t).forEach(x => db.list('entries').filter(e => e.date === x.date && e.time && !bad.has(e.name)
    && dayMin(x.time) - dayMin(e.time) >= 150 && dayMin(x.time) - dayMin(e.time) <= 300 && (e.macros?.c || 0) >= 40)
    .forEach(e => before.set(e.name, (before.get(e.name) || 0) + 1)));
  const usual = [...before.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const meal = usual || pick([...herFoods(m => m.c >= 45 && m.f <= 22 && m.cal >= 350, bad), 'GF pasta with chicken', 'a big rice bowl', 'a baked potato with turkey'], 1);
  const snack = pick([...herFoods(m => m.c >= 15 && m.f <= 6 && m.cal <= 300, bad), 'a banana', 'GF pretzels', 'applesauce', 'a rice cake with honey'], 2);
  const lowP = prot != null && prot < gl.p * 0.9;
  const refuel = pick([...herFoods(m => m.p >= 25 && m.c >= 30, bad), 'chocolate milk', 'a GF turkey wrap', 'a rice bowl with chicken'], 3);
  // Already ate in the meal window today? Then skip ahead.
  const ateMeal = date === t && db.list('entries').some(e => e.date === t && e.time && dayMin(e.time) >= tip - 300 && dayMin(e.time) <= tip - 120 && (e.macros?.c || 0) >= 40);
  const steps = [
    [-1e4, tip - 240, 'next', '🍝', usual ? `Game meal around ${at(tip - 240)}. You had ${esc(meal)} before past games, so stick with it.` : pick([`Game meal around ${at(tip - 240)}. ${esc(meal)} would be perfect.`, `Plan your game meal for ~${at(tip - 240)}: ${esc(meal)}, heavy on the carbs.`, `${at(tip - 240)}-ish: fuel up with ${esc(meal)}.`])
      + (lastNight && lastNight < sleepGoal() - 45 ? ` Short night (${fmtSleep(lastNight)}), so a 20-min nap early afternoon can help.` : '')],
    [tip - 240, tip - 180, 'now', '🍝', ateMeal ? 'Game meal logged ✓ Next: water this afternoon.' : usual ? `Game meal time: ${esc(meal)}, like before your other games.` : pick([`Game meal time! ${esc(meal)}: big on carbs, easy on fat.`, `Eat now so it's digested by tip-off. ${esc(meal)} 👌`, `Fuel window is open: ${esc(meal)}.`], 4)],
    [tip - 180, tip - 75, 'now', '💧', water != null && water < gl.water * 0.85 ? `You've averaged ${fmt(water)} oz lately (goal ${fmt(gl.water)}). Finish a full bottle before you leave.` : pick(['Keep a water bottle on you this afternoon.', "Sip, don't chug: a few cups before warmups.", 'Hydration check 💧 Finish a bottle before you leave.'], 5)],
    [tip - 75, tip - 30, 'now', '🍌', pick([`Quick snack: ${esc(snack)}.`, `Little top-off before warmups: ${esc(snack)}.`, `Grab ${esc(snack)} now for fast energy.`], 6)],
    [tip - 30, tip + 120, 'now', '🔥', `Go get it, #${esc(profile()?.number || '11')}.`],
    [tip + 120, tip + 180, 'now', '🥛', lowP ? `Refuel within the hour: ${esc(refuel)}. Your protein's been under goal this week, so go big on it.` : pick([`Refuel within the hour: ${esc(refuel)}.`, `Recovery starts now: ${esc(refuel)} (carbs + protein).`, `Post-game fuel: ${esc(refuel)}.`], 8)],
  ];
  const st = now < 0 ? steps[0] : steps.find(([a, b]) => now >= a && now < b);
  if (!st) return '<div class="gn"><span class="gn-e">✅</span><span class="grow">That\'s game day done. Sleep is the best recovery tonight.</span></div>';
  return `<div class="gn"><span class="gn-e">${st[3]}</span><span class="grow">${st[4]}</span>${st[2] === 'now' && now >= 0 ? '<span class="gp-now">Now</span>' : ''}</div>`;
}
function tipIn(g) {
  const m = dayMin(g.time) - dayMin(timeStr());
  return m > 0 ? `Tip-off in ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`}` : m > -120 ? 'Game on 🔥' : '';
}
function gameBanner(date) {
  const g = gameOn(date);
  // After a loss the card just moves on to the next game.
  if (g && !g.result?.startsWith('L')) {
    const plan = !g.result && g.time && date >= dateStr();
    if (plan && date === dateStr() && !ui.gameSeen) { ui.gameSeen = true; setTimeout(() => celebrate(`Game day 🏀 ${vsAt(g)} ${g.opp}`), 600); }
    return `<section class="game-banner ${plan ? 'gd' : ''}" ${plan ? 'data-act="gameTip" role="button"' : ''}><div class="gb-head">
    <img class="team-logo" src="${teamLogo(g)}" alt="">
    <div class="grow"><div class="gb-k">🏀 Game day${plan && date === dateStr() && tipIn(g) ? ` · ${tipIn(g)}` : ''}</div><div class="gb-t">${vsAt(g)} ${esc(g.opp)}</div>
    <div class="gb-s">${g.result ? esc(g.result) : gameTime(g)} · ${esc(g.venue || g.where)}</div></div>
    ${plan ? `<span class="gb-tap">${ui.gameTip ? '✕' : "🍽️ What's next"}</span>` : ''}</div>
    ${plan && ui.gameTip ? gameNudge(date, g) : ''}</section>`;
  }
  const n = nextGame(addDays(date, 1));
  if (!n || date < dateStr()) return '';
  const days = Math.round((parseDate(n.date) - parseDate(date)) / 864e5);
  if (days > 6) return '';
  return `<button class="next-game" data-act="calendar"><img class="team-logo sm" src="${teamLogo(n)}" alt="">
    <span class="grow">Next game <b>${days === 1 ? 'tomorrow' : parseDate(n.date).toLocaleDateString(undefined, { weekday: 'long' })}</b> ${vsAt(n)} ${esc(n.opp)}
    ${days === 1 && date === dateStr() ? `<div class="muted tiny">Tonight: a carb-rich dinner and bed by ${fmtTime(bedGoal(date))}</div>` : ''}</span><span class="muted">${gameTime(n)}</span></button>`;
}
function activityRow(date, day) {
  const on = new Set(actsOf(day)), today = date === dateStr();
  return `<section class="card train-card">
    <div class="card-head"><h3>${today ? "Today's training" : 'Training'}</h3><span class="muted small">${on.size ? '' : today ? 'Tap what you did' : ''}</span></div>
    <div class="train-grid">${ACTIVITIES.map(([k, e, l, sub]) => `<button class="train ${on.has(k) ? 'on' : ''} ${k === 'rest' ? 'rest' : ''}" data-act="activity" data-k="${k}" aria-pressed="${on.has(k)}">
      <span class="tick">${on.has(k) ? '✓' : ''}</span><span class="train-e">${e}</span><span class="train-l">${l}${sub ? `<small>${sub}</small>` : ''}</span></button>`).join('')}</div>
  </section>`;
}
function toggleActivity(k) {
  const d = { ...(db.get('days', ui.date) || { id: ui.date, date: ui.date }) };
  const on = new Set(actsOf(d));
  if (on.has(k)) on.delete(k);
  else if (k === 'rest') on.clear(), on.add('rest');
  else { on.add(k); on.delete('rest'); }
  d.activity = [...on];
  db.put('days', d);
}

// Asked once, so friends without celiac don't get gluten warnings.
function gfPrompt() {
  if (profile()?.glutenFree != null) return '';
  return `<section class="card ask-card"><b>🌾 Do you eat gluten-free?</b>
    <p class="muted small">If you have celiac or avoid gluten, Pulse will flag foods and recipes that contain or may contain gluten.</p>
    <div class="btn-row"><button class="btn primary grow" data-act="gfSet" data-v="1">Yes, gluten-free</button><button class="btn soft grow" data-act="gfSet" data-v="0">No</button></div></section>`;
}

// ---------- sleep ----------
// Bedtimes as minutes after noon, so 9 PM and 1 AM sort and average sensibly.
const toMin = t => { const [h, m] = t.split(':').map(Number); return ((h + 12) % 24) * 60 + m; };
const fromMin = x => { x = ((Math.round(x) % 1440) + 1440) % 1440; const h = (Math.floor(x / 60) + 12) % 24; return `${String(h).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
// Bedtime isn't one fixed time. It works back from when she has to be up the
// next morning, so a late class, a weekend or a game night moves it.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const sleepGoal = () => profile()?.sleepGoal || 540;
const wakeUsual = dow => profile()?.wakeByDay?.[dow] || (dow === 0 || dow === 6 ? '07:00' : '06:00');
// Wake time on the morning of `date`.
const wakeOn = date => db.get('days', date)?.planWake || wakeUsual(parseDate(date).getDay());
// Sleep coach: how much sleep the night starting on `date` calls for. Her goal,
// plus more after a hard day, before a game, or after a few short nights.
function sleepNeed(date) {
  const base = sleepGoal(), day = db.get('days', date) || {}, acts = actsOf(day), why = [];
  let need = base;
  if (day.strain >= 17) { need += 45; why.push('very hard day'); }
  else if (day.strain >= 14 || (acts.includes('practice') && acts.includes('weights'))) { need += 30; why.push('hard day'); }
  else if (gameOn(date)) { need += 30; why.push('game today'); }
  if (gameOn(addDays(date, 1))) { need += 30; why.push('game tomorrow'); }
  // Only nights well under her goal count as debt; she earns back up to half an hour.
  const last = [0, 1, 2].map(i => db.get('days', addDays(date, -i))?.sleepMin).filter(x => x != null);
  const debt = last.reduce((a, x) => a + (base - x > 30 ? base - x : 0), 0);
  if (last.length >= 2 && debt >= 60) { need += 30; why.push('short nights lately'); }
  return { min: Math.min(need, base + 45), why };
}
// Plan for the night that starts on `date`.
function bedPlan(date) {
  const wake = wakeOn(addDays(date, 1)), need = sleepNeed(date);
  let bed = toMin(wake) - need.min + (toMin(wake) < 360 ? 1440 : 0), why = '';
  const g = gameOn(date);
  if (g?.time && g.time >= '15:00') { const after = toMin(g.time) + 210; if (after > bed) { bed = after; why = 'game'; } }
  const set = db.get('days', date)?.planBed;
  if (set) { bed = toMin(set); why = 'set'; }
  return { bed: fromMin(bed), wake, why, need, sleep: toMin(wake) + (toMin(wake) < 360 ? 1440 : 0) - bed };
}
const bedGoal = (date = dateStr()) => bedPlan(date).bed;
// A logged bedtime on day D's record is the night before D.
const nearPlan = x => Math.abs(toMin(x.bed) - toMin(bedGoal(addDays(x.date || x.id, -1)))) <= 30;
// Nights she forgot to log are skipped, not counted as misses (up to 3 in a row).
function sleepStreak() {
  let d = dateStr(), n = 0, gap = 0;
  while (gap <= 3) {
    const b = db.get('days', d)?.bed;
    if (!b) { gap++; d = addDays(d, -1); continue; }
    if (!nearPlan({ bed: b, date: d })) break;
    n++; gap = 0; d = addDays(d, -1);
  }
  return n;
}
function sleepCard(date, day) {
  const last7 = Array.from({ length: 7 }, (_, i) => db.get('days', addDays(date, -i))).filter(x => x?.bed);
  const near = last7.filter(nearPlan).length, plan = date >= dateStr() ? bedPlan(date) : null;
  const st = date === dateStr() ? sleepStreak() : 0;
  return `<section class="card sleep-card tap" data-act="body">
    <div class="card-head"><h3>🌙 Sleep</h3><span class="link">${day.sleepMin != null || day.bed ? 'Edit' : 'Log'}</span></div>
    ${day.sleepMin != null || day.bed ? `<div class="sleep-main">
        <div><div class="sleep-big">${day.sleepMin != null ? fmtSleep(day.sleepMin) : '–'}</div><div class="muted small">${day.sleepPerf != null ? `${day.sleepPerf}% sleep performance` : 'last night'}</div></div>
        ${day.bed ? `<div class="sleep-times"><span>🛏️ ${fmtTime(day.bed)}</span><span>☀️ ${day.wake ? fmtTime(day.wake) : '–'}</span></div>` : ''}
      </div>` : `<p class="muted small">Tap to log last night.</p>`}
    ${plan ? tonightRow(date, plan) : ''}
    ${last7.length ? `<div class="sleep-goal"><span>🎯 Near your planned bedtime <b>${near} of the last ${last7.length} nights</b></span>${st >= 2 ? `<span class="streak">🔥 ${st} in a row</span>` : ''}</div>` : ''}
  </section>`;
}

function tonightRow(date, p) {
  const short = p.sleep < p.need.min - 15;
  return `<button class="tonight" data-act="sleepPlan" data-d="${date}">
    <span class="grow">${date === dateStr() ? 'Tonight' : fmtDay(date)}: bed by <b>${fmtTime(p.bed)}</b> · up at ${fmtTime(p.wake)}
    <div class="muted tiny">${p.why === 'game' ? `🏀 Game night, so a bit later. ` : ''}Sleep need ${fmtSleep(p.need.min)}${p.need.why.length ? ` (${p.need.why.join(', ')})` : ''}${short ? `, you'll get ${fmtSleep(p.sleep)}` : ''}</div></span>
    <span class="link">Change</span></button>`;
}
function openSleepPlan(date) {
  const tom = addDays(date, 1), dd = { ...(db.get('days', date) || { id: date, date }) }, td = { ...(db.get('days', tom) || { id: tom, date: tom }) };
  const s = openSheet({
    title: date === dateStr() ? 'Tonight' : fmtDay(date) + ' night',
    body: `<div class="grid2">
        <div class="field"><label>Wake up ${parseDate(tom).toLocaleDateString(undefined, { weekday: 'long' })}</label><input type="time" id="pw" value="${wakeOn(tom)}"></div>
        <div class="field"><label>Bed by</label><input type="time" id="pb" value="${bedGoal(date)}"></div></div>
      <p class="muted small" id="pinfo"></p>
      <p class="muted tiny">Pulse works back from your wake-up time to get you ${fmtSleep(sleepNeed(date).min)} tonight. That's your ${fmtSleep(sleepGoal())} goal plus extra after hard days, before games or after short nights. Late class, weekend, something came up? Change either one. It only affects this night.</p>
      ${dd.planBed || td.planWake ? `<button class="btn ghost full" data-x="reset">Back to usual</button>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  let bedTouched = !!dd.planBed;
  const info = () => {
    const w = toMin(s.$('#pw').value || wakeOn(tom)), b = toMin(s.$('#pb').value || bedGoal(date));
    s.$('#pinfo').textContent = `That's ${fmtSleep(w + (w < 360 ? 1440 : 0) - b)} of sleep.`;
  };
  s.on('input', '#pw', () => { if (!bedTouched) { const w = toMin(s.$('#pw').value); s.$('#pb').value = fromMin(w + (w < 360 ? 1440 : 0) - sleepNeed(date).min); } info(); });
  s.on('input', '#pb', () => { bedTouched = true; info(); });
  s.on('click', '[data-x="reset"]', () => { delete dd.planBed; delete td.planWake; db.put('days', dd); db.put('days', td); s.close(); toast('Back to your usual'); });
  s.on('click', '[data-x="save"]', () => {
    const w = s.$('#pw').value, b = s.$('#pb').value;
    if (w && w !== wakeUsual(parseDate(tom).getDay())) td.planWake = w; else delete td.planWake;
    db.put('days', td);
    if (bedTouched && b && b !== bedPlan(date).bed) dd.planBed = b; else if (!bedTouched) delete dd.planBed;
    db.put('days', dd);
    s.close(); toast(`🌙 Bed by ${fmtTime(bedGoal(date))}`);
  });
  info();
}
function openWakeTimes() {
  const s = openSheet({
    title: 'Usual wake-up times',
    body: `<p class="muted small">Your bedtime each night works back from these. Change a single night from the Sleep card.</p>
      ${[1, 2, 3, 4, 5, 6, 0].map(i => `<div class="kv-row"><span>${WEEKDAYS[i]}</span><input type="time" class="time-in" data-w="${i}" value="${wakeUsual(i)}"></div>`).join('')}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  s.on('click', '[data-x="save"]', () => {
    const w = {}; s.$$('[data-w]').forEach(i => { if (i.value) w[i.dataset.w] = i.value; });
    saveProfile({ wakeByDay: w }); s.close(); toast('Saved');
  });
}

// ---------- Apple Health (through an iPhone Shortcut) ----------
// Web apps can't read Health directly, so a Shortcut copies the numbers and
// Pulse pastes them. Only empty fields get filled; nothing she typed is replaced.
const HEALTH_FIELDS = { bed: ['today', 'bedtime', fmtTime], wake: ['today', 'wake time', fmtTime], sleepMin: ['today', 'sleep', fmtSleep],
  rhr: ['today', 'resting HR', v => v + ' bpm'], hrv: ['today', 'HRV', v => v + ' ms'],
  burned: ['yesterday', 'calories burned', v => fmt(v) + ' cal'], active: ['yesterday', 'active calories', v => fmt(v) + ' cal'],
  resting: ['yesterday', 'resting calories', v => fmt(v) + ' cal'], steps: ['yesterday', 'steps', v => fmt(v)] };
function applyHealth(h) {
  const t = dateStr(), y = addDays(t, -1);
  const recs = { today: { ...(db.get('days', t) || { id: t, date: t }) }, yesterday: { ...(db.get('days', y) || { id: y, date: y }) } };
  const added = [], kept = [];
  for (const [k, [when, label, show]] of Object.entries(HEALTH_FIELDS)) {
    if (h[k] == null) continue;
    if (recs[when][k] != null) { kept.push(label); continue; }
    recs[when][k] = h[k];
    added.push(`${label} ${show(h[k])}${when === 'yesterday' ? ' (yesterday)' : ''}`);
  }
  const r = recs.today;
  if (r.sleepMin == null && r.bed && r.wake) { r.sleepMin = (toMin(r.wake) - toMin(r.bed) + 1440) % 1440; added.push(`sleep ${fmtSleep(r.sleepMin)}`); }
  if (added.length) { db.put('days', recs.today); db.put('days', recs.yesterday); }
  return { added, kept };
}
function healthSync() {
  if (!profile()?.healthReady) return openHealthGuide();
  try { sessionStorage.setItem('pulseHealth', String(Date.now())); } catch {}
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}`;
}
async function healthPaste() {
  $('#pasteBar')?.remove();
  try { sessionStorage.removeItem('pulseHealth'); } catch {}
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { return toast("Couldn't read the clipboard. Tap Paste when it asks."); }
  const h = parseHealth(text);
  if (!h) return toast('No Health numbers found. Run the Pulse Sync shortcut first.');
  const { added, kept } = applyHealth(h);
  openSheet({
    title: '⌚ From Apple Health',
    body: `${added.length ? `<p class="small">Added:</p>${added.map(a => `<div class="kv-row"><span>✓ ${esc(a)}</span></div>`).join('')}` : '<p class="small">Nothing new to add.</p>'}
      ${kept.length ? `<p class="muted tiny mt">Kept what you'd already entered for ${esc(kept.join(', '))}.</p>` : ''}
      <p class="muted tiny">Anything Health didn't have just stays blank. You can fill it in by hand anytime.</p>`,
    footer: `<button class="btn primary grow" data-x="close">Done</button>`,
  });
}
// After the Shortcut runs and she comes back, offer a one-tap paste.
function offerPaste() {
  let t = 0;
  try { t = +sessionStorage.getItem('pulseHealth') || 0; } catch {}
  if (!t || Date.now() - t > 10 * 60e3 || $('#pasteBar')) return;
  const b = document.createElement('button');
  b.id = 'pasteBar'; b.className = 'paste-bar'; b.dataset.act = 'healthPaste';
  b.innerHTML = '📋 Tap to add your Apple Health numbers';
  document.body.appendChild(b);
}
// Setup is one tiny step per screen, since the Shortcuts app is a lot to read at once.
const HEALTH_TEXT = 'active: \nresting: \nsteps: \nrhr: ';
const findSamples = (type, sum) => `<li>Tap <b>Search</b> at the bottom, type <b>Find Health Samples</b>, tap it</li>
  <li>Tap <b>Type</b> → <b>${type}</b></li>
  ${sum ? `<li>Tap <b>Add Filter</b> → set it to <b>Start Date is Yesterday</b></li>
  <li>Search <b>Calculate Statistics</b>, tap it, set it to <b>Sum</b></li>` : `<li>Set <b>Sort by</b> Start Date, <b>Latest First</b>, <b>Limit</b> on, <b>1</b></li>`}`;
const HEALTH_STEPS = [
  { e: '⌚', t: 'Auto-fill from Apple Health', b: `<p class="hs-lead">One-time setup. About 5 minutes.</p><p class="muted small">Don't feel like it? Skip it and tap <b>✏️ Type it in</b> on the Recovery card. That works just as well.</p>` },
  { e: '1️⃣', t: 'Make a new shortcut', b: `<ul class="hs"><li>Open the <b>Shortcuts</b> app</li><li>Tap <b>＋</b> in the top right</li><li>Tap the name at the top → <b>Rename</b> → <b>${SHORTCUT_NAME}</b></li></ul><button class="btn soft full" data-x="copy" data-v="${SHORTCUT_NAME}">📋 Copy the name</button>` },
  { e: '🔥', t: 'Active calories', b: `<ul class="hs">${findSamples('Active Energy', true)}</ul>` },
  { e: '😴', t: 'Resting calories', b: `<ul class="hs">${findSamples('Resting Energy', true)}</ul><p class="muted tiny">Same as the last step, just a different type.</p>` },
  { e: '👟', t: 'Steps', b: `<ul class="hs">${findSamples('Steps', true)}</ul><p class="muted tiny">Same again.</p>` },
  { e: '🫀', t: 'Resting heart rate', b: `<ul class="hs">${findSamples('Resting Heart Rate', false)}</ul>` },
  { e: '📝', t: 'Put it together', b: `<ul class="hs"><li>Search <b>Text</b>, tap it</li><li>Paste this into the box:</li></ul><pre class="hs-pre">${HEALTH_TEXT}</pre>
    <button class="btn soft full" data-x="copy" data-v="${HEALTH_TEXT}">📋 Copy this text</button>
    <p class="small mt">Then tap right after each <b>:</b> and pick its blue bubble above the keyboard, top to bottom (same order as the steps you just did).</p>` },
  { e: '✅', t: 'Last step', b: `<ul class="hs"><li>Search <b>Copy to Clipboard</b>, tap it</li><li>Tap <b>Done</b></li></ul><p class="hs-lead">That's it 🎉</p><p class="muted small">From now on: tap <b>⌚ Apple Health</b>, then <b>◀ Pulse</b> in the top-left corner, then the purple bar.</p>` },
];
function openHealthGuide() {
  if (profile()?.healthReady) {
    const s = openSheet({ title: '⌚ Apple Health',
      body: `<p class="small">Runs your <b>${SHORTCUT_NAME}</b> shortcut, then brings the numbers back here.</p>`,
      footer: `<button class="btn ghost" data-x="redo">Setup steps</button><button class="btn ghost" data-x="paste">Paste</button><button class="btn primary grow" data-x="run">Run it</button>` });
    s.on('click', '[data-x="redo"]', () => { s.close(); saveProfile({ healthReady: false }); openHealthGuide(); });
    s.on('click', '[data-x="paste"]', () => { s.close(); healthPaste(); });
    s.on('click', '[data-x="run"]', () => { s.close(); healthSync(); });
    return;
  }
  let i = 0;
  const s = openSheet({ title: 'Apple Health', full: true, body: '<div id="hsb"></div>', footer: '<div id="hsf" class="btn-row grow"></div>' });
  const show = () => {
    const st = HEALTH_STEPS[i], last = i === HEALTH_STEPS.length - 1;
    s.$('#hsb').innerHTML = `<div class="hs-dots">${HEALTH_STEPS.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="hs-e">${st.e}</div><h2 class="hs-t">${st.t}</h2>${st.b}`;
    s.$('.sheet-body').scrollTop = 0;
    s.$('#hsf').innerHTML = i === 0
      ? `<button class="btn ghost grow" data-x="skip">✏️ I'll type it</button><button class="btn primary grow" data-x="next">Let's go</button>`
      : `<button class="btn ghost" data-x="back">Back</button><button class="btn primary grow" data-x="${last ? 'ready' : 'next'}">${last ? 'Try it now' : 'Done, next'}</button>`;
  };
  show();
  s.on('click', '[data-x="next"]', () => { i++; show(); });
  s.on('click', '[data-x="back"]', () => { i--; show(); });
  s.on('click', '[data-x="skip"]', () => { s.close(); openBody(ui.date); });
  s.on('click', '[data-x="copy"]', async el => { try { await navigator.clipboard.writeText(el.dataset.v); toast('Copied'); } catch { toast("Couldn't copy. Type it instead."); } });
  s.on('click', '[data-x="ready"]', () => { saveProfile({ healthReady: true }); s.close(); healthSync(); });
}

// ---------- meds & vitamins ----------
const medList = () => profile()?.meds || [];
function medsCard(date, day) {
  const meds = medList(), taken = day.meds || {};
  if (!meds.length) return `<section class="card"><div class="card-head"><h3>💊 Meds & vitamins</h3></div>
    <p class="muted small">Add what you take every day, then check things off with one tap.</p>
    <button class="btn soft full" data-act="editMeds">＋ Set up my list</button></section>`;
  const done = meds.filter(m => taken[m.id]).length;
  const groups = MED_TIMES.map(t => [t, meds.filter(m => medWhen(m) === t)]).filter(g => g[1].length);
  return `<section class="card meds">
    <div class="card-head"><h3>💊 Meds & vitamins</h3><span class="muted small">${done === meds.length ? '✅ All done' : `${done} of ${meds.length}`}</span></div>
    ${groups.map(([t, list]) => `<div class="med-group">${groups.length > 1 ? `<div class="med-when">${t}</div>` : ''}${list.map(m => `<button class="med ${taken[m.id] ? 'on' : ''}" data-act="med" data-id="${m.id}">
      <span class="med-box">${taken[m.id] ? '✓' : ''}</span><span class="grow">${esc(m.name)}${medFood(m) ? `<span class="med-food">🍽️ with food</span>` : ''}</span>${taken[m.id] ? `<span class="muted tiny">${fmtTime(taken[m.id])}</span>` : ''}</button>`).join('')}</div>`).join('')}
    <button class="link-btn" data-act="editMeds">Edit list</button>
  </section>`;
}
function toggleMed(id) {
  const d = { ...(db.get('days', ui.date) || { id: ui.date, date: ui.date }) };
  const taken = { ...(d.meds || {}) };
  if (taken[id]) delete taken[id]; else taken[id] = ui.date === dateStr() ? timeStr() : '12:00';
  d.meds = taken;
  db.put('days', d);
}
function openMeds() {
  let meds = medList().map(m => ({ ...m }));
  const s = openSheet({
    title: 'Meds & vitamins', full: true, lock: true,
    body: `<p class="muted small">Only you see this list. Add each thing you take and when you usually take it.</p>
      <div id="ml"></div>
      <div class="add-med"><input id="mn" placeholder="e.g. Vitamin D, Iron, Zyrtec" autocomplete="off">
      <div class="chips" id="mw">${MED_TIMES.map((t, i) => `<button class="chip sm ${i === 0 ? 'on' : ''}" data-x="when" data-v="${t}">${t === 'Morning' ? '☀️' : t === 'Night' ? '🌙' : '🕒'} ${t}</button>`).join('')}
        <button class="chip sm" data-x="food">🍽️ With food</button></div>
      <button class="btn soft full" data-x="add">＋ Add</button></div>`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save list</button>`,
  });
  let when = MED_TIMES[0], food = false;
  const draw = () => {
    s.$('#ml').innerHTML = meds.length ? meds.map((m, i) => `<div class="kv-row"><span>💊 ${esc(m.name)} <span class="muted tiny">${medWhen(m)}</span></span>
      <span class="med-edit"><button class="chip sm ${medFood(m) ? 'on' : ''}" data-x="mfood" data-n="${i}">🍽️ With food</button><button class="icon-btn" data-x="rm" data-n="${i}" aria-label="Remove">✕</button></span></div>`).join('')
      : `<p class="muted small center">Nothing added yet.</p>`;
  };
  s.on('click', '[data-x="when"]', el => { when = el.dataset.v; s.$$('[data-x="when"]').forEach(b => b.classList.toggle('on', b === el)); });
  s.on('click', '[data-x="food"]', el => { food = !food; el.classList.toggle('on', food); });
  s.on('click', '[data-x="mfood"]', el => { const m = meds[+el.dataset.n]; m.food = !medFood(m); m.when = medWhen(m); draw(); });
  s.on('click', '[data-x="add"]', () => {
    const name = s.$('#mn').value.trim();
    if (!name) return s.$('#mn').focus();
    meds.push({ id: uid(), name, when, food });
    s.$('#mn').value = ''; s.$('#mn').focus(); draw();
  });
  s.on('click', '[data-x="rm"]', el => { meds.splice(+el.dataset.n, 1); draw(); });
  s.on('click', '[data-x="save"]', () => { saveProfile({ meds }); s.close(); toast('Saved'); });
  draw();
  return s;
}

// ---------- period ----------
// Kept low-key: one slim row on Today. Period days line up with stomach and
// feeling-off logs so cycle symptoms don't get blamed on food.
// No flow levels: with an IUD there may be little or no bleeding, but the cycle
// still shows up in how she feels.
const PERIOD_FEELS = [['cramps', '😣', 'Cramps'], ['moody', '😤', 'Moody'], ['emotional', '🥺', 'Emotional'], ['bloated', '🎈', 'Bloated'],
  ['tired', '🥱', 'Tired'], ['cravings', '🍫', 'Cravings'], ['headache', '🤕', 'Headache']];
const periodOn = () => profile()?.showPeriod !== false;
const periodDays = () => db.list('days').filter(d => d.period).map(d => d.id).sort();
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
// A new period starts after 2+ days without one, so a skipped log mid-period doesn't split it.
function periodStarts() {
  const set = new Set(periodDays());
  return [...set].filter(d => !set.has(addDays(d, -1)) && !set.has(addDays(d, -2)));
}
function cycleInfo(date = dateStr()) {
  const starts = periodStarts(), set = new Set(periodDays());
  const last = [...starts].reverse().find(s => s <= date);
  const gaps = starts.slice(1).map((s, i) => daysBetween(starts[i], s)).filter(g => g >= 18 && g <= 50);
  const lens = starts.map(s => {
    let d = s;
    while (set.has(addDays(d, 1)) || set.has(addDays(d, 2))) d = set.has(addDays(d, 1)) ? addDays(d, 1) : addDays(d, 2);
    return daysBetween(s, d) + 1;
  });
  const avg = gaps.length ? Math.round(median(gaps)) : null;
  return { starts, last, day: last ? daysBetween(last, date) + 1 : null, avg,
    len: lens.length ? Math.round(median(lens)) : null, next: last && avg ? addDays(last, avg) : null };
}
// Period days plus the 2 days before each start, when cramps and stomach trouble often begin.
function periodWindow() {
  const w = new Set(periodDays());
  periodStarts().forEach(s => { w.add(addDays(s, -1)); w.add(addDays(s, -2)); });
  return w;
}
function periodRow(date, day) {
  if (!periodOn()) return '';
  const c = cycleInfo(date);
  if (day.period) return `<section class="period-row on"><div class="pr-top"><span>🌸 Period${c.day ? ` <span class="muted">· day ${c.day}</span>` : ''}</span><button class="pr-end" data-act="period" data-f="off">It ended</button></div>
    <div class="pr-flow">${PERIOD_FEELS.map(([k, , l]) => `<button class="pr-tag ${(day.periodFeel || []).includes(k) ? 'on' : ''}" data-act="periodFeel" data-k="${k}">${l}</button>`).join('')}</div></section>`;
  // The day after a period day, ask once instead of assuming either way.
  if (day.period === undefined && db.get('days', addDays(date, -1))?.period) return `<div class="period-row"><span class="grow">🌸 Still on your period?</span>
    <button class="pr-end" data-act="period" data-f="on">Yes</button><button class="pr-end" data-act="period" data-f="off">It ended</button></div>`;
  const soon = c.next && date >= dateStr() ? daysBetween(date, c.next) : null;
  const hint = soon != null && soon >= 0 && soon <= 4 ? (soon === 0 ? 'may start today' : `may start in ~${soon} day${soon === 1 ? '' : 's'}`) : c.day && c.day <= 60 ? `cycle day ${c.day}` : '';
  return `<button class="period-row" data-act="period" data-f="on"><span>🌸 Period</span><span class="muted small grow">${hint}</span><span class="link">Log</span></button>`;
}
function setPeriod(f) {
  const d = { ...(db.get('days', ui.date) || { id: ui.date, date: ui.date }) };
  // 'off' records that it ended, so tomorrow doesn't ask again.
  if (f === 'on') d.period = true; else { d.period = false; delete d.periodFeel; }
  db.put('days', d);
}
function togglePeriodFeel(k) {
  const d = { ...(db.get('days', ui.date) || { id: ui.date, date: ui.date }) };
  const on = new Set(d.periodFeel || []);
  on.has(k) ? on.delete(k) : on.add(k);
  d.periodFeel = [...on];
  db.put('days', d);
}
// "3 of 7 stomach logs were during or right before your period"
function periodShare(list, what) {
  if (!periodOn() || list.length < 3 || !periodStarts().length) return '';
  const w = periodWindow(), n = list.filter(e => w.has(e.date)).length;
  return n >= 2 ? `<div class="fact"><span>🌸</span><div><b>${n} of ${list.length}</b> ${what} were during or right before your period</div></div>` : '';
}
function cycleTrends() {
  if (!periodOn()) return '';
  const c = cycleInfo();
  if (!c.starts.length) return '';
  const fc = new Map();
  db.list('days').forEach(d => (d.periodFeel || []).forEach(k => fc.set(k, (fc.get(k) || 0) + 1)));
  const feelTop = [...fc.entries()].filter(([k]) => PERIOD_FEELS.some(f => f[0] === k)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const short = d => parseDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<section class="card gut-trends">
    <div class="card-head"><h3>🌸 Cycle</h3></div>
    <div class="big-stats"><div><b>${c.avg ?? '–'}</b><span>avg cycle (days)</span></div><div><b>${c.len ?? '–'}</b><span>avg period (days)</span></div><div><b>${c.day ?? '–'}</b><span>cycle day</span></div></div>
    <div class="facts">
      <div class="fact"><span>📅</span><div>Last started <b>${short(c.last)}</b>${c.next ? ` · next around <b>${short(c.next)}</b>` : ''}</div></div>
      ${periodShare(db.list('stomach'), 'stomach logs')}
      ${periodShare(db.list('feel'), 'feeling-off check-ins')}
    </div>
    ${!c.avg ? `<p class="muted small">Shows your usual cycle after a couple of periods.</p>` : ''}
    ${feelTop.length ? `<p class="small">Usually: ${feelTop.map(([k, n]) => { const f = PERIOD_FEELS.find(x => x[0] === k); return `<b>${f[2].toLowerCase()}</b> (${n})`; }).join(', ')}</p>` : ''}
  </section>`;
}

// ---------- notifications ----------
// A short list on purpose: at most a few a day, nothing after bedtime.
const NOTIFS = [
  ['n_bed', '🌙 Bedtime', "30 minutes before that night's planned bedtime.", true],
  ['n_week', '📊 Weekly recap', 'Sunday at 6 PM, when your week card is ready.', true],
  ['n_win', '🏆 Wins', 'A congrats right after the Pilots win.', true],
  ['n_game', '🏀 Game days', 'The morning of each game, with who you play and when.', true],
  ['n_prep', '🥡 Meal prep', "Once, when you're down to your last container.", true],
  ['n_meds', '💊 Meds reminder', "Only if they're not checked off yet.", true],
  ['n_period', '🌸 Period heads-up', 'The evening before it might start. The lock screen just says "Heads-up".', false],
];
const hmMinus = (t, m) => { const x = +t.slice(0, 2) * 60 + +t.slice(3) - m; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
// Morning meds remind between 5 AM and 1 PM only; anything else saved (old versions
// stored other values) falls back to 9 AM, so the reminder can't fire overnight.
const medsAm = () => [profile()?.medsAm, profile()?.medsTime].find(v => /^\d{2}:\d{2}$/.test(v || '') && v >= '05:00' && v <= '13:00') || '09:00';
const medsPm = () => profile()?.medsPm || '20:00';
const nOn = k => profile()?.[k] ?? NOTIFS.find(n => n[0] === k)[3];
function notifyItems() {
  const t = dateStr(), items = [];
  // Easter egg: no setting for this one.
  items.push({ id: 'wish', at: '11:11', ttl: 60, close: 60, keep: 1, title: '11:11', body: '🌠' });
  if (nOn('n_bed')) for (let i = -1; i < 8; i++) {
    const d = addDays(t, i), b = bedGoal(d), at = fromMin(toMin(b) - 30), on = at < '12:00' ? addDays(d, 1) : d;
    if (on > t || (on === t && at > timeStr())) items.push({ id: 'bed-' + d, date: on, at, ttl: 1800, keep: 30 + sleepGoal(), title: '🌙 Bedtime in 30 min', body: `Bed by ${fmtTime(b)} to get your sleep in.` });
  }
  if (nOn('n_game')) GAMES.filter(g => g.date >= t).slice(0, 10).forEach(g =>
    items.push({ id: 'game-' + g.date, date: g.date, at: g.time && g.time < '12:00' ? hmMinus(g.time, 180) : '09:00', ttl: 10800, keep: 900, title: '🏀 GAME DAY', body: `${vsAt(g)} ${g.opp} · ${gameTime(g)}${g.venue ? ` · ${g.venue}` : ''}` }));
  if (nOn('n_week')) { const dow = parseDate(t).getDay(), sun = addDays(t, (7 - dow) % 7); items.push({ id: 'week-' + sun, date: sun, at: '18:00', ttl: 10800, keep: 360, open: 'wrapped', title: '📊 Your week', body: 'Sleep, recovery and fueling, all in one card.' }); }
  const meds = medList();
  if (nOn('n_meds') && meds.length) {
    const taken = db.get('days', t)?.meds || {}, am = meds.filter(m => medWhen(m) !== 'Night'), pm = meds.filter(m => medWhen(m) === 'Night');
    if (am.length) items.push({ id: 'meds-am', at: medsAm(), ttl: 7200, keep: 720, skip: am.every(m => taken[m.id]) ? [t] : [], title: '💊 Morning meds', body: "Not checked off yet today." });
    if (pm.length) items.push({ id: 'meds-pm', at: medsPm(), ttl: 7200, keep: 360, skip: pm.every(m => taken[m.id]) ? [t] : [], title: '💊 Night meds', body: "Not checked off yet tonight." });
  }
  const preps = activePreps(), left = preps.reduce((a, p) => a + p.left, 0);
  if (nOn('n_prep') && left > 0 && left <= 1) {
    // Pick the day once so it can't turn into a daily nag.
    const key = preps.map(p => p.id).join(',');
    let note = {};
    try { note = JSON.parse(localStorage.getItem('pulsePrepNote') || '{}'); } catch {}
    if (note.key !== key) { note = { key, date: timeStr() < '17:00' ? t : addDays(t, 1) }; try { localStorage.setItem('pulsePrepNote', JSON.stringify(note)); } catch {} }
    if (note.date >= t) items.push({ id: 'prep', date: note.date, at: '17:00', ttl: 14400, keep: 360, title: '🥡 Last meal-prep container', body: 'Might be time to cook a new batch.' });
  }
  if (nOn('n_period') && periodOn()) {
    const c = cycleInfo();
    const eve = c.next && addDays(c.next, -1);
    if (eve && eve >= t) items.push({ id: 'period', date: eve, at: fromMin(toMin(bedGoal(eve)) - 120), ttl: 7200, keep: 720, title: 'Heads-up', body: '🌸 Might start tomorrow.' });
  }
  return items;
}
// Notifications she's already taken care of: meds checked off, or the night's sleep logged.
function handledNotes() {
  const t = dateStr(), y = addDays(t, -1), taken = db.get('days', t)?.meds || {}, meds = medList();
  const done = [];
  if (meds.filter(m => medWhen(m) !== 'Night').every(m => taken[m.id])) done.push('meds-am');
  if (meds.filter(m => medWhen(m) === 'Night').every(m => taken[m.id])) done.push('meds-pm');
  if (db.get('days', t)?.sleepMin || timeStr() > '05:00') done.push('bed-' + y);
  return done;
}
let notifyTimer;
function scheduleNotify(ms = 1500) {
  if (DEMO || NEW) return;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notify.clearStale(handledNotes());
    notify.saveSchedule(notifyItems(), { wins: nOn('n_win') }).catch(() => {});
  }, ms);
}
async function turnOnNotify() {
  if (DEMO || NEW) return toast("This is a test version. Notifications are off here.");
  try { await notify.turnOn(); ui.notifyOn = true; toast('🔔 Notifications on'); scheduleNotify(0); queueRender(); }
  catch (e) { toast(e.message); }
}
function notifyCard() {
  const intro = ui.notifyOn ? 'On. Never more than a few a day, and nothing after bedtime.'
    : !notify.installed() ? 'Add Pulse to your Home Screen first, then turn these on here.'
    : 'A few quiet reminders. Never more than a few a day.';
  return `<section class="card">
    <h3>🔔 Notifications</h3>
    <p class="muted small">${intro}</p>
    ${ui.notifyOn ? '' : `<button class="btn primary full" data-act="notifyOn">Turn on notifications</button>`}
    ${NOTIFS.filter(n => n[0] !== 'n_period' || periodOn()).map(([k, l, sub, def]) => switchRow(k, l, sub, def) + (k === 'n_meds' && nOn('n_meds') ? medsTimeRow() : '')).join('')}
  </section>`;
}
// Two plain dropdowns instead of a clock: "Morning meds: 9:00 AM".
function medsTimeRow() {
  const meds = medList();
  if (!meds.length) return `<button class="btn soft full mb" data-act="editMeds">💊 Add your meds first</button>`;
  const opts = (from, to, cur) => { let o = ''; for (let m = from; m <= to; m += 30) { const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; o += `<option value="${v}" ${v === cur ? 'selected' : ''}>${fmtTime(v)}</option>`; } return o; };
  const row = (label, key, html) => `<div class="kv-row remind-row"><span>${label}</span><select class="time-in" data-change="${key}">${html}</select></div>`;
  return `<div class="remind">
    ${meds.some(m => medWhen(m) !== 'Night') ? row('☀️ Morning meds', 'medsAm', opts(300, 780, medsAm())) : ''}
    ${meds.some(m => medWhen(m) === 'Night') ? row('🌙 Night meds', 'medsPm', opts(960, 1410, medsPm())) : ''}
  </div>`;
}
// If the app is open at 11:11 AM, a small note shows for that minute only.
function wishCheck() {
  const el = $('.wish-bar'), show = timeStr() === '11:11' && ui.wishGone !== dateStr();
  if (show && !el) {
    const b = document.createElement('button');
    b.className = 'wish-bar'; b.textContent = '🌠 11:11';
    b.onclick = () => { ui.wishGone = dateStr(); b.remove(); };
    document.body.appendChild(b);
  } else if (!show && el) el.remove();
}
setInterval(wishCheck, 5000);

// ---------- readiness (Whoop-style "how hard to go today") ----------
function readiness(date) {
  const day = db.get('days', date) || {}, need = sleepNeed(addDays(date, -1)).min;
  if (day.recovery == null && day.sleepMin == null) return null;
  const rec = day.recovery, pct = day.sleepMin != null ? day.sleepMin / need : null;
  let level = rec != null ? (rec >= 67 ? 2 : rec >= 34 ? 1 : 0) : pct >= 0.95 ? 2 : pct >= 0.8 ? 1 : 0;
  if (pct != null && pct < 0.8) level = Math.min(level, 1);
  const prev = db.get('days', addDays(date, -1)) || {}, game = gameOn(date);
  const facts = [rec != null && `💚 ${rec}% recovery`, day.sleepMin != null && `😴 ${fmtSleep(day.sleepMin)} of ${fmtSleep(need)} needed`, prev.strain != null && `⚡ ${prev.strain} strain yesterday`].filter(Boolean);
  const L = [
    { cls: 'red', t: 'Take it easier', d: 'Skip the extras. Fuel, fluids, early bed.' },
    { cls: 'yellow', t: 'Steady', d: 'Normal day. No need for extra.' },
    { cls: 'green', t: 'Ready to go', d: 'Good day to push it.' }][level];
  return { ...L, facts, game: game && !game.result ? `🏀 Carbs every meal + a GF snack 2–3 hrs before tip.` : '' };
}
function readinessCard(date) {
  if (date !== dateStr()) return '';
  const r = readiness(date);
  if (!r) return '';
  return `<section class="card readiness ${r.cls}"><div class="ready-top"><span class="ready-dot"></span><b>${r.t}</b><span class="muted small grow">Today's readiness</span></div>
    <p class="small">${r.d}</p><div class="ready-facts">${r.facts.map(f => `<span>${f}</span>`).join('')}</div>${r.game ? `<p class="small mt">${r.game}</p>` : ''}</section>`;
}

// ---------- weekly recap (Sunday and Monday) ----------
function weekRange(date) {
  const dow = parseDate(date).getDay();
  if (dow === 0) return [addDays(date, -6), date];
  if (dow === 1) return [addDays(date, -7), addDays(date, -1)];
  return null;
}
function weekStats([from, to]) {
  const dates = []; for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const g = goals(), days = dates.map(d => db.get('days', d) || {});
  const tots = dates.map(d => { const e = dayEntries(d); return e.length ? sumMacros(e.map(x => x.macros)) : null; }).filter(Boolean);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const sleeps = days.map(d => d.sleepMin).filter(x => x != null), recs = days.map(d => d.recovery).filter(x => x != null);
  const beds = days.map((d, i) => d.bed ? { ...d, date: dates[i] } : null).filter(Boolean);
  return {
    sleep: avg(sleeps), sleepN: sleeps.length, nearBed: beds.filter(nearPlan).length, bedN: beds.length, rec: avg(recs),
    foodDays: tots.length, cal: avg(tots.map(t => t.cal)), protein: tots.filter(t => t.p >= g.p * 0.95).length,
    water: days.filter(d => d.water >= g.water).length, stomach: db.list('stomach').filter(e => e.date >= from && e.date <= to).length,
    train: days.reduce((a, d) => a + actsOf(d).filter(x => x !== 'rest').length, 0),
    games: GAMES.filter(x => x.date >= from && x.date <= to && x.result?.startsWith('W')).map(x => `W ${vsAt(x)} ${x.opp}`),
  };
}
function weekCard(date) {
  const range = date === dateStr() && weekRange(date);
  if (!range || profile()?.['weekSeen-' + range[1]]) return '';
  const w = weekStats(range), g = goals();
  if (!w.foodDays && !w.sleepN) return '';
  const good = [], tryNext = [];
  if (w.bedN && w.nearBed >= w.bedN - 1) good.push(`On your bedtime plan ${w.nearBed} of ${w.bedN} nights`); else if (w.bedN) tryNext.push(`Bed on plan ${w.nearBed} of ${w.bedN} nights. Wind down at the 30-min reminder.`);
  if (w.foodDays && w.protein >= w.foodDays - 1) good.push(`Hit protein ${w.protein} of ${w.foodDays} days`); else if (w.foodDays) tryNext.push(`Protein hit ${w.protein} of ${w.foodDays} days. Add a shake after practice.`);
  if (w.cal != null && w.cal < g.cal * 0.9) tryNext.unshift(`Averaged ${fmt(w.cal)} cal, under your ${fmt(g.cal)} goal. Add a snack on heavy days.`);
  if (!w.stomach && w.foodDays >= 4) good.push('No stomach trouble all week');
  if (w.sleep != null && w.sleep >= sleepGoal() - 10) good.push(`Averaged ${fmtSleep(w.sleep)} of sleep`); else if (w.sleep != null) tryNext.push(`Sleep averaged ${fmtSleep(w.sleep)}, goal is ${fmtSleep(sleepGoal())}.`);
  if (w.water < 4 && w.foodDays >= 4) tryNext.push(`Hit your water goal ${w.water} of 7 days.`);
  const short = d => parseDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<section class="card week-card"><button class="pr-x" data-act="weekDone" data-d="${range[1]}" aria-label="Close">✕</button>
    <div class="card-head"><h3>📊 Your week</h3><span class="muted small">${short(range[0])} – ${short(range[1])}</span></div>
    <div class="big-stats"><div><b>${w.sleep != null ? fmtSleep(w.sleep) : '–'}</b><span>avg sleep</span></div><div><b>${w.rec != null ? Math.round(w.rec) + '%' : '–'}</b><span>avg recovery</span></div><div><b>${w.cal != null ? fmt(w.cal) : '–'}</b><span>avg cal</span></div></div>
    <div class="facts">
      ${w.games.length ? `<div class="fact"><span>🏀</span><div>${w.games.map(esc).join(' · ')}</div></div>` : ''}
      <div class="fact"><span>💪</span><div>${w.train} training session${w.train === 1 ? '' : 's'} logged${w.stomach ? ` · ${w.stomach} stomach log${w.stomach === 1 ? '' : 's'}` : ''}</div></div>
      ${good[0] ? `<div class="fact"><span>✅</span><div><b>Went well:</b> ${good[0]}</div></div>` : ''}
      ${tryNext[0] ? `<div class="fact"><span>🎯</span><div><b>Try this week:</b> ${tryNext[0]}</div></div>` : ''}
    </div>
    ${DEMO || parseDate(date).getDay() === 0 ? `<button class="btn primary full" data-act="wrapped" data-from="${range[0]}" data-to="${range[1]}">▶ Watch your week</button>` : ''}
    <button class="btn soft full mt" data-act="ask" data-q="How did my week go? What should I focus on this week?">✨ Ask Pulse about my week</button>
  </section>`;
}

// Weekly "Wrapped": a tap-through story of the week. Slides with no data are
// skipped. Numbers count up, visuals grow in, emojis float, and big moments
// get confetti.
function openWrapped(from, to) {
  const w = weekStats([from, to]), dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const days = dates.map(d => ({ ...(db.get('days', d) || {}), date: d }));
  const wd = d => parseDate(d).toLocaleDateString(undefined, { weekday: 'long' });
  const best = k => days.filter(d => d[k] != null).sort((a, b) => b[k] - a[k])[0];
  const counts = new Map();
  db.list('entries').forEach(e => { if (e.date >= from && e.date <= to && e.kind !== 'quick') counts.set(e.name, (counts.get(e.name) || 0) + 1); });
  const fav = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const short = d => parseDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const sleepStr = v => fmtSleep(Math.round(v));
  const slides = [];
  slides.push({ c: 'w1', fx: ['💜', '✨', '🏀'], k: 'Your week in review', big: esc(firstName()), sub: `${short(from)} – ${short(to)}`, foot: 'Tap to go through it', art: '<div class="wr-orb">🏀</div>' });
  if (w.sleepN) {
    // Bars start at 5h so the differences between nights actually show.
    const b = best('sleepMin'), goal = sleepGoal(), max = Math.max(goal, ...days.map(d => d.sleepMin || 0)) + 15, lo = 300;
    const hgt = m => Math.max(0, Math.min(1, (m - lo) / (max - lo)));
    const bars = days.map((d, i) => `<div class="wr-bar ${d.sleepMin >= goal - 10 ? 'hit' : ''}"><i style="--h:${d.sleepMin ? Math.max(0.04, hgt(d.sleepMin)) : 0};--d:${0.3 + i * 0.08}s"></i><span>${parseDate(addDays(d.date, -1)).toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`).join('');
    const good = w.sleep >= goal - 10;
    slides.push({ c: 'w2', fx: ['💤', '🌙', '⭐'], k: '😴 Sleep', count: [w.sleep, sleepStr], sub: 'average a night', stamp: good ? 'Sleep goal ✓' : '',
      art: `<div class="wr-bars7" style="--goal:${hgt(goal)}">${bars}<div class="wr-goal"></div></div>`,
      foot: `Best night: <b>${fmtSleep(b.sleepMin)}</b>, ${wd(addDays(b.date, -1))} night${w.bedN ? `<br>On your bedtime plan <b>${w.nearBed} of ${w.bedN}</b> nights` : ''}`, party: good });
  }
  if (w.foodDays) {
    const pct = w.protein / w.foodDays, C = 2 * Math.PI * 54;
    slides.push({ c: 'w3', fx: ['🥩', '💪', '🍗'], k: '🥩 Protein', count: [w.protein, x => `${Math.round(x)}/${w.foodDays}`], sub: 'days you hit your protein goal', stamp: pct >= 0.8 ? 'Protein goal ✓' : '',
      art: `<svg class="wr-ring" viewBox="0 0 120 120"><circle cx="60" cy="60" r="54"/><circle class="fill" cx="60" cy="60" r="54" style="--c:${C};--o:${C * (1 - pct)}"/></svg>`,
      foot: `${fmt(w.cal)} cal a day on average${w.water ? `<br>💧 Water goal hit <b>${w.water}</b> ${w.water === 1 ? 'day' : 'days'}` : ''}`, party: pct >= 0.8 });
  }
  if (fav && fav[1] >= 2) slides.push({ c: 'w4', fx: ['🍽️', '😋', '🔥'], k: '🍽️ Your go-to', big: esc(fav[0]), sub: `you had it <b>${fav[1]}×</b> this week`, foot: '', art: '<div class="wr-orb spin">😋</div>' });
  if (w.train || w.games.length) slides.push({ c: 'w5', fx: ['🏀', '💪', '⚡'], k: '💪 The grind', count: [w.train, x => String(Math.round(x))], sub: `training session${w.train === 1 ? '' : 's'}`,
    stamp: w.games.some(x => x.startsWith('W')) ? 'Pilots W 🏆' : '',
    foot: w.games.length ? w.games.map(x => `🏀 ${esc(x)}`).join('<br>') : '', party: w.games.some(x => x.startsWith('W')) });
  const br = best('recovery');
  if (br) slides.push({ c: 'w6', fx: ['💚', '🔋', '✨'], k: '💚 Recovery', count: [br.recovery, x => `${Math.round(x)}%`], sub: `your best, on ${wd(br.date)}`, foot: w.rec != null ? `${Math.round(w.rec)}% average` : '', art: '<div class="wr-orb beat">💚</div>', stamp: br.recovery >= 90 ? '90%+ day' : '' });
  const wins = [w.bedN && w.nearBed >= w.bedN - 1 && `On your bedtime ${w.nearBed} of ${w.bedN} nights`, w.foodDays && w.protein >= w.foodDays - 1 && `Protein goal ${w.protein} of ${w.foodDays} days`, !w.stomach && w.foodDays >= 4 && 'No stomach issues', w.water >= 5 && `Water goal ${w.water} days`].filter(Boolean);
  slides.push({ c: 'w7', fx: ['🏆', '🎉', '💜', '✨'], k: wins.length ? '🏆 Best of the week' : '🎯 Next week', big: wins.length ? wins[0] : 'New week', sub: wins.length ? wins.slice(1).join(' · ') : '', foot: `#${esc(profile()?.number || '11')} · Pulse`, party: true });

  const el = document.createElement('div');
  el.className = 'wrapped';
  document.body.appendChild(el);
  let i = 0, timer, raf;
  const close = () => { clearTimeout(timer); cancelAnimationFrame(raf); el.remove(); };
  const countUp = (node, to, f) => {
    const t0 = performance.now(), dur = 1100;
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); node.textContent = f(to * e); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  };
  const show = () => {
    clearTimeout(timer); cancelAnimationFrame(raf);
    const x = slides[i], last = i === slides.length - 1;
    el.className = `wrapped ${x.c}`;
    const floaters = Array.from({ length: 14 }, (_, j) => `<span class="wr-fl" style="left:${Math.random() * 100}%;font-size:${16 + Math.random() * 22}px;animation-duration:${5 + Math.random() * 5}s;animation-delay:${-Math.random() * 8}s">${x.fx[j % x.fx.length]}</span>`).join('');
    el.innerHTML = `<div class="wr-blob a"></div><div class="wr-blob b"></div>${floaters}
      <div class="wr-bars">${slides.map((_, j) => `<i class="${j < i ? 'done' : j === i ? 'on' : ''}"></i>`).join('')}</div>
      <button class="wr-x" aria-label="Close">✕</button>
      <div class="wr-body">
        <div class="wr-k">${x.k}</div>
        <div class="wr-big">${x.big || ''}</div>
        <div class="wr-sub">${x.sub}</div>
        ${x.art ? `<div class="wr-art">${x.art}</div>` : ''}
        ${x.stamp ? `<div class="wr-stamp">${x.stamp}</div>` : ''}
        <div class="wr-foot">${x.foot}</div></div>
      ${last ? `<div class="wr-end">📸 Screenshot to share · tap to close</div>` : ''}`;
    if (x.count) countUp(el.querySelector('.wr-big'), x.count[0], x.count[1]);
    if (x.party) setTimeout(() => celebrate('', last), x.count ? 1000 : 400);
    if (!last) timer = setTimeout(() => { i++; show(); }, 6000);
  };
  el.addEventListener('click', e => {
    if (e.target.closest('.wr-x')) return close();
    if (e.clientX < innerWidth / 3) i = Math.max(0, i - 1);
    else if (i < slides.length - 1) i++;
    else return close();
    buzz(); show();
  });
  show();
}

// ---------- what helps her recover (like Whoop's journal insights) ----------
// Compares next-morning recovery after nights she did something vs didn't.
function recoveryHelpers() {
  const g = goals(), rows = [];
  for (const d of db.list('days')) {
    if (d.recovery == null) continue;
    const prev = addDays(d.id, -1), pd = db.get('days', prev) || {}, ents = dayEntries(prev);
    if (!ents.length && pd.water == null) continue;
    const t = ents.length ? sumMacros(ents.map(e => e.macros)) : null;
    const last = ents.reduce((m, e) => (e.time || '') > m ? e.time : m, '');
    rows.push({ rec: d.recovery, f: {
      dinner: last ? last < '19:00' : null,
      bed: d.bed ? nearPlan(d) : null,
      water: pd.water != null ? pd.water >= g.water : null,
      caffeine: ents.length ? !ents.some(e => e.time >= '14:00' && entryTags(e).includes('Caffeine')) : null,
      protein: t ? t.p >= g.p * 0.95 : null,
      sleep: d.sleepMin != null ? d.sleepMin >= sleepGoal() : null,
    } });
  }
  const LABELS = { dinner: 'Done eating by 7 PM', bed: 'In bed near your plan', water: 'Hit your water goal', caffeine: 'No caffeine after 2 PM', protein: 'Hit your protein goal', sleep: 'Slept your full goal' };
  const out = [];
  for (const k of Object.keys(LABELS)) {
    const yes = rows.filter(r => r.f[k] === true).map(r => r.rec), no = rows.filter(r => r.f[k] === false).map(r => r.rec);
    if (yes.length < 3 || no.length < 3) continue;
    const a = yes.reduce((x, y) => x + y, 0) / yes.length, b = no.reduce((x, y) => x + y, 0) / no.length;
    if (a - b >= 4) out.push({ k, label: LABELS[k], yes: Math.round(a), no: Math.round(b), n: yes.length + no.length });
  }
  return { rows: rows.length, list: out.sort((x, y) => (y.yes - y.no) - (x.yes - x.no)) };
}
function recoveryCard() {
  const h = recoveryHelpers();
  return `<section class="card gut-trends"><div class="card-head"><h3>💚 What helps you recover</h3></div>
    ${h.rows < 8 ? `<p class="muted small">Shows up after about 2 weeks of logging.</p>`
      : h.list.length ? `<div class="facts">${h.list.slice(0, 4).map(x => `<div class="fact"><span>✅</span><div><b>${x.label}</b><div class="muted small">${x.yes}% recovery the next morning vs ${x.no}% when you didn't</div></div></div>`).join('')}</div>
        <p class="muted tiny">From ${h.rows} mornings. Patterns, not proof.</p>`
      : `<p class="small">No clear pattern yet. Keep logging and check back.</p>`}
  </section>`;
}

// ---------- Ask Pulse ----------
// Each question sends a plain-text summary of what she's logged to the AI on
// the Pulse server. Nothing is saved there.
function askContext() {
  const p = profile() || {}, g = goals(), t = dateStr(), lines = [];
  const meds = medList().map(m => `${m.name} (${medWhen(m).toLowerCase()}${medFood(m) ? ', with food' : ''})`).join('; ');
  lines.push(`Name: ${p.name || 'Carly'}. University of Portland women's basketball, #${p.number || '11'}. Celiac: strictly gluten-free.`);
  lines.push(`Today: ${parseDate(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, ${fmtTime(timeStr())}.`);
  const opt = OPTIONAL_MACROS.filter(([k]) => tracks(k)).map(([k, l]) => `${g[k]} g ${l.toLowerCase()}`), off = OPTIONAL_MACROS.filter(([k]) => !tracks(k)).map(([, l]) => l.toLowerCase());
  lines.push(`Daily goals: ${[`${g.cal} cal`, `${g.p} g protein`, ...opt, `${g.water} oz water`].join(', ')}. Sleep goal ${fmtSleep(sleepGoal())}.${p.goalsGuess ? " These goals are Pulse's generic starting point, NOT from her dietitian." : ''}${off.length ? ` She chose not to track ${off.join(' or ')}, so don't coach on those goals.` : ''}`);
  if (meds) lines.push(`Meds & vitamins: ${meds}.`);
  const tp = bedPlan(t); lines.push(`Tonight: sleep need ${fmtSleep(tp.need.min)}${tp.need.why.length ? ` (${tp.need.why.join(', ')})` : ''}, bed by ${fmtTime(tp.bed)}, up at ${fmtTime(tp.wake)}.`);
  const r = readiness(t); if (r) lines.push(`Readiness today: ${r.t} (${r.facts.join(', ')}).`);
  const next = GAMES.filter(x => x.date >= t && !x.result).slice(0, 3).map(x => `${x.date} ${vsAt(x)} ${x.opp} ${gameTime(x)}`);
  const past = GAMES.filter(x => x.result).slice(-3).map(x => `${x.date} ${vsAt(x)} ${x.opp}: ${x.result}`);
  if (next.length) lines.push(`Next games: ${next.join('; ')}.`);
  if (past.length) lines.push(`Recent results: ${past.join('; ')}.`);
  const preps = activePreps(); if (preps.length) lines.push(`Meal prep in the fridge: ${preps.map(x => `${x.name} (${fmt(x.left)} left, made ${x.madeOn})`).join('; ')}.`);
  if (periodOn() && periodStarts().length) { const c = cycleInfo(); lines.push(`Cycle: last period started ${c.last}${c.avg ? `, usual cycle ${c.avg} days, next around ${c.next}` : ''}.`); }
  const gut = analyzeGut(db.list('entries'), db.list('stomach'), entryTags, { windowH: 12 });
  const strong = [...gutSuspects().values()], st = db.list('stomach');
  lines.push(`Stomach analysis (${st.length} episodes logged): ${strong.length ? `foods that stand out: ${strong.map(f => `${f.name} (trouble after ${f.hit} of ${f.eaten} times)`).join('; ')}` : 'no single food stands out yet; everyday foods show up before most episodes just because she eats them daily, so they are not suspects'}.`);
  if (gut.tags.length) lines.push(`Food types more often before stomach trouble: ${gut.tags.slice(0, 4).map(x => `${x.name} (${Math.round(x.rate * 100)}% of the time vs ${Math.round(gut.base * 100)}% normally)`).join('; ')}.`);
  if (periodOn() && st.length) { const pw = periodWindow(); lines.push(`${st.filter(e => pw.has(e.date)).length} of ${st.length} stomach episodes and ${db.list('feel').filter(e => pw.has(e.date)).length} of ${db.list('feel').length} felt-off check-ins were during or within 2 days before a period.`); }
  const ctx = new Map(); st.forEach(e => (e.context || []).forEach(c => ctx.set(c, (ctx.get(c) || 0) + 1)));
  if (ctx.size) lines.push(`What was going on during stomach episodes: ${[...ctx.entries()].sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} (${n})`).join(', ')}.`);
  if (gut.safe.length) lines.push(`Foods that seem fine: ${gut.safe.slice(0, 6).map(f => f.name).join(', ')}.`);
  const help = recoveryHelpers().list; if (help.length) lines.push(`What helps recovery: ${help.map(x => `${x.label} (${x.yes}% vs ${x.no}%)`).join('; ')}.`);
  // Averages worked out here so the model doesn't do its own math. Only logged
  // days count, and today is left out because it isn't over yet.
  const avgs = (from, n) => {
    const ds = Array.from({ length: n }, (_, i) => addDays(t, -(from + i))), out = [];
    const eat = ds.map(d => dayEntries(d)).filter(e => e.length).map(e => sumMacros(e.map(x => x.macros)));
    const avg = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
    const day = k => ds.map(d => db.get('days', d)?.[k]).filter(x => x != null);
    // "vs goal" spelled out so under is never read as on track.
    const vs = (v, goal, f) => { const pct = Math.round(v / goal * 100); return `${f(v)} vs goal ${f(goal)} (${pct}%, ${pct >= 95 ? 'on track' : pct >= 85 ? 'a bit under' : 'well under'})`; };
    const gr = x => fmt(x) + ' g';
    if (eat.length) {
      out.push(`eaten per day (${eat.length} days logged): calories ${vs(avg(eat.map(m => m.cal)), g.cal, fmt)}, protein ${vs(avg(eat.map(m => m.p)), g.p, gr)}`
        + OPTIONAL_MACROS.filter(([k]) => tracks(k)).map(([k, l]) => `, ${l.toLowerCase()} ${vs(avg(eat.map(m => m[k] || 0)), g[k], gr)}`).join(''));
    }
    const wv = day('water'); if (wv.length) out.push(`water ${vs(avg(wv), g.water, x => fmt(x) + ' oz')} (${wv.length} days)`);
    const sv = day('sleepMin'); if (sv.length) out.push(`sleep ${vs(avg(sv), sleepGoal(), x => fmtSleep(Math.round(x)))} (${sv.length} nights)`);
    [['recovery', '% recovery', fmt], ['burned', 'cal burned', fmt]].forEach(([k, l, f]) => {
      const v = day(k); if (v.length) out.push(`${f(avg(v))}${l.startsWith('%') ? '' : ' '}${l} (${v.length} days)`);
    });
    return out.join(', ') || 'nothing logged';
  };
  lines.push(`Averages, last 7 days before today: ${avgs(1, 7)}.`, `Averages, the 7 days before that: ${avgs(8, 7)}.`);
  lines.push(`Today so far is not a full day yet; don't treat today's totals as a finished day.`);
  lines.push('', 'Daily log, newest first (blank fields = not logged):');
  for (let i = 0; i < 35; i++) {
    const d = addDays(t, -i), day = db.get('days', d) || {}, ents = dayEntries(d);
    const st = db.list('stomach').filter(e => e.date === d), fl = db.list('feel').filter(e => e.date === d);
    const parts = [];
    if (ents.length) {
      const m = sumMacros(ents.map(e => e.macros));
      parts.push(`ate ${fmt(m.cal)} cal, P ${fmt(m.p)} C ${fmt(m.c)} F ${fmt(m.f)} fiber ${fmt(m.fiber)}`);
      parts.push(`food: ${ents.map(e => `${e.time || ''} ${e.name}`.trim()).slice(0, 14).join(', ')}`);
    }
    if (day.water) parts.push(`water ${day.water} oz`);
    if (day.sleepMin != null || day.bed) parts.push(`slept ${day.sleepMin != null ? fmtSleep(day.sleepMin) : '?'}${day.bed ? ` (bed ${day.bed}, up ${day.wake || '?'})` : ''}`);
    const w = [day.recovery != null && `recovery ${day.recovery}%`, day.hrv != null && `HRV ${day.hrv}`, day.rhr != null && `RHR ${day.rhr}`, day.strain != null && `strain ${day.strain}`, day.burned != null && `burned ${day.burned}`, day.active != null && `active cal ${day.active}`, day.resting != null && `resting cal ${day.resting}`,day.steps != null && `steps ${day.steps}`].filter(Boolean);
    if (w.length) parts.push(w.join(', '));
    if (actsOf(day).length) parts.push(`training: ${actsOf(day).join(', ')}`);
    const gm = gameOn(d); if (gm) parts.push(`GAME ${vsAt(gm)} ${gm.opp}${gm.result ? ` ${gm.result}` : ''}`);
    if (medList().length && day.meds) parts.push(`meds ${Object.keys(day.meds).length}/${medList().length}`);
    if (day.period) parts.push(`period day${day.periodFeel?.length ? ` (${day.periodFeel.join(', ')})` : ''}`);
    if (day.weight != null) parts.push(`weight ${day.weight} lb`);
    st.forEach(e => parts.push(`STOMACH ${e.time} severity ${e.severity}/5: ${(e.symptoms || []).join(', ')}${e.context?.length ? ` [${e.context.join(', ')}]` : ''}${e.notes ? ` "${e.notes}"` : ''}`));
    fl.forEach(e => parts.push(`FELT OFF ${e.time} level ${e.level}/5: ${(e.feelings || []).join(', ')}${e.context?.length ? ` [${e.context.join(', ')}]` : ''}${e.notes ? ` "${e.notes}"` : ''}`));
    if (day.notes) parts.push(`journal: "${day.notes.slice(0, 500)}"`);
    if (parts.length) lines.push(`${d} ${parseDate(d).toLocaleDateString('en-US', { weekday: 'short' })}: ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}
const ASK_IDEAS = ['Why was I tired this week?', "What's been upsetting my stomach?", 'How has my sleep been?', 'Am I eating enough on practice days?', 'What should I eat before the next game?'];
function askBar() {
  return `<section class="card ask-bar"><button class="ask-open" data-act="ask"><span>✨</span><span class="grow">Ask Pulse anything about you</span></button>
    <div class="ask-ideas">${ASK_IDEAS.slice(0, 3).map(q => `<button class="pr-tag" data-act="ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></section>`;
}
// Bold headline, then bullets, so answers read at a glance.
function fmtAnswer(t) {
  const bold = x => esc(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let out = '', list = [];
  const flush = () => { if (list.length) out += `<ul>${list.map(l => `<li>${bold(l)}</li>`).join('')}</ul>`; list = []; };
  String(t).split(/\n+/).map(l => l.trim()).filter(Boolean).forEach(l => {
    const b = l.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
    // "💡 Try this: text…" on one line becomes a label plus a bullet per sentence.
    const h = !b && l.match(/^(\p{Extended_Pictographic}️?\s*[^:]{2,30}):\s*(.+)$/u);
    if (h) { flush(); out += `<p class="ans-h">${bold(h[1])}</p>`; list.push(...h[2].split(/(?<=[.!?])\s+(?=[A-Z*])/)); }
    else if (b) list.push(b[1]);
    else { flush(); out += `<p class="${!out ? 'ans-top' : l.length < 32 && !/[.!?]$/.test(l) ? 'ans-h' : ''}">${bold(l)}</p>`; }
  });
  flush();
  return out;
}
function openAsk(q = '') {
  ui.chat ||= [];
  const s = openSheet({
    title: '✨ Ask Pulse', full: true,
    body: `<div id="chat" class="chat"></div>`,
    footer: `<form class="ask-form" id="af"><button type="button" class="btn ghost mic" data-x="mic" aria-label="Talk"><svg class="mic-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg></button><input id="aq" placeholder="Ask about your sleep, food, stomach…" autocomplete="off" enterkeyhint="send"><button class="btn primary" aria-label="Send">↑</button></form>`,
  });
  // Mic: voice typing into the box; she still taps send. Without speech support
  // (some home-screen apps) the keyboard's own dictation does the same.
  let rec = null;
  const stopMic = () => { if (rec) { const r = rec; rec = null; r.stop(); } s.$('[data-x="mic"]')?.classList.remove('on'); };
  s.on('click', '[data-x="mic"]', () => {
    if (rec) return stopMic();
    const inp = s.$('#aq');
    if (!Speech) { inp.focus(); return toast('Tap the mic on your keyboard and talk'); }
    const base = inp.value.trim();
    rec = new Speech();
    Object.assign(rec, { continuous: true, interimResults: true, lang: navigator.language || 'en-US' });
    rec.onresult = e => { let said = ''; for (const r of e.results) said += r[0].transcript; inp.value = (base ? base + ' ' : '') + said.trim(); };
    rec.onend = () => stopMic();
    rec.onerror = () => { stopMic(); inp.focus(); toast('Tap the mic on your keyboard and talk'); };
    try { rec.start(); s.$('[data-x="mic"]').classList.add('on'); buzz(); } catch { stopMic(); }
  });
  s.onClose = stopMic;
  const box = s.$('#chat');
  const draw = (thinking = false) => {
    box.innerHTML = (ui.chat.length ? '' : `<div class="chat-hi"><div class="chat-big">✨</div><p>Ask anything about how you've been. Pulse reads everything you've logged to answer.</p>
        <div class="ask-ideas col">${ASK_IDEAS.map(x => `<button class="pr-tag" data-x="idea" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>`)
      + ui.chat.map(m => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.content) : fmtAnswer(m.content)}</div>`).join('')
      + (thinking ? `<div class="msg assistant thinking"><span></span><span></span><span></span></div>` : '');
    box.parentElement.scrollTop = box.parentElement.scrollHeight;
  };
  async function send(text) {
    text = text.trim();
    if (!text || s.busy) return;
    if (rec) stopMic();
    s.busy = true; s.$('#aq').value = '';
    ui.chat.push({ role: 'user', content: text }); draw(true);
    try {
      const r = await fetch(CONFIG_PUSH() + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: askContext(), messages: ui.chat.slice(-10) }) });
      const j = await r.json();
      ui.chat.push({ role: 'assistant', content: j.answer || "Couldn't answer that one right now. Try again in a minute." });
    } catch { ui.chat.push({ role: 'assistant', content: "Can't reach Pulse right now. Check your connection and try again." }); }
    s.busy = false; draw();
  }
  s.on('submit', '#af', (el, e) => { e.preventDefault(); send(s.$('#aq').value); });
  s.on('click', '[data-x="idea"]', el => send(el.dataset.q));
  draw();
  if (q) send(q);
}

// ---------- tour ----------
// A quick look around after setup: one spotlight at a time, two lines each.
const TOUR = [
  ['.hero', "Today's numbers", 'Calories left and protein so far. Fills in as you log food.'],
  ['#fab', 'Log food', 'Search, scan a barcode, use a recipe, or snap a photo of your plate.'],
  ['.rings', 'Daily rings', 'Protein, water, sleep and meds. Tap one to jump to it.'],
  ['.game-banner, .next-game', 'Games', 'Your next game shows up here. On game day, tap it to see what to eat next.'],
  ['.sleep-card', 'Sleep', "Log last night and see tonight's bedtime, planned around your wake-up and games."],
  ['.ask-pill', 'Ask Pulse', 'Ask about your sleep, food, stomach or games. Answers come from what you log. Tap the mic to talk.'],
  ['[data-tab="foods"]', 'Foods', "Everything you've eaten, plus your own foods. Easy to re-log."],
  ['[data-tab="recipes"]', 'Recipes', 'Save recipes and meal preps, and see how many containers are left.'],
  ['[data-tab="trends"]', 'Trends', 'Your week and month, what helps you recover, and what might bother your stomach.'],
  ['[data-tab="me"]', 'Me', 'Goals, meds, wake-up times and reminders. You can replay this tour here too.'],
];
function startTour() {
  if (document.querySelector('.tour')) return;
  if (ui.tab !== 'today' || ui.date !== dateStr()) { ui.date = dateStr(); go('today'); }
  const steps = TOUR.filter(([sel]) => document.querySelector(sel));
  let i = 0;
  const el = document.createElement('div');
  el.className = 'tour';
  document.body.appendChild(el);
  const end = () => {
    el.remove(); removeEventListener('resize', place);
    if (DEMO) { try { localStorage.setItem('pulseTourDemo', '1'); } catch {} } else saveProfile({ toured: true });
  };
  function place() {
    const [sel, title, text] = steps[i], t = document.querySelector(sel);
    if (!t) return;
    const r = t.getBoundingClientRect(), pad = 8, below = r.top + r.height / 2 < innerHeight / 2;
    el.innerHTML = `<div class="tour-hole" style="top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px"></div>
      <div class="tour-tip" style="${below ? `top:${Math.min(r.bottom + pad + 12, innerHeight - 190)}px` : `bottom:${Math.min(innerHeight - r.top + pad + 12, innerHeight - 190)}px`}">
        <div class="tour-n">${i + 1} of ${steps.length}</div><b>${title}</b><p>${text}</p>
        <div class="tour-btns">${i === steps.length - 1 ? '<span></span>' : '<button class="tour-skip" data-t="skip">Skip tour</button>'}<button class="btn primary" data-t="next">${i === steps.length - 1 ? 'Done' : 'Next'}</button></div></div>`;
  }
  function show() {
    const t = document.querySelector(steps[i][0]);
    if (!t.closest('#nav, #fab')) t.scrollIntoView({ block: 'center' });
    setTimeout(place, 60);
  }
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'skip' || i === steps.length - 1) return end();
    i++; buzz(); show();
  });
  addEventListener('resize', place);
  if (steps.length) show(); else el.remove();
}
const tourDue = () => DEMO ? !localStorage.getItem('pulseTourDemo') : !NEW && !profile()?.toured;

// ---------- journal ----------
function journalCard(day) {
  return `<section class="card tap" data-act="journal">
    <div class="card-head"><h3>📓 Journal <span class="lock">🔒</span></h3><span class="link">${day.notes ? 'Edit' : 'Write'}</span></div>
    ${day.notes ? `<p class="journal-txt">${esc(day.notes)}</p>` : `<p class="muted small">Practice, mood, anything. Just for you.</p>`}
    <button class="talk-btn" data-act="journalTalk">🎙️ Talk instead of typing</button>
  </section>`;
}
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
function openJournal(date = ui.date, talk = false) {
  const d = { ...(db.get('days', date) || { id: date, date }) };
  const s = openSheet({
    title: `Journal · ${fmtDay(date)}`, full: true, lock: true,
    body: `<button class="talk-big" data-x="talk"><span class="talk-dot"></span><span id="tl">🎙️ Tap and talk</span></button>
      <textarea id="jt" class="journal-in" rows="10" placeholder="How did today go?">${esc(d.notes || '')}</textarea>
      <p class="muted tiny center">🔒 Just for you. Stays on this phone.</p>`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  const ta = s.$('#jt'), btn = s.$('[data-x="talk"]');
  let rec = null, base = '';
  const stop = () => { if (rec) { const r = rec; rec = null; r.stop(); } btn.classList.remove('on'); s.$('#tl').textContent = '🎙️ Tap and talk'; };
  function start() {
    // No speech support (some home-screen apps): the keyboard mic does the same thing.
    if (!Speech) { ta.focus(); return toast('Tap the 🎤 on your keyboard and talk'); }
    base = ta.value.trim();
    rec = new Speech();
    Object.assign(rec, { continuous: true, interimResults: true, lang: navigator.language || 'en-US' });
    rec.onresult = e => {
      let said = '';
      for (const r of e.results) said += r[0].transcript;
      said = said.trim();
      ta.value = (base ? base + (base.endsWith('.') ? ' ' : '. ') : '') + (said ? said[0].toUpperCase() + said.slice(1) : '');
      ta.scrollTop = ta.scrollHeight;
    };
    rec.onerror = e => { if (e.error === 'not-allowed') toast('Allow the microphone for Pulse, or use the 🎤 on your keyboard'); };
    rec.onend = () => { if (rec) stop(); };
    try { rec.start(); btn.classList.add('on'); s.$('#tl').textContent = 'Listening… tap to stop'; } catch { stop(); ta.focus(); }
  }
  s.on('click', '[data-x="talk"]', () => rec ? stop() : start());
  s.on('click', '[data-x="save"]', () => { stop(); d.notes = ta.value.trim(); db.put('days', d); s.close(); toast('Saved'); });
  s.on('click', '[data-x="close"]', stop);
  if (talk) start(); else ta.focus();
}

// ---------- meal prep ----------
const activePreps = () => db.list('preps').filter(p => p.left > 0.05).sort((a, b) => a.madeOn.localeCompare(b.madeOn));
const prepAge = p => Math.round((parseDate(dateStr()) - parseDate(p.madeOn)) / 864e5);
const prepMacros = p => scale(p.per, p.gramsEach);
function prepRows(list, act = 'eatPrep') {
  return list.map(p => {
    const age = prepAge(p), m = prepMacros(p);
    return `<div class="prep">
      <button class="prep-main" data-act="editPrep" data-id="${p.id}">${thumb(p.photo, '🥡')}
        <div class="row-main"><div class="row-name">${esc(p.name)}</div>
        <div class="row-sub">${fmt(m.cal)} cal · ${macroLine(m)}</div>
        <div class="prep-meta"><b>${fmt(p.left)} of ${p.containers} left</b> · ${age === 0 ? 'made today' : age === 1 ? 'made yesterday' : `made ${age} days ago`}${age >= 4 ? ` <span class="warn-t">· eat soon</span>` : ''}</div></div></button>
      <button class="prep-eat" data-act="${act}" data-id="${p.id}">Eat one</button></div>`;
  }).join('');
}
function prepCard() {
  const list = activePreps();
  if (!list.length) return '';
  const left = list.reduce((s, p) => s + p.left, 0);
  return `<section class="card prep-card">
    <div class="card-head"><h3>🥡 Meal prep</h3><span class="muted small">${fmt(left)} container${left === 1 ? '' : 's'} ready</span></div>
    ${prepRows(list)}
  </section>`;
}
function adjustPrep(id, containers) {
  const p = db.get('preps', id);
  if (!p) return;
  db.put('preps', { ...p, left: Math.max(0, Math.round((p.left + containers) * 100) / 100) });
}
// Logs as the recipe (so stomach patterns still see it) but with the batch's own macros.
function prepItem(p) {
  const r = db.get('recipes', p.recipeId);
  return { ...(r ? itemFor('recipe', r) : { kind: 'recipe', id: p.recipeId, name: p.name, brand: 'Recipe', photo: p.photo }),
    per: p.per, servingG: p.gramsEach, servingLabel: 'container' };
}
function eatPrep(id) {
  const p = db.get('preps', id);
  if (p) openAmount({ item: prepItem(p), prep: p, meal: defaultMeal(), date: ui.date });
}

function openPrep({ recipe = null, prep = null }) {
  const r = recipe || db.get('recipes', prep?.recipeId);
  const info = r ? recipeInfo(r, getFood) : null;
  const p = prep ? { ...prep } : { id: uid(), recipeId: r.id, name: r.name, photo: r.photo || '', madeOn: dateStr(),
    containers: info.servings || 5, totalG: Math.round(info.weight) || '' };
  const s = openSheet({
    title: prep ? 'Meal prep batch' : 'Meal prep', full: true, lock: true,
    body: `<div class="amt-food">${thumb(p.photo, '🥡')}<div><div class="amt-name">${esc(p.name)}</div><div class="muted small">${prep ? `Made ${fmtDay(p.madeOn)}` : 'Split a batch into containers'}</div></div></div>
      <div class="grid2 mt">
        <div class="field"><label>Containers</label><input id="pc" inputmode="numeric" value="${p.containers}"></div>
        <div class="field"><label>Total weight</label><div class="unit-in"><input id="pt" inputmode="decimal" value="${fmtIn(p.totalG)}" placeholder="whole batch"><span>g</span></div></div>
        <div class="field"><label>Made on</label><input type="date" id="pd" value="${p.madeOn}"></div>
        ${prep ? `<div class="field"><label>Containers left</label><input id="pl" inputmode="decimal" value="${fmtIn(p.left)}"></div>` : ''}
      </div>
      <p class="muted tiny">Weigh the whole batch after cooking (minus the pot or containers). Pulse splits it evenly, so each container is one tap to log.</p>
      <div class="totals" id="ptot"></div>
      ${prep ? `<button class="btn ghost danger-t full" data-x="del">Remove batch</button>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">${prep ? 'Save' : 'Add to fridge'}</button>`,
  });
  const read = () => ({ n: Math.max(1, Math.round(num(s.$('#pc').value))), g: num(s.$('#pt').value) });
  function tot() {
    const { n, g } = read();
    const per = info && g ? scale(info.total, 1 / g) : p.per;
    s.$('#ptot').innerHTML = per && g ? `<div class="tot-row"><span>Each container</span><b>${fmt(scale(per, g / n).cal)} cal</b><span>${fmt(g / n)} g · ${macroLine(scale(per, g / n))}</span></div>`
      : `<p class="muted small">Add the total weight to see each container's macros.</p>`;
  }
  s.on('input', '#pc, #pt', tot);
  s.on('click', '[data-x="del"]', async () => { if (await confirmSheet('Remove this batch? Meals you already logged stay.', 'Remove')) { db.remove('preps', p.id); closeAllSheets(); } });
  s.on('click', '[data-x="save"]', () => {
    const { n, g } = read();
    if (!(g > 0)) return toast('Add the total weight in grams');
    const per = info ? scale(info.total, 1 / g) : scale(p.per, p.totalG / g);
    Object.assign(p, { containers: n, totalG: g, gramsEach: g / n, per, madeOn: s.$('#pd').value || p.madeOn,
      left: prep ? Math.max(0, num(s.$('#pl').value)) : n });
    db.put('preps', p);
    s.close();
    toast(prep ? 'Saved' : `🥡 ${n} containers in the fridge`);
  });
  tot();
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
    ['🫀', 'Resting HR', d.rhr != null ? d.rhr + ' bpm' : null],
    ['💚', 'Recovery', d.recovery != null ? d.recovery + '%' : null],
    ['⚡', 'Strain', d.strain != null ? d.strain : null],
    ['💓', 'HRV', d.hrv != null ? d.hrv + ' ms' : null],
    ['👟', 'Steps', d.steps != null ? fmt(d.steps) : null],
    ['⚖️', 'Weight', d.weight != null && profile()?.showWeight ? d.weight + ' lb' : null],
    ['🔋', 'Energy', d.energy ? d.energy + '/5' : null],
  ].filter(i => i[2] != null);
  const burn = d.burned ?? (d.active != null && d.resting != null ? d.active + d.resting : null);
  return `<section class="card body-card">
    <div class="card-head"><h3>⌚ Recovery</h3><button class="link" data-act="body">${items.length || burn != null ? 'Edit' : ''}</button></div>
    <button class="burn" data-act="body">
      <div class="burn-total"><b>${burn != null ? fmt(burn) : '–'}</b><span>🔥 cal burned</span></div>
      <div class="burn-split"><div><b>${d.active != null ? fmt(d.active) : '–'}</b><span>active</span></div><div><b>${d.resting != null ? fmt(d.resting) : '–'}</b><span>resting</span></div></div>
    </button>
    ${items.length ? `<div class="stat-grid tap" data-act="body">${items.map(i => `<div class="stat"><span class="stat-ico">${i[0]}</span><div><div class="stat-v">${esc(i[2])}</div><div class="stat-l">${i[1]}</div></div></div>`).join('')}</div>` : ''}
    <div class="btn-row mt"><button class="btn primary grow" data-act="body">✏️ Type it in</button><button class="btn soft grow" data-act="healthSync">⌚ Apple Health</button></div>
  </section>`;
}

function gutCard(date) {
  const eps = db.list('stomach').filter(e => e.date === date).sort((a, b) => a.time.localeCompare(b.time));
  return `<section class="card gut">
    <div class="card-head"><h3>Digestion</h3>${eps.length ? `<span class="muted small">${eps.length} logged</span>` : ''}</div>
    ${eps.map(e => { const s = SEVERITY[e.severity - 1] || SEVERITY[2]; return `<button class="entry" data-act="editGut" data-id="${e.id}">
      <div class="e-main"><div class="e-name">${s.e} ${s.t} · ${fmtTime(e.time)}</div><div class="e-sub">${esc((e.symptoms || []).join(', ') || 'No symptoms picked')}</div></div><div class="chev">›</div></button>`; }).join('')}
    <button class="gut-btn" data-act="gut">Log stomach symptoms</button>
  </section>`;
}

function feelCard(date) {
  const logs = db.list('feel').filter(e => e.date === date).sort((a, b) => a.time.localeCompare(b.time));
  return `<section class="card feel">
    <div class="card-head"><h3>How you feel</h3>${logs.length ? `<span class="muted small">${logs.length} logged</span>` : ''}</div>
    ${logs.map(e => { const l = OFF_LEVELS[e.level - 1] || OFF_LEVELS[1]; return `<button class="entry" data-act="editFeel" data-id="${e.id}">
      <div class="e-main"><div class="e-name">${l.e} ${l.t} · ${fmtTime(e.time)}</div><div class="e-sub">${esc((e.feelings || []).join(', ') || 'Just off')}</div></div><div class="chev">›</div></button>`; }).join('')}
    <button class="feel-btn" data-act="feel">Feeling off? Log it</button>
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
  if (!db.list('foods').length) return `<div class="empty"><div class="empty-ico">🏷️</div><b>Save the foods you buy</b>
    <p>Photograph the nutrition label or scan the barcode once. After that, enter the grams you weighed and the macros are calculated for you.</p>
    <button class="btn primary" data-act="newFood">＋ Add your first food</button></div>`;
  if (!list.length) return `<p class="muted center">No foods match “${esc(ui.foodQ)}”.</p>`;
  return list.map(f => `<button class="row" data-act="food" data-id="${f.id}">${thumb(f.photo, '🥣')}
    <div class="row-main"><div class="row-name">${esc(f.name)}${f.fav ? ' <span class="star">★</span>' : ''}${gfBadge('food', f)}</div><div class="row-sub">${foodSub(f)}</div></div><span class="chev">›</span></button>`).join('');
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
  if (!all.length) return `<div class="empty"><div class="empty-ico">🍲</div><b>No recipes yet</b>
    <p>Build a recipe from your saved foods, weigh the finished dish, and log any amount of it in grams — macros calculated automatically.</p>
    <button class="btn primary" data-act="newRecipe">＋ New recipe</button></div>`;
  const list = all.filter(r => !q || r.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return list.map(r => {
    const info = recipeInfo(r, getFood);
    const per = info.servings ? scale(info.total, 1 / info.servings) : scale(info.per, 100);
    return `<button class="row" data-act="recipe" data-id="${r.id}">${thumb(r.photo, '🍲')}
      <div class="row-main"><div class="row-name">${esc(r.name)}${gfBadge(r.ingredients ? 'recipe' : 'food', r)}</div>
      <div class="row-sub">${fmt(per.cal)} cal ${info.servings ? '/ serving' : '/ 100 g'} · ${macroLine(per)}</div></div><span class="chev">›</span></button>`;
  }).join('') || `<p class="muted center">No recipes match.</p>`;
}
function screenRecipes() {
  return `${header('Recipes', `${db.list('recipes').length} saved`, `<button class="top-btn" data-act="newRecipe">＋ New</button>`)}
  <div class="pad">
    ${activePreps().length ? `<section class="card prep-card"><div class="card-head"><h3>🥡 In the fridge</h3></div>${prepRows(activePreps())}</section>`
      : db.list('recipes').length ? `<div class="prep-hint">🥡 <div><b>Meal prepping?</b> Open a recipe and tap <b>I meal-prepped this</b>. Pulse splits the batch into containers so each one is a single tap to log.</div></div>` : ''}
    ${db.list('recipes').length ? `<div class="search"><input type="search" placeholder="Search recipes" value="${esc(ui.recipeQ)}" data-input="recipeQ"></div>` : ''}
    <div class="list" id="recipeList">${recipeListHTML()}</div>
    ${ideasCard()}
  </div>`;
}

// Meal prep ideas: AI picks dish names from what she already makes, and each
// one links to real recipes online. Pulse never writes the recipe itself.
function ideasCard() {
  const st = ui.ideas;
  return `<section class="card ideas-card"><div class="card-head"><h3>💡 Meal prep inspo</h3>${st?.list ? `<button class="link" data-act="getIdeas">New ideas</button>` : ''}</div>
    ${!st ? `<p class="muted small">Ideas picked from what you already make and eat, with real recipes to find online.</p><button class="btn soft full" data-act="getIdeas">✨ Give me ideas</button>`
      : st.loading ? `<div class="snap-wait"><span class="spin"></span> Thinking about what you'd like…</div>`
      : st.error ? `<p class="muted small">${st.error}</p><button class="btn soft full" data-act="getIdeas">Try again</button>`
      : st.list.map(x => `<a class="idea" href="https://www.google.com/search?q=${encodeURIComponent(`${x.name} gluten free meal prep recipe`)}" target="_blank" rel="noopener">
          <div class="grow"><b>${esc(x.name)}</b><div class="muted tiny">${esc(x.why)}</div></div><span class="idea-go">Find recipe ↗</span></a>`).join('')
        + `<p class="muted tiny">Opens recipes online. Double-check every ingredient is gluten-free (sauces, broth, seasoning mixes).</p>`}
  </section>`;
}
async function getIdeas() {
  const names = new Map();
  const bump = (n, w) => n && names.set(n, (names.get(n) || 0) + w);
  db.list('recipes').forEach(r => bump(r.name, 3));
  db.list('preps').forEach(p => bump(p.name, 4));
  db.list('entries').filter(e => e.date >= addDays(dateStr(), -30) && e.kind !== 'quick').forEach(e => bump(e.name, 1));
  const likes = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n]) => n).join(', ');
  ui.ideas = { loading: true }; queueRender();
  try {
    const r = await fetch(CONFIG_PUSH() + '/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ likes }) });
    const j = await r.json();
    ui.ideas = r.ok && j.ideas?.length ? { list: j.ideas } : { error: 'Pulse is busy right now. Try again in a minute.' };
  } catch { ui.ideas = { error: "Can't reach Pulse. Check your connection." }; }
  queueRender();
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

  // top foods in range
  const counts = new Map();
  db.list('entries').forEach(e => { if (e.date >= dates[0] && e.kind !== 'quick') { const c = counts.get(e.name) || { n: 0, cal: 0 }; c.n++; c.cal += e.macros.cal; counts.set(e.name, c); } });
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5);

  return `${header('Trends', streak() ? `🔥 ${streak()}-day logging streak` : '', `<button class="top-btn" data-act="calendar">${icon('calendar')} Calendar</button>`)}
  <div class="pad">
    ${askBar()}
    ${DEMO || parseDate(dateStr()).getDay() === 0 ? `<button class="wrapped-btn" data-act="wrapped"><span>▶</span><span class="grow"><b>Your last 7 days, Wrapped</b><small>Tap through your week</small></span></button>` : ''}
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
      <div class="card-head"><h3>Intake vs. burned</h3></div>
      ${both.length ? `<div class="big-stats"><div><b>${fmt(avgIn)}</b><span>avg eaten</span></div><div><b>${fmt(avgOut)}</b><span>avg burned</span></div><div><b class="${avgIn - avgOut < -300 ? 'warn-t' : ''}">${avgIn - avgOut > 0 ? '+' : ''}${fmt(avgIn - avgOut)}</b><span>difference</span></div></div>
      ${lineChart({ series: [{ values: totals.map((t, i) => t && days[i].burned ? t.cal : null), color: 'var(--purple-3)' }, { values: days.map((d, i) => totals[i] && d.burned ? d.burned : null), color: 'var(--warn)' }], labels })}
      <div class="legend"><span><i class="dot" style="background:var(--purple-3)"></i>Eaten</span><span><i class="dot" style="background:var(--warn)"></i>Burned</span></div>
      ${avgIn - avgOut < -300 ? `<p class="tip">You're averaging ${fmt(avgOut - avgIn)} cal under what you burn. Under-eating can affect recovery and performance.</p>` : ''}`
      : `<p class="muted small">Log calories burned (from your wearable) on days you log food to compare them here.</p>`}
    </section>

    <section class="card">
      <div class="card-head"><h3>Sleep</h3><span class="muted small">${sleepLogged.length ? 'avg ' + fmtSleep(sleepLogged.reduce((a, b) => a + b, 0) / sleepLogged.length * 60) : ''}</span></div>
      ${barChart({ values: sleepVals, labels, dates, goal: sleepGoal() / 60, color: 'var(--lav)', fmtY: x => x + 'h' })}
    </section>

    <section class="card">
      <div class="card-head"><h3>🌙 Sleep schedule</h3><span class="muted small">${(() => { const b = days.filter(d => d.bed); return b.length ? `${b.filter(nearPlan).length}/${b.length} near plan` : ''; })()}</span></div>
      ${sleepChart({ nights: days.map(d => d.bed && d.wake ? { bed: toMin(d.bed), wake: toMin(d.wake) < toMin(d.bed) ? toMin(d.wake) + 1440 : toMin(d.wake), goal: toMin(bedGoal(addDays(d.id, -1))) } : null), labels, goal: toMin(bedGoal(addDays(dateStr(), -1))), fmtT: v => fmtTime(fromMin(v)).replace(':00', '') })}
      <p class="muted tiny center">Each bar runs from bedtime (top) to wake-up. The green band is within 30 min of your bedtime goal.</p>
    </section>

    <section class="card">
      <div class="card-head"><h3>Recovery</h3><span class="muted small">${recov.length ? 'avg ' + Math.round(recov.reduce((a, b) => a + b, 0) / recov.length) + '%' : ''}</span></div>
      ${barChart({ values: dv('recovery').map(x => x || 0), labels, dates, colorFn: x => x >= 67 ? 'var(--good)' : x >= 34 ? 'var(--mid)' : 'var(--bad)', fmtY: x => x + '%' })}
    </section>

    <section class="card">
      <div class="card-head"><h3>Strain</h3></div>
      ${barChart({ values: dv('strain').map(x => x || 0), labels, dates, color: 'var(--c)', fmtY: x => Math.round(x * 10) / 10 })}
    </section>


    ${top.length ? `<section class="card"><h3>Most-logged foods</h3>${top.map(([name, c]) => `<div class="kv-row"><span>${esc(name)}</span><span class="muted">${c.n}×</span></div>`).join('')}</section>` : ''}

    ${recoveryCard()}
    ${feelTrends(dates)}
    ${gutTrends(dates)}
    ${cycleTrends()}
    <button class="btn soft full" data-act="shareImg">📸 Save a summary to Photos</button>
  </div>`;
}

// Weight with a 7-day average line, since single weigh-ins swing with water and salt.
const weighIns = () => db.list('days').filter(d => d.weight != null).sort((a, b) => a.id.localeCompare(b.id));
function weekAvg(all, date) {
  const w = all.filter(x => x.id <= date && x.id > addDays(date, -7)).map(x => x.weight);
  return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
}
function weightCard(dates, labels) {
  const all = weighIns(), inRange = all.filter(d => d.id >= dates[0]);
  const head = `<div class="card-head"><h3>⚖️ Body weight</h3><button class="pill-btn sm" data-act="logWeight">＋ Log weight</button></div>`;
  if (!all.length) return `<section class="card">${head}<p class="muted small">Weigh in a few mornings a week. Pulse shows a 7-day average, so daily swings don't matter.</p></section>`;
  const last = all[all.length - 1];
  const raw = dates.map(d => db.get('days', d)?.weight ?? null);
  const avg = dates.map(d => all.some(x => x.id <= d && x.id > addDays(d, -7)) ? weekAvg(all, d) : null);
  const change = inRange.length >= 2 ? weekAvg(all, last.id) - weekAvg(all, inRange[0].id) : null;
  const r1 = x => Math.round(x * 10) / 10;
  return `<section class="card">${head}
    <div class="big-stats"><div><b>${r1(last.weight)}</b><span>latest · ${fmtDay(last.id)}</span></div><div><b>${r1(weekAvg(all, last.id))}</b><span>7-day avg</span></div>
      <div><b>${change == null ? '–' : (change > 0 ? '+' : '') + r1(change)}</b><span>change this range</span></div></div>
    ${inRange.length >= 2 ? lineChart({ series: [{ values: raw, color: 'var(--lav-2)' }, { values: avg, color: 'var(--purple-3)' }], labels, fmtY: x => Math.round(x) })
      + `<div class="legend"><span><i class="dot" style="background:var(--lav-2)"></i>Weigh-ins</span><span><i class="dot" style="background:var(--purple-3)"></i>7-day average</span></div>` : ''}
    <p class="muted tiny">Daily swings are normal. Watch the average line.</p>
  </section>`;
}
function openWeight(date = dateStr()) {
  const last = weighIns().pop();
  const s = openSheet({
    title: 'Log weight',
    body: `<div class="amt-input"><input id="wv" type="text" inputmode="decimal" value="${db.get('days', date)?.weight ?? ''}" placeholder="${last ? last.weight : 'lb'}" aria-label="Weight in pounds"><span class="muted">lb</span></div>
      <div class="field"><label>Date</label><input type="date" id="wd" value="${date}"></div>
      ${last ? `<p class="muted small center">Last: ${last.weight} lb · ${fmtDay(last.id)}</p>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  s.on('click', '[data-x="save"]', () => {
    const w = optNum(s.$('#wv').value), d = s.$('#wd').value || date;
    if (!(w > 0)) return toast('Type your weight');
    db.put('days', { ...(db.get('days', d) || { id: d, date: d }), weight: w });
    s.close(); toast('Saved');
  });
  s.$('#wv').focus();
}

function gutTrends(dates) {
  const all = db.list('stomach');
  const inRange = all.filter(e => e.date >= dates[0]);
  const a = analyzeGut(db.list('entries'), all, entryTags, { windowH: ui.gutWindow });
  const pct = x => Math.round(x * 100) + '%';
  const sym = new Map();
  inRange.forEach(e => (e.symptoms || []).forEach(s => sym.set(s, (sym.get(s) || 0) + 1)));
  return `<section class="card gut-trends">
    <div class="card-head"><h3>🔍 Digestion patterns</h3></div>
    <div class="big-stats"><div><b>${inRange.length}</b><span>episodes this range</span></div><div><b>${inRange.length ? (inRange.reduce((s, e) => s + e.severity, 0) / inRange.length).toFixed(1) : '–'}</b><span>avg severity /5</span></div><div><b>${new Set(inRange.map(e => e.date)).size}</b><span>days affected</span></div></div>
    ${sym.size ? `<p class="small">Most common: ${[...sym.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(s => `<b>${esc(s[0])}</b> (${s[1]})`).join(', ')}</p>` : ''}
    ${gutTiming(all)}
    ${periodShare(all, 'stomach logs') ? `<div class="facts">${periodShare(all, 'stomach logs')}</div>` : ''}
    ${a.episodes < 3 ? `<p class="muted small">After 3 stomach logs, this points out possible trigger foods.</p>` : `
      <div class="win">Look at food eaten within
        ${[4, 12, 24].map(w => `<button class="chip sm ${ui.gutWindow === w ? 'on' : ''}" data-act="gutWin" data-w="${w}">${w}h</button>`).join('')} before it hurt</div>
      <p class="muted small">Normally, ${pct(a.base)} of what you eat is followed by stomach trouble within ${ui.gutWindow}h.</p>
      ${a.foods.length ? `<h4>Possible triggers</h4>${a.foods.map(f => `<div class="suspect"><div><b>${esc(f.name)}</b><div class="muted tiny">Eaten ${f.eaten}× · trouble after ${f.hit} of them</div></div><span class="badge">${pct(f.rate)}</span></div>`).join('')}`
        : `<p class="small">No clear trigger foods yet. Keep logging 👍</p>`}
      ${a.tags.length ? `<h4>Possible trigger types</h4><div class="chips">${a.tags.map(t => `<span class="chip sm warnchip">${esc(t.name)} · ${pct(t.rate)}</span>`).join('')}</div>` : ''}
      ${a.safe.length ? `<h4>Seem safe for you</h4><div class="chips">${a.safe.map(s => `<span class="chip sm safechip">${esc(s.name)}</span>`).join('')}</div>` : ''}
      ${gutDays()}
      <p class="muted tiny">These are patterns, not a diagnosis. Food types are guessed from names unless you tag the food yourself. Talk to a dietitian or doctor about anything persistent.</p>`}
    <div class="btn-row"><button class="btn soft grow" data-act="gutHistory">All stomach logs</button><button class="btn soft grow" data-act="report">📄 Share report</button></div>
  </section>`;
}

// When episodes happen: time of day, how long after eating, what else was going on.
function gutTiming(all) {
  if (all.length < 3) return '';
  const parts = [['Morning', 5, 12], ['Afternoon', 12, 17], ['Evening', 17, 22], ['Night', 22, 29]];
  const part = h => parts.find(p => (h < 5 ? h + 24 : h) >= p[1] && (h < 5 ? h + 24 : h) < p[2])[0];
  const pc = new Map();
  all.forEach(e => { const k = part(+e.time.slice(0, 2)); pc.set(k, (pc.get(k) || 0) + 1); });
  const [topPart, topN] = [...pc.entries()].sort((x, y) => y[1] - x[1])[0];
  const ents = db.list('entries').map(x => toTs(x.date, x.time)).sort((a, b) => b - a);
  const gaps = all.map(e => { const t = toTs(e.date, e.time), last = ents.find(x => x <= t); return last && t - last <= 12 * 3600e3 ? (t - last) / 3600e3 : null; }).filter(x => x != null);
  const ctx = new Map();
  all.forEach(e => (e.context || []).forEach(c => ctx.set(c, (ctx.get(c) || 0) + 1)));
  const topCtx = [...ctx.entries()].filter(c => c[1] >= 2).sort((x, y) => y[1] - x[1]).slice(0, 4);
  return `<div class="facts">
    <div class="fact"><span>🕒</span><div>Most often in the <b>${topPart.toLowerCase()}</b> <span class="muted">(${topN} of ${all.length})</span></div></div>
    ${gaps.length >= 3 ? `<div class="fact"><span>⏱️</span><div>Usually starts about <b>${hrsMin(median(gaps))}</b> after eating</div></div>` : ''}
    ${topCtx.length ? `<div class="fact"><span>📝</span><div>Often logged with ${topCtx.map(c => `<b>${esc(c[0].toLowerCase())}</b> (${c[1]})`).join(', ')}</div></div>` : ''}
  </div>`;
}

function gutDays() {
  const bad = new Set(db.list('stomach').map(e => e.date));
  const m = DAY_METRICS;
  const diffs = compareDays(dayRows(), r => bad.has(r.date), [m.f, m.fiber, m.cal, m.water, m.sleep, m.lastMeal, m.recovery]).slice(0, 4);
  return diffs.length ? `<h4>On days with stomach trouble</h4>${diffRows(diffs)}` : '';
}

function feelTrends(dates) {
  const all = db.list('feel');
  const inRange = all.filter(e => e.date >= dates[0]);
  if (!all.length) return `<section class="card"><div class="card-head"><h3>😵‍💫 Feeling off</h3></div>
    <p class="muted small">Feeling off? Log it on Today. After a few, this shows what's different on those days.</p></section>`;
  const fc = new Map();
  inRange.forEach(e => (e.feelings || []).forEach(f => fc.set(f, (fc.get(f) || 0) + 1)));
  const offDates = new Set(all.map(e => e.date));
  const m = DAY_METRICS;
  const diffs = compareDays(dayRows(), r => offDates.has(r.date), [m.sleep, m.recovery, m.cal, m.c, m.p, m.water, m.strainPrev]).slice(0, 5);
  const foods = analyzeGut(db.list('entries'), all, entryTags, { windowH: 6 });
  // Skip staples eaten most days; they'd show up before almost anything.
  const loggedDays = new Set(db.list('entries').map(e => e.date)).size;
  const daysWith = key => new Set(db.list('entries').filter(e => e.kind + ':' + e.refId === key).map(e => e.date)).size;
  foods.foods = foods.foods.filter(f => f.lift >= 1.5 && daysWith(f.key) < loggedDays * 0.6);
  return `<section class="card gut-trends">
    <div class="card-head"><h3>😵‍💫 Feeling off</h3></div>
    <div class="big-stats"><div><b>${inRange.length}</b><span>check-ins this range</span></div><div><b>${new Set(inRange.map(e => e.date)).size}</b><span>days affected</span></div></div>
    ${fc.size ? `<div class="chips">${[...fc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(f => `<span class="chip sm">${feelEmoji(f[0])} ${esc(f[0])} · ${f[1]}</span>`).join('')}</div>` : ''}
    ${periodShare(all, 'check-ins') ? `<div class="facts">${periodShare(all, 'check-ins')}</div>` : ''}
    ${offDates.size < 3 ? `<p class="muted small mt">Log at least 3 off days (and keep logging food and sleep) to see what's different about them.</p>`
      : diffs.length ? `<h4>What's different on off days</h4>${diffRows(diffs)}`
      : `<p class="small mt">No clear difference in sleep, food or recovery on off days yet.</p>`}
    ${foods.episodes >= 3 && foods.foods.length ? `<h4>Often eaten in the 6h before</h4><div class="chips">${foods.foods.slice(0, 4).map(f => `<span class="chip sm warnchip">${esc(f.name)}</span>`).join('')}</div>` : ''}
    <p class="muted tiny">Patterns, not a diagnosis. If it's frequent or severe, bring this to your athletic trainer or doctor.</p>
    <button class="btn soft full" data-act="feelHistory">All check-ins</button>
  </section>`;
}

// ===== ME =====
const switchRow = (k, label, sub, def = false) => `<button class="switch-row" data-act="toggle" data-k="${k}"${def ? ' data-def="1"' : ''}><span class="grow">${label}<div class="muted tiny">${sub}</div></span><span class="switch ${profile()?.[k] ?? def ? 'on' : ''}"><i></i></span></button>`;
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
      <div class="muted small">${cloud ? esc(cloud.email) : '🔒 Private. Stays on this phone.'}</div></div>
    </section>
    <button class="btn soft full" data-act="tour">🧭 Show me around</button>
    ${DEMO ? '<button class="btn soft full mt" data-act="winPreview">🏆 Preview the win screen</button>' : ''}

    <section class="card">
      <h3>Your setup</h3>
      ${OWNER?.glutenFree ? '' : switchRow('glutenFree', '🌾 I eat gluten-free', 'Flags foods and recipes that contain or may contain gluten.')}
      ${switchRow('showWeight', '⚖️ Show body weight', 'Off by default. Adds a weight card to Today.')}
      ${switchRow('showPeriod', '🌸 Period tracking', 'A small row at the bottom of Today. It never shows up on summary images.', true)}
      <div class="kv-row"><span>🌙 Sleep goal<div class="muted tiny">Bedtime each night works back from this</div></span><select class="time-in" data-change="sleepGoal" aria-label="Sleep goal">${[420, 450, 480, 510, 540, 570, 600].map(m => `<option value="${m}" ${m === sleepGoal() ? 'selected' : ''}>${fmtSleep(m)}</option>`).join('')}</select></div>
      <button class="btn soft full mt" data-act="wakeTimes">⏰ Usual wake-up times</button>
      <button class="btn soft full mt" data-act="editMeds">💊 Edit meds & vitamins</button>
    </section>

    ${notifyCard()}

    <section class="card">
      <h3>Daily goals</h3>
      <div class="grid2">${gi('cal', 'Calories', 'cal')}${gi('p', 'Protein', 'g')}${gi('water', 'Water', 'oz')}${OPTIONAL_MACROS.filter(([k]) => tracks(k)).map(([k, l]) => gi(k, l, 'g')).join('')}</div>
      <div class="chip-row">${OPTIONAL_MACROS.map(([k, l]) => `<button class="chip ${tracks(k) ? 'on' : ''}" data-act="trackTog" data-k="${k}">${tracks(k) ? '✓ ' : '＋ '}${l}</button>`).join('')}</div>
      <p class="muted tiny">${p.goalsGuess ? "These are Pulse's starting point. Swap in your dietitian's numbers when you have them." :'Use targets from your dietitian or coach. Changes save automatically.'}</p>
      ${tracks('c') || tracks('f') ? `<button class="btn soft full" data-act="calcMacros">Fill fat & carbs from my calories + protein</button>` : ''}
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
        <button class="btn soft" data-act="shareImg">📸 Save a summary to Photos</button>
      </div>
      <p class="muted tiny">${plural(db.list('foods').length, 'food')} · ${plural(db.list('recipes').length, 'recipe')} · ${plural(new Set(db.list('entries').map(e => e.date)).size, 'day')} logged</p>
    </section>


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
  feel: () => openFeel({ date: ui.date }),
  editFeel: d => openFeel({ log: db.get('feel', d.id) }),
  feelHistory: () => openFeelHistory(),
  report: () => exportReport(),
  calendar: () => openCalendar(),
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
  shareImg: () => openShareImage(),
  activity: d => toggleActivity(d.k),
  sleepPlan: d => openSleepPlan(d.d),
  wakeTimes: () => openWakeTimes(),
  gfSet: d => { saveProfile({ glutenFree: d.v === '1' }); if (d.v === '1') toast('Gluten warnings on'); },
  med: d => toggleMed(d.id),
  editMeds: () => openMeds(),
  journalTalk: () => openJournal(ui.date, true),
  journal: () => openJournal(),
  healthSync: () => healthSync(),
  healthPaste: () => healthPaste(),
  healthGuide: () => openHealthGuide(),
  toggle: d => saveProfile({ [d.k]: !(profile()?.[d.k] ?? d.def === '1') }),
  trackTog: d => saveProfile({ track: { ...(profile()?.track || {}), [d.k]: !tracks(d.k) } }),
  period: d => setPeriod(d.f),
  periodFeel: d => togglePeriodFeel(d.k),
  winPreview: () => winScreen(GAMES.find(g => g.result?.startsWith('W')) || { ...GAMES[0], result: 'W 72-65' }),
  winDone: d => { try { localStorage.setItem('pulseWinSeen', JSON.stringify([...winSeen(), d.d])); } catch {} queueRender(); },
  notifyOn: () => turnOnNotify(),
  eatPrep: d => eatPrep(d.id),
  editPrep: d => openPrep({ prep: db.get('preps', d.id) }),
  logWeight: () => openWeight(),
  ask: d => openAsk(d.q || ''),
  tour: () => startTour(),
  weekDone: d => saveProfile({ ['weekSeen-' + d.d]: true }),
  getIdeas: () => getIdeas(),
  gameTip: () => { ui.gameTip = !ui.gameTip; buzz(); queueRender(); },
  wrapped: d => openWrapped(d.from || addDays(dateStr(), -7), d.to || addDays(dateStr(), -1)),
  jump: d => { const el = $('.card.' + d.to); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } },
};
const inputs = {
  foodQ: el => { ui.foodQ = el.value; $('#foodList').innerHTML = foodListHTML(); },
  recipeQ: el => { ui.recipeQ = el.value; $('#recipeList').innerHTML = recipeListHTML(); },
};
const changes = {
  pickDate: el => { if (el.value) { ui.date = el.value; render(); } },
  goal: el => { const g = goals(); g[el.dataset.k] = num(el.value); saveProfile({ goals: g, goalsGuess: false }); },
  name: el => saveProfile({ name: el.value.trim() }),
  sleepGoal: el => saveProfile({ sleepGoal: +el.value }),
  medsAm: el => saveProfile({ medsAm: el.value }),
  medsPm: el => saveProfile({ medsPm: el.value }),
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
// Fills in her name, number and gluten-free setting without asking.
function applyOwner() {
  const p = profile();
  if (!OWNER || !p) return;
  const patch = {};
  if (!p.name) patch.name = OWNER.name;
  if (!p.number) patch.number = OWNER.number;
  if (OWNER.glutenFree && !p.glutenFree) patch.glutenFree = true;
  if (Object.keys(patch).length) saveProfile(patch);
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
  if (e.prepId) Object.assign(item, { per: e.per, servingG: db.get('preps', e.prepId)?.gramsEach || 0, servingLabel: 'container' });
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
        ${mode === 'log' ? `<label class="tool"><span>🍽️</span>Snap meal<input type="file" accept="image/*" capture="environment" hidden data-x="snapIn"></label><button class="tool" data-x="quick"><span>⚡</span>Quick add</button>` : ''}
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
    const preps = mode === 'log' && !q && tab === 'recent' ? activePreps() : [];
    s.$('#plist').innerHTML = (preps.length ? `<h4 class="sec">🥡 From your meal prep</h4>${preps.map(p => `<button class="row" data-x="prep" data-id="${p.id}">
        ${thumb(p.photo, '🥡')}<div class="row-main"><div class="row-name">${esc(p.name)}</div><div class="row-sub">1 container · ${fmt(prepMacros(p).cal)} cal · ${fmt(p.left)} left</div></div><span class="row-plus">＋</span></button>`).join('')}<h4 class="sec">Recent</h4>` : '')
      + (rows.length ? rows.map(([k, o, sub]) => `<button class="row" data-x="pick" data-k="${k}" data-id="${o.id}">
        ${thumb(o.photo, k === 'recipe' ? '🍲' : '🥣')}<div class="row-main"><div class="row-name">${esc(o.name)}${o.fav ? ' <span class="star">★</span>' : ''}${gfBadge(k, o)}</div><div class="row-sub">${sub}</div></div><span class="row-plus">＋</span></button>`).join('')
      : `<div class="empty small"><p>${q ? `Nothing saved called “${esc(q)}”.` : tab === 'recipes' ? 'No recipes yet.' : 'No saved foods yet.'}</p>
         <button class="btn primary" data-x="new">📷 Add it from the label</button>${q ? `<button class="btn soft" data-x="online">🔎 Search online for “${esc(q)}”</button>` : ''}</div>`);
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
  s.on('click', '[data-x="prep"]', el => {
    const p = db.get('preps', el.dataset.id);
    openAmount({ item: prepItem(p), prep: p, meal, date, onAdded: e => {
      added++; addedCal += e.macros.cal;
      s.$('#addedTxt').innerHTML = `<b>✓ ${added} added</b> · ${fmt(addedCal)} cal`;
      draw();
    } });
  });
  s.on('click', '[data-x="pick"]', el => picked(el.dataset.k, db.get(el.dataset.k === 'food' ? 'foods' : 'recipes', el.dataset.id)));
  s.on('click', '[data-x="new"]', () => openFoodForm({ prefill: q ? { name: q } : {}, onSaved: f => picked('food', f) }));
  s.on('click', '[data-x="scan"]', () => scanFlow({ onFood: f => picked('food', f) }));
  s.on('click', '[data-x="online"]', () => openOnline({ q, onSaved: f => picked('food', f) }));
  s.on('click', '[data-x="quick"]', () => openQuick({ meal, date }));
  s.on('change', '[data-x="snapIn"]', el => { const f = el.files[0]; el.value = ''; if (f) snapMeal(f, { meal, date, onAdded: cal => { added++; addedCal += cal; s.$('#addedTxt').innerHTML = `<b>✓ ${added} added</b> · ${fmt(addedCal)} cal`; } }); });
  draw();
}

// ---------- amount sheet ----------
function openAmount({ item, entry = null, prep = null, meal, date, onAdded }) {
  let unit = 'g', curMeal = meal;
  if (!prep && entry?.prepId) prep = db.get('preps', entry.prepId);
  const startG = entry ? entry.grams : prep ? prep.gramsEach : (lastGrams(item.kind, item.id) ?? (item.servingG || 100));
  const quick = [];
  const lg = prep ? null : lastGrams(item.kind, item.id);
  if (prep) quick.push([prep.gramsEach, `1 container · ${fmt(prep.gramsEach)} g`], [prep.gramsEach / 2, '½ container']);
  if (lg) quick.push([lg, `Last time · ${fmt(lg)} g`]);
  if (item.servingG && !prep) {
    const sl = item.kind === 'food' && item.servingLabel ? item.servingLabel : 'serving';
    quick.push([item.servingG, `${/^\d/.test(sl) ? '' : '1 '}${esc(sl)} · ${fmt(item.servingG)} g`]);
  }
  quick.push([100, '100 g']);
  const sus = entry ? null : gutSuspects().get(item.kind + ':' + item.id);
  const s = openSheet({
    title: entry ? 'Edit entry' : 'How much?',
    body: `<div class="amt-food">${thumb(item.photo, item.kind === 'recipe' ? '🍲' : '🥣')}<div><div class="amt-name">${esc(item.name)}</div><div class="muted small">${esc(item.brand || '')}</div></div></div>
      ${gfWarning(item.kind, item.kind === 'food' ? getFood(item.id) : db.get('recipes', item.id))}
      ${sus ? `<p class="tip">⚠️ Heads up: stomach trouble followed this ${sus.hit} of the ${sus.eaten} times you had it.</p>` : ''}
      <div class="amt-input"><input id="amt" type="text" inputmode="decimal" value="${fmtIn(startG)}" autocomplete="off" aria-label="Amount">
        <div class="seg unit">${`<button data-x="unit" data-u="g" class="on">grams</button>`}${item.servingG ? `<button data-x="unit" data-u="s">${prep ? 'containers' : 'servings'}</button>` : ''}</div></div>
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
  // Eating from a meal-prep batch takes containers out of the fridge (and puts them back if removed).
  const usedOf = g => prep && prep.gramsEach ? g / prep.gramsEach : 0;
  s.on('click', '[data-x="del"]', () => {
    db.remove('entries', entry.id);
    if (entry.prepId) adjustPrep(entry.prepId, usedOf(entry.grams));
    s.close(); toast('Removed');
  });
  s.on('click', '[data-x="save"]', () => {
    const g = grams();
    if (!(g > 0)) { inp.focus(); return toast('Type how many grams'); }
    const e = entry ? { ...entry } : { id: uid(), date, kind: item.kind, refId: item.id };
    Object.assign(e, { name: item.name, brand: item.kind === 'food' ? item.brand : '', grams: g, per: item.per,
      macros: scale(item.per, g), meal: curMeal, time: s.$('#etime').value || timeStr() });
    if (prep) { e.prepId = prep.id; adjustPrep(prep.id, -(usedOf(g) - (entry ? usedOf(entry.grams) : 0))); }
    db.put('entries', e);
    s.close();
    const left = prep ? db.get('preps', prep.id)?.left : null;
    toast(entry ? 'Saved' : `Added · ${fmt(e.macros.cal)} cal${left != null ? ` · ${fmt(left)} left` : ''}`);
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
    body: `<p class="muted small">For when you already know the numbers, like eating out.</p>
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

// ---------- meal photo ----------
// AI looks at a photo and guesses each food and portion. It's a rough guess
// (portions are hard to judge from a picture), so she reviews every number first.
const GLUTEN_TXT = { likely: '⚠️ Usually has gluten', check: '❓ Check for gluten', safe: '' };
async function snapMeal(file, { meal, date, onAdded }) {
  let photo;
  try { photo = await fileToDataURL(file, 768, 0.7); } catch (e) { return toast(e.message); }
  let items = [], conf = 'low', note = '', curMeal = meal;
  const s = openSheet({
    title: '🍽️ Snap meal', full: true,
    body: `<img class="snap-img" src="${photo}" alt="">
      <div class="snap-warn"><b>📏 Rough estimate</b> AI guesses portions from a photo and can be off by a lot, sometimes 30% or more. Fix any amount that looks wrong before adding.</div>
      <div id="snapOut"><div class="snap-wait"><span class="spin"></span> Looking at your plate…</div></div>`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="add" disabled>Add</button>`,
  });
  const total = () => items.reduce((a, x) => a + (x.on ? x.cal : 0), 0);
  const draw = () => {
    if (!items.length) return;
    s.$('#snapOut').innerHTML = `${conf === 'low' || note ? `<p class="muted small">${conf === 'low' ? 'Hard to tell from this photo. ' : ''}${esc(note)}</p>` : ''}
      ${items.map((x, i) => `<div class="snap-item ${x.on ? '' : 'off'}">
        <div class="snap-top"><button class="snap-tick" data-x="tick" data-i="${i}" aria-label="Include">${x.on ? '✓' : ''}</button>
          <input class="snap-name" data-i="${i}" data-f="name" value="${esc(x.name)}"><span class="muted tiny">${esc(x.portion)}</span></div>
        ${gfOn() && GLUTEN_TXT[x.gluten] ? `<div class="snap-gf ${x.gluten}">${GLUTEN_TXT[x.gluten]}</div>` : ''}
        <div class="snap-macros">${[['cal', 'cal'], ['p', 'protein'], ['c', 'carbs'], ['f', 'fat']].map(([k, l]) => `<label><input inputmode="decimal" data-i="${i}" data-f="${k}" value="${x[k]}"><span>${l}</span></label>`).join('')}</div>
        <div class="snap-size">${[[0.5, '½×'], [0.75, '¾×'], [1.25, '1¼×'], [1.5, '1½×']].map(([m, l]) => `<button class="chip sm" data-x="scale" data-i="${i}" data-m="${m}">${l}</button>`).join('')}<span class="muted tiny">portion</span></div>
      </div>`).join('')}
      <div class="field"><label>Meal</label><div class="chips">${MEALS.map(x => `<button class="chip ${x.id === curMeal ? 'on' : ''}" data-x="meal" data-m="${x.id}">${x.icon} ${x.name}</button>`).join('')}</div></div>`;
    const b = s.$('[data-x="add"]'); b.disabled = !total(); b.textContent = `Add · ~${fmt(total())} cal`;
  };
  const fail = msg => { s.$('#snapOut').innerHTML = `<p class="muted center">${msg}</p><button class="btn soft full" data-x="quickInstead">⚡ Type it in instead</button>`; };
  s.on('click', '[data-x="quickInstead"]', () => { s.close(); openQuick({ meal: curMeal, date }); });
  s.on('click', '[data-x="tick"]', el => { const x = items[el.dataset.i]; x.on = !x.on; draw(); });
  s.on('click', '[data-x="meal"]', el => { curMeal = el.dataset.m; draw(); });
  s.on('click', '[data-x="scale"]', el => { const x = items[el.dataset.i], m = +el.dataset.m; ['cal', 'p', 'c', 'f', 'fiber'].forEach(k => { x[k] = Math.round(x[k] * m); }); x.portion = `${el.textContent} of ${x.portion || 'the guess'}`; draw(); });
  s.on('input', '[data-f]', el => { const x = items[el.dataset.i], f = el.dataset.f; x[f] = f === 'name' ? el.value : num(el.value);
    const b = s.$('[data-x="add"]'); b.disabled = !total(); b.textContent = `Add · ~${fmt(total())} cal`; });
  s.on('click', '[data-x="add"]', () => {
    const on = items.filter(x => x.on && x.cal);
    on.forEach(x => db.put('entries', { id: uid(), date, kind: 'quick', est: true, time: defaultTime(date, curMeal), name: x.name.trim() || 'Food', grams: null, meal: curMeal,
      macros: { cal: x.cal, p: x.p, c: x.c, f: x.f, fiber: x.fiber || 0, sugar: 0, sodium: 0 } }));
    s.close(); toast(`Added ${plural(on.length, 'item')} · ~${fmt(total())} cal`); onAdded?.(total());
  });
  try {
    const r = await fetch(CONFIG_PUSH() + '/photo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: photo }) });
    const j = await r.json();
    if (!s.$('#snapOut')) return;
    if (!r.ok || !j.items?.length) return fail(j.error === 'unclear' ? "Couldn't tell what's on the plate. Try a closer, brighter photo from above." : 'Pulse is busy right now. Try again in a minute.');
    items = j.items.map(x => ({ ...x, on: true })); conf = j.confidence; note = j.note; draw();
  } catch { if (s.$('#snapOut')) fail("Can't reach Pulse. Check your connection."); }
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
      ${gfOn() ? `<h4 class="sec">🌾 Gluten <span class="muted">— check the allergen line on the label</span></h4>${gfPicker(f.gf)}` : ''}
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
  let gfSel = f.gf || '';
  s.on('click', '[data-x="gf"]', el => { gfSel = el.dataset.v; s.$$('[data-x="gf"]').forEach(b => b.className = b === el ? 'on ' + GF[gfSel].cls : ''); });
  // New foods get tags guessed from the name until she taps a tag herself.
  let tagsTouched = !!food;
  function autoTags() {
    if (tagsTouched) return;
    tags = new Set(guessTags(s.$('#ff-name').value + ' ' + s.$('#ff-brand').value));
    s.$$('[data-x="tag"]').forEach(b => b.classList.toggle('on', tags.has(b.dataset.t)));
  }
  s.on('input', '#ff-name, #ff-brand', autoTags);
  autoTags();
  s.on('click', '[data-x="tag"]', el => { tagsTouched = true; const t = el.dataset.t; tags.has(t) ? tags.delete(t) : tags.add(t); el.classList.toggle('on'); });
  s.on('click', '[data-x="del"]', async () => {
    if (!(await confirmSheet(`Delete “${esc(f.name)}”? Past log entries stay.`))) return;
    db.remove('foods', f.id); closeAllSheets(); toast('Food deleted');
  });
  s.on('click', '[data-x="save"]', () => {
    s.$$('[data-t]').forEach(i => { f[i.dataset.t] = i.value.trim(); });
    s.$$('[data-k]').forEach(i => { f[i.dataset.k] = optNum(i.value) ?? ''; });
    f.tags = [...tags];
    f.gf = gfSel;
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
      ${gfOn() ? gfPicker(f.gf) : ''}
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
  s.on('click', '[data-x="gf"]', el => {
    const v = el.dataset.v;
    db.put('foods', { ...getFood(id), gf: v });
    s.$$('[data-x="gf"]').forEach(b => b.className = b === el ? 'on ' + GF[v].cls : '');
    toast(GF[v].t);
  });
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
        <div class="row-main"><div class="row-name">${esc(r.name)}${gfBadge(r.ingredients ? 'recipe' : 'food', r)}</div><div class="row-sub">${esc(r.brand)}${r.brand ? ' · ' : ''}${fmt(num(r.cal))} cal / ${fmt(num(r.servingG))} g</div></div><span class="row-plus">＋</span></button>`).join('')
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
      ${gfOn() ? `<div class="center">${gfBadge('recipe', r) || '<span class="gf gf-unk">Gluten not checked</span>'}</div>` : ''}
      <div class="totals">
        ${info.servings ? `<div class="tot-row"><span>Per serving</span><b>${fmt(info.total.cal / info.servings)} cal</b><span>${macroLine(scale(info.total, 1 / info.servings))}</span></div>` : ''}
        <div class="tot-row"><span>Per 100 g</span><b>${fmt(info.per.cal * 100)} cal</b><span>${macroLine(scale(info.per, 100))}</span></div>
        <div class="tot-row"><span>Whole recipe</span><b>${fmt(info.total.cal)} cal</b><span>${macroLine(info.total)}</span></div>
      </div>
      <h4 class="sec">Ingredients</h4>
      ${info.ings.map(i => `<div class="kv-row"><span>${esc(i.name)}</span><span class="muted">${fmt(num(i.grams))} g · ${fmt(i.macros.cal)} cal</span></div>`).join('')}
      ${r.steps ? `<h4 class="sec">Instructions</h4><p class="pre">${esc(r.steps)}</p>` : ''}
      ${r.notes ? `<h4 class="sec">Notes</h4><p class="pre">${esc(r.notes)}</p>` : ''}
      <button class="btn soft full mt" data-x="prep">🥡 I meal-prepped this</button>
      <button class="btn ghost full" data-x="dup">Duplicate (make a variation)</button>`,
    footer: `<button class="btn ghost" data-x="edit">Edit</button><button class="btn primary grow" data-x="log">Log it</button>`,
  });
  s.on('click', '[data-x="edit"]', () => { s.close(); openRecipeForm({ recipe: db.get('recipes', id) }); });
  s.on('click', '[data-x="prep"]', () => {
    if (!info.ings.length) return toast('Add ingredients to the recipe first');
    s.close(); openPrep({ recipe: db.get('recipes', id) });
  });
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
    body: `<h4 class="sec">🌙 Sleep (last night)</h4>
      <div class="grid2">
        <div class="field"><label>Went to bed</label><input type="time" id="sb" value="${d.bed || ''}"></div>
        <div class="field"><label>Woke up</label><input type="time" id="sw" value="${d.wake || ''}"></div>
        <div class="field"><label>Hours</label><div class="unit-in"><input id="sh" inputmode="numeric" value="${d.sleepMin != null ? Math.floor(d.sleepMin / 60) : ''}" placeholder="7"><span>h</span></div></div>
        <div class="field"><label>Minutes</label><div class="unit-in"><input id="sm" inputmode="numeric" value="${d.sleepMin != null ? Math.round(d.sleepMin % 60) : ''}" placeholder="45"><span>m</span></div></div>
        ${fld('sleepPerf', 'Sleep performance', '%')}
      </div>
      <p class="muted tiny">Leave hours blank and Pulse works them out from bed and wake time. If your Whoop shows actual time asleep, type that in instead.</p>
      <h4 class="sec">🔥 Calories burned</h4>
      <div class="cal3">${fld('active', 'Active', 'cal')}${fld('resting', 'Resting', 'cal')}${fld('burned', 'Total', 'cal')}</div>
      <p class="muted tiny" id="calHint">Fill in any two and Pulse does the math.</p>
      <h4 class="sec">⌚ Whoop / Apple Watch</h4>
      <div class="grid2">${fld('recovery', 'Recovery', '%')}${fld('strain', 'Strain', '/21')}${fld('rhr', 'Resting HR', 'bpm')}${fld('hrv', 'HRV', 'ms')}${fld('steps', 'Steps', '')}</div>
      <h4 class="sec">🔋 How do you feel?</h4>
      <div class="chips energy">${[1, 2, 3, 4, 5].map(v => `<button class="chip ${energy === v ? 'on' : ''}" data-x="en" data-v="${v}">${['😴', '😕', '🙂', '😃', '🔥'][v - 1]} ${v}</button>`).join('')}</div>`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  s.on('click', '[data-x="en"]', el => { const v = +el.dataset.v; energy = energy === v ? 0 : v; s.$$('[data-x="en"]').forEach(b => b.classList.toggle('on', +b.dataset.v === energy)); });
  // Active + resting = total: whichever two she types, the third fills itself.
  const cal = k => s.$(`[data-k="${k}"]`), CAL = ['active', 'resting', 'burned'];
  CAL.forEach(k => { if (d[k] != null) cal(k).dataset.typed = '1'; });
  if (CAL.every(k => d[k] != null) && d.active + d.resting === d.burned) cal('burned').dataset.typed = '';
  s.$$('.cal3 input').forEach(i => i.addEventListener('input', () => {
    i.dataset.typed = i.value.trim() ? '1' : '';
    i.classList.remove('auto');
    const typed = CAL.filter(k => cal(k).dataset.typed), left = CAL.find(k => !typed.includes(k));
    if (typed.length !== 2) { s.$$('.cal3 input.auto').forEach(x => { x.value = ''; x.classList.remove('auto'); }); return; }
    const [a, r, t] = CAL.map(k => optNum(cal(k).value));
    const v = left === 'burned' ? a + r : left === 'active' ? t - r : t - a;
    cal(left).value = v > 0 ? Math.round(v) : '';
    cal(left).classList.toggle('auto', v > 0);
  }));
  s.on('click', '[data-x="save"]', () => {
    s.$$('[data-k]').forEach(i => { d[i.dataset.k] = optNum(i.value); });
    const h = optNum(s.$('#sh').value), m = optNum(s.$('#sm').value);
    d.bed = s.$('#sb').value || null; d.wake = s.$('#sw').value || null;
    d.sleepMin = h == null && m == null ? (d.bed && d.wake ? (toMin(d.wake) - toMin(d.bed) + 1440) % 1440 : null) : (h || 0) * 60 + (m || 0);
    d.energy = energy || null;
    db.put('days', d);
    s.close();
    toast('Saved');
  });
}

// ---------- stomach ----------
function openGut({ ep = null, date = ui.date } = {}) {
  const e = ep ? { ...ep } : { id: uid(), date, time: date === dateStr() ? timeStr() : '12:00', severity: 3, symptoms: [], context: [], notes: '' };
  const sym = new Set(e.symptoms || []), ctx = new Set(e.context || []);
  const one = (k, list, id) => `<div class="chips">${list.map(x => `<button class="chip sm ${e[k] === x ? 'on' : ''}" data-x="${id}" data-v="${x}">${x}</button>`).join('')}</div>`;
  const s = openSheet({
    title: ep ? 'Edit stomach log' : 'Stomach log', full: true, lock: true,
    body: `<h4 class="sec">How bad?</h4>
      <div class="sev">${SEVERITY.map(x => `<button class="${e.severity === x.v ? 'on' : ''}" data-x="sev" data-v="${x.v}"><span>${x.e}</span>${x.t}</button>`).join('')}</div>
      <h4 class="sec">Symptoms</h4>
      <div class="chips">${SYMPTOMS.map(x => `<button class="chip sm ${sym.has(x) ? 'on' : ''}" data-x="sym" data-v="${x}">${x}</button>`).join('')}</div>
      <h4 class="sec">Where <span class="muted">(optional)</span></h4>${one('where', WHERE, 'where')}
      <h4 class="sec">How long <span class="muted">(optional)</span></h4>${one('duration', DURATION, 'dur')}
      <div class="grid2 mt"><div class="field"><label>Date</label><input type="date" id="gd" value="${e.date}"></div><div class="field"><label>Started at</label><input type="time" id="gt" value="${e.time}"></div></div>
      <h4 class="sec">Anything else going on? <span class="muted">(optional)</span></h4>
      <div class="chips">${CONTEXT.map(x => `<button class="chip sm ${ctx.has(x) ? 'on' : ''}" data-x="ctx" data-v="${x}">${x}</button>`).join('')}</div>
      <div class="field mt"><label>Notes</label><textarea id="gn" rows="3" placeholder="Possible cause, other notes">${esc(e.notes || '')}</textarea></div>
      <div id="recent"></div>
      ${ep ? `<button class="btn ghost danger-t full" data-x="del">Delete</button>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  function recent() {
    const t = toTs(s.$('#gd').value || e.date, s.$('#gt').value || e.time);
    const list = db.list('entries').map(x => ({ x, ts: toTs(x.date, x.time) })).filter(o => o.ts <= t && t - o.ts <= 12 * 3600e3).sort((a, b) => b.ts - a.ts);
    const sus = gutSuspects();
    const flagged = list.filter(o => sus.has(o.x.kind + ':' + o.x.refId));
    s.$('#recent').innerHTML = list.length ? `<h4 class="sec">You ate in the 12 hours before</h4>
      ${flagged.length ? `<p class="tip">⚠️ ${flagged.map(o => `<b>${esc(o.x.name)}</b>`).join(', ')} ${flagged.length === 1 ? 'has' : 'have'} come before stomach trouble before.</p>` : ''}
      ${list.map(o => `<div class="kv-row"><span>${sus.has(o.x.kind + ':' + o.x.refId) ? '⚠️ ' : ''}${esc(o.x.name)}${o.x.grams ? ` <span class="muted tiny">${fmt(o.x.grams)} g</span>` : ''}</span><span class="muted">${fmtTime(o.x.time)}${o.x.date !== (s.$('#gd').value || e.date) ? ' (prev day)' : ''}</span></div>`).join('')}`
      : `<p class="muted small mt">No food logged in the 12 hours before this. Logging meals is what lets Pulse find triggers.</p>`;
  }
  const pickOne = (id, k) => s.on('click', `[data-x="${id}"]`, el => {
    e[k] = e[k] === el.dataset.v ? '' : el.dataset.v;
    s.$$(`[data-x="${id}"]`).forEach(b => b.classList.toggle('on', b.dataset.v === e[k]));
  });
  pickOne('where', 'where');
  pickOne('dur', 'duration');
  s.on('click', '[data-x="sev"]', el => { e.severity = +el.dataset.v; s.$$('[data-x="sev"]').forEach(b => b.classList.toggle('on', b === el)); });
  s.on('click', '[data-x="sym"]', el => { const v = el.dataset.v; sym.has(v) ? sym.delete(v) : sym.add(v); el.classList.toggle('on'); });
  s.on('click', '[data-x="ctx"]', el => { const v = el.dataset.v; ctx.has(v) ? ctx.delete(v) : ctx.add(v); el.classList.toggle('on'); });
  s.on('change', '#gd, #gt', recent);
  s.on('click', '[data-x="del"]', async () => { if (await confirmSheet('Delete this stomach log?')) { db.remove('stomach', e.id); closeAllSheets(); } });
  s.on('click', '[data-x="save"]', () => {
    Object.assign(e, { date: s.$('#gd').value || e.date, time: s.$('#gt').value || e.time, symptoms: [...sym], context: [...ctx], notes: s.$('#gn').value.trim() });
    db.put('stomach', e);
    s.close();
    toast(ep ? 'Saved' : 'Logged');
  });
  recent();
}

function openGutHistory() {
  const all = db.list('stomach').sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const s = openSheet({
    title: 'Stomach logs', full: true,
    body: all.length ? all.map(e => { const sv = SEVERITY[e.severity - 1] || SEVERITY[2]; return `<button class="row" data-x="ep" data-id="${e.id}"><span class="thumb ph">${sv.e}</span>
      <div class="row-main"><div class="row-name">${fmtDay(e.date)} · ${fmtTime(e.time)}</div><div class="row-sub">${sv.t}${(e.symptoms || []).length ? ' · ' + esc(e.symptoms.join(', ')) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div><span class="chev">›</span></button>`; }).join('')
      : `<p class="muted center">No stomach logs yet.</p>`,
  });
  s.on('click', '[data-x="ep"]', el => { s.close(); openGut({ ep: db.get('stomach', el.dataset.id) }); });
}

// ---------- feeling off ----------
// Looks at what was logged up to a moment and lists things that commonly make
// people feel off, compared with her own usual numbers.
function offSignals(date, time) {
  const ts = toTs(date, time), out = [], H = 3600e3;
  const ents = db.list('entries').map(x => ({ x, ts: toTs(x.date, x.time) })).filter(o => o.ts <= ts).sort((a, b) => b.ts - a.ts);
  const hr = +time.slice(0, 2) + +time.slice(3, 5) / 60;
  const day = db.get('days', date) || {}, prev = db.get('days', addDays(date, -1)) || {};
  const past = Array.from({ length: 30 }, (_, i) => addDays(date, -i - 1));

  // Food so far vs. what she usually has eaten by this time of day.
  const soFar = sumMacros(ents.filter(o => o.x.date === date).map(o => o.x.macros));
  const usual = past.map(d => db.list('entries').filter(e => e.date === d)).filter(l => l.length)
    .map(l => sumMacros(l.filter(e => (e.time || '') <= time).map(e => e.macros)));
  const avgBy = k => usual.length ? usual.reduce((s, t) => s + t[k], 0) / usual.length : 0;
  const gap = ents.length ? (ts - ents[0].ts) / H : null;
  if (gap != null && gap >= 4 && gap < 30) out.push({ e: '⏰', t: `Last ate <b>${hrsMin(gap)} ago</b>`, d: 'Long gaps without food can cause dizziness, shakiness and fog, especially around training.' });
  else if (!soFar.cal && hr >= 10 && usual.length) out.push({ e: '🍽️', t: '<b>Nothing logged yet today</b>', d: 'If you haven\'t eaten, low fuel is a common cause.' });
  if (usual.length >= 3 && avgBy('cal') > 300 && soFar.cal && soFar.cal < avgBy('cal') * 0.65)
    out.push({ e: '🔥', t: `<b>${fmt(soFar.cal)} cal</b> so far, usually ~${fmt(avgBy('cal'))} by now`, d: 'Eating less than usual is a common reason for feeling drained.' });
  else if (usual.length >= 3 && avgBy('c') > 50 && soFar.cal && soFar.c < avgBy('c') * 0.6)
    out.push({ e: '🍞', t: `<b>${fmt(soFar.c)} g carbs</b> so far, usually ~${fmt(avgBy('c'))} g by now`, d: 'Carbs are the main fuel for practice. Low carbs often feel like heavy legs or fog.' });

  // Water, only if she tracks it.
  const tracksWater = past.slice(0, 14).some(d => db.get('days', d)?.water);
  if (tracksWater && hr >= 11) {
    const expect = goals().water * Math.min(1, Math.max(0, (hr - 7) / 15));
    if ((day.water || 0) < expect * 0.5) out.push({ e: '💧', t: `Only <b>${fmt(day.water || 0)} oz</b> water so far`, d: 'Even mild dehydration can bring on headaches, dizziness and fatigue.' });
  }

  // Sleep and recovery against her own average.
  const pastDays = past.map(d => db.get('days', d)).filter(Boolean);
  const avgOf = k => { const v = pastDays.map(d => d[k]).filter(x => x != null); return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sAvg = avgOf('sleepMin');
  if (day.sleepMin != null && (day.sleepMin < 390 || (sAvg && day.sleepMin < sAvg - 60)))
    out.push({ e: '😴', t: `Slept <b>${fmtSleep(day.sleepMin)}</b>${sAvg ? ` (usual ${fmtSleep(sAvg)})` : ''}`, d: 'Short sleep is one of the most common reasons for feeling off.' });
  const rAvg = avgOf('recovery');
  if (day.recovery != null && (day.recovery < 34 || (rAvg && day.recovery < rAvg - 15)))
    out.push({ e: '💚', t: `Recovery <b>${day.recovery}%</b>${rAvg ? ` (usual ${Math.round(rAvg)}%)` : ''}`, d: 'Your body is still catching up. That can come from training load, sleep, stress or getting sick.' });
  const stAvg = avgOf('strain');
  if (prev.strain != null && (prev.strain >= 16 || (stAvg && prev.strain > stAvg + 3)))
    out.push({ e: '⚡', t: `Big day yesterday: strain <b>${prev.strain}</b>`, d: 'Hard sessions can leave you flat the next day, especially if you didn\'t refuel.' });
  const yEnts = db.list('entries').filter(e => e.date === addDays(date, -1));
  if (prev.burned && yEnts.length) {
    const yc = sumMacros(yEnts.map(e => e.macros)).cal;
    if (yc < prev.burned - 500) out.push({ e: '📉', t: `Yesterday: ate <b>${fmt(yc)}</b>, burned <b>${fmt(prev.burned)}</b>`, d: 'A big gap between eating and burning can show up the next day as low energy.' });
  }
  const gut = db.list('stomach').find(g => { const t = toTs(g.date, g.time); return t <= ts && ts - t <= 12 * H; });
  if (gut) out.push({ e: '🫄', t: 'Had stomach trouble in the last 12 hours', d: 'Gut issues can leave you drained, especially if you ate less because of it.' });
  return out;
}

function openFeel({ log = null, date = ui.date } = {}) {
  const e = log ? { ...log } : { id: uid(), date, time: date === dateStr() ? timeStr() : '12:00', level: 2, feelings: [], context: [], notes: '' };
  const fl = new Set(e.feelings || []), ctx = new Set(e.context || []);
  const s = openSheet({
    title: log ? 'Edit check-in' : 'Feeling off', full: true, lock: true,
    body: `<h4 class="sec">How off?</h4>
      <div class="sev">${OFF_LEVELS.map(x => `<button class="${e.level === x.v ? 'on' : ''}" data-x="lvl" data-v="${x.v}"><span>${x.e}</span>${x.t}</button>`).join('')}</div>
      <h4 class="sec">What does it feel like? <span class="muted">(pick any)</span></h4>
      <div class="chips">${FEELINGS.map(([em, x]) => `<button class="chip sm ${fl.has(x) ? 'on' : ''}" data-x="fl" data-v="${x}">${em} ${x}</button>`).join('')}</div>
      <div class="grid2 mt"><div class="field"><label>Date</label><input type="date" id="fd" value="${e.date}"></div><div class="field"><label>Time</label><input type="time" id="ft" value="${e.time}"></div></div>
      <div id="why"></div>
      <h4 class="sec">Anything else going on? <span class="muted">(optional)</span></h4>
      <div class="chips">${CONTEXT.map(x => `<button class="chip sm ${ctx.has(x) ? 'on' : ''}" data-x="ctx" data-v="${x}">${x}</button>`).join('')}</div>
      <div class="field mt"><label>Notes</label><textarea id="fn" rows="3" placeholder="What were you doing? How long has it lasted?">${esc(e.notes || '')}</textarea></div>
      ${log ? `<button class="btn ghost danger-t full" data-x="del">Delete</button>` : ''}`,
    footer: `<button class="btn ghost" data-x="close">Cancel</button><button class="btn primary grow" data-x="save">Save</button>`,
  });
  function why() {
    const sig = offSignals(s.$('#fd').value || e.date, s.$('#ft').value || e.time);
    s.$('#why').innerHTML = `<div class="why-box"><h4>🔎 What might be behind it</h4>
      ${sig.length ? sig.map(x => `<div class="why"><span class="why-ico">${x.e}</span><div><div>${x.t}</div><div class="muted tiny">${x.d}</div></div></div>`).join('')
        : `<p class="small muted">Nothing stands out in what's logged. Logging food, sleep and recovery gives this more to go on, and after a few check-ins Trends compares your off days with normal ones.</p>`}
      <p class="muted tiny">If it's severe, sudden, or keeps happening, tell your athletic trainer or a doctor.</p></div>`;
  }
  s.on('click', '[data-x="lvl"]', el => { e.level = +el.dataset.v; s.$$('[data-x="lvl"]').forEach(b => b.classList.toggle('on', b === el)); });
  s.on('click', '[data-x="fl"]', el => { const v = el.dataset.v; fl.has(v) ? fl.delete(v) : fl.add(v); el.classList.toggle('on'); });
  s.on('click', '[data-x="ctx"]', el => { const v = el.dataset.v; ctx.has(v) ? ctx.delete(v) : ctx.add(v); el.classList.toggle('on'); });
  s.on('change', '#fd, #ft', why);
  s.on('click', '[data-x="del"]', async () => { if (await confirmSheet('Delete this check-in?')) { db.remove('feel', e.id); closeAllSheets(); } });
  s.on('click', '[data-x="save"]', () => {
    Object.assign(e, { date: s.$('#fd').value || e.date, time: s.$('#ft').value || e.time, feelings: [...fl], context: [...ctx], notes: s.$('#fn').value.trim() });
    db.put('feel', e);
    s.close();
    toast(log ? 'Saved' : 'Logged');
  });
  why();
}

function openFeelHistory() {
  const all = db.list('feel').sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const s = openSheet({
    title: 'Feeling-off log', full: true,
    body: all.length ? all.map(e => { const l = OFF_LEVELS[e.level - 1] || OFF_LEVELS[1]; return `<button class="row" data-x="ep" data-id="${e.id}"><span class="thumb ph">${l.e}</span>
      <div class="row-main"><div class="row-name">${fmtDay(e.date)} · ${fmtTime(e.time)}</div><div class="row-sub">${l.t}${(e.feelings || []).length ? ' · ' + esc(e.feelings.join(', ')) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div><span class="chev">›</span></button>`; }).join('')
      : `<p class="muted center">Nothing logged yet.</p>`,
  });
  s.on('click', '[data-x="ep"]', el => { s.close(); openFeel({ log: db.get('feel', el.dataset.id) }); });
}

// ---------- calendar ----------
function openCalendar() {
  let month = ui.date.slice(0, 7);
  const s = openSheet({
    title: 'Calendar', full: true,
    body: `<div class="cal-nav"><button class="icon-btn" data-x="prev" aria-label="Previous month">‹</button><b id="calTitle"></b><button class="icon-btn" data-x="next" aria-label="Next month">›</button></div>
      <div class="cal-grid cal-wd">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid" id="calGrid"></div>
      <div class="cal-legend"><span><i class="lg on"></i>On target</span><span><i class="lg under"></i>Under</span><span><i class="lg over"></i>Over</span><span><i class="mk gut"></i>Stomach</span><span><i class="mk feel"></i>Felt off</span><span><i class="mk sleep"></i>Recovery logged</span>${periodOn() ? '<span><i class="mk period"></i>Period</span>' : ''}<span>🏀 Practice</span><span>🎯 Shoot-around</span><span>🏋️ Weights</span><span>💪 Workout</span><span><i class="lg game"></i>Game</span></div>
      <div id="calSum"></div>
      <div id="calGames"></div>`,
  });
  function draw() {
    const first = parseDate(month + '-01'), y = first.getFullYear(), m = first.getMonth();
    const nDays = new Date(y, m + 1, 0).getDate(), today = dateStr(), g = goals();
    s.$('#calTitle').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const by = {};
    db.list('entries').forEach(e => { if (e.date.startsWith(month)) (by[e.date] ||= []).push(e.macros); });
    const eps = {};
    db.list('stomach').forEach(e => { if (e.date.startsWith(month)) eps[e.date] = (eps[e.date] || 0) + 1; });
    const offs = new Set(db.list('feel').map(e => e.date));
    let cells = '<span></span>'.repeat(first.getDay());
    const logged = [];
    for (let d = 1; d <= nDays; d++) {
      const ds = `${month}-${String(d).padStart(2, '0')}`;
      const t = by[ds] ? sumMacros(by[ds]) : null;
      const day = db.get('days', ds);
      if (t) logged.push(t);
      const r = t ? t.cal / (g.cal || 1) : 0;
      const cls = !t ? '' : r < 0.9 ? 'under' : r > 1.1 ? 'over' : 'on';
      const gm = gameOn(ds), acts = actsOf(day);
      cells += `<button class="cal-day ${cls} ${ds === today ? 'today' : ''} ${ds === ui.date ? 'sel' : ''} ${ds > today ? 'future' : ''} ${gm ? 'game' : ''}" data-x="day" data-d="${ds}">
        <span class="cal-n">${d}</span>${gm ? `<img class="cal-logo" src="${teamLogo(gm)}" alt="${esc(gm.opp)}">` : ''}<span class="cal-c">${t ? (t.cal >= 1000 ? (t.cal / 1000).toFixed(1) + 'k' : Math.round(t.cal)) : gm ? '' : acts.includes('practice') ? '🏀' : acts.includes('weights') ? '🏋️' : acts.includes('workout') ? '💪' : acts.includes('shoot') ? '🎯' : ''}</span>
        <span class="cal-mk">${eps[ds] ? '<i class="mk gut"></i>' : ''}${offs.has(ds) ? '<i class="mk feel"></i>' : ''}${day && (day.sleepMin != null || day.recovery != null) ? '<i class="mk sleep"></i>' : ''}${day?.period && periodOn() ? '<i class="mk period"></i>' : ''}</span></button>`;
    }
    s.$('#calGrid').innerHTML = cells;
    const avg = k => logged.length ? logged.reduce((a, t) => a + t[k], 0) / logged.length : 0;
    const nEp = Object.values(eps).reduce((a, b) => a + b, 0);
    s.$('#calSum').innerHTML = `<div class="card"><div class="big-stats">
      <div><b>${logged.length}</b><span>days logged</span></div><div><b>${logged.length ? fmt(avg('cal')) : '–'}</b><span>avg cal</span></div>
      <div><b>${logged.length ? fmt(avg('p')) + 'g' : '–'}</b><span>avg protein</span></div><div><b>${nEp}</b><span>symptom logs</span></div></div></div>`;
    const gms = GAMES.filter(g => g.date.startsWith(month));
    s.$('#calGames').innerHTML = gms.length ? `<h4 class="sec">🏀 Games this month</h4>${gms.map(g => `<button class="row" data-x="day" data-d="${g.date}">
      <img class="team-logo sm" src="${teamLogo(g)}" alt=""><div class="row-main"><div class="row-name">${vsAt(g)} ${esc(g.opp)}</div>
      <div class="row-sub">${parseDate(g.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${g.result ? esc(g.result) : gameTime(g)}${g.home ? ' · Home' : ' · ' + esc(g.where)}</div></div><span class="chev">›</span></button>`).join('')}` : '';
  }
  const shift = n => { const d = parseDate(month + '-01'); d.setMonth(d.getMonth() + n); month = dateStr(d).slice(0, 7); draw(); };
  s.on('click', '[data-x="prev"]', () => shift(-1));
  s.on('click', '[data-x="next"]', () => shift(1));
  s.on('click', '[data-x="day"]', el => { s.close(); ui.date = el.dataset.d; go('today'); });
  draw();
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

// ---------- summary image ----------
function summaryData(range) {
  const n = range === 'week' ? 7 : 30, today = dateStr(), g = goals();
  const dates = Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
  const by = {};
  db.list('entries').forEach(e => { if (e.date >= dates[0]) (by[e.date] ||= []).push(e.macros); });
  const totals = dates.map(d => by[d] ? sumMacros(by[d]) : null), logged = totals.filter(Boolean);
  const avg = k => logged.length ? logged.reduce((s, t) => s + t[k], 0) / logged.length : 0;
  const days = dates.map(d => db.get('days', d) || {});
  const avgOf = k => { const v = days.map(d => d[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const allW = weighIns(), w = allW.filter(d => d.id >= dates[0]);
  const r1 = x => Math.round(x * 10) / 10;
  const dw = w.length >= 2 ? weekAvg(allW, w[w.length - 1].id) - weekAvg(allW, w[0].id) : 0;
  const weight = w.length >= 2 ? `${r1(w[w.length - 1].weight)} (${dw >= 0 ? '+' : ''}${r1(dw)})` : w.length ? String(r1(w[0].weight)) : '';
  const fmtD = d => parseDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const name = (profile()?.name || '').trim().split(/\s+/)[0];
  return {
    kicker: profile()?.number ? `Pulse · #${profile().number}` : 'Pulse',
    title: name ? `${name}'s ${range === 'week' ? 'week' : 'month'}` : range === 'week' ? 'My week' : 'My month',
    rangeLabel: `${fmtD(dates[0])} – ${fmtD(today)}`,
    badge: streak() >= 3 ? `🔥 ${streak()}-day logging streak` : '',
    days: dates.map((d, i) => ({ label: n === 7 ? parseDate(d).toLocaleDateString(undefined, { weekday: 'short' }) : `${parseDate(d).getMonth() + 1}/${parseDate(d).getDate()}`, cal: totals[i]?.cal || 0 })),
    n, logged: logged.length, goalCal: g.cal, goalP: g.p,
    onTarget: logged.filter(t => Math.abs(t.cal - g.cal) <= g.cal * 0.1).length,
    avgCal: logged.length ? avg('cal') : null, avgP: avg('p'), avgC: avg('c'), avgF: avg('f'),
    avgSleep: avgOf('sleepMin'), avgRecovery: avgOf('recovery'), weight: profile()?.showWeight ? weight : null,
    sleepNear: days.filter(d => d.bed && nearPlan(d)).length,
    games: GAMES.filter(x => x.date >= dates[0] && x.date <= today).length,
    gutDays: new Set(db.list('stomach').filter(e => e.date >= dates[0]).map(e => e.date)).size,
    offDays: new Set(db.list('feel').filter(e => e.date >= dates[0]).map(e => e.date)).size,
  };
}
function openShareImage() {
  let range = 'week', blob = null;
  const s = openSheet({
    title: 'Save a summary', full: true,
    body: `<div class="seg">${[['week', 'This week'], ['month', 'Last 30 days']].map(([k, l]) => `<button class="${k === range ? 'on' : ''}" data-x="rng" data-r="${k}">${l}</button>`).join('')}</div>
      <div class="img-prev" id="ip"><div class="muted small center">Making your image…</div></div>
      <p class="muted tiny center">Tap Save, then choose <b>Save Image</b> to put it in your camera roll.</p>`,
    footer: `<button class="btn ghost" data-x="close">Close</button><button class="btn primary grow" data-x="save" disabled>Save to Photos</button>`,
  });
  async function make() {
    s.$('[data-x="save"]').disabled = true;
    blob = await drawSummary(summaryData(range));
    const url = URL.createObjectURL(blob);
    s.$('#ip').innerHTML = `<img src="${url}" alt="Summary image">`;
    s.$('[data-x="save"]').disabled = false;
  }
  s.on('click', '[data-x="rng"]', el => { range = el.dataset.r; s.$$('[data-x="rng"]').forEach(b => b.classList.toggle('on', b === el)); make(); });
  s.on('click', '[data-x="save"]', () => shareFile(`pulse-${range}-${dateStr()}.png`, blob, 'image/png'));
  make();
}

// Plain-text summary of the last 60 days of stomach and feeling-off logs,
// meant for an athletic trainer, dietitian or doctor.
function exportReport() {
  const since = addDays(dateStr(), -59);
  const st = db.list('stomach').filter(e => e.date >= since).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const fe = db.list('feel').filter(e => e.date >= since).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const a = analyzeGut(db.list('entries'), db.list('stomach'), entryTags, { windowH: 12 });
  const name = profile()?.name ? ` for ${profile().name}` : '';
  const L = [`Pulse symptom report${name}`, `${fmtDay(since)} – ${fmtDay(dateStr())}`, ''];
  L.push(`STOMACH: ${st.length} episodes on ${new Set(st.map(e => e.date)).size} days`);
  if (a.episodes >= 3 && a.foods.length) L.push('Foods most often eaten in the 12h before (vs. usual rate ' + Math.round(a.base * 100) + '%):',
    ...a.foods.map(f => `  - ${f.name}: trouble after ${f.hit} of ${f.eaten} times (${Math.round(f.rate * 100)}%)`));
  if (a.episodes >= 3 && a.tags.length) L.push('Food types: ' + a.tags.map(t => `${t.name} ${Math.round(t.rate * 100)}%`).join(', '));
  L.push('', ...st.map(e => {
    const sv = SEVERITY[e.severity - 1] || SEVERITY[2];
    const before = db.list('entries').filter(x => { const t = toTs(e.date, e.time) - toTs(x.date, x.time); return t >= 0 && t <= 12 * 3600e3; }).map(x => x.name);
    return `${e.date} ${e.time}  ${sv.t} (${e.severity}/5)${(e.symptoms || []).length ? ' · ' + e.symptoms.join(', ') : ''}${e.where ? ' · ' + e.where : ''}${e.duration ? ' · ' + e.duration : ''}`
      + `${(e.context || []).length ? '\n    Context: ' + e.context.join(', ') : ''}${before.length ? '\n    Ate in 12h before: ' + before.join(', ') : ''}${e.notes ? '\n    Notes: ' + e.notes : ''}`;
  }));
  L.push('', `FEELING OFF: ${fe.length} check-ins on ${new Set(fe.map(e => e.date)).size} days`, ...fe.map(e => {
    const l = OFF_LEVELS[e.level - 1] || OFF_LEVELS[1];
    return `${e.date} ${e.time}  ${l.t} (${e.level}/5)${(e.feelings || []).length ? ' · ' + e.feelings.join(', ') : ''}${(e.context || []).length ? '\n    Context: ' + e.context.join(', ') : ''}${e.notes ? '\n    Notes: ' + e.notes : ''}`;
  }));
  L.push('', 'Patterns are from self-logged data and are not a diagnosis.');
  shareFile(`pulse-report-${dateStr()}.txt`, L.join('\n'), 'text/plain');
}
// ---------- onboarding & auth ----------
function fullscreen(html) {
  appEl.classList.remove('ready');
  main.innerHTML = html;
  $('#fab').hidden = true;
}

// First-time setup: one small screen per thing the app needs, saved as she
// goes, so quitting halfway picks up where she left off.
const needsSetup = () => !profile() || profile().setupDone === false;
function showWelcome() {
  const p0 = profile() || {};
  let saveGoalsStrict = false;
  let i = p0.setupStep || 0, perDay = new Set([1, 2, 3, 4, 5].map(d => p0.wakeByDay?.[d])).size > 1;
  // Wake times as shown on the sleep step: one per day, or weekdays + weekends.
  const readWake = () => {
    const w = { ...(profile()?.wakeByDay || {}) };
    if ($('[data-wd]')) $$('[data-wd]').forEach(x => { if (x.value) w[x.dataset.wd] = x.value; });
    else { const wd = $('#obWd')?.value || '06:00', we = $('#obWe')?.value || '07:00'; [1, 2, 3, 4, 5].forEach(d => { w[d] = wd; }); w[0] = w[6] = we; }
    return w;
  };
  const tog = (k, on, label, sub) => `<button type="button" class="ob-tog ${on ? 'on' : ''}" data-tog="${k}"><span class="grow"><b>${label}</b><small>${sub}</small></span><span class="sw"><i></i></span></button>`;
  const opt = (k, v, cur, e, label, sub) => `<button type="button" class="ob-opt ${cur === v ? 'on' : ''}" data-opt="${k}" data-v="${v}"><span class="ob-opt-e">${e}</span><span class="grow"><b>${label}</b><small>${sub}</small></span><span class="ob-radio"></span></button>`;
  const STEPS = [
    { k: 'hi', e: '👋', t: OWNER ? `Hi ${esc(OWNER.name)}!` : 'Welcome to Pulse',
      b: () => `<p class="ob-lead">Let's get Pulse set up for you. About 2 minutes.</p>
        <div class="ob-list"><span>🍽️ Food & macros</span><span>😴 Sleep & bedtime</span><span>💊 Meds</span><span>⌚ Calories burned</span><span>🔔 Reminders</span></div>
        ${OWNER ? '' : `<div class="field mt"><label>Your first name</label><input id="obName" autocomplete="given-name" value="${esc(p0.name || '')}"></div>
          ${tog('glutenFree', p0.glutenFree, '🌾 I eat gluten-free', 'Flags foods that have or may have gluten')}`}`,
      go: 'Let\'s go',
      save: () => { const n = $('#obName')?.value.trim(); if (!OWNER && !n) return toast('Type your name first'), false;
        saveProfile({ setupDone: false, name: OWNER?.name || n, number: OWNER?.number || '', glutenFree: OWNER?.glutenFree || !!profile()?.glutenFree, goals: profile()?.goals || { ...DEFAULT_GOALS } }); } },
    { k: 'goals', e: '🎯', t: 'Daily goals',
      b: () => { const p = profile() || {}, src = p.goalsFrom || 'guess', tr = k => p.track?.[k] ?? false;
        // Her own numbers start blank so she types what her dietitian gave her.
        const g = p.goalsGuess === false ? goals() : {}, d = DEFAULT_GOALS;
        const f = (k, l, u) => `<div class="field"><label>${l}</label><div class="unit-in"><input data-g="${k}" inputmode="decimal" value="${g[k] ?? ''}" placeholder="Type it"><span>${u}</span></div></div>`;
        const chips = `<div class="chip-row">${OPTIONAL_MACROS.map(([k, l]) => `<button type="button" class="chip sm ${tr(k) ? 'on' : ''}" data-o="track" data-k="${k}">${tr(k) ? '✓ ' : '＋ '}${l}</button>`).join('')}</div>`;
        return `<p class="ob-sub">Did your dietitian give you numbers?</p>
          ${opt('goalsFrom', 'guess', src, '🤷‍♀️', 'Not yet / not sure', 'Pulse picks a starting point for you')}
          ${opt('goalsFrom', 'mine', src, '📋', 'Yes, I have my numbers', "I'll type them in")}
          ${src === 'guess' ? `<div class="ob-plan">
              <div><b>${fmt(d.cal)}</b><span>calories</span></div><div><b>${d.p}g</b><span>protein</span></div><div><b>${d.water} oz</b><span>water</span></div></div>
            <p class="muted tiny">A typical starting point for a college basketball player. Every body is different, so swap in your dietitian's numbers anytime in <b>Me</b>.</p>
            <label class="ob-lbl">Also track <span class="muted">(optional)</span></label>${chips}`
          : `<div class="grid2 mt">${f('cal', 'Calories', 'cal')}${f('p', 'Protein', 'g')}${f('water', 'Water', 'oz')}${OPTIONAL_MACROS.filter(([k]) => tr(k)).map(([k, l]) => f(k, l, 'g')).join('')}</div>
            <label class="ob-lbl">Did they give you any of these too? <span class="muted">(optional)</span></label>${chips}`}`; },
      save: () => {
        const track = { c: false, f: false, fiber: false, ...(profile()?.track || {}) };
        if ((profile()?.goalsFrom || 'guess') === 'guess') return saveProfile({ goals: { ...DEFAULT_GOALS }, track, goalsGuess: true });
        // Partial save while toggling chips; the Next button checks the basics.
        const g = { ...DEFAULT_GOALS }; let miss = false;
        $$('[data-g]').forEach(x => { if (x.value.trim()) g[x.dataset.g] = num(x.value); else if (x.dataset.g === 'cal' || x.dataset.g === 'p') miss = true; });
        saveProfile({ goals: g, track, goalsGuess: false });
        if (miss && saveGoalsStrict) return toast('Add your calories and protein'), false;
      } },
    { k: 'sleep', e: '😴', t: 'Sleep',
      b: () => `<p class="ob-sub">Pulse plans your bedtime every night from these. Game nights move it automatically.</p>
        <div class="field"><label>How much sleep do you want?</label><select id="obSleep">${[420, 450, 480, 510, 540, 570, 600].map(m => `<option value="${m}" ${m === sleepGoal() ? 'selected' : ''}>${fmtSleep(m)}</option>`).join('')}</select></div>
        ${perDay ? `<label class="ob-lbl">I usually wake up</label>${[1, 2, 3, 4, 5, 6, 0].map(d => `<div class="kv-row"><span>${WEEKDAYS[d]}</span><input type="time" class="time-in" data-wd="${d}" value="${wakeUsual(d)}"></div>`).join('')}`
          : `<div class="grid2"><div class="field"><label>Weekdays I wake up</label><input type="time" id="obWd" value="${wakeUsual(1)}"></div>
          <div class="field"><label>Weekends I wake up</label><input type="time" id="obWe" value="${wakeUsual(6)}"></div></div>`}
        <button type="button" class="link-btn" data-o="perDay">${perDay ? 'Same time every weekday' : 'Different each day? Set each one'}</button>
        <p class="muted tiny">Something comes up? Change any single night from the Sleep card.</p>`,
      save: () => { saveProfile({ sleepGoal: +$('#obSleep').value, wakeByDay: readWake() }); } },
    { k: 'meds', e: '💊', t: 'Meds & vitamins',
      b: () => { const m = medList(); return `<p class="ob-sub">Check them off each day. Pulse only reminds you if you forget.</p>
        ${m.length ? `<div class="ob-meds">${m.map(x => `<span>${medWhen(x) === 'Night' ? '🌙' : medWhen(x) === 'Morning' ? '☀️' : '🕒'} ${esc(x.name)}${medFood(x) ? ' 🍽️' : ''}</span>`).join('')}</div>` : ''}
        <button type="button" class="btn soft full big" data-o="meds">${m.length ? '✏️ Edit my list' : '＋ Add what I take'}</button>`; },
      go: () => medList().length ? 'Next' : 'Skip for now' },
    { k: 'burn', e: '⌚', t: 'Calories burned',
      b: () => { const cur = profile()?.burnFrom || 'type';
        return `<p class="ob-sub">Active + resting calories, heart rate and recovery from your Whoop or Apple Watch.</p>
        ${opt('burnFrom', 'type', cur, '✏️', 'I\'ll type it in', 'Quick and easy. Takes 10 seconds a day.')}
        ${opt('burnFrom', 'health', cur, '🍎', 'Auto-fill from Apple Health', 'One-time 5-minute setup, right after this')}
        <p class="muted tiny">You can switch anytime from the Recovery card.</p>`; } },
    { k: 'extras', e: '✨', t: 'Extras',
      b: () => { const p = profile() || {};
        return `<p class="ob-sub">Turn on what you want. Both stay private.</p>
        ${tog('showPeriod', p.showPeriod ?? true, '🌸 Period tracking', 'A small row at the bottom of Today')}
        ${tog('showWeight', !!p.showWeight, '⚖️ Body weight', 'A weight card with a 7-day average')}`; } },
    { k: 'notify', e: '🔔', t: 'Reminders',
      b: () => `<p class="ob-sub">Just a few, at the right moments. Never spammy.</p>
        ${ui.notifyOn ? `<p class="ob-ok">✅ Reminders are on</p>`
          : !notify.installed() && !NEW ? `<div class="ob-install"><b>First, add Pulse to your Home Screen:</b><ol><li>Tap <b>Share</b> <span class="muted">(square with arrow)</span></li><li>Tap <b>Add to Home Screen</b></li><li>Open Pulse from your Home Screen</li></ol></div>`
          : `<button type="button" class="btn primary full big" data-o="notify">🔔 Turn on reminders</button>`}`,
      go: () => ui.notifyOn ? 'Next' : 'Maybe later' },
    { k: 'done', e: '🎉', t: 'You\'re all set!',
      b: () => { const p = profile() || {}, g = goals(), m = medList();
        return `<div class="ob-sum">
          <span>🎯 ${fmt(g.cal)} cal · ${fmt(g.p)}g protein · ${fmt(g.water)} oz water</span>
          <span>😴 ${fmtSleep(sleepGoal())} of sleep, bed by ${fmtTime(bedGoal())} tonight</span>
          <span>💊 ${m.length ? plural(m.length, 'med') : 'No meds yet'}</span>
          <span>⌚ ${p.burnFrom === 'health' ? 'Apple Health (setting up next)' : 'Typing it in'}</span>
          <span>🔔 ${ui.notifyOn ? 'Reminders on' : 'Reminders off for now'}</span></div>
          <p class="ob-sub mt">Tap <b>＋</b> to log food, and <b>✨ Ask</b> anytime to ask about you.</p>`; },
      go: 'Start using Pulse' },
  ];
  const draw = () => {
    const st = STEPS[i], go = typeof st.go === 'function' ? st.go() : st.go || 'Next';
    fullscreen(`<div class="ob">
      <div class="ob-top">${i > 0 ? `<button class="ob-back" data-o="back" aria-label="Back">‹</button>` : '<span></span>'}<div class="ob-bar"><i style="width:${(i + 1) / STEPS.length * 100}%"></i></div><span class="ob-n">${i + 1}/${STEPS.length}</span></div>
      <div class="ob-body"><div class="ob-e">${st.e}</div><h1>${st.t}</h1>${st.b()}</div>
      <div class="ob-foot"><button class="btn primary big full" data-o="next">${go}</button></div></div>`);
    window.scrollTo(0, 0);
  };
  main.onclick = async e => {
    const t = e.target.closest('[data-o],[data-tog],[data-opt]');
    if (!t || !main.querySelector('.ob')) return;
    if (t.dataset.tog) { const k = t.dataset.tog, on = !t.classList.contains('on'); t.classList.toggle('on', on); return saveProfile({ [k]: on }); }
    if (t.dataset.opt) { $$(`[data-opt="${t.dataset.opt}"]`).forEach(b => b.classList.toggle('on', b === t));
      if (t.dataset.opt !== 'goalsFrom') return saveProfile({ [t.dataset.opt]: t.dataset.v });
      STEPS[i].save(); saveProfile({ goalsFrom: t.dataset.v }); draw();
      if (t.dataset.v === 'mine') $('[data-g="cal"]')?.focus(); return; }
    const o = t.dataset.o;
    if (o === 'back') { i--; saveProfile({ setupStep: i }); return draw(); }
    if (o === 'meds') { const s = openMeds(); const was = s?.onClose; if (s) s.onClose = () => { was?.(); draw(); }; return; }
    if (o === 'notify') { await turnOnNotify(); return draw(); }
    if (o === 'perDay') { saveProfile({ wakeByDay: readWake() }); perDay = !perDay; return draw(); }
    if (o === 'track') { STEPS[i].save(); const tr = profile()?.track || {}; saveProfile({ track: { ...tr, [t.dataset.k]: !(tr[t.dataset.k] ?? false) } }); return draw(); }
    if (o !== 'next') return;
    saveGoalsStrict = true; const ok = STEPS[i].save?.(); saveGoalsStrict = false;
    if (ok === false) return;
    if (i < STEPS.length - 1) { i++; saveProfile({ setupStep: i }); return draw(); }
    main.onclick = null;
    saveProfile({ setupDone: true, setupStep: 0 });
    startApp({ first: true });
    celebrate("Let's go! 🏀", true);
    if (profile()?.burnFrom === 'health') setTimeout(openHealthGuide, 2600);
  };
  draw();
}

function showAuth(mode = 'in', msg = '') {
  fullscreen(`<div class="welcome">
    <img src="icons/icon-192.png" class="logo" alt="">
    <h1>Pulse</h1>
    <p class="muted">Nutrition, recovery and digestion in one place.</p>
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
  applyOwner();
  if (needsSetup()) showWelcome(); else startApp();
}

// Tapping the Sunday "Your week" notification lands here and plays Wrapped.
function openFromNote(what) { if (what === 'wrapped') setTimeout(() => acts.wrapped({}), 700); }
navigator.serviceWorker?.addEventListener('message', e => openFromNote(e.data?.open));
function startApp({ first = false } = {}) {
  applyTheme();
  appEl.classList.add('ready');
  render();
  let quiet = false;
  try { quiet = !!sessionStorage.getItem('pulseQuiet'); sessionStorage.removeItem('pulseQuiet'); } catch {}
  if (!quiet || first) splash(first);
  if (DEMO) document.body.insertAdjacentHTML('beforeend', '<div class="demo-tag">Sample data</div>');
  navigator.storage?.persist?.();
  notify.clearStale(handledNotes());
  if (DEMO && new URLSearchParams(location.search).has('win')) setTimeout(() => acts.winPreview(), 2200);
  if (new URLSearchParams(location.search).get('open') === 'wrapped') { openFromNote('wrapped'); history.replaceState(null, '', location.pathname); }
  notify.isOn().then(on => { ui.notifyOn = on; if (ui.tab === 'me') queueRender(); });
  refreshResults();
  scheduleNotify();
}

// A short personal hello each time the app opens.
// A different welcome-back line each launch: usually something real from her logs,
// sometimes a plain line for the time of day. Never the same one twice in a row.
function welcomeLine({ n, preps, todayCal }) {
  const t = dateStr(), y = addDays(t, -1), day = db.get('days', t) || {}, g = goals(), h = new Date().getHours();
  const yEat = sumMacros(dayEntries(y).map(e => e.macros)), ng = nextGame(addDays(t, 1));
  const ngDays = ng ? Math.round((parseDate(ng.date) - parseDate(t)) / 864e5) : 99;
  const real = [
    n >= 2 && `🔥 ${n} days logged in a row`,
    preps >= 1 && `🥡 ${fmt(preps)} meal-prep container${preps === 1 ? '' : 's'} ready`,
    todayCal && `${fmt(todayCal)} cal logged so far today`,
    day.sleepMin && `😴 Last night: ${fmtSleep(day.sleepMin)}`,
    day.recovery != null && `💚 ${fmt(day.recovery)}% recovery today`,
    ngDays <= 6 && `🏀 Next game: ${ngDays === 1 ? 'tomorrow' : parseDate(ng.date).toLocaleDateString(undefined, { weekday: 'long' })} ${vsAt(ng)} ${esc(ng.opp)}`,
    dayEntries(y).length && yEat.p >= g.p && '✓ Hit your protein goal yesterday',
    (db.get('days', y)?.water || 0) >= g.water && '💧 Hit your water goal yesterday',
  ].filter(Boolean);
  const plain = h < 5 ? ['Late one. Sleep soon', 'Up late'] : h < 12 ? ['Have a good day', 'Water first', 'Morning'] : h < 17 ? ['Hope the day is going well', "Don't skip lunch", 'Afternoon check-in'] : ['Hope today went well', 'Wind down when you can', 'Evening check-in'];
  let last = '';
  try { last = localStorage.getItem('pulseLastHello') || ''; } catch {}
  const pool = (real.length && Math.random() < 0.75 ? real : plain).filter(x => x !== last);
  const pick = pool[Math.floor(Math.random() * pool.length)] || plain[0];
  try { localStorage.setItem('pulseLastHello', pick); } catch {}
  return pick;
}
function splash(first) {
  const name = (profile()?.name || '').trim().split(/\s+/)[0];
  const t = dateStr(), n = streak(), preps = activePreps().reduce((s, p) => s + p.left, 0);
  const todayCal = sumMacros(dayEntries(t).map(e => e.macros)).cal;
  const now = timeStr(), num = profile()?.number, gm = gameOn(t)?.result ? null : gameOn(t);
  const note = first ? 'Tap ＋ to log your first meal'
    : now === '11:11' ? '🌠 11:11'
    : recentWin(t) ? `🏆 Congrats on the win ${vsAt(recentWin(t))} ${esc(recentWin(t).opp)}!`
    : gm ? `🏀 Game day ${vsAt(gm)} ${esc(gm.opp)} · ${gameTime(gm)}`
    : welcomeLine({ n, preps, todayCal });
  const el = document.createElement('div');
  el.className = 'splash';
  el.innerHTML = `<div class="splash-in">${num ? `<div class="splash-num">${esc(num)}</div>` : ''}<img src="icons/icon-192.png" alt="">
    <h1>${first ? 'Welcome' : 'Welcome back'}${name ? `, ${esc(name)}` : ''}</h1>
    <p>${greeting()} · ${parseDate(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
    <div class="splash-note">${note}</div></div>`;
  document.body.appendChild(el);
  const done = () => { el.classList.add('out'); setTimeout(() => el.remove(), 450); };
  el.addEventListener('click', done);
  setTimeout(done, first ? 2400 : 1700);
  let due = false;
  try { due = first || tourDue(); } catch {}
  if (due) setTimeout(startTour, (first ? 2400 : 1700) + 500);
}

// ---------- pull to refresh ----------
// Pull down from the top of any screen: checks for scores and reloads the app.
(() => {
  let y0 = null, dy = 0;
  const ptr = document.createElement('div');
  ptr.className = 'ptr'; ptr.innerHTML = '<span class="spin"></span>';
  document.body.appendChild(ptr);
  const blocked = () => sheets.length || document.querySelector('.tour, .wrapped, .winscreen, .splash, .ob');
  addEventListener('touchstart', e => { y0 = scrollY <= 0 && !blocked() ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (scrollY > 0) { y0 = null; dy = 0; }
    ptr.style.transform = `translate(-50%, ${Math.min(dy * 0.5, 70) - 50}px) rotate(${dy * 2}deg)`;
    ptr.classList.toggle('ready', dy > 120);
  }, { passive: true });
  addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    if (dy > 120) { ptr.classList.add('go'); buzz(); try { sessionStorage.setItem('pulseQuiet', '1'); } catch {} setTimeout(() => location.reload(), 350); }
    else ptr.style.transform = '';
  });
})();

// ---------- boot ----------
db.onChange(kind => {
  if (kind === 'settings') applyTheme();
  // Don't yank focus away while she's tabbing through the goal fields.
  if (kind === 'settings' && ui.tab === 'me' && main.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return sync.schedule();
  queueRender();
  sync.schedule();
  if (kind !== 'entries') scheduleNotify();
});
sync.onStatus(() => { if (ui.tab === 'me') queueRender(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const t = dateStr();
  if (t !== lastToday) { if (ui.date === lastToday) ui.date = t; lastToday = t; queueRender(); }
  offerPaste();
  notify.clearStale(handledNotes());
  scheduleNotify();
  wishCheck();
  refreshResults();
  sync.schedule(100);
});
window.addEventListener('online', () => sync.schedule(100));

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    if (DEMO) {
      // Fresh sample data each day so "today" always looks lived-in.
      const day = localStorage.getItem('pulseDemoDay');
      if (day !== dateStr()) await new Promise(r => { const q = indexedDB.deleteDatabase('pulse-demo'); q.onsuccess = q.onerror = q.onblocked = r; });
      await db.init('demo');
      if (!profile()) { await (await import('./demo.js')).seedDemo(); localStorage.setItem('pulseDemoDay', dateStr()); }
    } else if (NEW) {
      await new Promise(r => { const q = indexedDB.deleteDatabase('pulse-new'); q.onsuccess = q.onerror = q.onblocked = r; });
      await db.init('new');
      document.body.classList.add('is-new');
      document.body.insertAdjacentHTML('beforeend', '<button class="demo-tag new" onclick="location.reload()">First-time test ↻</button>');
    } else if (sync.enabled) {
      const user = await sync.getUser(askNewPassword);
      if (!user) return showAuth();
      await db.init(user.id);
      sync.schedule(50);
    } else {
      await db.init('local');
    }
    applyTheme();
    applyOwner();
    if (needsSetup()) showWelcome(); else startApp();
  } catch (e) {
    console.error(e);
    fullscreen(`<div class="welcome"><h1>Hmm…</h1><p class="muted">Pulse couldn't start: ${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`);
  }
}
boot();
