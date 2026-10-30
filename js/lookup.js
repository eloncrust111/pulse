// Free, keyless helpers: Open Food Facts (barcode + name search), a live
// barcode scanner, and on-device OCR for nutrition labels.
const OFF = 'https://world.openfoodfacts.org';
const FIELDS = 'code,product_name,product_name_en,brands,serving_quantity,serving_size,nutriments';
const H5Q = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

const scripts = {};
function loadScript(src) {
  if (!scripts[src]) scripts[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res;
    s.onerror = () => { delete scripts[src]; rej(new Error('No internet connection?')); };
    document.head.appendChild(s);
  });
  return scripts[src];
}

const r1 = v => v == null || !isFinite(v) ? '' : Math.round(v * 10) / 10;

function offToFood(p) {
  const n = p.nutriments || {};
  const kcal = n['energy-kcal_100g'] ?? (n.energy_100g != null ? n.energy_100g / 4.184 : null);
  const sq = parseFloat(p.serving_quantity);
  const servingG = sq > 0 ? sq : 100;
  const k = servingG / 100;
  const v = x => x == null ? '' : r1(x * k);
  return {
    name: (p.product_name_en || p.product_name || '').trim(),
    brand: (p.brands || '').split(',')[0].trim(),
    barcode: p.code || '',
    servingG: r1(servingG),
    servingLabel: sq > 0 ? (p.serving_size || '') : '',
    cal: kcal == null ? '' : Math.round(kcal * k),
    p: v(n.proteins_100g), c: v(n.carbohydrates_100g), f: v(n.fat_100g),
    fiber: v(n.fiber_100g), sugar: v(n.sugars_100g),
    sodium: n.sodium_100g == null ? '' : Math.round(n.sodium_100g * 1000 * k),
  };
}

export async function offBarcode(code) {
  const r = await fetch(`${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.status === 1 ? offToFood(j.product) : null;
}

export async function offSearch(q) {
  const r = await fetch(`${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=30&fields=${FIELDS}`);
  if (!r.ok) throw new Error('Search is busy, try again in a sec');
  const j = await r.json();
  return (j.products || []).map(offToFood).filter(f => f.name && f.cal !== '');
}

export async function startScanner(elId, onCode) {
  await loadScript(H5Q);
  const F = window.Html5QrcodeSupportedFormats;
  const s = new window.Html5Qrcode(elId, {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false,
  });
  let done = false;
  await s.start({ facingMode: 'environment' },
    { fps: 12, qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.85, 320)), height: Math.floor(Math.min(h * 0.45, 150)) }) },
    txt => {
      if (done) return;
      done = true;
      navigator.vibrate?.(40);
      s.stop().catch(() => {}).finally(() => onCode(txt));
    }, () => {});
  return () => { if (!done) { done = true; return s.stop().catch(() => {}); } };
}

async function prepImage(file) {
  const img = await new Promise((res, rej) => {
    const i = new Image(); const u = URL.createObjectURL(file);
    i.onload = () => { URL.revokeObjectURL(u); res(i); }; i.onerror = rej; i.src = u;
  });
  const s = Math.min(2.5, 2000 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.6)';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export async function readLabel(file, onProgress) {
  onProgress?.('Loading reader…');
  await loadScript(TESS);
  const canvas = await prepImage(file);
  const { data } = await window.Tesseract.recognize(canvas, 'eng', {
    logger: m => { if (m.status === 'recognizing text') onProgress?.(`Reading label… ${Math.round(m.progress * 100)}%`); },
  });
  return parseLabel(data.text);
}

export function parseLabel(raw) {
  const t = raw.toLowerCase()
    .replace(/[|]/g, ' ')
    .replace(/(\s)[o]\s?g\b/g, '$10g')        // "Og" -> "0g"
    .replace(/(\d)\s?[o]\s?g\b/g, '$10g')
    .replace(/<\s?1\s?g/g, '0.5g');
  const N = '(\\d+(?:[.,]\\d+)?)';
  const grab = re => { const m = t.match(re); return m ? parseFloat(m[1].replace(',', '.')) : null; };
  return {
    servingG: grab(new RegExp(`serving size[^\\n]*?\\(?\\s*${N}\\s*g\\b`)) ?? grab(new RegExp(`\\(\\s*${N}\\s*g\\s*\\)`)),
    cal: grab(/calories[^\d]{0,15}(\d{1,4})/),
    f: grab(new RegExp(`total\\s*fat[^\\d\\n]{0,6}${N}\\s*g`)),
    c: grab(new RegExp(`total\\s*carb\\w*\\.?[^\\d\\n]{0,6}${N}\\s*g`)),
    p: grab(new RegExp(`protein[^\\d\\n]{0,6}${N}\\s*g`)),
    fiber: grab(new RegExp(`fib(?:er|re)[^\\d\\n]{0,6}${N}\\s*g`)),
    sugar: grab(new RegExp(`sugars?[^\\d\\n]{0,6}${N}\\s*g`)),
    sodium: grab(new RegExp(`sodium[^\\d\\n]{0,6}${N}\\s*mg`)),
  };
}
