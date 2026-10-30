// Local-first storage: everything lives in IndexedDB on the phone and is
// mirrored in memory for instant reads. Each record carries an updatedAt
// timestamp and a dirty flag so the optional cloud sync can merge changes.
import { uid } from './util.js';

export const KINDS = ['settings', 'foods', 'recipes', 'entries', 'days', 'stomach'];

const recs = Object.fromEntries(KINDS.map(k => [k, new Map()]));
const listeners = new Set();
let idb = null;

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function openIDB(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('records', { keyPath: 'key' });
      r.result.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function init(userKey) {
  if (idb) idb.close();
  KINDS.forEach(k => recs[k].clear());
  idb = await openIDB('fuel-' + userKey);
  const all = await req(idb.transaction('records').objectStore('records').getAll());
  all.forEach(r => recs[r.kind]?.set(r.id, r));
  emit('*');
}

function write(list) {
  if (!list.length) return Promise.resolve();
  const tx = idb.transaction('records', 'readwrite');
  const st = tx.objectStore('records');
  list.forEach(r => st.put(r));
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

export function onChange(fn) { listeners.add(fn); }
function emit(kind) { listeners.forEach(fn => { try { fn(kind); } catch (e) { console.error(e); } }); }

export function list(kind) {
  const out = [];
  for (const r of recs[kind].values()) if (!r.deleted) out.push(r.data);
  return out;
}

export function get(kind, id) {
  const r = recs[kind].get(id);
  return r && !r.deleted ? r.data : undefined;
}

function makeRec(kind, data) {
  if (!data.id) data.id = uid();
  return { key: kind + ':' + data.id, kind, id: data.id, data, updatedAt: Date.now(), deleted: false, dirty: true };
}

export function put(kind, data) {
  const r = makeRec(kind, data);
  recs[kind].set(r.id, r);
  write([r]);
  emit(kind);
  return data;
}

export function putMany(kind, items) {
  const rs = items.map(d => makeRec(kind, d));
  rs.forEach(r => recs[kind].set(r.id, r));
  write(rs);
  emit(kind);
}

export function remove(kind, id) {
  const old = recs[kind].get(id);
  if (!old) return;
  const r = { ...old, data: null, deleted: true, updatedAt: Date.now(), dirty: true };
  recs[kind].set(id, r);
  write([r]);
  emit(kind);
}

export function dirty() {
  const out = [];
  KINDS.forEach(k => { for (const r of recs[k].values()) if (r.dirty) out.push(r); });
  return out;
}

export async function markClean(list) {
  const changed = [];
  for (const r of list) {
    const cur = recs[r.kind]?.get(r.id);
    if (cur && cur.updatedAt === r.updatedAt && cur.dirty) { cur.dirty = false; changed.push(cur); }
  }
  await write(changed);
}

// Merge rows from the cloud (or a backup file). Newest updatedAt wins.
export async function applyRemote(rows, { markDirty = false } = {}) {
  const changed = [];
  for (const row of rows) {
    if (!recs[row.kind]) continue;
    const cur = recs[row.kind].get(row.id);
    if (cur && cur.updatedAt >= row.updatedAt) continue;
    const r = { key: row.kind + ':' + row.id, kind: row.kind, id: row.id, data: row.deleted ? null : row.data,
      updatedAt: row.updatedAt, deleted: !!row.deleted, dirty: markDirty };
    recs[row.kind].set(row.id, r);
    changed.push(r);
  }
  await write(changed);
  if (changed.length) emit('*');
  return changed.length;
}

export function allRecords() {
  const out = [];
  KINDS.forEach(k => { for (const r of recs[k].values()) if (!r.deleted) out.push({ kind: r.kind, id: r.id, data: r.data, updatedAt: r.updatedAt }); });
  return out;
}

export async function getMeta(k) {
  const r = await req(idb.transaction('meta').objectStore('meta').get(k));
  return r?.v;
}

export async function setMeta(k, v) {
  const tx = idb.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ k, v });
  return new Promise(res => { tx.oncomplete = res; });
}
