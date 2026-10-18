// Availability board, notifications, technician workload.
import { h, mount, api, state, can, fmt, toast, act, modal, form, opt, simpleTable, pageHead, filterBar, assetBadge, prioBadge, woBadge, typeBadge, label, kv, assetPicker, ApiError } from '../ui.js';

export async function availability(el, q) {
  const siteSel = h('select', null, h('option', { value: '' }, 'All sites'), ...state.meta.sites.map(s => h('option', { value: s.id, selected: String(q.site_id) === String(s.id) }, s.name)));
  const board = h('div'); const summary = h('div');
  mount(el, pageHead('Equipment availability board', 'Equipment that is unavailable or running with restrictions, with reason, responsible person and estimated recovery',
    can('downtime.manage') ? h('button', { class: 'btn', onclick: manualDowntime }, '+ Record other downtime') : null,
    h('a', { class: 'btn', href: '#/reports/availability' }, 'Availability % report'), h('a', { class: 'btn', href: '#/reports/downtime' }, 'Downtime report')),
  h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', null, 'Site'), siteSel)), summary, board, legend());
  siteSel.addEventListener('change', load);
  async function load() {
    const r = await api('/availability/board', { query: { site_id: siteSel.value } });
    const sites = {};
    for (const s of r.summary) { const o = sites[s.site] = sites[s.site] || { total: 0, up: 0, restricted: 0, down: 0 }; if (s.status === 'DECOMMISSIONED') continue; o.total += s.n; if (['AVAILABLE', 'OPERATIONAL', 'STANDBY'].includes(s.status)) o.up += s.n; else if (s.status === 'RUNNING_RESTRICTED') o.restricted += s.n; else o.down += s.n; }
    mount(summary, h('div', { class: 'grid kpis' }, ...Object.entries(sites).map(([s, o]) => h('div', { class: 'kpi ' + (o.down ? 'bad' : o.restricted ? 'warn' : 'ok') }, h('div', { class: 'label' }, s),
      h('div', { class: 'value' }, `${o.up}`, h('small', null, ` / ${o.total} available`)), h('div', { class: 'note' }, `${o.down} down · ${o.restricted} restricted`)))));
    mount(board, h('div', { class: 'panel' }, h('h2', null, `Unavailable or restricted (${r.unavailable.length})`), simpleTable([
      { label: 'Equipment', render: a => h('a', { href: `#/assets/${a.id}` }, h('b', null, a.asset_code), ` ${a.name}`) }, { label: 'Site', key: 'site' }, { label: 'Criticality', render: a => prioBadge(a.criticality) },
      { label: 'Status', render: a => assetBadge(a.status) }, { label: 'Reason', render: a => a.status_reason || '—' }, { label: 'Work order', render: a => a.wo_id ? h('a', { href: `#/wo/${a.wo_id}` }, a.wo_number) : '—' },
      { label: 'Responsible', render: a => a.status_responsible || '—' }, { label: 'Down since', render: a => a.down_since ? fmt.dt(a.down_since) : (a.status === 'RUNNING_RESTRICTED' ? 'running' : '—') },
      { label: 'Hours', num: true, render: a => a.hours_down == null ? '—' : fmt.num(a.hours_down) }, { label: 'Est. recovery', render: a => a.est_recovery_at ? fmt.dt(a.est_recovery_at) : h('span', { class: 'muted' }, 'not set') },
    ], r.unavailable, { empty: 'All equipment is available', rowClass: a => (a.status === 'BREAKDOWN' ? 'row-bad' : a.status === 'RUNNING_RESTRICTED' ? 'row-warn' : '') })));
  }
  function legend() {
    return h('div', { class: 'panel' }, h('h3', null, 'Status definitions and return-to-service rules'), simpleTable([{ label: 'Status', render: s => assetBadge(s.code) }, { label: 'Meaning', key: 'desc' }, { label: 'Counts as', render: s => s.up === true ? 'Available' : s.up === false ? 'Downtime' : 'Excluded' }, { label: 'Set by', render: s => s.manual ? 'Authorised user' : 'Work order workflow' }], state.meta.asset_statuses),
      h('p', { class: 'sub' }, 'Equipment held by a work order returns to service (Available) only when that work order is verified and closed by an authorised person. Downtime is recorded automatically from these status changes.'));
  }
  function manualDowntime() {
    const picker = assetPicker();
    const f = form([{ name: 'category', label: 'Downtime type', type: 'select', required: true, options: [{ value: 'OTHER', label: 'Other authorised downtime' }, { value: 'EXTERNAL', label: 'External service' }, { value: 'WAITING_PARTS', label: 'Waiting for parts' }, { value: 'UNPLANNED', label: 'Unplanned' }, { value: 'PLANNED', label: 'Planned' }] },
      { name: 'start_at', label: 'Start', type: 'datetime', required: true }, { name: 'end_at', label: 'End', type: 'datetime', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, full: true }]);
    modal({ title: 'Record other authorised downtime', body: h('div', null, h('p', { class: 'sub' }, 'For past periods not captured by a work order (e.g. typhoon stand-down, power interruption). Overlaps are counted once.'), h('div', { class: 'field' }, h('label', null, 'Equipment *'), picker), f),
      actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => { if (!picker.value) throw new ApiError(400, 'Select the equipment'); const r = await api('/downtime', { method: 'POST', body: { ...f.values(), asset_id: picker.value } }); toast(r.note || 'Downtime recorded', 'ok'); } }] });
  }
  load();
}

