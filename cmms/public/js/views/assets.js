// Equipment registry: list, detail (history, status, QR, actions), register/edit, QR scanning.
import { h, mount, api, state, can, fmt, toast, act, modal, confirmDialog, form, opt, enumOpts, dataTable, simpleTable, pageHead, kv, tabs, assetBadge, woBadge, prioBadge, typeBadge, debounce, attachmentsPanel, label, codeLabel, todayManila } from '../ui.js';

export async function list(el, q) {
  const search = h('input', { type: 'search', placeholder: 'ID, name, serial, plate, model…', value: q.q || '' });
  const site = h('select', null, h('option', { value: '' }, 'All sites'), ...state.meta.sites.map(s => h('option', { value: s.id, selected: String(q.site_id) === String(s.id) }, s.name)));
  const cat = h('select', null, h('option', { value: '' }, 'All categories'), ...state.meta.categories.map(c => h('option', { value: c.id, selected: String(q.category_id) === String(c.id) }, c.name)));
  const status = h('select', null, h('option', { value: '' }, 'Any status'), ...state.meta.asset_statuses.map(s => h('option', { value: s.code, selected: q.status === s.code }, s.label)));
  if (q.status && q.status.includes(',')) status.appendChild(h('option', { value: q.status, selected: true }, 'Selected statuses'));
  const crit = h('select', null, h('option', { value: '' }, 'Any criticality'), ...['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(c => h('option', { value: c }, label(c))));
  const table = dataTable({
    defaultSort: 'asset_code',
    columns: [
      { key: 'asset_code', label: 'Equipment ID', sort: 'asset_code', render: r => h('b', null, r.asset_code) },
      { key: 'name', label: 'Name', sort: 'name' }, { key: 'category', label: 'Category', sort: 'category' }, { key: 'site', label: 'Site', sort: 'site' },
      { key: 'criticality', label: 'Criticality', sort: 'criticality', render: r => prioBadge(r.criticality) },
      { key: 'status', label: 'Status', sort: 'status', render: r => assetBadge(r.status) },
      { key: 'meter_reading', label: 'Meter', num: true, render: r => r.meter_type === 'NONE' ? '—' : `${fmt.num(r.meter_reading)} ${r.meter_type === 'HOURS' ? 'h' : 'km'}` },
      { key: 'last_pms_date', label: 'Last PMS', render: r => fmt.date(r.last_pms_date) },
      { key: 'next_pms_due', label: 'Next PMS', sort: 'next_pms_due', render: r => r.next_pms_due ? h('span', { class: r.next_pms_due < todayManila() ? 'badge b-bad' : '' }, fmt.date(r.next_pms_due)) : '—' },
    ],
    fetch: p => api('/assets', { query: p }),
    onRow: r => { location.hash = `#/assets/${r.id}`; },
  });
  const reload = () => table.reload({ q: search.value, site_id: site.value, category_id: cat.value, status: status.value, criticality: crit.value });
  search.addEventListener('input', debounce(reload));
  for (const s of [site, cat, status, crit]) s.addEventListener('change', reload);
  mount(el, pageHead('Equipment registry', 'All registered equipment in your permitted sites',
    can('asset.create') ? h('a', { class: 'btn btn-primary', href: '#/assets/new' }, '+ Register equipment') : null,
    can('report.export') ? h('a', { class: 'btn', href: '#/reports/equipment_master' }, 'Master list report') : null),
  h('div', { class: 'toolbar' }, h('div', { class: 'field grow' }, h('label', null, 'Search'), search), h('div', { class: 'field' }, h('label', null, 'Site'), site),
    h('div', { class: 'field' }, h('label', null, 'Category'), cat), h('div', { class: 'field' }, h('label', null, 'Status'), status), h('div', { class: 'field' }, h('label', null, 'Criticality'), crit)),
  h('div', { class: 'panel' }, table));
  reload();
}

export async function byCode(el, code) {
  const a = await api(`/assets/by-code/${encodeURIComponent(code)}`);
  return render(el, a);
}
export async function detail(el, id) { return render(el, await api(`/assets/${id}`)); }

async function render(el, a) {
  const reload = () => detail(el, a.id);
  const qrImg = h('img', { class: 'qr', alt: `QR code for ${a.asset_code}`, src: `/api/assets/${a.id}/qr.svg` });
  const actions = [];
  if (a.actions.report_breakdown) actions.push(h('a', { class: 'btn btn-danger', href: `#/report?asset=${a.id}` }, '⚠ Report breakdown / defect'));
  if (a.actions.create_wo) actions.push(h('a', { class: 'btn', href: `#/wo/new?asset=${a.id}` }, '+ Work order'));
  if (a.actions.meter) actions.push(h('button', { class: 'btn', onclick: () => meterDialog(a, reload) }, 'Record meter'));
  if (a.actions.set_status) actions.push(h('button', { class: 'btn', onclick: () => statusDialog(a, reload) }, 'Change status'));
  if (a.actions.transfer) actions.push(h('button', { class: 'btn', onclick: () => transferDialog(a, reload) }, 'Transfer'));
  if (a.actions.edit) actions.push(h('a', { class: 'btn', href: `#/assets/${a.id}/edit` }, 'Edit'));

  const overview = h('div', { class: 'grid two' },
    h('div', { class: 'panel' }, h('h2', null, 'Details'), kv([
      ['Equipment ID', a.asset_code], ['Name', a.name], ['Description', a.description], ['Category', a.category.name], ['Make / model', [a.manufacturer, a.model].filter(Boolean).join(' ')],
      ['Serial no.', a.serial_no], ['Plate no.', a.plate_no], ['Site', a.site.name], ['Location', a.location && a.location.name], ['Criticality', prioBadge(a.criticality)],
      ['Custodian / dept.', [a.custodian, a.department].filter(Boolean).join(' · ')], ['Acquired', fmt.date(a.date_acquired)], ['Commissioned', fmt.date(a.commissioning_date)],
      a.purchase_value !== undefined ? ['Asset value', fmt.money(a.purchase_value)] : null, ['Supplier', a.supplier && a.supplier.name],
      ['Warranty', [a.warranty_expiry ? `until ${fmt.date(a.warranty_expiry)}` : null, a.warranty_details].filter(Boolean).join(' – ')],
      a.meter_type !== 'NONE' ? ['Meter', `${fmt.num(a.meter_reading)} ${a.meter_type === 'HOURS' ? 'operating hours' : 'km'} (${fmt.dt(a.meter_read_at)})`] : null,
      ['Last PMS', fmt.date(a.last_pms_date)], ['Next PMS due', a.next_pms_due ? fmt.date(a.next_pms_due) : '—'],
    ])),
    h('div', null,
      h('div', { class: 'panel' }, h('h2', null, 'Operational status'), h('div', { class: 'status-strip' }, assetBadge(a.status)),
        h('p', { class: 'sub' }, a.status_info.desc), kv([['Since', fmt.dt(a.status_since)], ['Reason', a.status_reason], ['Responsible', a.status_responsible], ['Est. recovery', a.est_recovery_at ? fmt.dt(a.est_recovery_at) : null],
          a.downtime_open ? ['Down since', `${fmt.dt(a.downtime_open.start_at)} (${label(a.downtime_open.category)})`] : null])),
      h('div', { class: 'panel' }, h('h2', null, 'Open work orders'), simpleTable([
        { label: 'WO', render: w => h('a', { href: `#/wo/${w.id}` }, w.wo_number) }, { label: 'Type', render: w => typeBadge(w.wo_type) }, { label: 'Title', key: 'title' },
        { label: 'Status', render: w => woBadge(w.status) }, { label: 'Due', render: w => fmt.date(w.due_date || w.planned_end) }], a.open_work_orders, { empty: 'No open work orders' })),
      h('div', { class: 'panel' }, h('h2', null, 'QR code'), h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } }, qrImg,
        h('div', { class: 'sub' }, 'Scanning opens this equipment profile (sign-in required; actions follow user permissions).', h('br'),
          h('button', { class: 'btn btn-sm mt', onclick: () => printLabel(a) }, '⎙ Print label')))),
      a.cost_summary ? h('div', { class: 'panel' }, h('h2', null, 'Lifetime maintenance cost'), kv(a.cost_summary.map(c => [label(c.category), fmt.money(c.amount)]).concat([['Total', h('b', null, fmt.money(a.cost_summary.reduce((t, c) => t + c.amount, 0)))]]))) : null));

  const histCols = [{ label: 'WO', render: w => h('a', { href: `#/wo/${w.id}` }, w.wo_number) }, { label: 'Type', render: w => typeBadge(w.wo_type) }, { label: 'Title', key: 'title' },
    { label: 'Site', key: 'site' }, { label: 'Status', render: w => woBadge(w.status) }, { label: 'Created', render: w => fmt.date(w.created_at) }, { label: 'Completed', render: w => fmt.date(w.actual_end) },
    { label: 'Root cause', render: w => w.root_cause_code ? codeLabel('ROOT_CAUSE', w.root_cause_code) : '—' }];
  mount(el, pageHead(`${a.asset_code} – ${a.name}`, `${a.category.name} · ${a.site.name}`, ...actions),
    tabs([
      { key: 'overview', label: 'Overview', render: overview },
      { key: 'history', label: `Maintenance history (${a.history.length})`, render: () => h('div', { class: 'panel' }, simpleTable(histCols, a.history, { empty: 'No maintenance history', onRow: w => { location.hash = `#/wo/${w.id}`; } })) },
      { key: 'bd', label: `Breakdowns (${a.breakdowns.length})`, render: () => h('div', { class: 'panel' }, simpleTable([
        { label: 'Report', key: 'report_no' }, { label: 'Reported', render: b => fmt.dt(b.reported_at) }, { label: 'Severity', render: b => prioBadge(b.severity) }, { label: 'Impact', render: b => label(b.impact) },
        { label: 'Description', key: 'description' }, { label: 'WO', render: b => h('a', { href: `#/wo/${b.work_order_id}` }, b.wo_number) }, { label: 'Status', render: b => woBadge(b.status) }], a.breakdowns, { empty: 'No breakdowns recorded' })) },
      { key: 'pms', label: 'PMS schedules', render: () => h('div', { class: 'panel' }, simpleTable([
        { label: 'Plan', render: s => h('a', { href: `#/pms/plans/${s.plan_id}` }, `${s.plan_code} ${s.plan_name}`) }, { label: 'Frequency', render: s => `${s.interval_value} × ${label(s.frequency)}` },
        { label: 'Last done', render: s => fmt.date(s.last_done_date) }, { label: 'Next due', render: s => s.next_due_date ? fmt.date(s.next_due_date) : s.next_due_meter != null ? `${fmt.num(s.next_due_meter)} ${a.meter_type === 'KM' ? 'km' : 'h'}` : '—' },
        { label: 'Active', render: s => s.is_active ? 'Yes' : 'No' }], a.pms_schedules, { empty: 'No PMS plan applies to this equipment' })) },
      { key: 'status', label: 'Status history', render: () => h('div', { class: 'panel' }, simpleTable([
        { label: 'When', render: s => fmt.dt(s.changed_at) }, { label: 'From', render: s => s.from_status ? assetBadge(s.from_status) : '—' }, { label: 'To', render: s => assetBadge(s.to_status) },
        { label: 'Reason', key: 'reason' }, { label: 'WO', key: 'wo_number' }, { label: 'By', key: 'changed_by_name' }], a.status_history)) },
      { key: 'transfers', label: 'Transfers & meters', render: () => h('div', { class: 'grid two' },
        h('div', { class: 'panel' }, h('h3', null, 'Site transfers'), simpleTable([{ label: 'When', render: t => fmt.dt(t.transferred_at) }, { label: 'From', key: 'from_site' }, { label: 'To', key: 'to_site' }, { label: 'Reason', key: 'reason' }, { label: 'By', key: 'by_name' }], a.transfers, { empty: 'Never transferred' })),
        h('div', { class: 'panel' }, h('h3', null, 'Meter readings'), simpleTable([{ label: 'When', render: m => fmt.dt(m.reading_at) }, { label: 'Reading', num: true, render: m => fmt.num(m.reading) }, { label: 'Source', key: 'source' }, { label: 'By', key: 'by_name' }], a.meter_readings, { empty: 'No readings' }))) },
      { key: 'docs', label: `Photos & documents (${a.attachments.length})`, render: () => h('div', { class: 'panel' }, attachmentsPanel('asset', a.id, a.attachments, { canUpload: a.actions.edit, reload })) },
    ]));
}

