// Work orders: breakdown reporting, register, my jobs, create, execution/detail, investigations.
import { h, mount, api, state, can, canAny, fmt, toast, act, modal, confirmDialog, form, opt, enumOpts, dataTable, simpleTable, pageHead, kv, tabs, assetBadge, woBadge, prioBadge, typeBadge, debounce, attachmentsPanel, label, codeLabel, assetPicker, uid, toLocalInput, errorBox, ApiError } from '../ui.js';

const fcOpts = kind => state.meta.failure_codes.filter(f => f.kind === kind).map(f => ({ value: f.code, label: f.label }));

// ---------------------------------------------------------------- breakdown report (mobile first)
export async function reportBreakdown(el, q) {
  const requestId = uid(); // idempotency key: a double tap or retry never creates a second report
  let asset = null;
  const assetInfo = h('div');
  const picker = assetPicker({ onPick: a => { asset = a; showAsset(); } });
  async function showAsset() {
    if (!asset) return mount(assetInfo);
    const dups = await api('/work-orders/check-duplicates', { query: { asset_id: asset.id, wo_type: 'CM' } }).catch(() => []);
    mount(assetInfo, h('div', { class: 'sub' }, `${asset.site} · current status `, assetBadge(asset.status)),
      dups.length ? h('div', { class: 'alert warn mt' }, h('b', null, 'Open corrective work already exists for this equipment:'), h('ul', null, ...dups.map(d => h('li', null, h('a', { href: `#/wo/${d.id}` }, d.wo_number), ` – ${d.title} (${label(d.status)})`))), 'If this is the same problem, add a note to that work order instead of reporting again.') : null);
  }
  if (q.asset) { const a = await api(`/assets/${q.asset}`); asset = { id: a.id, asset_code: a.asset_code, name: a.name, site: a.site.name, status: a.status }; picker.setLabel(`${a.asset_code} – ${a.name}`); picker.value = a.id; showAsset(); }

  const sevBtns = {};
  let severity = null, impact = null;
  const seg = (opts, onPick, store) => h('div', { class: 'seg', style: { flexWrap: 'wrap' } }, ...opts.map(([v, t, cls]) => {
    const b = h('button', { type: 'button', class: cls || '', onclick: () => { for (const x of Object.values(store)) x.classList.remove('on', 'FAIL', 'PASS'); b.classList.add('on', v === 'CRITICAL' || v === 'STOPPED' ? 'FAIL' : 'PASS'); onPick(v); } }, t);
    store[v] = b; return b;
  }));
  const impBtns = {};
  const sevSeg = seg([['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']], v => { severity = v; }, sevBtns);
  const impSeg = seg([['STOPPED', 'Stopped / not usable'], ['RESTRICTED', 'Running with restriction'], ['NONE', 'No impact yet']], v => { impact = v; }, impBtns);
  const details = form([
    { name: 'category_code', label: 'Breakdown category', type: 'select', required: true, options: fcOpts('BREAKDOWN_CATEGORY') },
    { name: 'occurred_at', label: 'When did it happen? (if known)', type: 'datetime' },
    { name: 'description', label: 'What is wrong?', type: 'textarea', required: true, full: true },
    { name: 'safety_impact', label: 'Safety impact', type: 'textarea', rows: 2 },
    { name: 'production_impact', label: 'Production impact', type: 'textarea', rows: 2 },
    { name: 'operating_condition', label: 'Operating condition before failure', type: 'textarea', rows: 2 },
    { name: 'temporary_action', label: 'Temporary action taken', type: 'textarea', rows: 2 },
    ...(can('wo.assign') ? [{ name: 'target_recovery_at', label: 'Target recovery (optional)', type: 'datetime' }] : []),
  ]);
  const file = h('input', { type: 'file', accept: 'image/*,video/mp4,video/quicktime', capture: 'environment' });
  const submit = h('button', { class: 'btn btn-danger btn-big' }, 'Submit breakdown report');
  submit.addEventListener('click', async () => {
    try {
      if (!picker.value) throw new ApiError(400, 'Select the equipment');
      if (!severity) throw new ApiError(400, 'Select severity');
      if (!impact) throw new ApiError(400, 'Select the operational impact');
      const v = details.values();
      const body = { ...v, asset_id: picker.value, severity, impact, client_request_id: requestId };
      let r;
      try { r = await act(submit, () => api('/breakdowns', { method: 'POST', body })); }
      catch (e) {
        if (e.status === 409 && e.details && e.details.duplicates) {
          if (!(await confirmDialog(`${e.message}\n\nCreate a new breakdown report anyway?`, { okLabel: 'Report anyway', danger: true }))) return;
          r = await act(submit, () => api('/breakdowns', { method: 'POST', body: { ...body, confirm_duplicate: true } }));
        } else return;
      }
      if (file.files[0]) {
        const fd = new FormData(); fd.append('file', file.files[0]); fd.append('entity_type', 'work_order'); fd.append('entity_id', r.id); fd.append('caption', 'Photo at time of report');
        await api('/attachments', { method: 'POST', body: fd }).catch(e => toast(`Report saved, but the photo failed to upload: ${e.message}. Add it from the work order.`, 'err'));
      }
      toast(`${r.report_no} reported – work order ${r.wo_number} created${r.repeat_count >= 2 ? ` (repeat breakdown: ${r.repeat_count} in window)` : ''}`, 'ok');
      location.hash = canAny('wo.view', 'wo.view_assigned') ? `#/wo/${r.id}` : `#/assets/${body.asset_id}`;
    } catch (e) { if (e instanceof ApiError && e.status === 400) toast(e.message, 'err'); }
  });
  mount(el, pageHead('Report breakdown or defect', 'Takes less than a minute. The maintenance team is notified immediately for critical reports.'),
    h('div', { class: 'panel', style: { maxWidth: '760px' } },
      h('div', { class: 'field' }, h('label', null, 'Equipment ', h('span', { class: 'req' }, '*')), picker, assetInfo, h('span', { class: 'hint' }, 'Tip: scan the QR label on the equipment to open this form pre-filled.')),
      h('div', { class: 'field' }, h('label', null, 'Severity ', h('span', { class: 'req' }, '*')), sevSeg,
        h('span', { class: 'hint' }, 'Critical: immediate safety risk or major disruption · High: significant impairment · Medium: limited impact · Low: minor defect')),
      h('div', { class: 'field' }, h('label', null, 'Equipment condition now ', h('span', { class: 'req' }, '*')), impSeg),
      details,
      h('div', { class: 'field' }, h('label', null, 'Photo / video'), file),
      submit));
}

