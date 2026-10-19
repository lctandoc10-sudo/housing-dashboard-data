// PMS planning: plan list, plan editor with schedules, calendar (month grid + list).
import { h, mount, api, state, can, fmt, toast, act, modal, form, opt, enumOpts, simpleTable, pageHead, kv, label, todayManila, addDays, woBadge, ApiError } from '../ui.js';

const FREQ_LABEL = { DAILY: 'day(s)', WEEKLY: 'week(s)', MONTHLY: 'month(s)', QUARTERLY: 'quarter(s)', SEMIANNUAL: 'half-year(s)', ANNUAL: 'year(s)', CUSTOM_DAYS: 'days', HOURS: 'operating hours', KM: 'km' };
export const freqText = p => `Every ${fmt.num(p.interval_value, 0)} ${FREQ_LABEL[p.frequency]}`;

export async function plans(el) {
  const rows = await api('/pms/plans');
  mount(el, pageHead('PMS plans', 'Preventive maintenance plans per equipment type or individual asset. Work orders are generated automatically when a schedule enters its lead window.',
    can('pms.plan') ? h('a', { class: 'btn btn-primary', href: '#/pms/plans/new' }, '+ New PMS plan') : null,
    can('pms.plan') ? h('button', { class: 'btn', onclick: async e => { const r = await act(e.currentTarget, () => api('/pms/generate', { method: 'POST' })); toast(`${r.generated.length} PMS work order(s) generated`, 'ok'); } }, 'Generate due work orders now') : null,
    h('a', { class: 'btn', href: '#/pms/calendar' }, 'Calendar')),
  h('div', { class: 'panel' }, simpleTable([
    { label: 'Code', render: p => h('b', null, p.code) }, { label: 'Plan', key: 'name' }, { label: 'Applies to', render: p => p.asset_code ? `Asset ${p.asset_code}` : `All ${p.category}` },
    { label: 'Frequency', render: freqText }, { label: 'Checklist', render: p => p.checklist || '—' }, { label: 'Schedules', num: true, key: 'schedules' },
    { label: 'Next due', render: p => fmt.date(p.next_due) }, { label: 'Active', render: p => p.is_active ? h('span', { class: 'badge b-ok' }, 'Active') : h('span', { class: 'badge b-grey' }, 'Inactive') },
  ], rows, { empty: 'No PMS plans yet', onRow: p => { location.hash = `#/pms/plans/${p.id}`; } })));
}