function printLabel(a) {
  const w = window.open('', '_blank', 'width=420,height=520');
  if (!w) return toast('Allow pop-ups to print labels', 'err');
  w.document.title = a.asset_code;
  const img = w.document.createElement('img'); img.src = `/api/assets/${a.id}/qr.svg`; img.style.width = '260px';
  const t = w.document.createElement('div'); t.style.font = 'bold 22px sans-serif'; t.textContent = a.asset_code;
  const n = w.document.createElement('div'); n.style.font = '14px sans-serif'; n.textContent = `${a.name} · ${a.site.name}`;
  const box = w.document.createElement('div'); box.style.cssText = 'text-align:center;padding:20px;border:2px solid #000;width:300px;margin:auto';
  box.append(img, t, n); w.document.body.appendChild(box);
  img.onload = () => w.print();
}

function meterDialog(a, reload) {
  const f = form([{ name: 'reading', label: `New reading (${a.meter_type === 'HOURS' ? 'operating hours' : 'km'})`, type: 'number', required: true, step: '0.1', hint: `Last: ${fmt.num(a.meter_reading)} on ${fmt.dt(a.meter_read_at)}` },
    { name: 'reading_at', label: 'Reading date/time', type: 'datetime', hint: 'Leave blank for now' }]);
  modal({ title: `Record meter – ${a.asset_code}`, body: f, actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => { await api(`/assets/${a.id}/meter`, { method: 'POST', body: f.values() }); toast('Meter reading saved', 'ok'); reload(); } }] });
}
function statusDialog(a, reload) {
  const manual = state.meta.asset_statuses.filter(s => s.manual);
  const f = form([{ name: 'status', label: 'New status', type: 'select', required: true, options: manual.map(s => ({ value: s.code, label: s.label })) }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, full: true }]);
  modal({ title: `Change status – ${a.asset_code}`, body: h('div', null, h('div', { class: 'alert info' }, 'Maintenance statuses (Breakdown, Under PM/CM, Waiting, For Testing) are set by work orders. Equipment held by a work order returns to service only when that work order is verified and closed.'), f),
    actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => {
      const v = f.values();
      if (v.status === 'DECOMMISSIONED' && !(await confirmDialog('Decommissioning removes the equipment from availability and PMS scheduling. Continue?', { danger: true }))) return false;
      await api(`/assets/${a.id}/status`, { method: 'POST', body: v }); toast('Status updated', 'ok'); reload();
    } }] });
}
function transferDialog(a, reload) {
  const f = form([
    { name: 'to_site_id', label: 'Destination site', type: 'select', required: true, options: opt(state.meta.all_sites), onChange: (i, inputs) => {
      const locs = state.meta.locations.filter(l => String(l.site_id) === i.value);
      mount(inputs.to_location_id, h('option', { value: '' }, '— none —'), ...locs.map(l => h('option', { value: l.id }, l.name)));
    } },
    { name: 'to_location_id', label: 'Location', type: 'select', options: [] },
    { name: 'reason', label: 'Reason', type: 'textarea', required: true, full: true }]);
  modal({ title: `Transfer ${a.asset_code}`, body: h('div', null, h('p', { class: 'sub' }, `Currently at ${a.site.name}. The complete maintenance history moves with the equipment; past work orders keep the site where the work was done.`), f),
    actions: [{ label: 'Cancel' }, { label: 'Transfer', class: 'btn-primary', onClick: async () => { await api(`/assets/${a.id}/transfer`, { method: 'POST', body: f.values() }); toast('Equipment transferred', 'ok'); reload(); } }] });
}