// ---------------------------------------------------------------- register
function woColumns() {
  return [
    { key: 'wo_number', label: 'WO no.', sort: 'wo_number', render: r => h('b', null, r.wo_number) },
    { key: 'wo_type', label: 'Type', render: r => typeBadge(r.wo_type) },
    { key: 'asset', label: 'Equipment', sort: 'asset', render: r => [h('b', null, r.asset_code), ' ', h('span', { class: 'muted' }, r.asset_name)] },
    { key: 'title', label: 'Description', render: r => [r.title, r.is_recurrence ? h('span', { class: 'badge b-warn', style: { marginLeft: '4px' } }, 'Repeat') : null] },
    { key: 'site', label: 'Site' },
    { key: 'priority', label: 'Priority', sort: 'priority', render: r => prioBadge(r.priority) },
    { key: 'status', label: 'Status', sort: 'status', render: r => [woBadge(r.status), r.is_overdue ? h('span', { class: 'badge b-bad', style: { marginLeft: '4px' } }, 'Overdue') : null, r.is_unassigned ? h('span', { class: 'badge b-warn', style: { marginLeft: '4px' } }, 'Unassigned') : null] },
    { key: 'assigned_to', label: 'Assigned to', render: r => r.assigned_to || '—' },
    { key: 'due', label: 'Due / target', sort: 'due_date', render: r => r.due_date ? fmt.date(r.due_date) : r.planned_end ? fmt.dt(r.planned_end) : '—' },
    { key: 'created_at', label: 'Created', sort: 'created_at', render: r => fmt.date(r.created_at) },
  ];
}
const rowClass = r => (r.is_overdue || (r.priority === 'CRITICAL' && r.status_category !== 'DONE' && r.status_category !== 'CANCELLED') ? 'row-bad' : r.status === 'WAITING_PARTS' || r.is_unassigned ? 'row-warn' : '');

export async function list(el, q) {
  const search = h('input', { type: 'search', placeholder: 'WO no., equipment, description…', value: q.q || '' });
  const sel = (name, all, opts, cur) => h('select', { name }, h('option', { value: '' }, all), ...opts.map(([v, t]) => h('option', { value: v, selected: String(cur ?? '') === String(v) }, t)));
  const fSite = sel('site_id', 'All sites', state.meta.sites.map(s => [s.id, s.name]), q.site_id);
  const fType = sel('wo_type', 'All types', [['PMS', 'PMS'], ['CM', 'Corrective'], ['INSPECTION', 'Inspection'], ['OTHER', 'Other']], q.wo_type);
  const fPrio = sel('priority', 'Any priority', ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(p => [p, label(p)]), q.priority);
  const fStatus = sel('status', 'Any status', state.meta.wo_statuses.map(s => [s.code, s.label]), q.status);
  const fTech = sel('assignee_id', 'Any technician', state.meta.personnel.map(p => [p.id, p.full_name]), q.assignee_id);
  const fState = sel('view', 'Open + closed', [['open', 'Open only'], ['closed', 'Closed/cancelled'], ['overdue', 'Overdue'], ['unassigned', 'Unassigned'], ['waiting', 'Waiting for parts'], ['critical', 'Critical breakdowns']],
    q.overdue ? 'overdue' : q.open ? (q.priority === 'CRITICAL' ? 'critical' : 'open') : q.ids ? '' : 'open');
  const fFrom = h('input', { type: 'date', value: q.from || '' }), fTo = h('input', { type: 'date', value: q.to || '' });
  const table = dataTable({ columns: woColumns(), fetch: p => api('/work-orders', { query: p }), onRow: r => { location.hash = `#/wo/${r.id}`; }, rowClass });
  const reload = () => {
    const v = fState.value;
    table.reload({ q: search.value, site_id: fSite.value, wo_type: fType.value, priority: v === 'critical' ? 'CRITICAL' : fPrio.value, status: v === 'waiting' ? 'WAITING_PARTS' : fStatus.value, assignee_id: fTech.value,
      open: ['open', 'critical'].includes(v) ? 1 : '', closed: v === 'closed' ? 1 : '', overdue: v === 'overdue' ? 1 : '', unassigned: v === 'unassigned' ? 1 : '', ids: q.ids, from: fFrom.value, to: fTo.value, asset_id: q.asset_id, category_id: q.category_id });
  };
  search.addEventListener('input', debounce(reload));
  for (const s of [fSite, fType, fPrio, fStatus, fTech, fState, fFrom, fTo]) s.addEventListener('change', reload);
  const f = (l, i, grow) => h('div', { class: 'field' + (grow ? ' grow' : '') }, h('label', null, l), i);
  mount(el, pageHead('Work orders', q.ids ? h('span', null, 'Showing records behind a dashboard figure · ', h('a', { href: '#/wo' }, 'clear')) : 'PMS, corrective, inspection and other maintenance work',
    can('wo.create') ? h('a', { class: 'btn btn-primary', href: '#/wo/new' }, '+ New work order') : null,
    can('breakdown.report') ? h('a', { class: 'btn btn-danger', href: '#/report' }, '⚠ Report breakdown') : null),
  h('div', { class: 'toolbar' }, f('Search', search, true), f('Show', fState), f('Site', fSite), f('Type', fType), f('Priority', fPrio), f('Status', fStatus), f('Technician', fTech), f('Created from', fFrom), f('to', fTo)),
  h('div', { class: 'panel' }, table));
  reload();
}

export async function myJobs(el) {
  const table = dataTable({ columns: woColumns().filter(c => !['site', 'assigned_to', 'created_at'].includes(c.key)), fetch: p => api('/work-orders', { query: { ...p, mine: 1, open: 1 } }), onRow: r => { location.hash = `#/wo/${r.id}`; }, rowClass });
  mount(el, pageHead('My jobs', 'Open work orders assigned to you'), h('div', { class: 'panel' }, table));
  table.reload();
}