export async function notifications(el) {
  const box = h('div');
  mount(el, pageHead('Notifications', 'Alerts for PMS, breakdowns, escalations, low stock and verification',
    h('button', { class: 'btn', onclick: async e => { await act(e.currentTarget, () => api('/notifications/read-all', { method: 'POST' })); load(); window.__cmms.refreshBell(); } }, 'Mark all read')), box);
  async function load() {
    const r = await api('/notifications', { query: { page_size: 200 } });
    const link = n => n.entity_type === 'work_order' ? `#/wo/${n.entity_id}` : n.entity_type === 'asset' ? `#/assets/${n.entity_id}` : n.entity_type === 'part' ? `#/inventory/parts/${n.entity_id}` : null;
    mount(box, h('div', { class: 'panel' }, r.rows.length ? r.rows.map(n => h('div', { class: 'checklist-row', style: { opacity: n.is_read ? .6 : 1 } },
      h('div', null, h('span', { class: 'badge ' + ({ CRITICAL: 'b-bad', WARNING: 'b-warn' }[n.severity] || 'b-info') }, label(n.type)), ' ', link(n) ? h('a', { href: link(n), onclick: () => api(`/notifications/${n.id}/read`, { method: 'POST' }).then(() => window.__cmms.refreshBell()) }, h('b', null, n.title)) : h('b', null, n.title),
        n.body ? h('div', { class: 'sub' }, n.body) : null, h('div', { class: 'sub' }, fmt.dt(n.created_at))),
      n.is_read ? h('span', { class: 'muted' }, 'read') : h('button', { class: 'btn btn-sm', onclick: async () => { await api(`/notifications/${n.id}/read`, { method: 'POST' }); load(); window.__cmms.refreshBell(); } }, 'Mark read'))) : h('div', { class: 'empty' }, 'No notifications')));
  }
  load();
}

export async function team(el, q) {
  const box = h('div');
  const bar = filterBar({ site: false, initial: q, onChange: f => load(f) });
  mount(el, pageHead('Technician workload', 'Open jobs, overdue jobs and planned vs actual labor hours per technician'), bar, box);
  async function load(f) {
    const rows = await api('/team/workload', { query: f });
    mount(box, h('div', { class: 'panel' }, simpleTable([
      { label: 'Technician', render: u => [h('b', null, u.full_name), h('div', { class: 'sub' }, [u.position, u.skills].filter(Boolean).join(' · '))] },
      { label: 'Open jobs', num: true, key: 'open_count' }, { label: 'Overdue', num: true, render: u => u.overdue_count ? h('span', { class: 'badge b-bad' }, u.overdue_count) : '0' },
      { label: 'Open est. h', num: true, render: u => fmt.num(u.open_est_hours) }, { label: 'Closed in period', num: true, key: 'closed_in_period' },
      { label: 'Planned h (closed)', num: true, render: u => fmt.num(u.planned_hours_closed) }, { label: 'Actual labor h', num: true, render: u => fmt.num(u.actual_hours) },
    ], rows, { onRow: u => modal({ title: `${u.full_name} – open jobs`, wide: true, body: simpleTable([{ label: 'WO', render: w => h('a', { href: `#/wo/${w.id}` }, w.wo_number) }, { label: 'Type', render: w => typeBadge(w.wo_type) }, { label: 'Title', key: 'title' }, { label: 'Priority', render: w => prioBadge(w.priority) }, { label: 'Status', render: w => woBadge(w.status) }, { label: 'Due', render: w => fmt.date(w.due_date || w.planned_end) }], u.open, { empty: 'No open jobs', rowClass: w => (w.overdue ? 'row-bad' : '') }) }) })));
  }
  load(bar.values());
}