export async function edit(el, id) {
  if (typeof id !== 'string') id = null;
  const a = id ? await api(`/assets/${id}`) : {};
  const vals = id ? { ...a, site_id: a.site.id, category_id: a.category.id, location_id: a.location && a.location.id, supplier_id: a.supplier && a.supplier.id } : {};
  const locOpts = siteId => opt(state.meta.locations.filter(l => String(l.site_id) === String(siteId) && l.is_active));
  const f = form([
    { type: 'heading', label: 'Identification' },
    { name: 'asset_code', label: 'Equipment ID', required: true, hint: 'Unique, e.g. TL-CPF-03' }, { name: 'name', label: 'Equipment name', required: true },
    { name: 'category_id', label: 'Category', type: 'select', required: true, options: opt(state.meta.categories.filter(c => c.is_active)) },
    { name: 'criticality', label: 'Criticality', type: 'select', required: true, options: enumOpts(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) },
    { name: 'manufacturer', label: 'Manufacturer / make' }, { name: 'model', label: 'Model' }, { name: 'serial_no', label: 'Serial number' }, { name: 'plate_no', label: 'Plate number' },
    { name: 'description', label: 'Description', type: 'textarea', full: true },
    { type: 'heading', label: 'Assignment' },
    { name: 'site_id', label: 'Project / site', type: 'select', required: true, options: opt(state.meta.sites.filter(s => s.is_active)), attrs: id ? { disabled: 'disabled' } : null,
      hint: id ? 'Use Transfer on the equipment page to move it' : null, onChange: (i, inputs) => mount(inputs.location_id, h('option', { value: '' }, '— none —'), ...locOpts(i.value).map(o => h('option', { value: o.value }, o.label))) },
    { name: 'location_id', label: 'Location / operating area', type: 'select', options: locOpts(vals.site_id) },
    { name: 'custodian', label: 'Custodian' }, { name: 'department', label: 'Responsible department' },
    { type: 'heading', label: 'Acquisition & warranty' },
    { name: 'date_acquired', label: 'Date acquired', type: 'date' }, { name: 'commissioning_date', label: 'Commissioning date', type: 'date' },
    { name: 'purchase_value', label: 'Purchase price / asset value (₱)', type: 'number', step: '0.01', hidden: !can('cost.view') },
    { name: 'supplier_id', label: 'Supplier', type: 'select', options: opt(state.meta.suppliers) },
    { name: 'warranty_expiry', label: 'Warranty expiry', type: 'date' }, { name: 'warranty_details', label: 'Warranty details' },
    ...(id ? [] : [{ name: 'meter_reading', label: 'Current meter reading (hours/km)', type: 'number', step: '0.1', hint: 'For equipment categories with hour meters or odometers' }]),
  ], vals);
  const save = h('button', { class: 'btn btn-primary', onclick: async e => {
    const v = f.values();
    if (id) delete v.site_id;
    const r = await act(e.currentTarget, () => api(id ? `/assets/${id}` : '/assets', { method: id ? 'PUT' : 'POST', body: v }), id ? 'Equipment updated' : 'Equipment registered');
    location.hash = `#/assets/${id || r.id}`;
  } }, id ? 'Save changes' : 'Register equipment');
  mount(el, pageHead(id ? `Edit ${a.asset_code}` : 'Register equipment', 'Fields marked * are required'), h('div', { class: 'panel' }, f, h('div', { class: 'inline-actions' }, save, h('a', { class: 'btn', href: id ? `#/assets/${id}` : '#/assets' }, 'Cancel'))));
}