export async function create(el, q) {
  let presetAsset = null;
  if (q.asset) presetAsset = await api(`/assets/${q.asset}`);
  const picker = assetPicker();
  if (presetAsset) { picker.setLabel(`${presetAsset.asset_code} – ${presetAsset.name}`); picker.value = presetAsset.id; }
  const f = form([
    { name: 'wo_type', label: 'Work order type', type: 'select', required: true, options: [{ value: 'CM', label: 'Corrective maintenance' }, { value: 'INSPECTION', label: 'Inspection' }, { value: 'PMS', label: 'Preventive (one-off PMS)' }, { value: 'OTHER', label: 'Other maintenance activity' }] },
    { name: 'priority', label: 'Priority', type: 'select', required: true, options: enumOpts(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) },
    { name: 'title', label: 'Description of work', required: true, full: true },
    { name: 'description', label: 'Details', type: 'textarea', full: true },
    { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'planned_start', label: 'Planned start', type: 'datetime' }, { name: 'planned_end', label: 'Planned completion', type: 'datetime' },
    { name: 'est_labor_hours', label: 'Estimated labor hours', type: 'number', step: '0.5' },
    { name: 'checklist_template_id', label: 'Checklist', type: 'select', options: opt(state.meta.checklists) },
    { name: 'requires_shutdown', label: 'Equipment must be taken out of service for this work', type: 'checkbox', full: true },
  ], { priority: 'MEDIUM', wo_type: 'CM', requires_shutdown: true });
  const save = h('button', { class: 'btn btn-primary', onclick: async e => {
    const body = { ...f.values(), asset_id: picker.value, client_request_id: save.dataset.rid };
    if (!body.asset_id) return toast('Select the equipment', 'err');
    let r;
    try { r = await act(e.currentTarget, () => api('/work-orders', { method: 'POST', body })); }
    catch (ex) {
      if (ex.status !== 409 || !ex.details || !ex.details.duplicates) return;
      if (!(await confirmDialog(`${ex.message} Existing: ${ex.details.duplicates.map(d => d.wo_number).join(', ')}`, { okLabel: 'Create anyway' }))) return;
      r = await act(e.currentTarget, () => api('/work-orders', { method: 'POST', body: { ...body, confirm_duplicate: true } }));
    }
    toast(`Work order ${r.wo_number || ''} created`, 'ok');
    location.hash = `#/wo/${r.id}`;
  } }, 'Create work order');
  save.dataset.rid = uid();
  mount(el, pageHead('New work order', 'For breakdowns use “Report breakdown” so the incident details and downtime are captured'),
    h('div', { class: 'panel' }, h('div', { class: 'field' }, h('label', null, 'Equipment *'), picker), f, save));
}

// ---------------------------------------------------------------- detail / execution
export async function detail(el, id) {
  const w = await api(`/work-orders/${id}`);
  const reload = () => detail(el, id);
  const exec = w.can.execute && ['IN_PROGRESS', 'WAITING_PARTS', 'WAITING_EXTERNAL', 'FOR_TESTING', 'ASSIGNED'].includes(w.status);
  const open = ['OPEN', 'HOLD'].includes(w.status_info.category);

  // --- action bar
  const actionBtns = w.transitions.map(t => {
    const cls = t.category === 'DONE' ? 'btn-ok' : t.category === 'CANCELLED' || t.category === 'MISSED' ? '' : t.to_status === 'IN_PROGRESS' || t.to_status === 'FOR_VERIFICATION' ? 'btn-primary' : '';
    const text = { IN_PROGRESS: w.status === 'FOR_VERIFICATION' ? 'Return for rework' : w.status === 'FOR_TESTING' ? 'Test failed – continue repair' : w.status.startsWith('WAITING') ? 'Resume work' : 'Start work',
      FOR_VERIFICATION: 'Submit for verification', CLOSED: 'Verify & close (return to service)', CANCELLED: 'Cancel', MISSED: 'Mark missed', FOR_TESTING: 'Repair done – for testing',
      UNDER_ASSESSMENT: 'Start assessment', ASSIGNED: 'Approve / assign', WAITING_PARTS: 'Waiting for parts', WAITING_EXTERNAL: 'Waiting for external service' }[t.to_status] || t.label;
    return h('button', { class: 'btn ' + cls, onclick: () => transitionDialog(w, t, text, reload) }, text);
  });
  if (w.can.assign && open) actionBtns.unshift(h('button', { class: 'btn', onclick: () => assignDialog(w, reload) }, w.assignees.length ? 'Reassign' : 'Assign technician'));
  if (w.can.reschedule && open && w.due_date) actionBtns.push(h('button', { class: 'btn', onclick: () => rescheduleDialog(w, reload) }, 'Reschedule'));
  if ((w.wo_type === 'PMS' || w.wo_type === 'INSPECTION') && open && (w.can.execute || can('wo.create'))) actionBtns.push(h('button', { class: 'btn', onclick: () => linkedCmDialog(w, reload) }, '+ Corrective WO from finding'));
  const nextHint = guidance(w);

  const summary = h('div', { class: 'grid two' },
    h('div', { class: 'panel' }, h('h2', null, 'Work order'), kv([
      ['Number', h('b', null, w.wo_number)], ['Type', [typeBadge(w.wo_type), w.source !== 'MANUAL' ? h('span', { class: 'muted' }, ` · ${label(w.source)}`) : null]],
      ['Equipment', h('a', { href: `#/assets/${w.asset.id}` }, `${w.asset.asset_code} – ${w.asset.name}`)], ['Equipment status', assetBadge(w.asset.status)], ['Site', w.site.name],
      ['Priority', prioBadge(w.priority)], ['Status', woBadge(w.status)], ['Description', w.title], ['Details', w.description ? h('div', { style: { whiteSpace: 'pre-wrap' } }, w.description) : null],
      ['Requested by', w.people[w.requested_by]], ['Supervisor', w.people[w.supervisor_id]], ['Assigned to', w.assignees.map(a => a.full_name).join(', ') || h('span', { class: 'badge b-warn' }, 'Unassigned')],
      w.due_date ? ['Due date', [fmt.date(w.due_date), w.original_due_date && w.original_due_date !== w.due_date ? h('span', { class: 'muted' }, ` (originally ${fmt.date(w.original_due_date)})`) : null]] : null,
      w.due_meter != null ? ['Due at meter', fmt.num(w.due_meter)] : null,
      ['Planned', `${fmt.dt(w.planned_start)} → ${fmt.dt(w.planned_end)}`], ['Actual', `${fmt.dt(w.actual_start)} → ${fmt.dt(w.actual_end)}`],
      ['Labor', `${fmt.hours(w.labor_hours)} actual${w.est_labor_hours ? ` / ${fmt.hours(w.est_labor_hours)} estimated` : ''}`],
      w.returned_to_service_at ? ['Returned to service', fmt.dt(w.returned_to_service_at)] : null,
      w.submitted_by ? ['Submitted by', `${w.people[w.submitted_by]} · ${fmt.dt(w.submitted_at)}`] : null,
      w.verified_by ? ['Verified & closed by', `${w.people[w.verified_by]} · ${fmt.dt(w.verified_at)}`] : null,
      w.cancelled_by ? ['Cancelled / missed by', `${w.people[w.cancelled_by]} · ${fmt.dt(w.cancelled_at)} – ${w.cancel_reason}`] : null,
      w.investigation ? ['Investigation', h('a', { href: `#/investigations/${w.investigation.id}` }, `${w.investigation.inv_no} ${w.investigation.title}`)] : null,
      w.linked.length ? ['Linked WOs', w.linked.map(l => h('div', null, h('a', { href: `#/wo/${l.id}` }, l.wo_number), ` ${l.title} `, woBadge(l.status)))] : null,
    ]), w.can.edit_plan ? h('button', { class: 'btn btn-sm mt', onclick: () => planDialog(w, reload) }, 'Edit planning details') : null),
    w.breakdown ? h('div', { class: 'panel' }, h('h2', null, `Breakdown report ${w.breakdown.report_no}`), kv([
      ['Reported', `${fmt.dt(w.breakdown.reported_at)} by ${w.breakdown.reported_by_name}`], ['Occurred', fmt.dt(w.breakdown.occurred_at)], ['Category', codeLabel('BREAKDOWN_CATEGORY', w.breakdown.category_code)],
      ['Severity', prioBadge(w.breakdown.severity)], ['Impact', label(w.breakdown.impact)], ['Description', w.breakdown.description], ['Operating condition', w.breakdown.operating_condition],
      ['Safety impact', w.breakdown.safety_impact], ['Production impact', w.breakdown.production_impact], ['Temporary action', w.breakdown.temporary_action],
      !w.breakdown.is_failure ? ['Counted as failure', h('span', { class: 'badge b-grey' }, 'No – cancelled as invalid')] : null,
    ])) : h('div', { class: 'panel' }, h('h2', null, 'Status history'), timeline(w)));

  const t = tabs([
    { key: 'work', label: 'Work & findings', render: () => workTab(w, exec, reload) },
    { key: 'checklist', label: `Checklist (${w.checklist.filter(c => c.result).length}/${w.checklist.length})`, show: w.checklist.length > 0, render: () => checklistTab(w, exec, reload) },
    { key: 'labor', label: `Labor (${fmt.hours(w.labor_hours)})`, render: () => laborTab(w, reload) },
    { key: 'parts', label: `Parts (${w.parts.length})`, render: () => partsTab(w, reload) },
    { key: 'costs', label: 'Costs', show: !!w.can.cost, render: () => costsTab(w, reload) },
    { key: 'files', label: `Photos & files (${w.attachments.length})`, render: () => h('div', { class: 'panel' }, attachmentsPanel('work_order', w.id, w.attachments, { canUpload: open && (w.can.execute || w.can.assign || w.requested_by === state.me.id), reload })) },
    { key: 'notes', label: `Notes (${w.notes.length})`, render: () => notesTab(w, reload) },
    { key: 'history', label: 'History & approvals', render: () => h('div', { class: 'grid two' }, h('div', { class: 'panel' }, h('h3', null, 'Status history'), timeline(w)),
      h('div', { class: 'panel' }, h('h3', null, 'Approvals'), simpleTable([{ label: 'When', render: a => fmt.dt(a.decided_at) }, { label: 'Action', render: a => label(a.action) }, { label: 'Decision', render: a => h('span', { class: 'badge ' + (a.decision === 'APPROVED' ? 'b-ok' : 'b-bad') }, label(a.decision)) }, { label: 'By', key: 'by_name' }, { label: 'Remarks', key: 'remarks' }], w.approvals, { empty: 'No approvals yet' }),
        w.reschedules.length ? [h('h3', null, 'Reschedules'), simpleTable([{ label: 'When', render: r => fmt.dt(r.created_at) }, { label: 'From', render: r => fmt.date(r.old_due_date) }, { label: 'To', render: r => fmt.date(r.new_due_date) }, { label: 'Reason', key: 'reason' }, { label: 'Authorised by', key: 'by_name' }], w.reschedules)] : null,
        h('h3', null, 'Downtime intervals'), simpleTable([{ label: 'Type', render: d => label(d.category) }, { label: 'Start', render: d => fmt.dt(d.start_at) }, { label: 'End', render: d => d.end_at ? fmt.dt(d.end_at) : 'ongoing' }, { label: 'Void', render: d => d.is_void ? 'Yes' : '' }], w.downtime, { empty: 'No downtime recorded' }))) },
  ], exec && w.checklist.length && w.checklist.some(c => !c.result) ? 'checklist' : 'work');

  mount(el, pageHead(`${w.wo_number}`, w.title, ...actionBtns), nextHint, summary, t);
}

