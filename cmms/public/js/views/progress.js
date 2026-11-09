// Site progress reports: phone form with camera, register, detail with photos, monthly summary, upload queue.
import { h, mount, api, state, can, fmt, toast, act, modal, confirmDialog, form, dataTable, pageHead, kv, filterBar, errorBox, download, uid, todayManila, label, ApiError } from '../ui.js';
import * as outbox from '../outbox.js';

const fields = () => state.meta.progress.fields;
const WEATHER_LABEL = { SUNNY: '☀ Sunny', CLOUDY: '☁ Cloudy', RAINY: '🌧 Rainy', STORMY: '⛈ Stormy' };
const siteLabel = id => (state.meta.sites.find(s => s.id === Number(id)) || {}).name || '—';
const photoUrl = id => `/api/attachments/${id}`;
const LAST_SITE = 'cmms_progress_site';
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* not available */ } } };
const stampTime = d => new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function seg(options, value, onPick) {
  const btns = {};
  const el = h('div', { class: 'seg', style: { flexWrap: 'wrap' } }, ...options.map(([v, t]) => {
    const b = h('button', { type: 'button', class: v === value ? 'on PASS' : '', onclick: () => {
      const off = el.value === v;
      for (const x of Object.values(btns)) x.classList.remove('on', 'PASS');
      el.value = off ? null : v;
      if (!off) b.classList.add('on', 'PASS');
      onPick && onPick(el.value);
    } }, t);
    btns[v] = b; return b;
  }));
  el.value = value || null;
  return el;
}

/** Pending-upload banner for the top of progress screens. */
async function queueBanner() {
  const items = await outbox.mine();
  if (!items.length) return null;
  const attention = items.filter(i => i.state === 'attention').length;
  const pending = items.length - attention;
  return h('div', { class: 'alert ' + (attention ? 'err' : 'warn') + ' no-print' },
    pending ? `⏳ ${pending} report${pending === 1 ? '' : 's'} saved on this phone, waiting to upload. They are sent automatically when there is signal. ` : '',
    attention ? `⚠ ${attention} report${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} your attention. ` : '',
    h('a', { href: '#/progress/outbox' }, 'Open upload queue'));
}