export async function scan(el) {
  const out = h('div');
  const manual = h('input', { placeholder: 'Or type the equipment ID', autocapitalize: 'characters' });
  const go = () => { if (manual.value.trim()) location.hash = `#/a/${encodeURIComponent(manual.value.trim())}`; };
  manual.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  mount(el, pageHead('Scan equipment QR code', 'Point the camera at the QR label on the equipment'), h('div', { class: 'panel' }, out,
    h('div', { class: 'toolbar mt' }, h('div', { class: 'field grow' }, h('label', null, 'Equipment ID'), manual), h('button', { class: 'btn btn-primary', onclick: go }, 'Open'))));
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
    mount(out, h('div', { class: 'alert info' }, 'In-app scanning is not supported by this browser. Use your phone\'s camera app to scan the QR label – it opens the equipment page directly – or type the equipment ID below.'));
    return;
  }
  const video = h('video', { playsinline: true, muted: true, style: { width: '100%', maxWidth: '480px', borderRadius: '8px', background: '#000' } });
  mount(out, video);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch { mount(out, h('div', { class: 'alert warn' }, 'Camera permission denied or unavailable. Type the equipment ID instead.')); return; }
  video.srcObject = stream; await video.play();
  const det = new window.BarcodeDetector({ formats: ['qr_code'] });
  const stop = () => stream.getTracks().forEach(t => t.stop());
  window.addEventListener('hashchange', stop, { once: true });
  const tick = async () => {
    if (!video.isConnected) return stop();
    try {
      const codes = await det.detect(video);
      if (codes.length) {
        const v = codes[0].rawValue; stop();
        const m = v.match(/#\/a\/([^?#]+)/);
        location.hash = m ? `#/a/${m[1]}` : `#/a/${encodeURIComponent(v)}`;
        return;
      }
    } catch { /* keep scanning */ }
    requestAnimationFrame(tick);
  };
  tick();
}