function guidance(w) {
  const msg = {
    REPORTED: 'Next: supervisor assesses the report and assigns technician(s).', SCHEDULED: 'Next: assign a technician before the due date.',
    UNDER_ASSESSMENT: 'Next: approve and assign technician(s).', ASSIGNED: 'Next: assigned technician starts the work (equipment status changes to Under Maintenance).',
    IN_PROGRESS: w.wo_type === 'CM' ? 'Record repair details, root cause, parts and labor. Then mark “Repair done – for testing”.' : 'Complete the checklist, record findings, labor and condition after maintenance, then submit for verification.',
    FOR_TESTING: 'Record testing results and confirm the functional test passed, then submit for verification.',
    FOR_VERIFICATION: 'Waiting for an authorised supervisor (not the person who did the work) to verify and close. Equipment is not released until then.',
  }[w.status];
  return msg ? h('div', { class: 'alert info' }, msg) : null;
}
function timeline(w) {
  return h('ul', { class: 'timeline' }, ...w.history.map(x => h('li', null, h('b', null, label(x.to_status)), ` · ${fmt.dt(x.changed_at)} · ${x.by_name || 'System'}`, x.remarks ? h('div', { class: 'sub' }, x.remarks) : null)));
}

function workTab(w, exec, reload) {
  const isCM = w.wo_type === 'CM';
  const fields = [
    { name: 'work_performed', label: 'Work performed', type: 'textarea', full: true },
    { name: 'findings', label: 'Findings and observations', type: 'textarea' }, { name: 'defects_found', label: 'Defects identified', type: 'textarea' },
    { name: 'recommendations', label: 'Recommendations / corrective actions required', type: 'textarea' },
    ...(!isCM ? [{ name: 'condition_after', label: 'Equipment condition after maintenance', type: 'select', options: enumOpts(['Good / serviceable', 'Serviceable – monitor', 'Serviceable with restriction', 'Not serviceable – corrective work required']).map(o => ({ value: o.value, label: o.value })) }] : []),
    ...(isCM ? [
      { type: 'heading', label: 'Failure analysis & repair' },
      { name: 'root_cause_code', label: 'Root cause', type: 'select', options: fcOpts('ROOT_CAUSE') }, { name: 'root_cause_remarks', label: 'Root cause remarks' },
      { name: 'failure_mode_code', label: 'Failure mode', type: 'select', options: fcOpts('FAILURE_MODE') }, { name: 'failed_component', label: 'Failed component' },
      { name: 'repair_action', label: 'Repair action', type: 'textarea', full: true }, { name: 'is_recurrence', label: 'Recurrence of a previous failure', type: 'checkbox' },
    ] : []),
    { type: 'heading', label: 'Testing & completion' },
    { name: 'test_results', label: 'Testing results', type: 'textarea' }, { name: 'test_passed', label: 'Functional test passed', type: 'checkbox' },
    ...(w.asset.meter_type !== 'NONE' ? [{ name: 'meter_at_completion', label: `Meter reading at completion (${w.asset.meter_type === 'HOURS' ? 'h' : 'km'})`, type: 'number', step: '0.1', hint: `Last recorded: ${fmt.num(w.asset.meter_reading)}` }] : []),
    { name: 'actual_start', label: 'Actual start', type: 'datetime' }, { name: 'actual_end', label: 'Actual completion', type: 'datetime', hint: 'Set automatically when submitted if blank' },
    { name: 'completion_remarks', label: 'Completion remarks', type: 'textarea', full: true },
  ];
  if (!exec) {
    return h('div', { class: 'panel' }, kv(fields.filter(f => f.type !== 'heading').map(f => {
      let v = w[f.name];
      if (f.type === 'checkbox') v = v == null ? null : v ? 'Yes' : 'No';
      else if (f.name === 'root_cause_code' && v) v = codeLabel('ROOT_CAUSE', v);
      else if (f.name === 'failure_mode_code' && v) v = codeLabel('FAILURE_MODE', v);
      else if (f.type === 'datetime') v = v ? fmt.dt(v) : null;
      return [f.label, v != null && v !== '' ? h('div', { style: { whiteSpace: 'pre-wrap' } }, String(v)) : null];
    })));
  }
  const f = form(fields, w);
  const save = h('button', { class: 'btn btn-primary', onclick: async e => {
    const v = f.values();
    for (const k of ['actual_start', 'actual_end']) if (v[k] && toLocalInput(w[k]) === v[k]) delete v[k];
    await act(e.currentTarget, () => api(`/work-orders/${w.id}`, { method: 'PUT', body: { ...v, version: w.version } }), 'Saved');
    reload();
  } }, 'Save work details');
  return h('div', { class: 'panel' }, f, save);
}

