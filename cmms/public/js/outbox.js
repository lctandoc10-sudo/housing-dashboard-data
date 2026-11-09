// Upload queue for progress reports. A submitted report and its photos are first saved on the
// phone (IndexedDB), then sent to the server. If the signal drops, they stay on the phone and are
// sent automatically when the connection is back. The report and every photo carry an idempotency
// key, so a retry after a lost response never creates a duplicate on the server.
import { api, state, uid } from './ui.js';

const DB_NAME = 'cmms-outbox';
const STORE = 'progress';
let dbp = null;
const memory = new Map(); // fallback when IndexedDB is unavailable (e.g. some private-browsing modes)

function idb() {
  if (!dbp) {
    dbp = new Promise(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const db = await idb();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Saving on this phone failed'));
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function put(item) { return tx('readwrite', s => (s ? reqP(s.put(item)) : memory.set(item.id, item))); }
async function del(id) { return tx('readwrite', s => (s ? reqP(s.delete(id)) : memory.delete(id))); }
export async function all() {
  const items = await tx('readonly', s => (s ? reqP(s.getAll()) : [...memory.values()]));
  return (items || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export async function get(id) { return tx('readonly', s => (s ? reqP(s.get(id)) : memory.get(id))); }
export async function isPersistent() { return !!(await idb()); }

// ---------------------------------------------------------------- change notifications
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch { /* listener errors must not stop the queue */ } } }

/** Items that belong to the signed-in user and still need to be sent or looked at. */
export async function mine() { return state.me ? (await all()).filter(i => i.user_id === state.me.id) : []; }

// ---------------------------------------------------------------- photos
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot read this image')); };
    img.src = url;
  });
}
/**
 * Resize a phone photo (max 1920 px, JPEG) and optionally stamp site, date and time on it.
 * A 4–10 MB camera photo becomes about 300–600 KB, which uploads on a weak signal.
 * If the browser cannot decode the format, the original file is sent instead.
 */
export async function preparePhoto(file, { stamp } = {}) {
  try {
    const img = await loadImage(file);
    const max = 1920;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    if (stamp) {
      const fs = Math.max(14, Math.round(Math.min(w, h) * 0.028));
      const pad = Math.round(fs * 0.6);
      const lines = stamp.filter(Boolean);
      const boxH = lines.length * fs * 1.3 + pad * 2;
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(0, h - boxH, w, boxH);
      g.fillStyle = '#fff';
      g.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
      g.textBaseline = 'top';
      lines.forEach((t, i) => g.fillText(t, pad, h - boxH + pad + i * fs * 1.3, w - pad * 2));
    }
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
    if (!blob) throw new Error('encode failed');
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '').replace(/[^\w.\- ()]/g, '_').slice(0, 80) || 'photo';
    return { blob, name: `${base}.jpg`, type: 'image/jpeg' };
  } catch {
    return { blob: file, name: file.name || 'photo.jpg', type: file.type || 'image/jpeg' };
  }
}

// ---------------------------------------------------------------- queue
/**
 * Save a report with its prepared photos on this phone. Returns the queue id.
 * photos: [{ blob, name, type, caption, taken_at }]
 */
export async function enqueue(report, photos, id = report.client_request_id) {
  const item = {
    id, user_id: state.me.id, user_name: state.me.full_name, created_at: new Date().toISOString(),
    report: { ...report, client_request_id: id }, server_id: null, report_no: null,
    photos: photos.map(p => ({ cid: p.cid || uid(), blob: p.blob, name: p.name, type: p.type, caption: p.caption || '', taken_at: p.taken_at || null, done: false, error: null })),
    state: 'pending', error: null, error_kind: null, duplicates: null, attempts: 0, last_error: null,
  };
  await put(item);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* best effort */ }
  emit({ type: 'queued', item });
  return item.id;
}
export async function discard(id) { await del(id); emit({ type: 'discarded', id }); }
/** Put an item that needed attention back into the queue, optionally changing the report. */
export async function retry(id, patch = {}) {
  const it = await get(id);
  if (!it) return;
  Object.assign(it.report, patch);
  it.state = 'pending'; it.error = null; it.error_kind = null; it.duplicates = null;
  for (const p of it.photos) if (!p.done) p.error = null;
  await put(it);
  emit({ type: 'queued', item: it });
  return sync();
}
/** Drop photos the server refused, keeping the report that was already saved. */
export async function dropFailedPhotos(id) {
  const it = await get(id);
  if (!it) return;
  it.photos = it.photos.filter(p => p.done);
  await put(it);
  return retry(id);
}

const results = new Map(); // queue id -> { server_id, report_no, photos }
export const result = id => results.get(id);

const transient = e => !e.status || e.status >= 500 || e.status === 401 || e.status === 408 || e.status === 429;

async function sendItem(it) {
  try {
    if (!it.server_id) {
      const r = await api('/progress-reports', { method: 'POST', body: it.report });
      it.server_id = r.id; it.report_no = r.report_no; it.last_error = null;
      await put(it);
      emit({ type: 'progress', item: it });
    }
    for (const p of it.photos) {
      if (p.done) continue;
      const fd = new FormData();
      fd.append('file', p.blob, p.name);
      fd.append('client_photo_id', p.cid);
      if (p.caption) fd.append('caption', p.caption);
      if (p.taken_at) fd.append('taken_at', p.taken_at);
      try {
        await api(`/progress-reports/${it.server_id}/photos`, { method: 'POST', body: fd });
        p.done = true; p.blob = null; p.error = null; // free the phone's storage as soon as the server has it
      } catch (e) {
        if (transient(e)) throw e;
        p.error = e.message;
      }
      await put(it);
      emit({ type: 'progress', item: it });
    }
    const failed = it.photos.filter(p => !p.done);
    if (!failed.length) {
      await del(it.id);
      results.set(it.id, { server_id: it.server_id, report_no: it.report_no, photos: it.photos.length });
      emit({ type: 'done', item: it });
      return 'done';
    }
    it.state = 'attention'; it.error_kind = 'photos';
    it.error = `The report ${it.report_no} is saved, but ${failed.length} photo(s) were refused: ${[...new Set(failed.map(p => p.error))].join('; ')}`;
    await put(it);
    emit({ type: 'attention', item: it });
    return 'attention';
  } catch (e) {
    it.attempts += 1; it.last_error = e.message;
    if (transient(e)) { await put(it); emit({ type: 'waiting', item: it }); return 'offline'; }
    it.state = 'attention'; it.error = e.message;
    it.error_kind = e.status === 409 && e.details && e.details.duplicates ? 'duplicate' : 'invalid';
    it.duplicates = it.error_kind === 'duplicate' ? e.details.duplicates : null;
    await put(it);
    emit({ type: 'attention', item: it });
    return 'attention';
  }
}

let running = null, again = false;
/** Send everything this user has waiting. Concurrent calls share one run. */
export function sync() {
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      if (!state.me) return;
      for (const it of await mine()) {
        if (it.state !== 'pending') continue;
        const r = await sendItem(it);
        if (r === 'offline') return; // no connection: stop here and try again later
      }
    } while (again);
  })().catch(() => { /* storage errors are retried on the next run */ }).finally(() => { running = null; emit({ type: 'synced' }); });
  return running;
}

let started = false;
/** Retry automatically: when the phone reconnects, when the app comes back to the screen, and every 30 s. */
export function start() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(async () => { if ((await mine()).some(i => i.state === 'pending')) sync(); }, 30000);
  sync();
}
