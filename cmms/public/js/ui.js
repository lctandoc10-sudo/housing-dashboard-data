// Shared UI helpers: DOM builder, API client, formatting, forms, tables, modals.
export const state = { me: null, meta: null };

// ---------------------------------------------------------------- DOM
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v; // only used with trusted static markup
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function mount(el, ...children) { el.replaceChildren(); append(el, children); return el; }
export const $ = sel => document.querySelector(sel);

// ---------------------------------------------------------------- API
export class ApiError extends Error { constructor(status, msg, details) { super(msg); this.status = status; this.details = details; } }
export async function api(path, { method = 'GET', body, query, raw } = {}) {
  let url = '/api' + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    const s = qs.toString(); if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, 'Network error – the change was NOT saved. Check your connection and try again.'); }
  if (res.status === 401 && !path.startsWith('/auth/login')) { state.me = null; if (location.hash !== '#/login') location.hash = '#/login'; throw new ApiError(401, 'Session expired. Please sign in again.'); }
  if (raw) { if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || res.statusText); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText, data.details);
  return data;
}
export async function download(path, query) {
  const res = await api(path, { query, raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = (cd.match(/filename="([^"]+)"/) || [])[1] || 'download';
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export const can = p => !!state.me && state.me.permissions.includes(p);
export const canAny = (...ps) => ps.some(can);

// ---------------------------------------------------------------- formatting (Asia/Manila)
const TZ = 'Asia/Manila';
export const fmt = {
  date(v) { if (!v) return '—'; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T00:00:00+08:00').toLocaleDateString('en-PH', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' }); return new Date(v).toLocaleDateString('en-PH', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' }); },
  dt(v) { return v ? new Date(v).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; },
  money(v) { return v == null ? '—' : '₱' + Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  num(v, d = 1) { return v == null || v === '' ? '—' : Number(v).toLocaleString('en-PH', { maximumFractionDigits: d }); },
  hours(v) { return v == null ? '—' : `${Number(v).toLocaleString('en-PH', { maximumFractionDigits: 1 })} h`; },
};
export function todayManila() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
export function addDays(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
/** Value for <input type=datetime-local> in Manila time. */
export function toLocalInput(iso) { if (!iso) return ''; return new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 16); }

const ASSET_STATUS_CLASS = { AVAILABLE: 'b-ok', OPERATIONAL: 'b-ok', STANDBY: 'b-grey', RUNNING_RESTRICTED: 'b-warn', UNDER_PM: 'b-info', UNDER_CM: 'b-purple', BREAKDOWN: 'b-bad', WAITING_PARTS: 'b-warn', WAITING_EXTERNAL: 'b-warn', FOR_TESTING: 'b-info', DECOMMISSIONED: 'b-grey' };
export function assetBadge(code) {
  const s = state.meta && state.meta.asset_statuses.find(x => x.code === code);
  return h('span', { class: 'badge ' + (ASSET_STATUS_CLASS[code] || ''), title: s ? s.desc : '' }, s ? s.label : code);
}
const WO_CLASS = { REPORTED: 'b-bad', SCHEDULED: 'b-grey', UNDER_ASSESSMENT: 'b-warn', ASSIGNED: 'b-info', IN_PROGRESS: 'b-purple', WAITING_PARTS: 'b-warn', WAITING_EXTERNAL: 'b-warn', FOR_TESTING: 'b-info', FOR_VERIFICATION: 'b-info', CLOSED: 'b-ok', CANCELLED: 'b-grey', MISSED: 'b-bad' };
export function woBadge(code) {
  const s = state.meta && state.meta.wo_statuses.find(x => x.code === code);
  return h('span', { class: 'badge ' + (WO_CLASS[code] || 'b-grey'), title: s ? s.description || '' : '' }, s ? s.label : code);
}
const PRIO_CLASS = { CRITICAL: 'b-bad', HIGH: 'b-warn', MEDIUM: 'b-info', LOW: 'b-grey' };
export const prioBadge = p => h('span', { class: 'badge ' + (PRIO_CLASS[p] || '') }, p ? p[0] + p.slice(1).toLowerCase() : '—');
export const typeBadge = t => h('span', { class: 'badge ' + ({ PMS: 'b-info', CM: 'b-purple', INSPECTION: 'b-grey', OTHER: 'b-grey' }[t] || '') }, t === 'CM' ? 'Corrective' : t === 'PMS' ? 'PMS' : t ? t[0] + t.slice(1).toLowerCase() : '');
export const label = s => (s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
export function codeLabel(kind, code) { const f = state.meta.failure_codes.find(x => x.kind === kind && x.code === code); return f ? f.label : code || '—'; }
export const siteName = id => (state.meta.all_sites.find(s => s.id === Number(id)) || {}).name || '—';

// ---------------------------------------------------------------- feedback
export function toast(msg, type = '') {
  const t = h('div', { class: 'toast ' + type, role: type === 'err' ? 'alert' : 'status' }, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 8000 : 4000);
}
export function errorBox(e) { return h('div', { class: 'alert err' }, e.message || String(e)); }

/** Run an async action with a busy button; shows errors, never a false success. */
export async function act(btn, fn, okMsg) {
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; }
  catch (e) { if (e.status !== 401) toast(e.message, 'err'); throw e; }
  finally { if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------------- modal
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const footer = h('footer', null, ...actions.map(a => h('button', { class: 'btn ' + (a.class || ''), type: 'button', onclick: async ev => {
    if (!a.onClick) return close();
    const btn = ev.currentTarget;
    btn.disabled = true;
    try { const keep = await a.onClick(); if (keep !== false) close(); }
    catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  } }, a.label)));
  const m = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('header', null, title, h('button', { class: 'icon-btn x', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'body' }, body), actions.length ? footer : null);
  back.appendChild(m);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.body.appendChild(back);
  const first = m.querySelector('input, select, textarea'); if (first) setTimeout(() => first.focus(), 30);
  return { close, el: m };
}
export function confirmDialog(message, { title = 'Please confirm', okLabel = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    let decided = false;
    modal({ title, body: h('p', null, message), onClose: () => { if (!decided) resolve(false); },
      actions: [{ label: 'Cancel' }, { label: okLabel, class: danger ? 'btn-danger' : 'btn-primary', onClick: () => { decided = true; resolve(true); } }] });
  });
}

// ---------------------------------------------------------------- forms
/**
 * fields: [{ name, label, type: text|number|date|datetime|select|textarea|checkbox|password|multiselect, options:[{value,label}]|fn, required, hint, full, attrs }]
 */
export function form(fields, values = {}) {
  const inputs = {};
  const el = h('div', { class: 'form-grid' });
  for (const f of fields) {
    if (f.type === 'heading') { el.appendChild(h('h3', { class: 'full' }, f.label)); continue; }
    let input;
    const v = values[f.name];
    if (f.type === 'select') {
      const opts = typeof f.options === 'function' ? f.options(values) : f.options;
      input = h('select', { name: f.name }, f.required && v != null ? null : h('option', { value: '' }, f.placeholder || '— select —'),
        ...opts.map(o => h('option', { value: o.value, selected: String(o.value) === String(v ?? '') }, o.label)));
    } else if (f.type === 'multiselect') {
      const opts = typeof f.options === 'function' ? f.options(values) : f.options;
      const sel = new Set((v || []).map(String));
      input = h('div', { class: 'multi' }, ...opts.map(o => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: o.value, checked: sel.has(String(o.value)) }), o.label)));
      input.getValue = () => [...input.querySelectorAll('input:checked')].map(i => (isNaN(i.value) ? i.value : Number(i.value)));
    } else if (f.type === 'textarea') input = h('textarea', { name: f.name, rows: f.rows || 3 }, v ?? '');
    else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', name: f.name, checked: !!v });
    else input = h('input', { name: f.name, type: f.type === 'datetime' ? 'datetime-local' : f.type || 'text', value: f.type === 'datetime' ? toLocalInput(v) : (v ?? ''), step: f.step, min: f.min, max: f.max, autocomplete: f.autocomplete || 'off', inputmode: f.type === 'number' ? 'decimal' : null });
    if (f.attrs) for (const [k, a] of Object.entries(f.attrs)) input.setAttribute(k, a);
    if (f.onChange) input.addEventListener('change', () => f.onChange(input, inputs));
    inputs[f.name] = input;
    const wrap = f.type === 'checkbox'
      ? h('label', { class: 'check' + (f.full ? ' full' : '') }, input, f.label)
      : h('div', { class: 'field' + (f.full ? ' full' : '') }, h('label', null, f.label, f.required ? h('span', { class: 'req' }, ' *') : null), input, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    if (f.hidden) wrap.hidden = true;
    el.appendChild(wrap);
  }
  el.values = () => {
    const out = {};
    for (const f of fields) {
      if (f.type === 'heading') continue;
      const i = inputs[f.name];
      if (f.type === 'checkbox') out[f.name] = i.checked;
      else if (f.type === 'multiselect') out[f.name] = i.getValue();
      else if (f.type === 'number') out[f.name] = i.value === '' ? null : Number(i.value);
      else out[f.name] = i.value === '' ? null : i.value;
    }
    for (const f of fields) if (f.required && (out[f.name] == null || out[f.name] === '') && !inputs[f.name].closest('[hidden]')) throw new ApiError(400, `${f.label} is required`);
    return out;
  };
  el.inputs = inputs;
  return el;
}
export const opt = (rows, v = 'id', l = 'name') => rows.map(r => ({ value: r[v], label: typeof l === 'function' ? l(r) : r[l] }));
export const enumOpts = list => list.map(x => ({ value: x, label: label(x) }));
export const siteOpts = () => opt(state.meta.sites.filter(s => s.is_active));

// ---------------------------------------------------------------- tables
/**
 * Server-paginated table. columns: [{ key, label, render(row), sort, num, cls }]
 * fetch(params) -> { rows, total }
 */
export function dataTable({ columns, fetch, onRow, rowClass, pageSize = 50, defaultSort, empty = 'No records found' }) {
  const st = { page: 1, sort: defaultSort || '', extra: {} };
  const tbody = h('tbody');
  const info = h('span');
  const prev = h('button', { class: 'btn btn-sm', onclick: () => { st.page--; load(); } }, '‹ Prev');
  const next = h('button', { class: 'btn btn-sm', onclick: () => { st.page++; load(); } }, 'Next ›');
  const headRow = h('tr', null, ...columns.map(c => {
    const th = h('th', { class: (c.sort ? 'sortable ' : '') + (c.num ? 'num' : '') }, c.label);
    if (c.sort) th.addEventListener('click', () => { st.sort = st.sort === c.sort ? '-' + c.sort : c.sort; st.page = 1; load(); });
    return th;
  }));
  const table = h('table', { class: 'data' }, h('thead', null, headRow), tbody);
  const el = h('div', null, h('div', { class: 'table-wrap' }, table), h('div', { class: 'pager' }, info, prev, next));
  let seq = 0;
  async function load() {
    const my = ++seq;
    mount(tbody, h('tr', null, h('td', { colspan: columns.length, class: 'loading' }, 'Loading…')));
    try {
      const r = await fetch({ page: st.page, page_size: pageSize, sort: st.sort, ...st.extra });
      if (my !== seq) return;
      const rows = Array.isArray(r) ? r : r.rows;
      const total = Array.isArray(r) ? rows.length : r.total;
      mount(tbody, rows.length ? rows.map(row => {
        const tr = h('tr', { class: (onRow ? 'clickable ' : '') + (rowClass ? rowClass(row) || '' : '') }, ...columns.map(c => h('td', { class: (c.num ? 'num ' : '') + (c.cls || '') }, c.render ? c.render(row) : (row[c.key] ?? '—'))));
        if (onRow) tr.addEventListener('click', e => { if (!e.target.closest('a,button')) onRow(row); });
        return tr;
      }) : h('tr', null, h('td', { colspan: columns.length, class: 'empty' }, empty)));
      const pages = Math.max(1, Math.ceil(total / pageSize));
      info.textContent = `${total} record${total === 1 ? '' : 's'} · page ${st.page} of ${pages}`;
      prev.disabled = st.page <= 1; next.disabled = st.page >= pages;
    } catch (e) { mount(tbody, h('tr', null, h('td', { colspan: columns.length }, errorBox(e)))); }
  }
  el.reload = (extra) => { if (extra) { st.extra = extra; st.page = 1; } return load(); };
  return el;
}
/** Simple client-side table for small arrays. */
export function simpleTable(columns, rows, { onRow, empty = 'None', rowClass } = {}) {
  if (!rows || !rows.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, ...columns.map(c => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', null, ...rows.map(r => {
      const tr = h('tr', { class: (onRow ? 'clickable ' : '') + (rowClass ? rowClass(r) || '' : '') }, ...columns.map(c => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : (r[c.key] ?? '—'))));
      if (onRow) tr.addEventListener('click', e => { if (!e.target.closest('a,button,input,select')) onRow(r); });
      return tr;
    }))));
}
export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function tabs(defs, initial) {
  const body = h('div');
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const show = key => {
    for (const b of bar.children) b.classList.toggle('active', b.dataset.key === key);
    const d = defs.find(x => x.key === key);
    mount(body, typeof d.render === 'function' ? d.render() : d.render);
  };
  for (const d of defs) if (d.show !== false) bar.appendChild(h('button', { type: 'button', 'data-key': d.key, onclick: () => show(d.key) }, d.label));
  const el = h('div', null, bar, body);
  show(initial || defs.find(d => d.show !== false).key);
  el.show = show;
  return el;
}
export function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null), actions.length ? h('div', { class: 'actions no-print' }, ...actions) : null);
}
export function kv(pairs) { return h('dl', { class: 'kv' }, ...pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v == null || v === '' ? '—' : v)])); }
/** Common filter bar: date range + site (+ extras). Calls onChange(values). */
export function filterBar({ dates = true, site = true, category = false, woType = false, extras = [], onChange, initial = {} }) {
  const to = initial.to || todayManila();
  const from = initial.from || addDays(to, -29);
  const fields = [];
  if (dates) fields.push(h('div', { class: 'field' }, h('label', null, 'From'), h('input', { type: 'date', name: 'from', value: from })), h('div', { class: 'field' }, h('label', null, 'To'), h('input', { type: 'date', name: 'to', value: to })));
  if (site) fields.push(h('div', { class: 'field' }, h('label', null, 'Project / site'), h('select', { name: 'site_id' }, h('option', { value: '' }, 'All permitted sites'), ...state.meta.sites.map(s => h('option', { value: s.id, selected: String(initial.site_id) === String(s.id) }, s.name)))));
  if (category) fields.push(h('div', { class: 'field' }, h('label', null, 'Equipment category'), h('select', { name: 'category_id' }, h('option', { value: '' }, 'All'), ...state.meta.categories.map(c => h('option', { value: c.id }, c.name)))));
  if (woType) fields.push(h('div', { class: 'field' }, h('label', null, 'Maintenance type'), h('select', { name: 'wo_type' }, h('option', { value: '' }, 'All'), ...['PMS', 'CM', 'INSPECTION', 'OTHER'].map(t => h('option', { value: t }, t === 'CM' ? 'Corrective' : label(t))))));
  fields.push(...extras);
  const el = h('div', { class: 'toolbar panel no-print' }, ...fields);
  el.values = () => Object.fromEntries([...el.querySelectorAll('input,select')].filter(i => i.name).map(i => [i.name, i.value || undefined]));
  el.addEventListener('change', () => onChange(el.values()));
  return el;
}
export function assetPicker({ value, siteId, onPick, placeholder = 'Search equipment ID, name, serial or plate…' } = {}) {
  const input = h('input', { type: 'search', placeholder, autocomplete: 'off' });
  const list = h('div', { class: 'panel dropdown', style: { display: 'none', position: 'absolute', zIndex: 20, left: 0, right: 0, maxHeight: '260px', overflowY: 'auto', padding: '4px' } });
  const wrap = h('div', { style: { position: 'relative' } }, input, list);
  wrap.value = value || null;
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) { list.style.display = 'none'; return; }
    const r = await api('/assets', { query: { q, page_size: 15, site_id: siteId } }).catch(() => ({ rows: [] }));
    mount(list, r.rows.length ? r.rows.map(a => h('div', { class: 'btn', style: { width: '100%', justifyContent: 'flex-start', marginBottom: '2px' }, onclick: () => {
      wrap.value = a.id; input.value = `${a.asset_code} – ${a.name}`; list.style.display = 'none'; onPick && onPick(a);
    } }, h('b', null, a.asset_code), ' ', a.name, ' ', h('span', { class: 'muted' }, `· ${a.site}`), ' ', assetBadge(a.status))) : h('div', { class: 'empty' }, 'No match'));
    list.style.display = 'block';
  }, 250);
  input.addEventListener('input', () => { wrap.value = null; search(); });
  wrap.setLabel = t => { input.value = t; };
  return wrap;
}
export function attachmentsPanel(entityType, entityId, items, { canUpload, reload }) {
  const list = items.length ? h('ul', { class: 'timeline' }, ...items.map(a => h('li', null,
    h('a', { href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener' }, a.filename), ' ', h('span', { class: 'muted' }, `${Math.round(a.size_bytes / 1024)} KB · ${fmt.dt(a.uploaded_at)}`), a.caption ? h('div', null, a.caption) : null))) : h('div', { class: 'empty' }, 'No photos or documents');
  const file = h('input', { type: 'file', accept: 'image/*,video/mp4,video/quicktime,application/pdf,.xlsx,.docx', capture: 'environment' });
  const caption = h('input', { placeholder: 'Caption (optional)' });
  const btn = h('button', { class: 'btn', onclick: async e => {
    if (!file.files[0]) return toast('Choose a file or take a photo first', 'err');
    const fd = new FormData(); fd.append('file', file.files[0]); fd.append('entity_type', entityType); fd.append('entity_id', entityId); fd.append('caption', caption.value);
    await act(e.currentTarget, () => api('/attachments', { method: 'POST', body: fd }), 'Uploaded');
    reload();
  } }, '⬆ Upload');
  return h('div', null, list, canUpload ? h('div', { class: 'toolbar mt' }, h('div', { class: 'field grow' }, h('label', null, 'Photo / document'), file), h('div', { class: 'field grow' }, h('label', null, 'Caption'), caption), btn) : null);
}
export function uid() { return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2); }