// ---------------------------------------------------------------- new report (phone first)
export async function create(el, q = {}) {
  const draft = q.draft ? await outbox.get(q.draft) : null;
  if (q.draft && (!draft || draft.server_id)) { location.hash = '#/progress/outbox'; return; }
  const r0 = draft ? draft.report : {};
  const requestId = draft ? draft.id : uid();
  const sites = state.meta.sites.filter(s => s.is_active);
  if (!sites.length) return mount(el, pageHead('New progress report'), h('div', { class: 'alert err' }, 'You have no project or site assigned. Ask an administrator to give you access to your site.'));
  const lastSite = store.get(LAST_SITE);
  const defaultSite = r0.site_id || (sites.length === 1 ? sites[0].id : sites.some(s => String(s.id) === lastSite) ? Number(lastSite) : '');

  const head = form([
    { name: 'site_id', label: 'Project / site', type: 'select', required: true, options: sites.map(s => ({ value: s.id, label: s.name })) },
    { name: 'report_date', label: 'Date of the work', type: 'date', required: true, max: todayManila() },
    { name: 'area', label: 'Area (block / lot / phase / line)' },
  ], { site_id: defaultSite || null, report_date: r0.report_date || todayManila(), area: r0.area });
  head.inputs.area.placeholder = 'e.g. Phase 2, Blk 14 Lots 1–8';
  const weather = seg(state.meta.progress.weather.map(w => [w, WEATHER_LABEL[w] || label(w)]), r0.weather);

  // photos: kept in memory as taken; resized and stamped when the report is submitted
  const photos = draft ? draft.photos.map(p => ({ cid: p.cid, file: p.blob, prepared: true, name: p.name, type: p.type, caption: p.caption, taken_at: p.taken_at })) : [];
  const grid = h('div', { class: 'photo-grid' });
  const count = h('span', { class: 'muted' });
  const urls = new Map();
  const thumbUrl = p => { if (!urls.has(p)) urls.set(p, URL.createObjectURL(p.file)); return urls.get(p); };
  function renderPhotos() {
    count.textContent = photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'No photos yet';
    mount(grid, photos.map(p => h('figure', { class: 'photo' },
      h('img', { src: thumbUrl(p), alt: p.caption || 'Progress photo' }),
      h('button', { type: 'button', class: 'photo-x', 'aria-label': 'Remove photo', onclick: () => { photos.splice(photos.indexOf(p), 1); URL.revokeObjectURL(urls.get(p)); urls.delete(p); renderPhotos(); } }, '✕'),
      h('input', { class: 'photo-cap', placeholder: 'Caption (optional)', value: p.caption || '', oninput: e => { p.caption = e.target.value; } }))));
  }
  const max = state.meta.progress.max_photos;
  function addFiles(list) {
    for (const f of list) {
      if (!f.type.startsWith('image/') && !/\.(heic|jpe?g|png|webp)$/i.test(f.name)) { toast(`${f.name}: only photos can be added`, 'err'); continue; }
      if (photos.length >= max) { toast(`A report can hold at most ${max} photos`, 'err'); break; }
      photos.push({ cid: uid(), file: f, prepared: false, caption: '', taken_at: f.lastModified ? new Date(f.lastModified).toISOString() : new Date().toISOString() });
    }
    renderPhotos();
  }
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: e => { addFiles([...e.target.files]); e.target.value = ''; } });
  const gallery = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: e => { addFiles([...e.target.files]); e.target.value = ''; } });
  const stampBox = h('input', { type: 'checkbox', checked: store.get('cmms_progress_stamp') !== '0', onchange: e => store.set('cmms_progress_stamp', e.target.checked ? '1' : '0') });
  renderPhotos();

  const narrative = form([
    { name: 'work_done', label: 'Work accomplished', type: 'textarea', required: true, full: true, rows: 4 },
    { name: 'issues', label: 'Issues, delays or safety concerns', type: 'textarea', full: true, rows: 2 },
    { name: 'next_plan', label: 'Plan for the next working day', type: 'textarea', full: true, rows: 2 },
  ], r0);
  narrative.inputs.work_done.placeholder = 'e.g. Installed 6 FTB at Blk 14; poured 18 wall panels on line 2';
  const qty = form(fields().map(f => ({ name: f.key, label: f.label, type: 'number', min: 0, step: f.int ? 1 : 0.001 })), r0);
  for (const f of fields()) if (f.int) qty.inputs[f.key].setAttribute('inputmode', 'numeric');

  // optional GPS location (asked only when the user taps the button)
  let loc = r0.latitude != null ? { latitude: r0.latitude, longitude: r0.longitude, location_accuracy_m: r0.location_accuracy_m } : null;
  const locInfo = h('span', { class: 'muted' });
  const locBtn = h('button', { type: 'button', class: 'btn' }, '📍 Add my location');
  const showLoc = () => { locInfo.textContent = loc ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}${loc.location_accuracy_m ? ` (±${Math.round(loc.location_accuracy_m)} m)` : ''}` : 'Not recorded'; locBtn.textContent = loc ? '✕ Remove location' : '📍 Add my location'; };
  locBtn.addEventListener('click', () => {
    if (loc) { loc = null; return showLoc(); }
    if (!navigator.geolocation) return toast('This browser cannot read the location', 'err');
    locBtn.disabled = true; locInfo.textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition(p => { loc = { latitude: p.coords.latitude, longitude: p.coords.longitude, location_accuracy_m: p.coords.accuracy }; locBtn.disabled = false; showLoc(); },
      e => { locBtn.disabled = false; showLoc(); toast(`Location not available: ${e.message || 'permission denied'}`, 'err'); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  });
  showLoc();

  const status = h('div', { class: 'sub', 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn btn-primary btn-big' }, draft ? 'Save and upload again' : 'Submit progress report');
  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    let body;
    try {
      body = { ...head.values(), ...narrative.values(), ...qty.values(), weather: weather.value, ...(loc || { latitude: null, longitude: null }), client_request_id: requestId };
      for (const f of fields()) if (body[f.key] != null && (body[f.key] < 0 || (f.int && !Number.isInteger(body[f.key])))) throw new ApiError(400, `${f.label} must be ${f.int ? 'a whole number' : 'a number'} of 0 or more`);
      if (body.report_date > todayManila()) throw new ApiError(400, 'The date cannot be in the future');
    } catch (e) { return toast(e.message, 'err'); }
    body.site_id = Number(body.site_id);
    if (!photos.length && !(await confirmDialog('There are no photos on this report. Submit it without photos?', { okLabel: 'Submit without photos' }))) return;
    submit.disabled = true;
    try {
      // warn about a second report for the same site and day (it would double the quantities)
      if (navigator.onLine && !r0.confirm_duplicate) {
        const dups = await api('/progress-reports/check-duplicates', { query: { site_id: body.site_id, report_date: body.report_date } }).catch(() => []);
        if (dups.length) {
          const ok = await confirmDialog(`${siteLabel(body.site_id)} already has a progress report for ${fmt.date(body.report_date)}: ${dups.map(d => `${d.report_no} by ${d.created_by_name}${d.area ? ` (${d.area})` : ''}`).join(', ')}.\n\nSubmit another one only if it covers different work. Otherwise its quantities are counted twice.`, { okLabel: 'Submit another report' });
          if (!ok) return;
          body.confirm_duplicate = true;
        }
      } else if (r0.confirm_duplicate) body.confirm_duplicate = true;
      const stamp = stampBox.checked;
      const ready = [];
      for (const [i, p] of photos.entries()) {
        status.textContent = `Preparing photo ${i + 1} of ${photos.length}…`;
        if (p.prepared) { ready.push({ cid: p.cid, blob: p.file, name: p.name, type: p.type, caption: p.caption, taken_at: p.taken_at }); continue; }
        const out = await outbox.preparePhoto(p.file, { stamp: stamp ? [siteLabel(body.site_id) + (body.area ? ` · ${body.area}` : ''), `${stampTime(p.taken_at)} · ${state.me.full_name}`] : null });
        ready.push({ cid: p.cid, ...out, caption: p.caption, taken_at: p.taken_at });
      }
      store.set(LAST_SITE, String(body.site_id));
      if (draft) await outbox.discard(draft.id);
      const id = await outbox.enqueue(body, ready, requestId);
      status.textContent = 'Uploading…';
      const off = outbox.onChange(ev => {
        if (ev.item && ev.item.id === id && ev.type === 'progress') {
          const done = ev.item.photos.filter(p => p.done).length;
          status.textContent = ev.item.photos.length ? `Report ${ev.item.report_no} saved · uploading photos ${done} of ${ev.item.photos.length}…` : `Report ${ev.item.report_no} saved`;
        }
      });
      await outbox.sync();
      off();
      for (const u of urls.values()) URL.revokeObjectURL(u);
      const res = outbox.result(id);
      if (res) {
        toast(`${res.report_no} uploaded${res.photos ? ` with ${res.photos} photo${res.photos === 1 ? '' : 's'}` : ''}`, 'ok');
        location.hash = `#/progress/${res.server_id}`;
        return;
      }
      const it = await outbox.get(id);
      if (it && it.state === 'attention') { toast(it.error, 'err'); location.hash = '#/progress/outbox'; return; }
      toast('No connection right now. The report is saved on this phone and will upload automatically when there is signal.', 'ok');
      location.hash = '#/progress';
    } catch (e) {
      toast(`The report could not be saved on this phone: ${e.message}`, 'err');
    } finally { submit.disabled = false; status.textContent = ''; }
  });

  mount(el,
    pageHead(draft ? 'Correct progress report' : 'New progress report', 'Take photos and record the work done. The report uploads automatically; with no signal it is kept on this phone and sent later.'),
    draft && draft.error ? h('div', { class: 'alert err' }, draft.error) : null,
    h('div', { class: 'progress-form' },
      h('div', { class: 'panel' }, head, h('div', { class: 'field' }, h('label', null, 'Weather'), weather)),
      h('div', { class: 'panel' },
        h('h2', { class: 'panel-title' }, '📷 Photos ', count),
        h('div', { class: 'photo-actions' },
          h('button', { type: 'button', class: 'btn btn-primary btn-camera', onclick: () => camera.click() }, '📷 Take photo'),
          h('button', { type: 'button', class: 'btn btn-camera', onclick: () => gallery.click() }, '🖼 Choose from gallery'), camera, gallery),
        grid,
        h('label', { class: 'check mt' }, stampBox, 'Stamp site, date, time and my name on the photos'),
        h('span', { class: 'hint muted' }, 'Photos are resized on the phone before upload, so they send quickly even on a weak signal.')),
      h('div', { class: 'panel' }, narrative),
      h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, 'Quantities for this report'),
        h('p', { class: 'sub' }, 'Today\'s figures only, not running totals. Leave blank what does not apply. These add up to the monthly figures of the FTB Supply & Production workbook.'), qty),
      h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, 'Location (optional)'), h('div', { class: 'toolbar' }, locBtn, locInfo)),
      h('div', { class: 'submit-bar' }, submit, status)));
}

