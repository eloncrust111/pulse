// Optional Supabase cloud sync. Pull newer rows, then push local changes.
// Conflicts resolve by newest updatedAt (last edit wins).
import { CONFIG } from '../config.js';
import * as db from './db.js';

export const enabled = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
const TABLE = 'pulse_records';
let client = null, user = null, timer = null, running = false, again = false;
export let status = 'idle';
const statusFns = new Set();
export const onStatus = fn => statusFns.add(fn);
const setStatus = s => { status = s; statusFns.forEach(f => f(s)); };

async function sb() {
  if (!client) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return client;
}

const redirect = () => location.origin + location.pathname;
export const currentUser = () => user;

export async function getUser(onRecovery) {
  const c = await sb();
  c.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') onRecovery?.(); });
  const { data } = await c.auth.getSession();
  user = data.session?.user || null;
  return user;
}

export async function signIn(email, password) {
  const { data, error } = await (await sb()).auth.signInWithPassword({ email, password });
  if (error) throw error;
  return (user = data.user);
}

export async function signUp(email, password) {
  const { data, error } = await (await sb()).auth.signUp({ email, password, options: { emailRedirectTo: redirect() } });
  if (error) throw error;
  user = data.session ? data.user : null;
  return { user, needsConfirm: !data.session };
}

export async function resetPassword(email) {
  const { error } = await (await sb()).auth.resetPasswordForEmail(email, { redirectTo: redirect() });
  if (error) throw error;
}

export async function setPassword(password) {
  const { error } = await (await sb()).auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  await (await sb()).auth.signOut();
  user = null;
}

export function schedule(ms = 1500) {
  if (!enabled || !user) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export async function syncNow() {
  if (!enabled || !user) return;
  if (running) { again = true; return; }
  running = true;
  setStatus('syncing');
  try {
    await pull();
    await push();
    setStatus('ok');
  } catch (e) {
    console.warn('sync failed', e);
    setStatus(navigator.onLine ? 'error' : 'offline');
  } finally {
    running = false;
    if (again) { again = false; schedule(300); }
  }
}

async function pull() {
  const c = await sb();
  let since = (await db.getMeta('syncedAt')) || '1970-01-01T00:00:00Z';
  for (;;) {
    const { data, error } = await c.from(TABLE).select('kind,id,data,deleted,updated_at,synced_at')
      .gte('synced_at', since).order('synced_at').limit(1000);
    if (error) throw error;
    await db.applyRemote(data.map(r => ({ kind: r.kind, id: r.id, data: r.data, deleted: r.deleted, updatedAt: Number(r.updated_at) })));
    const last = data.length ? data[data.length - 1].synced_at : since;
    const moved = last !== since;
    since = last;
    if (data.length < 1000 || !moved) break;
  }
  await db.setMeta('syncedAt', since);
}

async function push() {
  const c = await sb();
  const d = db.dirty();
  for (let i = 0; i < d.length; i += 200) {
    const chunk = d.slice(i, i + 200);
    const rows = chunk.map(r => ({ user_id: user.id, kind: r.kind, id: r.id, data: r.data, deleted: r.deleted, updated_at: r.updatedAt }));
    const { error } = await c.from(TABLE).upsert(rows, { onConflict: 'user_id,kind,id' });
    if (error) throw error;
    await db.markClean(chunk);
  }
}