function checklistTab(w, exec, reload) {
  const vals = Object.fromEntries(w.checklist.map(c => [c.id, { result: c.result, remarks: c.remarks }]));
  let section = null;
  const rows = [];
  for (const c of w.checklist) {
    if (c.section !== section) { section = c.section; rows.push(h('h3', null, section || 'General')); }
    const remarks = h('input', { placeholder: 'Remarks', value: c.remarks || '', disabled: !exec, oninput: e => { vals[c.id].remarks = e.target.value; } });
    let control;
    if (c.response_type === 'PASS_FAIL' || c.response_type === 'DONE') {
      const choices = c.response_type === 'PASS_FAIL' ? ['PASS', 'FAIL', 'NA'] : ['DONE', 'NA'];
      const btns = choices.map(ch => h('button', { type: 'button', class: (c.result === ch ? 'on ' : '') + ch, disabled: !exec, onclick: () => { vals[c.id].result = ch; btns.forEach(b => b.classList.toggle('on', b.textContent === ch)); } }, ch));
      control = h('div', { class: 'seg' }, ...btns);
    } else control = h('input', { value: c.result || '', disabled: !exec, style: { maxWidth: '160px' }, oninput: e => { vals[c.id].result = e.target.value; } });
    rows.push(h('div', { class: 'checklist-row' }, h('div', null, h('div', null, c.description, c.is_required ? h('span', { class: 'req' }, ' *') : null), remarks), control));
  }
  const save = exec ? h('button', { class: 'btn btn-primary mt', onclick: async e => {
    await act(e.currentTarget, () => api(`/work-orders/${w.id}/checklist`, { method: 'PUT', body: { results: Object.entries(vals).map(([id, v]) => ({ id: Number(id), ...v })) } }), 'Checklist saved');
    reload();
  } }, 'Save checklist') : null;
  return h('div', { class: 'panel' }, !exec ? h('div', { class: 'sub' }, 'Checklist is filled in by the assigned technician while the work is in progress.') : h('div', { class: 'sub' }, 'Failed items require remarks. Defects beyond PMS scope: use “+ Corrective WO from finding”.'), ...rows, save);
}

function laborTab(w, reload) {
  const open = ['OPEN', 'HOLD'].includes(w.status_info.category) && !['REPORTED', 'SCHEDULED', 'UNDER_ASSESSMENT'].includes(w.status);
  const people = w.can.assign ? state.meta.personnel : state.meta.personnel.filter(p => p.id === state.me.id);
  const f = form([
    { name: 'user_id', label: 'Person', type: 'select', required: true, options: opt(people.length ? people : [{ id: state.me.id, full_name: state.me.full_name }], 'id', 'full_name') },
    { name: 'work_date', label: 'Work date', type: 'date', required: true }, { name: 'hours', label: 'Hours', type: 'number', step: '0.25', required: true, min: '0.25', max: '24' }, { name: 'notes', label: 'Notes' },
  ], { user_id: state.me.id, work_date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) });
  return h('div', { class: 'panel' },
    simpleTable([{ label: 'Date', render: l => fmt.date(l.work_date) }, { label: 'Person', key: 'full_name' }, { label: 'Hours', num: true, render: l => fmt.num(l.hours, 2) },
      w.can.cost ? { label: 'Cost', num: true, render: l => fmt.money(l.cost) } : null, { label: 'Notes', key: 'notes' }, { label: '', render: l => l.is_void ? h('span', { class: 'badge b-grey' }, 'Void') : (open && (w.can.execute) ? h('button', { class: 'btn btn-sm', onclick: () => voidLabor(w, l, reload) }, 'Void') : '') }].filter(Boolean),
    w.labor, { empty: 'No labor recorded', rowClass: l => (l.is_void ? 'muted' : '') }),
    h('p', { class: 'sub' }, 'Labor hours are person-hours worked. Elapsed equipment downtime is tracked separately from equipment status.'),
    open && w.can.execute ? [h('h3', null, 'Record labor'), f, h('button', { class: 'btn btn-primary', onclick: async e => { await act(e.currentTarget, () => api(`/work-orders/${w.id}/labor`, { method: 'POST', body: f.values() }), 'Labor recorded'); reload(); } }, 'Add labor')] : null);
}
function voidLabor(w, l, reload) {
  const f = form([{ name: 'reason', label: 'Reason', required: true, full: true }]);
  modal({ title: 'Void labor entry', body: f, actions: [{ label: 'Cancel' }, { label: 'Void', class: 'btn-danger', onClick: async () => { await api(`/work-orders/${w.id}/labor/${l.id}/void`, { method: 'POST', body: f.values() }); toast('Labor entry voided', 'ok'); reload(); } }] });
}