// ---------------------------------------------------------------- register / home
export async function list(el, q = {}) {
  const recent = await api('/progress-reports/recent').catch(() => []);
  const table = dataTable({
    columns: [
      { key: 'cover', label: '', render: r => (r.cover_photo_id ? h('img', { class: 'thumb', src: photoUrl(r.cover_photo_id), alt: '', loading: 'lazy' }) : h('div', { class: 'thumb empty-thumb' }, '📷')) },
      { key: 'report_date', label: 'Report', sort: 'report_date', render: r => [h('b', { class: 'nowrap' }, r.report_no), r.status === 'VOID' ? [' ', h('span', { class: 'badge b-grey' }, 'Void')] : null, h('div', { class: 'muted' }, fmt.date(r.report_date))] },
      { key: 'site', label: 'Site / area', sort: 'site', render: r => [r.site_name, r.area ? h('div', { class: 'muted' }, r.area) : null] },
      { key: 'work_done', label: 'Work accomplished', render: r => h('div', { class: 'clamp' }, r.work_done) },
      { key: 'ftb_installed', label: 'FTB inst.', num: true, sort: 'ftb_installed', render: r => fmt.num(r.ftb_installed, 0) },
      { key: 'volume_produced_m3', label: 'm³ prod.', num: true, render: r => fmt.num(r.volume_produced_m3, 2) },
      { key: 'photo_count', label: 'Photos', num: true },
      { key: 'by', label: 'By', render: r => r.created_by_name },
    ],
    fetch: p => api('/progress-reports', { query: p }),
    onRow: r => { location.hash = `#/progress/${r.id}`; },
    empty: 'No progress reports in this period',
  });
  const search = h('input', { type: 'search', name: 'q', placeholder: 'Report no., area or text' });
  const statusSel = h('select', { name: 'status' }, h('option', { value: '' }, 'Submitted'), h('option', { value: 'VOID' }, 'Void'), h('option', { value: 'ALL' }, 'All'));
  const bar = filterBar({ initial: { site_id: q.site_id }, extras: [h('div', { class: 'field grow' }, h('label', null, 'Search'), search), h('div', { class: 'field' }, h('label', null, 'Status'), statusSel)], onChange: v => table.reload(v) });
  search.addEventListener('search', () => table.reload(bar.values()));
  const banner = h('div');
  const refreshBanner = async () => mount(banner, await queueBanner());
  refreshBanner();
  const off = outbox.onChange(ev => { if (!banner.isConnected) return off(); if (['done', 'attention', 'synced', 'queued', 'discarded'].includes(ev.type)) { refreshBanner(); if (ev.type === 'done') table.reload(); } });
  const reported = new Map(recent.map(r => [r.site_id, r]));
  const showCoverage = can('progress.view') && state.meta.sites.length > 1;
  mount(el,
    pageHead('Site progress reports', 'Daily progress from the sites, with photos', can('progress.submit') ? h('a', { class: 'btn btn-primary', href: '#/progress/new' }, '📷 New report') : null,
      can('progress.view') ? h('a', { class: 'btn', href: '#/progress/monthly' }, 'Monthly summary') : null),
    banner,
    showCoverage ? h('div', { class: 'panel no-print' }, h('h2', { class: 'panel-title' }, 'Last 7 days'),
      h('div', { class: 'coverage' }, ...state.meta.sites.filter(s => s.is_active).map(s => {
        const r = reported.get(s.id);
        return h('div', { class: 'cov ' + (r ? 'ok' : 'none') }, h('b', null, s.name), h('span', null, r ? `${r.reports} report${r.reports === 1 ? '' : 's'} · last ${fmt.date(r.last_date)}` : 'No report'));
      }))) : null,
    bar, h('div', { class: 'panel' }, table));
  table.reload(bar.values());
}