export async function plan(el, id) {
  const isNew = id === 'new';
  const p = isNew ? { frequency: 'MONTHLY', interval_value: 1, lead_days: 7, schedule_basis: 'FIXED', default_priority: 'MEDIUM', requires_shutdown: 1, is_active: 1, parts: [], schedules: [] } : await api(`/pms/plans/${id}`);
  const editable = can('pms.plan');
  const partsList = await api('/parts', { query: { page_size: 200 } }).catch(() => ({ rows: [] }));
  const assets = isNew ? (await api('/assets', { query: { page_size: 200 } })).rows : [];
  const fields = [
    { name: 'code', label: 'Plan code', required: true, attrs: isNew ? null : { disabled: 'disabled' } }, { name: 'name', label: 'Plan name', required: true },
    ...(isNew ? [
      { name: 'scope', label: 'Applies to', type: 'select', required: true, options: [{ value: 'category', label: 'All equipment of a category' }, { value: 'asset', label: 'One specific asset' }], onChange: (i, inp) => {
        inp.category_id.closest('.field').hidden = i.value !== 'category'; inp.asset_id.closest('.field').hidden = i.value !== 'asset';
      } },
      { name: 'category_id', label: 'Equipment category', type: 'select', options: opt(state.meta.categories) },
      { name: 'asset_id', label: 'Asset', type: 'select', options: opt(assets, 'id', a => `${a.asset_code} – ${a.name}`), hidden: true },
    ] : []),
    { name: 'frequency', label: 'Frequency', type: 'select', required: true, options: state.meta.pms_frequencies.map(f => ({ value: f, label: label(f) + (f === 'HOURS' ? ' (operating hours)' : f === 'KM' ? ' (odometer)' : '') })), attrs: isNew ? null : { disabled: 'disabled' } },
    { name: 'interval_value', label: 'Interval', type: 'number', required: true, step: 'any', hint: 'e.g. 1 month, 250 hours, 5000 km, 45 days' },
    { name: 'schedule_basis', label: 'Next due calculated from', type: 'select', required: true, options: [{ value: 'FIXED', label: 'Fixed schedule (previous due date / meter)' }, { value: 'FLOATING', label: 'Actual completion date / meter' }] },
    ...(isNew ? [{ name: 'start_date', label: 'First due date (calendar plans)', type: 'date' }] : []),
    { name: 'lead_days', label: 'Generate work order (days before due)', type: 'number', required: true },
    { name: 'lead_meter', label: 'Generate work order (hours/km before due)', type: 'number', step: 'any' },
    { name: 'checklist_template_id', label: 'Checklist', type: 'select', options: opt(state.meta.checklists) },
    { name: 'est_labor_hours', label: 'Estimated labor hours', type: 'number', step: '0.5' },
    { name: 'default_priority', label: 'Priority', type: 'select', required: true, options: enumOpts(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) },
    { name: 'requires_shutdown', label: 'Equipment is out of service during this PMS (planned downtime)', type: 'checkbox' },
    ...(!isNew ? [{ name: 'is_active', label: 'Plan active', type: 'checkbox' }] : []),
    { name: 'instructions', label: 'Instructions', type: 'textarea', full: true },
  ];
  const f = form(fields, { ...p, scope: 'category' });
  const partRows = (p.parts || []).map(x => ({ part_id: x.part_id, qty: x.qty }));
  const partsBox = h('div');
  const renderParts = () => mount(partsBox, ...partRows.map((r, i) => h('div', { class: 'toolbar' },
    h('div', { class: 'field grow' }, h('select', { onchange: e => { r.part_id = Number(e.target.value); } }, h('option', { value: '' }, '— part —'), ...partsList.rows.map(pt => h('option', { value: pt.id, selected: pt.id === r.part_id }, `${pt.part_no} – ${pt.name}`)))),
    h('div', { class: 'field' }, h('input', { type: 'number', step: 'any', value: r.qty, oninput: e => { r.qty = Number(e.target.value); } })),
    h('button', { class: 'btn btn-sm', onclick: () => { partRows.splice(i, 1); renderParts(); } }, 'Remove'))),
  h('button', { class: 'btn btn-sm', onclick: () => { partRows.push({ part_id: null, qty: 1 }); renderParts(); } }, '+ Add part'));
  renderParts();
  const save = h('button', { class: 'btn btn-primary', onclick: async e => {
    const v = f.values();
    if (isNew) { if (v.scope === 'category') v.asset_id = null; else v.category_id = null; delete v.scope; }
    else { delete v.code; delete v.frequency; }
    v.parts = partRows.filter(r => r.part_id);
    const r = await act(e.currentTarget, () => api(isNew ? '/pms/plans' : `/pms/plans/${id}`, { method: isNew ? 'POST' : 'PUT', body: v }), 'PMS plan saved');
    location.hash = `#/pms/plans/${isNew ? r.id : id}`;
    if (!isNew) plan(el, id);
  } }, isNew ? 'Create plan' : 'Save plan');
  const meter = p.frequency === 'HOURS' || p.frequency === 'KM';
  mount(el, pageHead(isNew ? 'New PMS plan' : `${p.code} – ${p.name}`, isNew ? 'Schedules are created for every applicable asset' : freqText(p)),
    h('div', { class: 'panel' }, f, h('h3', null, 'Required spare parts & consumables (per service)'), partsBox, editable ? h('div', { class: 'mt' }, save) : null),
    !isNew ? h('div', { class: 'panel' }, h('h2', null, `Schedules (${p.schedules.length})`), simpleTable([
      { label: 'Equipment', render: s => h('a', { href: `#/assets/${s.asset_id}` }, `${s.asset_code} ${s.asset_name}`) }, { label: 'Site', key: 'site' },
      { label: 'Last done', render: s => fmt.date(s.last_done_date) }, meter ? { label: 'Current meter', num: true, render: s => fmt.num(s.meter_reading) } : null,
      { label: 'Next due', render: s => meter ? `${fmt.num(s.next_due_meter)} ${p.frequency === 'HOURS' ? 'h' : 'km'}` : h('span', { class: s.next_due_date < todayManila() ? 'badge b-bad' : '' }, fmt.date(s.next_due_date)) },
      { label: 'Open WO', render: s => { if (!s.open_wo) return '—'; const [no, wid, st] = s.open_wo.split('|'); return [h('a', { href: `#/wo/${wid}` }, no), ' ', woBadge(st)]; } },
      { label: 'Active', render: s => (s.is_active ? 'Yes' : 'No') },
      editable ? { label: '', render: s => h('button', { class: 'btn btn-sm', onclick: () => editSchedule(s, meter, () => plan(el, id)) }, 'Adjust') } : null,
    ].filter(Boolean), p.schedules, { empty: 'No equipment matches this plan' })) : null);
}