function partsTab(w, reload) {
  const open = ['OPEN', 'HOLD'].includes(w.status_info.category);
  const actions = [];
  if (open && w.can.issue) actions.push(h('button', { class: 'btn btn-primary', onclick: () => stockDialog(w, 'issue', reload) }, 'Issue parts'), h('button', { class: 'btn', onclick: () => stockDialog(w, 'return', reload) }, 'Return unused'));
  if (open && w.can.reserve) actions.push(h('button', { class: 'btn', onclick: () => stockDialog(w, 'reserve', reload) }, 'Reserve parts'));
  if (open && can('pr.create')) actions.push(h('button', { class: 'btn', onclick: () => stockDialog(w, 'pr', reload) }, 'Request purchase'));
  return h('div', null,
    w.required_parts.length ? h('div', { class: 'panel' }, h('h3', null, 'Required parts (from PMS plan)'), simpleTable([{ label: 'Part', render: p => `${p.part_no} ${p.name}` }, { label: 'Qty', num: true, render: p => `${p.qty} ${p.uom}` }], w.required_parts)) : null,
    h('div', { class: 'panel' }, h('h3', null, 'Issued / returned'), simpleTable([
      { label: 'Txn', key: 'txn_no' }, { label: 'Type', render: p => label(p.txn_type) }, { label: 'Part', render: p => `${p.part_no} ${p.name}` }, { label: 'Qty', num: true, render: p => `${-p.qty} ${p.uom}` },
      { label: 'Store', key: 'store' }, { label: 'Recipient', key: 'recipient' }, w.can.cost ? { label: 'Value', num: true, render: p => fmt.money(-p.total_cost) } : null, { label: 'When', render: p => fmt.dt(p.created_at) }].filter(Boolean), w.parts, { empty: 'No parts issued' }),
    w.reservations.length ? [h('h3', null, 'Reservations'), simpleTable([{ label: 'Part', render: r => `${r.part_no} ${r.name}` }, { label: 'Store', key: 'store' }, { label: 'Reserved', num: true, key: 'qty_reserved' }, { label: 'Issued', num: true, key: 'qty_issued' }, { label: 'Status', render: r => label(r.status) }], w.reservations)] : null,
    w.purchase_requests.length ? [h('h3', null, 'Purchase requests'), simpleTable([{ label: 'PR', key: 'pr_no' }, { label: 'Part', render: r => `${r.part_no} ${r.name}` }, { label: 'Qty', num: true, key: 'qty' }, { label: 'Status', render: r => label(r.status) }], w.purchase_requests)] : null,
    h('div', { class: 'inline-actions mt' }, ...actions)));
}

async function stockDialog(w, mode, reload) {
  const stores = state.meta.stores.filter(s => s.site_id === w.site.id).concat(state.meta.stores.filter(s => s.site_id !== w.site.id));
  const partPick = h('select', null, h('option', { value: '' }, 'Loading parts…'));
  const r = await api('/parts', { query: { page_size: 200 } });
  mount(partPick, h('option', { value: '' }, '— select part —'), ...r.rows.map(p => h('option', { value: p.id }, `${p.part_no} – ${p.name} (${fmt.num(p.on_hand)} ${p.uom} on hand)`)));
  const fields = [{ name: 'store_id', label: 'Store', type: 'select', required: true, options: opt(stores) }, { name: 'qty', label: 'Quantity', type: 'number', required: true, step: 'any' }];
  if (mode === 'issue') fields.push({ name: 'recipient', label: 'Received by', required: true, hint: 'Technician receiving the parts' });
  if (mode === 'return') fields.push({ name: 'reason', label: 'Reason' });
  if (mode === 'pr') fields.push({ name: 'needed_by', label: 'Needed by', type: 'date' }, { name: 'remarks', label: 'Remarks', full: true });
  const f = form(fields, { store_id: stores[0] && stores[0].id, recipient: w.assignees.map(a => a.full_name).join(', ') });
  const rid = uid();
  const title = { issue: 'Issue parts to work order', return: 'Return unused parts', reserve: 'Reserve parts for this job', pr: 'Request purchase' }[mode];
  modal({ title, body: h('div', null, h('div', { class: 'field' }, h('label', null, 'Part *'), partPick), f), actions: [{ label: 'Cancel' }, { label: 'Confirm', class: 'btn-primary', onClick: async () => {
    const v = f.values();
    if (!partPick.value) throw new ApiError(400, 'Select the part');
    const body = { ...v, part_id: Number(partPick.value), work_order_id: w.id, client_request_id: rid };
    const url = { issue: '/inventory/issue', return: '/inventory/return', reserve: '/inventory/reserve', pr: '/purchase-requests' }[mode];
    await api(url, { method: 'POST', body });
    toast(mode === 'issue' ? 'Parts issued and deducted from stock' : mode === 'return' ? 'Return posted to stock' : mode === 'reserve' ? 'Parts reserved' : 'Purchase request submitted', 'ok');
    reload();
  } }] });
}

function costsTab(w, reload) {
  const rows = w.costs || [];
  const actual = rows.filter(c => c.kind === 'ACTUAL' && ['APPROVED', 'PENDING'].includes(c.status)).reduce((t, c) => t + c.amount, 0);
  const est = rows.filter(c => c.kind === 'ESTIMATE' && c.status !== 'VOID' && c.status !== 'REJECTED').reduce((t, c) => t + c.amount, 0) + (w.est_cost || 0);
  return h('div', { class: 'panel' }, kv([['Actual cost (approved + pending)', h('b', null, fmt.money(actual))], ['Estimated cost', fmt.money(est)]]),
    simpleTable([{ label: 'Date', render: c => fmt.date(c.entry_date) }, { label: 'Category', render: c => label(c.category) }, { label: 'Kind', render: c => label(c.kind) }, { label: 'Description', key: 'description' },
      { label: 'Source', render: c => label(c.source_type) }, { label: 'Amount', num: true, render: c => fmt.money(c.amount) }, { label: 'Status', render: c => h('span', { class: 'badge ' + ({ APPROVED: 'b-ok', PENDING: 'b-warn', REJECTED: 'b-bad', VOID: 'b-grey' }[c.status]) }, label(c.status)) }], rows, { empty: 'No costs recorded' }),
    h('p', { class: 'sub' }, 'Parts and internal labor are costed automatically from stock issues and labor entries (each source once). Add external labor, third-party services, rentals and other direct costs here.'),
    w.can.cost_manage && w.status !== 'CANCELLED' ? h('button', { class: 'btn', onclick: () => costDialog({ work_order_id: w.id }, reload) }, '+ Add cost entry') : null);
}
export function costDialog(preset, reload) {
  const f = form([
    { name: 'category', label: 'Cost category', type: 'select', required: true, options: [['EXTERNAL_LABOR', 'External labor'], ['THIRD_PARTY_SERVICE', 'Third-party repair service'], ['RENTAL', 'Equipment rental due to breakdown'], ['PARTS', 'Parts – direct purchase (not from stores)'], ['OTHER', 'Other direct cost']].map(([value, l]) => ({ value, label: l })) },
    { name: 'kind', label: 'Estimate or actual', type: 'select', required: true, options: [{ value: 'ACTUAL', label: 'Actual' }, { value: 'ESTIMATE', label: 'Estimate' }] },
    { name: 'amount', label: 'Amount (₱)', type: 'number', step: '0.01', required: true }, { name: 'entry_date', label: 'Date', type: 'date' },
    { name: 'vendor', label: 'Vendor' }, { name: 'reference', label: 'OR / invoice / reference' }, { name: 'description', label: 'Description', required: true, full: true },
  ], { kind: 'ACTUAL' });
  modal({ title: 'Add cost entry', body: f, actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => {
    const body = { ...preset, ...f.values() };
    try { await api('/costs', { method: 'POST', body }); }
    catch (e) { if (e.status === 409 && e.details && e.details.duplicate_id && await confirmDialog(e.message, { okLabel: 'Record anyway' })) await api('/costs', { method: 'POST', body: { ...body, confirm_duplicate: true } }); else throw e; }
    toast('Cost entry recorded (pending approval)', 'ok'); reload();
  } }] });
}