// ---------------------------------------------------------------- detail
export async function detail(el, id) {
  const r = await api(`/progress-reports/${id}`);
  const reload = () => detail(el, id);
  const actions = [h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print / PDF')];
  if (r.can.edit) actions.push(h('button', { class: 'btn', onclick: () => editDialog(r, reload) }, '✎ Correct'));
  if (r.can.void) actions.push(h('button', { class: 'btn btn-danger', onclick: () => voidDialog(r, reload) }, 'Void'));

  const gallery = r.photos.length ? h('div', { class: 'photo-grid view' }, ...r.photos.map(p => h('figure', { class: 'photo' },
    h('a', { href: photoUrl(p.id), target: '_blank', rel: 'noopener' }, h('img', { src: photoUrl(p.id), alt: p.caption || 'Progress photo', loading: 'lazy' })),
    r.can.edit ? h('button', { type: 'button', class: 'photo-x no-print', 'aria-label': 'Remove photo', onclick: async e => {
      if (!(await confirmDialog('Remove this photo from the report?', { okLabel: 'Remove', danger: true }))) return;
      await act(e.currentTarget, () => api(`/attachments/${p.id}/delete`, { method: 'POST' }), 'Photo removed'); reload();
    } }, '✕') : null,
    h('figcaption', null, p.caption ? h('div', null, p.caption) : null, h('span', { class: 'muted' }, fmt.dt(p.taken_at || p.uploaded_at)))))) : h('div', { class: 'empty' }, 'No photos');

  let addBox = null;
  if (r.can.add_photos) {
    const status = h('span', { class: 'muted' });
    const upload = async list => {
      const files = [...list];
      for (const [i, f] of files.entries()) {
        status.textContent = `Uploading ${i + 1} of ${files.length}…`;
        const taken = f.lastModified ? new Date(f.lastModified).toISOString() : new Date().toISOString();
        const p = await outbox.preparePhoto(f, { stamp: [r.site_name + (r.area ? ` · ${r.area}` : ''), `${stampTime(taken)} · ${state.me.full_name}`] });
        const fd = new FormData(); fd.append('file', p.blob, p.name); fd.append('client_photo_id', uid()); fd.append('taken_at', taken);
        try { await api(`/progress-reports/${r.id}/photos`, { method: 'POST', body: fd }); }
        catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
      }
      status.textContent = '';
      reload();
    };
    const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: e => upload(e.target.files) });
    const gal = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: e => upload(e.target.files) });
    addBox = h('div', { class: 'photo-actions mt no-print' }, h('button', { class: 'btn', onclick: () => cam.click() }, '📷 Take photo'), h('button', { class: 'btn', onclick: () => gal.click() }, '🖼 Add from gallery'), cam, gal, status);
  }
  const q = fields().filter(f => r[f.key] != null);
  mount(el,
    pageHead(`Progress report ${r.report_no}`, `${r.site_name} · ${fmt.date(r.report_date)} · submitted by ${r.created_by_name}`, ...actions),
    r.status === 'VOID' ? h('div', { class: 'alert err' }, h('b', null, 'Void: '), r.void_reason, ` (${r.voided_by_name}, ${fmt.dt(r.voided_at)}). Not counted in monthly totals.`) : null,
    h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, `Photos (${r.photos.length})`), gallery, addBox),
    h('div', { class: 'grid two' },
      h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, 'Work accomplished'), h('p', { class: 'prewrap' }, r.work_done),
        r.issues ? [h('h3', null, 'Issues, delays, safety'), h('p', { class: 'prewrap' }, r.issues)] : null,
        r.next_plan ? [h('h3', null, 'Plan for next working day'), h('p', { class: 'prewrap' }, r.next_plan)] : null),
      h('div', { class: 'panel' }, h('h2', { class: 'panel-title' }, 'Quantities'),
        q.length ? kv(q.map(f => [f.label, fmt.num(r[f.key], 3)])) : h('div', { class: 'empty' }, 'No quantities recorded'),
        h('h3', null, 'Details'),
        kv([['Site', r.site_name], ['Date', fmt.date(r.report_date)], ['Area', r.area], ['Weather', r.weather ? WEATHER_LABEL[r.weather] : null],
          ['Location', r.latitude != null ? h('a', { href: `https://www.google.com/maps?q=${r.latitude},${r.longitude}`, target: '_blank', rel: 'noopener' }, `${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}${r.location_accuracy_m ? ` (±${r.location_accuracy_m} m)` : ''}`) : null],
          ['Submitted', `${fmt.dt(r.created_at)} by ${r.created_by_name}`], r.updated_by ? ['Last corrected', `${fmt.dt(r.updated_at)} by ${r.updated_by_name}`] : null]))),
    !r.can.edit && r.edit_blocked_reason && r.status !== 'VOID' && r.created_by === state.me.id ? h('div', { class: 'sub no-print' }, r.edit_blocked_reason) : null);
}

