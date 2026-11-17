// Fills a sample copy of Pulse with ~6 weeks of made-up use, so you can see Pulse
// the way it looks after Carly's been using it. Only loads at ?demo, in its own
// database, so it never touches her real data.
import * as db from './db.js';
import { dateStr, addDays, perGram, scale, sumMacros } from './util.js';

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);
const pad = n => String(n).padStart(2, '0');
const hm = m => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.round(m % 60))}`;
let n = 0; const id = p => `${p}${++n}`;

export async function seedDemo() {
  const today = dateStr();
  const start = addDays(today, -42);

  const F = {};
  const food = (k, name, brand, servingG, cal, p, c, f, fiber, extra = {}) =>
    (F[k] = { id: id('f'), name, brand, servingG, servingLabel: '', cal, p, c, f, fiber, sugar: extra.sugar || 0, sodium: extra.sodium || 0, tags: extra.tags || [], gf: extra.gf ?? 'yes', fav: !!extra.fav, barcode: '' });
  food('oats', 'Gluten Free Rolled Oats', "Bob's Red Mill", 40, 150, 5, 27, 2.5, 4, { tags: ['High fiber'], fav: true });
  food('banana', 'Banana', '', 118, 105, 1.3, 27, 0.4, 3.1, { gf: 'yes' });
  food('pb', 'Creamy Peanut Butter', 'Jif', 32, 190, 7, 8, 16, 2, { fav: true });
  food('eggs', 'Large Eggs', 'Vital Farms', 50, 70, 6, 0, 5, 0);
  food('bread', 'Gluten Free White Bread', "Canyon Bakehouse", 34, 90, 2, 17, 1.5, 1, { fav: true });
  food('yogurt', 'Greek Yogurt Vanilla', 'Chobani', 150, 120, 12, 13, 2.5, 0, { tags: ['Dairy'], fav: true });
  food('berries', 'Strawberries', '', 150, 48, 1, 11.5, 0.5, 3);
  food('chicken', 'Chicken Breast (cooked)', '', 100, 165, 31, 0, 3.6, 0);
  food('rice', 'Jasmine Rice (cooked)', '', 158, 205, 4.3, 45, 0.4, 0.6);
  food('broc', 'Broccoli', '', 91, 31, 2.5, 6, 0.3, 2.4, { tags: ['High fiber'] });
  food('turkey', 'Ground Turkey 93%', 'Jennie-O', 112, 170, 22, 0, 9, 0);
  food('beans', 'Black Beans', 'Bush\'s', 130, 110, 7, 20, 0.5, 7, { tags: ['Beans / legumes', 'High fiber'] });
  food('salsa', 'Medium Salsa', "Pace", 32, 10, 0, 2, 0, 0, { tags: ['Acidic', 'Spicy'] });
  food('salmon', 'Atlantic Salmon (cooked)', '', 120, 250, 26, 0, 15, 0);
  food('sweetpot', 'Sweet Potato (baked)', '', 150, 135, 3, 31, 0.2, 5);
  food('shake', 'Protein Shake Chocolate', 'Fairlife Core Power', 414, 170, 26, 8, 4.5, 1, { tags: ['Dairy', 'Protein powder'], fav: true });
  food('bar', 'Protein Bar Cookies & Cream', 'Barebells', 55, 200, 20, 19, 8, 3, { tags: ['Sugar alcohol', 'Dairy'], gf: 'maybe' });
  food('kind', 'Dark Chocolate Nuts & Sea Salt', 'KIND', 40, 180, 6, 16, 15, 7);
  food('celsius', 'Celsius Sparkling Orange', 'Celsius', 355, 10, 0, 2, 0, 0, { tags: ['Caffeine', 'Artificial sweetener', 'Carbonated'] });
  food('chips', 'Tortilla Chips Sea Salt', 'Siete', 28, 130, 1, 19, 6, 1, { tags: ['Fried / greasy'] });
  food('avocado', 'Avocado', '', 50, 80, 1, 4, 7.5, 3.4);
  food('cheese', 'String Cheese', 'Tillamook', 28, 80, 7, 0, 6, 0, { tags: ['Dairy'] });
  food('apple', 'Honeycrisp Apple', '', 200, 104, 0.5, 28, 0.3, 4.8);
  food('chex', 'Honey Nut Chex', 'General Mills', 37, 150, 3, 31, 2, 2, { sugar: 9 });
  food('milk', '2% Milk', 'Fairlife', 240, 120, 13, 6, 4.5, 0, { tags: ['Dairy'] });
  Object.values(F).forEach(f => db.put('foods', f));

  const R = {};
  const recipe = (k, name, ings, servings) => {
    const total = sumMacros(ings.map(([f, g]) => scale(perGram(F[f]), g)));
    const weight = ings.reduce((a, [, g]) => a + g, 0);
    const per = {}; Object.keys(total).forEach(x => { per[x] = total[x] / weight; });
    R[k] = { id: id('r'), name, servings, cookedG: '', photo: '', notes: '', ingredients: ings.map(([f, g]) => ({ foodId: F[f].id, name: F[f].name, grams: g, per: perGram(F[f]) })), per, weight };
    const { per: _p, weight: _w, ...save } = R[k];
    db.put('recipes', save);
  };
  recipe('bowl', 'Chicken Rice Bowl', [['chicken', 750], ['rice', 1000], ['broc', 450], ['avocado', 150]], 5);
  recipe('taco', 'Turkey Taco Bowl', [['turkey', 680], ['rice', 800], ['beans', 390], ['salsa', 160]], 5);
  recipe('salmon', 'Salmon & Sweet Potato', [['salmon', 480], ['sweetpot', 600], ['broc', 360]], 4);

  // Meal prep: a batch each Sunday-ish (one Wednesday), the latest still has 2 left.
  const prepDays = [-42, -35, -28, -24, -14, -7, -2].map(d => addDays(today, d));
  const preps = prepDays.map((d, i) => {
    const r = R[['bowl', 'taco', 'bowl', 'salmon', 'taco', 'bowl', 'bowl'][i]];
    const containers = r.servings;
    return { id: id('p'), recipeId: r.id, name: r.name, photo: '', madeOn: d, containers, totalG: r.weight, gramsEach: r.weight / containers, per: r.per, left: 0, _r: r };
  });

  const entries = [];
  const log = (date, meal, time, kind, obj, grams, extra = {}) => {
    const per = kind === 'food' ? perGram(obj) : obj.per;
    entries.push({ id: id('e'), date, kind, refId: obj.id, name: obj.name, brand: kind === 'food' ? obj.brand : '', grams: Math.round(grams), per, macros: scale(per, grams), meal, time, ...extra });
  };
  const quick = (date, meal, time, name, cal, p, c, f) => entries.push({ id: id('e'), date, kind: 'quick', refId: '', name, grams: null, meal, time, macros: { cal, p, c, f, fiber: 0, sugar: 0, sodium: 0 } });

  const games = new Set((await import('./games.js')).GAMES.map(g => g.date));
  const period = new Set([...[0, 1, 2, 3, 4].map(i => addDays(today, -56 + i)), ...[0, 1, 2, 3, 4].map(i => addDays(today, -28 + i)), addDays(today, -1), today]);
  const meds = [{ id: 'm1', name: 'Vitamin D3', when: 'Morning' }, { id: 'm2', name: 'Multivitamin', when: 'Morning' }, { id: 'm3', name: 'Iron', when: 'Morning', food: true }, { id: 'm4', name: 'Magnesium', when: 'Night', food: true }];
  const notes = ['Legs felt heavy at practice but shooting was good.', 'Lift was hard. PR on trap bar deadlift though.', 'Slept great, felt fast today.',
    'Stomach was off after lunch. Not sure why.', 'Film + recovery day. Iced after.', 'Coach said my defense looked better.', 'Tired. Need to get to bed on time tonight.'];

  let lateDinner = false, lowWater = false;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const prevLate = lateDinner, prevLow = lowWater;
    const isToday = d === today, dow = new Date(d + 'T12:00').getDay();
    const game = games.has(d), rest = dow === 0;
    const prep = [...preps].reverse().find(p => p.madeOn <= d && addDays(p.madeOn, 6) > d);
    // breakfast
    if (rnd() < 0.6) { log(d, 'breakfast', hm(between(370, 410)), 'food', F.oats, 60); log(d, 'breakfast', hm(390), 'food', F.banana, 118); log(d, 'breakfast', hm(390), 'food', F.pb, 32); }
    else { log(d, 'breakfast', hm(between(370, 410)), 'food', F.eggs, 150); log(d, 'breakfast', hm(390), 'food', F.bread, 68); log(d, 'breakfast', hm(392), 'food', F.yogurt, 150); log(d, 'breakfast', hm(392), 'food', F.berries, 100); }
    // lunch: a meal-prep container most days
    const lunchT = hm(between(735, 780));
    if (prep && (prep.eaten || 0) < prep.containers && rnd() < 0.85) { log(d, 'lunch', lunchT, 'recipe', prep._r, prep.gramsEach, { prepId: prep.id }); prep.eaten = (prep.eaten || 0) + 1; }
    else if (!isToday) { log(d, 'lunch', lunchT, 'food', F.chicken, 150); log(d, 'lunch', lunchT, 'food', F.rice, 200); }
    if (!isToday) {
      const sn = pick([F.shake, F.shake, F.bar, F.bar, F.kind, F.cheese]);
      log(d, 'snack', hm(between(900, 960)), 'food', sn, sn.servingG);
      if (rnd() < 0.35) log(d, 'snack', hm(between(840, 870)), 'food', F.celsius, 355);
      if (rnd() < 0.4) log(d, 'snack', hm(between(1000, 1040)), 'food', pick([F.apple, F.chips, F.yogurt]), 150);
      // dinner
      const dinT = hm(between(1065, 1185));
      lateDinner = dinT >= '19:00';
      if (game || (dow === 4 && rnd() < 0.7)) quick(d, 'dinner', dinT, game ? 'Team meal (pregame)' : 'Team dinner', 820, 48, 105, 22);
      else if (prep && prep.eaten < prep.containers && rnd() < 0.5) { log(d, 'dinner', dinT, 'recipe', prep._r, prep.gramsEach, { prepId: prep.id }); prep.eaten++; }
      else { log(d, 'dinner', dinT, 'food', F.salmon, 140); log(d, 'dinner', dinT, 'food', F.sweetpot, 200); log(d, 'dinner', dinT, 'food', F.broc, 100); }
      if (rnd() < 0.3) { log(d, 'snack', hm(1215), 'food', F.chex, 50); log(d, 'snack', hm(1215), 'food', F.milk, 200); }
    }

    // day record: sleep, Whoop numbers (some days missing on purpose), meds, training
    const bedM = 1260 + between(-20, 25) + (rnd() < 0.12 ? 50 : 0);
    const wakeM = 350 + between(-10, 20);
    const sleepMin = Math.round(wakeM + 1440 - bedM - between(15, 35));
    // Late dinners and low water the day before cost some recovery, so the insights card has something real to find.
    const recovery = Math.round(Math.min(98, Math.max(22, 30 + (sleepMin - 420) * 0.35 + between(10, 40) + (prevLate ? -9 : 4) + (prevLow ? -6 : 2))));
    const day = { id: d, date: d };
    if (rnd() > 0.08) Object.assign(day, { bed: hm(bedM), wake: hm(wakeM), sleepMin, sleepPerf: Math.round(between(78, 97)) });
    if (rnd() > 0.15) Object.assign(day, { recovery, hrv: Math.round(between(68, 98)), rhr: Math.round(between(49, 56)) });
    if (!isToday && rnd() > 0.15) Object.assign(day, { strain: Math.round(between(game ? 15 : rest ? 5 : 10, game ? 19 : rest ? 9 : 16) * 10) / 10, resting: Math.round(between(1500, 1600)), active: Math.round(between(rest ? 600 : 1100, rest ? 900 : 1700)), steps: Math.round(between(7000, 15000)) });
    if (isToday) Object.assign(day, { active: 640, resting: 1050 });
    if (day.active != null) day.burned = day.active + day.resting;
    day.water = isToday ? 48 : Math.round(between(64, 112) / 8) * 8;
    lowWater = day.water < 100;
    if ([1, 3, 5].includes(dow)) day.weight = Math.round((152 + between(-1.5, 1.5)) * 10) / 10;
    day.activity = rest ? ['rest'] : game ? ['shoot'] : dow === 1 || dow === 3 ? ['practice', 'weights'] : dow === 6 ? ['workout'] : rnd() < 0.3 ? ['practice', 'shoot'] : ['practice'];
    if (isToday) day.activity = ['practice'];
    const taken = {};
    meds.forEach(m => { if (rnd() < (isToday ? (m.when === 'Night' ? 0 : 1) : 0.88)) taken[m.id] = m.when === 'Night' ? '20:40' : '06:30'; });
    day.meds = taken;
    if (rnd() < 0.3 && !isToday) day.notes = pick(notes);
    if (period.has(d)) { day.period = true; day.periodFeel = [pick(['moody', 'cramps', 'tired']), pick(['bloated', 'cravings', 'emotional', 'moody'])]; }
    db.put('days', day);
  }
  [0, 1, 2, 3, 4].forEach(i => { const d = addDays(today, -56 + i); db.put('days', { id: d, date: d, period: true }); });
  preps.forEach(p => { p.left = Math.max(0, p.containers - (p.eaten || 0)); delete p._r; delete p.eaten; db.put('preps', p); });
  preps.slice(0, -1).forEach(p => { p.left = 0; db.put('preps', p); });
  const latest = preps[preps.length - 1];
  latest.left = 2; db.put('preps', latest);
  db.putMany('entries', entries);

  // Stomach: some after Barebells/Celsius, some around her period, one after a team meal.
  const stomach = [
    [-38, '15:40', 3, ['Bloating', 'Gas'], ['Hard workout']], [-33, '16:10', 2, ['Bloating', 'Stomach ache'], []],
    [-30, '09:30', 3, ['Cramps', 'Stomach ache'], ['Period']], [-28, '13:00', 4, ['Cramps', 'Diarrhea'], ['Period']],
    [-21, '15:20', 3, ['Bloating', 'Gas', 'Stomach ache'], []], [-17, '20:15', 4, ['Stomach ache', 'Nausea', 'Diarrhea'], ['Ate food I didn\'t make', 'Possible gluten cross-contact']],
    [-12, '15:50', 2, ['Bloating'], []], [-6, '14:45', 3, ['Gas', 'Bloating'], ['Stressed']], [-1, '10:20', 3, ['Cramps'], ['Period']],
  ];
  stomach.forEach(([o, time, severity, symptoms, context]) => db.put('stomach', { id: id('s'), date: addDays(today, o), time, severity, symptoms, context, where: 'Lower stomach', duration: '1–2 hours', notes: '' }));
  const feel = [
    [-31, '16:00', 2, ['Tired / drained', 'Heavy legs'], ['Poor sleep']], [-23, '11:30', 3, ['Dizzy / lightheaded', 'Shaky'], ['Hard workout']],
    [-15, '14:00', 2, ['Brain fog', 'Tired / drained'], ['Poor sleep']], [-9, '17:20', 1, ['Headache'], ['Not enough water']],
  ];
  feel.forEach(([o, time, level, feelings, context]) => db.put('feel', { id: id('o'), date: addDays(today, o), time, level, feelings, context, notes: '' }));

  db.put('settings', { id: 'profile', name: 'Carly', number: '11', glutenFree: true, showWeight: true, sleepGoal: 540, meds,
    goals: { cal: 2600, p: 135, c: 320, f: 80, fiber: 30, water: 100 }, theme: 'system', healthReady: true });
  return { entries: entries.length, days: 43 };
}