function notesTab(w, reload) {
  const ta = h('textarea', { placeholder: 'Progress update or remark…' });
  return h('div', { class: 'panel' }, h('div', { class: 'field' }, ta), h('button', { class: 'btn btn-primary', onclick: async e => { await act(e.currentTarget, () => api(`/work-orders/${w.id}/notes`, { method: 'POST', body: { note: ta.value } }), 'Note added'); reload(); } }, 'Add note'),
    h('ul', { class: 'timeline mt' }, ...w.notes.map(n => h('li', null, h('b', null, n.full_name || ''), ` · ${fmt.dt(n.created_at)}`, h('div', { style: { whiteSpace: 'pre-wrap' } }, n.note)))));
}

function transitionDialog(w, t, text, reload) {
  const needsReason = ['CANCELLED', 'MISSED'].includes(t.category) || (w.status === 'FOR_VERIFICATION' && t.to_status === 'IN_PROGRESS');
  const fields = [{ name: 'remarks', label: needsReason ? 'Reason' : 'Remarks', type: 'textarea', required: needsReason, full: true }];
  if (t.category === 'DONE' && w.requires_shutdown) fields.push({ name: 'returned_to_service_at', label: 'Returned to service at', type: 'datetime', hint: 'Leave blank for now. Must be after actual completion.' });
  if (t.category === 'CANCELLED' && w.wo_type === 'CM' && w.breakdown) fields.push({ name: 'invalid_report', label: 'Report was invalid / duplicate – do not count as a failure and void its downtime', type: 'checkbox', full: true });
  const f = form(fields);
  const warn = t.category === 'DONE' ? h('div', { class: 'alert info' }, 'Closing confirms the work was verified and releases the equipment back to service. Pending parts/labor costs on this work order are approved.')
    : t.to_status === 'FOR_VERIFICATION' ? h('div', { class: 'alert info' }, 'Submitting requires work performed, labor, all required checklist items' + (w.wo_type === 'CM' ? ', root cause, failure mode, failed component, repair action and a passed test.' : ' and the equipment condition.')) : null;
  modal({ title: `${text} – ${w.wo_number}`, body: h('div', null, warn, f), actions: [{ label: 'Back' }, { label: text, class: t.category === 'CANCELLED' || t.category === 'MISSED' ? 'btn-danger' : 'btn-primary', onClick: async () => {
    await api(`/work-orders/${w.id}/transition`, { method: 'POST', body: { to: t.to_status, version: w.version, ...f.values() } });
    toast(`${w.wo_number}: ${t.label}`, 'ok'); window.__cmms.refreshBell(); reload();
  } }] });
}
function assignDialog(w, reload) {
  const people = state.meta.personnel.filter(p => p.all_sites || (p.site_ids || '').split(',').map(Number).includes(w.site.id));
  const f = form([{ name: 'user_ids', label: 'Technicians', type: 'multiselect', options: people.map(p => ({ value: p.id, label: `${p.full_name}${p.skills ? ' – ' + p.skills : ''}` })) }, { name: 'remarks', label: 'Instructions / remarks', full: true }], { user_ids: w.assignees.map(a => a.id) });
  modal({ title: `Assign – ${w.wo_number}`, body: h('div', null, h('p', { class: 'sub' }, 'See ', h('a', { href: '#/team', target: '_blank' }, 'technician workload'), ' before assigning.'), f), actions: [{ label: 'Cancel' }, { label: 'Assign', class: 'btn-primary', onClick: async () => {
    const v = f.values(); await api(`/work-orders/${w.id}/assign`, { method: 'POST', body: { ...v, version: w.version } }); toast('Assigned', 'ok'); reload();
  } }] });
}
function rescheduleDialog(w, reload) {
  const f = form([{ name: 'new_due_date', label: 'New due date', type: 'date', required: true }, { name: 'reason', label: 'Reason for rescheduling', type: 'textarea', required: true, full: true }]);
  modal({ title: `Reschedule – ${w.wo_number}`, body: h('div', null, h('p', { class: 'sub' }, `Current due date ${fmt.date(w.due_date)}. The reason and your name are recorded as the authorising person.`), f), actions: [{ label: 'Cancel' }, { label: 'Reschedule', class: 'btn-primary', onClick: async () => { await api(`/work-orders/${w.id}/reschedule`, { method: 'POST', body: f.values() }); toast('Rescheduled', 'ok'); reload(); } }] });
}
function linkedCmDialog(w, reload) {
  const f = form([{ name: 'title', label: 'Defect requiring corrective repair', required: true, full: true }, { name: 'description', label: 'Details', type: 'textarea', full: true }, { name: 'priority', label: 'Priority', type: 'select', required: true, options: enumOpts(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) }, { name: 'requires_shutdown', label: 'Repair requires taking equipment out of service', type: 'checkbox' }], { priority: 'MEDIUM', requires_shutdown: true });
  modal({ title: 'Create linked corrective work order', body: h('div', null, h('p', { class: 'sub' }, `This PMS stays classified as preventive. The corrective work order is linked to ${w.wo_number}.`), f), actions: [{ label: 'Cancel' }, { label: 'Create', class: 'btn-primary', onClick: async () => { const r = await api(`/work-orders/${w.id}/linked-cm`, { method: 'POST', body: f.values() }); toast(`Corrective WO ${r.wo_number} created`, 'ok'); reload(); } }] });
}
function planDialog(w, reload) {
  const f = form([
    { name: 'title', label: 'Description', required: true, full: true }, { name: 'description', label: 'Details', type: 'textarea', full: true },
    { name: 'priority', label: 'Priority', type: 'select', required: true, options: enumOpts(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) },
    { name: 'supervisor_id', label: 'Supervisor', type: 'select', options: opt(state.meta.personnel.filter(p => p.role_code !== 'TECHNICIAN'), 'id', 'full_name') },
    { name: 'planned_start', label: 'Planned start', type: 'datetime' }, { name: 'planned_end', label: 'Planned completion / target recovery', type: 'datetime' },
    { name: 'est_labor_hours', label: 'Estimated labor hours', type: 'number', step: '0.5' }, ...(can('cost.view') ? [{ name: 'est_cost', label: 'Estimated cost (₱)', type: 'number', step: '0.01' }] : []),
  ], w);
  modal({ title: `Planning – ${w.wo_number}`, wide: true, body: f, actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => { await api(`/work-orders/${w.id}`, { method: 'PUT', body: { ...f.values(), version: w.version } }); toast('Saved', 'ok'); reload(); } }] });
}