function editDialog(r, reload) {
  const f = form([
    { name: 'report_date', label: 'Date of the work', type: 'date', required: true, max: todayManila() },
    { name: 'area', label: 'Area (block / lot / phase / line)' },
    { name: 'weather', label: 'Weather', type: 'select', options: state.meta.progress.weather.map(w => ({ value: w, label: WEATHER_LABEL[w] || label(w) })) },
    { name: 'work_done', label: 'Work accomplished', type: 'textarea', required: true, full: true },
    { name: 'issues', label: 'Issues, delays or safety concerns', type: 'textarea', full: true, rows: 2 },
    { name: 'next_plan', label: 'Plan for the next working day', type: 'textarea', full: true, rows: 2 },
    { type: 'heading', label: 'Quantities' },
    ...fields().map(x => ({ name: x.key, label: x.label, type: 'number', min: 0, step: x.int ? 1 : 0.001 })),
  ], r);
  modal({ title: `Correct ${r.report_no}`, wide: true, body: [h('p', { class: 'sub' }, 'Every correction is recorded in the audit log with the old and new values.'), f],
    actions: [{ label: 'Cancel' }, { label: 'Save correction', class: 'btn-primary', onClick: async () => {
      await api(`/progress-reports/${r.id}`, { method: 'PUT', body: { ...f.values(), version: r.version } });
      toast('Report corrected', 'ok'); reload();
    } }] });
}
function voidDialog(r, reload) {
  const reason = h('textarea', { rows: 3, placeholder: 'e.g. Duplicate of SP-2026-00031 / wrong site' });
  modal({ title: `Void ${r.report_no}`, body: [h('p', null, 'A void report stays on record but is no longer counted in the monthly totals.'), h('div', { class: 'field' }, h('label', null, 'Reason ', h('span', { class: 'req' }, '*')), reason)],
    actions: [{ label: 'Cancel' }, { label: 'Void report', class: 'btn-danger', onClick: async () => {
      if (!reason.value.trim()) { toast('Enter a reason', 'err'); return false; }
      await api(`/progress-reports/${r.id}/void`, { method: 'POST', body: { reason: reason.value } });
      toast('Report voided', 'ok'); reload();
    } }] });
}