function editSchedule(s, meter, reload) {
  const f = form([meter ? { name: 'next_due_meter', label: 'Next due meter', type: 'number', step: 'any' } : { name: 'next_due_date', label: 'Next due date', type: 'date' },
    { name: 'is_active', label: 'Schedule active', type: 'checkbox' }, { name: 'reason', label: 'Reason for change', required: true, full: true }], { ...s, is_active: !!s.is_active });
  modal({ title: `Adjust schedule – ${s.asset_code}`, body: h('div', null, h('p', { class: 'sub' }, 'To move an already generated work order, use Reschedule on the work order (recorded with reason and authoriser).'), f),
    actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => { await api(`/pms/schedules/${s.id}`, { method: 'PUT', body: f.values() }); toast('Schedule updated', 'ok'); reload(); } }] });
}

export async function calendar(el, q) {
  let month = (q.month || todayManila().slice(0, 7));
  const siteSel = h('select', null, h('option', { value: '' }, 'All sites'), ...state.meta.sites.map(s => h('option', { value: s.id }, s.name)));
  const mode = h('select', null, h('option', { value: 'grid' }, 'Calendar'), h('option', { value: 'list' }, 'List'));
  const body = h('div');
  const title = h('h2', { style: { margin: 0 } });
  const shift = n => { const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1)); month = d.toISOString().slice(0, 7); load(); };
  mount(el, pageHead('PMS calendar', 'Generated PMS work orders and forecast occurrences (dashed) from active schedules'),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => shift(-1) }, '‹'), title, h('button', { class: 'btn', onclick: () => shift(1) }, '›'),
      h('button', { class: 'btn', onclick: () => { month = todayManila().slice(0, 7); load(); } }, 'Today'), h('div', { class: 'field' }, h('label', null, 'Site'), siteSel), h('div', { class: 'field' }, h('label', null, 'View'), mode)),
    h('div', { class: 'sub', style: { marginBottom: '8px' } }, h('span', { class: 'badge b-info' }, 'Open'), ' ', h('span', { class: 'badge b-ok' }, 'Completed'), ' ', h('span', { class: 'badge b-bad' }, 'Overdue / missed'), ' ', h('span', { class: 'badge' }, 'Forecast')),
    body);
  siteSel.addEventListener('change', load); mode.addEventListener('change', load);
  async function load() {
    const first = `${month}-01`;
    const wd = new Date(first + 'T00:00:00Z').getUTCDay();
    const start = addDays(first, -((wd + 6) % 7));
    const end = addDays(start, 41);
    title.textContent = new Date(first + 'T00:00:00Z').toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const data = await api('/pms/calendar', { query: { from: start, to: end, site_id: siteSel.value } });
    const t = todayManila();
    const evClass = w => (w.category === 'DONE' ? 'done' : (w.category === 'MISSED' || ((w.category === 'OPEN' || w.category === 'HOLD') && w.due_date < t)) ? 'late' : '');
    if (mode.value === 'list') {
      const all = [...data.work_orders.map(w => ({ ...w, kind: 'wo' })), ...data.forecast.map(f => ({ ...f, kind: 'fc' }))].filter(x => x.due_date.slice(0, 7) === month).sort((a, b) => a.due_date.localeCompare(b.due_date));
      mount(body, h('div', { class: 'panel' }, simpleTable([{ label: 'Due', render: x => fmt.date(x.due_date) }, { label: 'Equipment', render: x => `${x.asset_code} ${x.asset_name}` }, { label: 'PMS', key: 'title' },
        { label: 'Work order', render: x => x.kind === 'wo' ? h('a', { href: `#/wo/${x.id}` }, x.wo_number) : h('span', { class: 'muted' }, 'forecast') }, { label: 'Status', render: x => x.kind === 'wo' ? woBadge(x.status) : '—' }], all, { empty: 'Nothing scheduled this month' })));
      return;
    }
    const byDay = {};
    for (const w of data.work_orders) (byDay[w.due_date] = byDay[w.due_date] || []).push(h('a', { class: 'ev ' + evClass(w), href: `#/wo/${w.id}`, title: `${w.wo_number} ${w.asset_code} ${w.title} (${w.status})` }, `${w.asset_code} · ${w.title}`));
    for (const f of data.forecast) (byDay[f.due_date] = byDay[f.due_date] || []).push(h('span', { class: 'ev fc', title: `Forecast: ${f.asset_code} ${f.title}` }, `${f.asset_code} · ${f.title}`));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      cells.push(h('div', { class: 'day' + (d.slice(0, 7) !== month ? ' other' : '') + (d === t ? ' today' : '') }, h('div', { class: 'n' }, String(+d.slice(8))), ...(byDay[d] || [])));
    }
    mount(body, h('div', { class: 'cal' }, ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => h('div', { class: 'dow' }, x)), ...cells));
  }
  load();
}