// ---------------------------------------------------------------- breakdown register & investigations
export async function breakdowns(el) {
  const fSite = h('select', null, h('option', { value: '' }, 'All sites'), ...state.meta.sites.map(s => h('option', { value: s.id }, s.name)));
  const fSev = h('select', null, h('option', { value: '' }, 'Any severity'), ...['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(s => h('option', { value: s }, label(s))));
  const table = dataTable({ columns: [
    { label: 'Report', render: b => h('b', null, b.report_no) }, { label: 'Reported', render: b => fmt.dt(b.reported_at) }, { label: 'Equipment', render: b => `${b.asset_code} ${b.asset_name}` }, { label: 'Site', key: 'site' },
    { label: 'Severity', render: b => prioBadge(b.severity) }, { label: 'Impact', render: b => label(b.impact) }, { label: 'Description', key: 'description' }, { label: 'WO', key: 'wo_number' }, { label: 'Status', render: b => woBadge(b.status) },
  ], fetch: p => api('/breakdowns', { query: p }), onRow: b => { location.hash = `#/wo/${b.work_order_id}`; } });
  const reload = () => table.reload({ site_id: fSite.value, severity: fSev.value });
  fSite.addEventListener('change', reload); fSev.addEventListener('change', reload);
  mount(el, pageHead('Breakdown register', 'All reported breakdowns and defects', can('breakdown.report') ? h('a', { class: 'btn btn-danger', href: '#/report' }, '⚠ Report breakdown') : null),
    h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', null, 'Site'), fSite), h('div', { class: 'field' }, h('label', null, 'Severity'), fSev)), h('div', { class: 'panel' }, table));
  reload();
}

export async function investigations(el) {
  const rows = await api('/investigations');
  mount(el, pageHead('Failure investigations', 'Repeat failures linked to root-cause investigations and follow-up preventive actions',
    can('investigation.manage') ? h('button', { class: 'btn btn-primary', onclick: newInvestigation }, '+ New investigation') : null, h('a', { class: 'btn', href: '#/reports/repeat_breakdowns' }, 'Repeat breakdown analysis')),
  h('div', { class: 'panel' }, simpleTable([{ label: 'No.', key: 'inv_no' }, { label: 'Equipment', render: i => `${i.asset_code} ${i.asset_name}` }, { label: 'Title', key: 'title' }, { label: 'Linked WOs', num: true, key: 'linked' },
    { label: 'Status', render: i => h('span', { class: 'badge ' + (i.status === 'OPEN' ? 'b-warn' : 'b-ok') }, label(i.status)) }, { label: 'Created', render: i => fmt.date(i.created_at) }], rows, { empty: 'No investigations yet', onRow: i => { location.hash = `#/investigations/${i.id}`; } })));
  function newInvestigation() {
    const picker = assetPicker();
    const f = form([{ name: 'title', label: 'Title', required: true, full: true }, { name: 'problem_statement', label: 'Problem statement', type: 'textarea', full: true }]);
    modal({ title: 'New failure investigation', body: h('div', null, h('div', { class: 'field' }, h('label', null, 'Equipment *'), picker), f), actions: [{ label: 'Cancel' }, { label: 'Create', class: 'btn-primary', onClick: async () => {
      if (!picker.value) throw new ApiError(400, 'Select the equipment');
      const r = await api('/investigations', { method: 'POST', body: { ...f.values(), asset_id: picker.value } }); location.hash = `#/investigations/${r.id}`;
    } }] });
  }
}
export async function investigation(el, id) {
  const i = await api(`/investigations/${id}`);
  const reload = () => investigation(el, id);
  const editable = can('investigation.manage') && i.status === 'OPEN';
  const f = form([{ name: 'title', label: 'Title', required: true, full: true }, { name: 'problem_statement', label: 'Problem statement', type: 'textarea', full: true },
    { name: 'root_cause', label: 'Root cause (findings)', type: 'textarea', full: true }, { name: 'preventive_actions', label: 'Preventive actions', type: 'textarea', full: true }], i);
  const linkSel = form([{ name: 'link_work_order_ids', label: 'Link corrective work orders', type: 'multiselect', options: i.candidates.map(c => ({ value: c.id, label: `${c.wo_number} – ${c.title} (${fmt.date(c.created_at)})` })) }]);
  mount(el, pageHead(`${i.inv_no} – ${i.title}`, h('a', { href: `#/assets/${i.asset_id}` }, `${i.asset_code} ${i.asset_name}`),
    editable ? h('button', { class: 'btn', onclick: async e => { await act(e.currentTarget, () => api(`/investigations/${id}/follow-up`, { method: 'POST', body: { title: `Follow-up preventive action – ${i.inv_no}` } }), 'Follow-up inspection work order created'); reload(); } }, '+ Follow-up preventive WO') : null,
    editable ? h('button', { class: 'btn btn-ok', onclick: async e => { await act(e.currentTarget, () => api(`/investigations/${id}`, { method: 'PUT', body: { ...f.values(), status: 'CLOSED' } }), 'Investigation closed'); reload(); } }, 'Close investigation') : null),
  h('div', { class: 'grid two' },
    h('div', { class: 'panel' }, editable ? [f, h('button', { class: 'btn btn-primary', onclick: async e => { await act(e.currentTarget, () => api(`/investigations/${id}`, { method: 'PUT', body: f.values() }), 'Saved'); reload(); } }, 'Save')]
      : kv([['Status', label(i.status)], ['Problem', i.problem_statement], ['Root cause', i.root_cause], ['Preventive actions', i.preventive_actions], ['Closed', fmt.dt(i.closed_at)]])),
    h('div', { class: 'panel' }, h('h3', null, 'Linked work orders'), simpleTable([{ label: 'WO', render: w => h('a', { href: `#/wo/${w.id}` }, w.wo_number) }, { label: 'Type', render: w => typeBadge(w.wo_type) }, { label: 'Title', key: 'title' },
      { label: 'Root cause', render: w => w.root_cause_code ? codeLabel('ROOT_CAUSE', w.root_cause_code) : '—' }, { label: 'Status', render: w => woBadge(w.status) }], i.work_orders, { empty: 'None linked' }),
    editable && i.candidates.length ? [linkSel, h('button', { class: 'btn', onclick: async e => { await act(e.currentTarget, () => api(`/investigations/${id}`, { method: 'PUT', body: linkSel.values() }), 'Linked'); reload(); } }, 'Link selected')] : null)));
}