// ---------------------------------------------------------------- monthly summary
export async function monthly(el) {
  const cur = todayManila().slice(0, 7);
  const [y, m] = cur.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 6, 1)).toISOString().slice(0, 7);
  const from = h('input', { type: 'month', name: 'from', value: start, max: cur });
  const to = h('input', { type: 'month', name: 'to', value: cur, max: cur });
  const site = h('select', { name: 'site_id' }, h('option', { value: '' }, 'All permitted sites'), ...state.meta.sites.map(s => h('option', { value: s.id }, s.name)));
  const values = () => ({ from: from.value, to: to.value, site_id: site.value || undefined });
  const out = h('div');
  const cols = [
    ['site_name', 'Site'], ['month', 'Month'], ['reports', 'Reports', 0], ['days_reported', 'Days', 0], ['photos', 'Photos', 0],
    ['ftb_produced', 'FTB produced', 0], ['ftb_installed', 'FTB installed', 0], ['volume_produced_m3', 'm³ produced', 2], ['volume_installed_m3', 'm³ installed', 2],
    ['manpower_production', 'Manpower prod. (avg/day)', 1], ['manpower_installation', 'Manpower inst. (avg/day)', 1],
    ['manhours_production', 'Manhours prod.', 1], ['manhours_installation', 'Manhours inst.', 1], ['coca', 'COCA', 0],
    ['production_efficiency', 'Prod. m³/manhour', 3], ['installation_efficiency', 'Inst. m³/manhour', 3],
  ];
  async function load() {
    mount(out, h('div', { class: 'loading' }, 'Loading…'));
    try {
      const d = await api('/progress-reports/monthly', { query: values() });
      mount(out, h('div', { class: 'panel' }, d.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ...cols.map(([, l, dp]) => h('th', { class: dp != null ? 'num' : '' }, l)))),
        h('tbody', null, ...d.rows.map(r => h('tr', null, ...cols.map(([k, , dp]) => h('td', { class: dp != null ? 'num' : k === 'month' ? 'nowrap' : '' },
          k === 'site_name' ? h('a', { href: `#/progress?site_id=${r.site_id}` }, r.site_name) : dp != null ? fmt.num(r[k], dp) : r[k] ?? '—'))))))) : h('div', { class: 'empty' }, 'No progress reports in these months'),
      h('ul', { class: 'sub' }, ...d.notes.map(n => h('li', null, n)))));
    } catch (e) { mount(out, errorBox(e)); }
  }
  const exportBtn = h('button', { class: 'btn btn-primary', onclick: e => act(e.currentTarget, () => download('/progress-reports/monthly.xlsx', values())) }, '⬇ Export for Monthly History (.xlsx)');
  for (const i of [from, to, site]) i.addEventListener('change', load);
  mount(el,
    pageHead('Monthly progress summary', 'Totals per site and month from the daily progress reports', exportBtn),
    h('div', { class: 'toolbar panel no-print' },
      h('div', { class: 'field' }, h('label', null, 'From month'), from), h('div', { class: 'field' }, h('label', null, 'To month'), to),
      h('div', { class: 'field' }, h('label', null, 'Project / site'), site)),
    h('div', { class: 'alert info no-print' }, 'The export uses the column order and site names of the "Monthly History" sheet in the Housing Database workbook, so the rows can be pasted straight in. Target Installation and Target FTB Produced are planning figures and stay blank.'),
    out);
  load();
}

// ---------------------------------------------------------------- upload queue on this phone
export async function queue(el) {
  const body = h('div');
  async function render() {
    if (!body.isConnected && body.dataset.rendered) return off();
    body.dataset.rendered = '1';
    const items = await outbox.all();
    const mine = items.filter(i => i.user_id === state.me.id);
    const others = items.length - mine.length;
    mount(body,
      !(await outbox.isPersistent()) ? h('div', { class: 'alert warn' }, 'This browser does not allow saving on the phone (private mode?). Keep this page open until the upload finishes.') : null,
      mine.length ? mine.map(card) : h('div', { class: 'panel empty' }, '✓ Nothing waiting. Every report from this phone has been uploaded.'),
      others ? h('div', { class: 'alert info' }, `${others} report${others === 1 ? '' : 's'} on this phone belong${others === 1 ? 's' : ''} to another user and will upload when they sign in.`) : null);
  }
  function card(it) {
    const done = it.photos.filter(p => p.done).length;
    const btns = [];
    if (it.state === 'pending') btns.push(h('button', { class: 'btn btn-primary', onclick: e => act(e.currentTarget, () => outbox.sync()) }, '⟳ Upload now'));
    if (it.state === 'attention' && it.error_kind === 'duplicate') btns.push(h('button', { class: 'btn btn-primary', onclick: e => act(e.currentTarget, () => outbox.retry(it.id, { confirm_duplicate: true })) }, 'Submit anyway (different work)'));
    if (it.state === 'attention' && it.error_kind === 'photos') {
      btns.push(h('button', { class: 'btn', onclick: e => act(e.currentTarget, () => outbox.retry(it.id)) }, '⟳ Try photos again'));
      btns.push(h('button', { class: 'btn', onclick: e => act(e.currentTarget, () => outbox.dropFailedPhotos(it.id)) }, 'Skip refused photos'));
    }
    if (it.state === 'attention' && !it.server_id) btns.push(h('a', { class: 'btn', href: `#/progress/new?draft=${encodeURIComponent(it.id)}` }, '✎ Correct and resend'));
    if (it.server_id) btns.push(h('a', { class: 'btn', href: `#/progress/${it.server_id}` }, `Open ${it.report_no}`));
    btns.push(h('button', { class: 'btn btn-danger', onclick: async () => {
      const msg = it.server_id ? `The report ${it.report_no} is already saved. Discard the ${it.photos.length - done} photo(s) not yet uploaded?` : 'Discard this report and its photos from the phone? It has not been uploaded.';
      if (await confirmDialog(msg, { okLabel: 'Discard', danger: true })) { await outbox.discard(it.id); render(); }
    } }, 'Discard'));
    return h('div', { class: 'panel' },
      h('div', { class: 'page-head' }, h('div', null, h('b', null, `${siteLabel(it.report.site_id)} · ${fmt.date(it.report.report_date)}`),
        h('div', { class: 'sub' }, `${it.report_no ? it.report_no + ' · ' : ''}saved on phone ${fmt.dt(it.created_at)} · photos uploaded ${done} of ${it.photos.length}`)),
        h('span', { class: 'badge ' + (it.state === 'attention' ? 'b-bad' : 'b-warn') }, it.state === 'attention' ? 'Needs attention' : 'Waiting for signal')),
      h('div', { class: 'clamp' }, it.report.work_done),
      it.error ? h('div', { class: 'alert err mt' }, it.error, it.duplicates ? h('ul', null, ...it.duplicates.map(d => h('li', null, `${d.report_no} by ${d.created_by_name}${d.area ? ` (${d.area})` : ''}`))) : null) : null,
      it.state === 'pending' && it.last_error ? h('div', { class: 'sub mt' }, `Last attempt: ${it.last_error}`) : null,
      h('div', { class: 'inline-actions mt' }, ...btns));
  }
  const off = outbox.onChange(() => render());
  mount(el, pageHead('Upload queue', 'Progress reports saved on this phone that are not on the server yet'), body);
  render();
}
