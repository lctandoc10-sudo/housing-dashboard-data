// Administration: users & passwords, roles, master data, checklists, settings, workflow, audit, import.
import { h, mount, api, state, can, fmt, toast, act, modal, confirmDialog, form, opt, enumOpts, simpleTable, pageHead, tabs, label, dataTable, debounce, download, ApiError } from '../ui.js';
import { strength } from './auth.js';

async function refreshMeta() { state.meta = await api('/meta'); }

// ---------------------------------------------------------------- users & passwords
function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(10); crypto.getRandomValues(a);
  let p = [...a].map(x => chars[x % chars.length]).join('');
  if (!/\d/.test(p)) p = p.slice(0, 9) + '7';
  return p;
}
export async function users(el) {
  const [list, roles] = await Promise.all([api('/admin/users'), api('/admin/roles')]);
  const search = h('input', { type: 'search', placeholder: 'Search name, username, role…' });
  const box = h('div');
  const render = () => {
    const s = search.value.toLowerCase();
    const rows = list.filter(u => !s || `${u.full_name} ${u.username} ${u.role_code} ${u.position || ''}`.toLowerCase().includes(s));
    mount(box, h('div', { class: 'panel' }, simpleTable([
      { label: 'Name', render: u => [h('b', null, u.full_name), h('div', { class: 'sub' }, u.position || '')] }, { label: 'Username', key: 'username' },
      { label: 'Role', render: u => (roles.roles.find(r => r.code === u.role_code) || {}).name || u.role_code },
      { label: 'Sites', render: u => u.all_sites ? 'All sites' : (u.site_ids || '').split(',').filter(Boolean).map(id => (state.meta.all_sites.find(x => x.id === Number(id)) || {}).code).join(', ') || h('span', { class: 'badge b-warn' }, 'None') },
      { label: 'Status', render: u => [u.is_active ? h('span', { class: 'badge b-ok' }, 'Active') : h('span', { class: 'badge b-grey' }, 'Inactive'),
        u.locked_until && u.locked_until > new Date().toISOString() ? h('span', { class: 'badge b-bad', style: { marginLeft: '4px' } }, 'Locked') : null,
        u.must_change_password ? h('span', { class: 'badge b-warn', style: { marginLeft: '4px' } }, 'Must change password') : null] },
      { label: 'Last sign-in', render: u => fmt.dt(u.last_login_at) },
      { label: '', render: u => h('div', { class: 'inline-actions' }, h('button', { class: 'btn btn-sm', onclick: () => userDialog(u, roles, reload) }, 'Edit'), h('button', { class: 'btn btn-sm', onclick: () => resetDialog(u, reload) }, 'Reset password'),
        u.locked_until && u.locked_until > new Date().toISOString() ? h('button', { class: 'btn btn-sm', onclick: async e => { await act(e.currentTarget, () => api(`/admin/users/${u.id}`, { method: 'PUT', body: { unlock: true } }), 'Account unlocked'); reload(); } }, 'Unlock') : null) },
    ], rows, { onRow: u => userDialog(u, roles, reload) })));
  };
  const reload = async () => { list.splice(0, list.length, ...(await api('/admin/users'))); render(); };
  search.addEventListener('input', debounce(render, 150));
  mount(el, pageHead('Users & passwords', 'Create accounts, assign roles and sites, reset passwords, unlock and deactivate users',
    h('button', { class: 'btn btn-primary', onclick: () => userDialog(null, roles, reload) }, '+ New user')),
  h('div', { class: 'alert info' }, 'Passwords are stored as salted scrypt hashes and cannot be viewed. A reset sets a temporary password that the user must change at the next sign-in; it also signs out all of the user\'s sessions and clears any lockout.'),
  h('div', { class: 'toolbar' }, h('div', { class: 'field grow' }, h('label', null, 'Search'), search)), box);
  render();
}

function pwField(initial = '') {
  const input = h('input', { type: 'text', value: initial, autocomplete: 'new-password' });
  const hint = h('div', { class: 'sub' });
  const upd = () => { hint.textContent = strength(input.value).map(([ok, t]) => (ok ? '✓ ' : '○ ') + t).join('   '); };
  input.addEventListener('input', upd); upd();
  const gen = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { input.value = genPassword(); upd(); } }, 'Generate');
  const wrap = h('div', null, h('div', { style: { display: 'flex', gap: '6px' } }, input, gen), hint);
  wrap.input = input;
  return wrap;
}

function userDialog(u, roles, reload) {
  const isNew = !u;
  const f = form([
    ...(isNew ? [{ name: 'username', label: 'Username', required: true, hint: '3–40 letters, digits, . _ -' }] : []),
    { name: 'full_name', label: 'Full name', required: true }, { name: 'role_code', label: 'Role', type: 'select', required: true, options: opt(roles.roles, 'code', 'name') },
    { name: 'position', label: 'Position' }, { name: 'department', label: 'Department' }, { name: 'email', label: 'E-mail', type: 'email' }, { name: 'phone', label: 'Mobile number' },
    { name: 'skills', label: 'Skills / equipment specialisations', full: true }, { name: 'hourly_rate', label: 'Internal labor rate (₱/h)', type: 'number', step: '0.01', hint: 'Blank = default rate' },
    { name: 'all_sites', label: 'Access to all sites', type: 'checkbox', onChange: (i, inp) => { inp.site_ids.closest('.field').hidden = i.checked; } },
    { name: 'site_ids', label: 'Permitted sites', type: 'multiselect', options: opt(state.meta.all_sites), hidden: u && u.all_sites },
    ...(!isNew ? [{ name: 'is_active', label: 'Account active (unchecking signs the user out and blocks sign-in)', type: 'checkbox', full: true }] : []),
  ], u ? { ...u, site_ids: (u.site_ids || '').split(',').filter(Boolean).map(Number), is_active: !!u.is_active, all_sites: !!u.all_sites } : { role_code: 'TECHNICIAN' });
  const pw = isNew ? pwField(genPassword()) : null;
  modal({ title: isNew ? 'New user' : `Edit ${u.username}`, wide: true,
    body: h('div', null, f, isNew ? h('div', { class: 'field' }, h('label', null, 'Temporary password *'), pw, h('span', { class: 'hint' }, 'Give this to the user securely. They must change it at first sign-in.')) : null),
    actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => {
      const v = f.values();
      if (v.all_sites) v.site_ids = [];
      if (isNew) v.password = pw.input.value;
      if (!isNew && u.is_active && !v.is_active && !(await confirmDialog(`Deactivate ${u.full_name}? They will be signed out immediately.`, { danger: true, okLabel: 'Deactivate' }))) return false;
      await api(isNew ? '/admin/users' : `/admin/users/${u.id}`, { method: isNew ? 'POST' : 'PUT', body: v });
      toast(isNew ? `User ${v.username} created` : 'User updated', 'ok');
      await refreshMeta(); reload();
    } }] });
}

function resetDialog(u, reload) {
  const pw = pwField(genPassword());
  modal({ title: `Reset password – ${u.full_name}`, body: h('div', null,
    h('p', { class: 'sub' }, `Sets a temporary password for ${u.username}. All their sessions are signed out, any lockout is cleared, and they must choose a new password at the next sign-in.`),
    h('div', { class: 'field' }, h('label', null, 'Temporary password'), pw)),
  actions: [{ label: 'Cancel' }, { label: 'Reset password', class: 'btn-danger', onClick: async () => {
    const p = pw.input.value;
    await api(`/admin/users/${u.id}`, { method: 'PUT', body: { password: p } });
    modal({ title: 'Password reset', body: h('div', null, h('p', null, `Temporary password for ${u.username}:`), h('div', { class: 'formula', style: { fontSize: '1.2rem' } }, p), h('p', { class: 'sub' }, 'Copy it now – it is not stored in readable form and will not be shown again.')), actions: [{ label: 'Done', class: 'btn-primary' }] });
    reload();
  } }] });
}

// ---------------------------------------------------------------- roles
export async function roles(el) {
  const r = await api('/admin/roles');
  const perms = Object.entries(r.permissions);
  const state2 = Object.fromEntries(r.roles.map(x => [x.code, new Set(x.permissions)]));
  const table = h('table', { class: 'data matrix' },
    h('thead', null, h('tr', null, h('th', null, 'Permission'), ...r.roles.map(x => h('th', { title: x.description || '' }, x.name)))),
    h('tbody', null, ...perms.map(([p, d]) => h('tr', null, h('td', null, h('b', null, p), h('div', { class: 'sub' }, d)), ...r.roles.map(x => h('td', null, h('input', { type: 'checkbox', checked: state2[x.code].has(p), disabled: x.code === 'ADMIN', onchange: e => { e.target.checked ? state2[x.code].add(p) : state2[x.code].delete(p); } })))))));
  mount(el, pageHead('Roles & permissions', 'Permissions are enforced by the server on every request. System Administrator always has all permissions.',
    h('button', { class: 'btn', onclick: () => {
      const f = form([{ name: 'code', label: 'Role code', required: true, hint: 'UPPER_CASE' }, { name: 'name', label: 'Role name', required: true }, { name: 'description', label: 'Description', full: true }]);
      modal({ title: 'New role', body: f, actions: [{ label: 'Cancel' }, { label: 'Create', class: 'btn-primary', onClick: async () => { await api('/admin/roles', { method: 'POST', body: f.values() }); toast('Role created', 'ok'); roles(el); } }] });
    } }, '+ New role'),
    h('button', { class: 'btn btn-primary', onclick: async e => {
      await act(e.currentTarget, async () => { for (const x of r.roles) if (x.code !== 'ADMIN') await api(`/admin/roles/${x.code}/permissions`, { method: 'PUT', body: { permissions: [...state2[x.code]] } }); }, 'Permissions saved');
    } }, 'Save permissions')),
  h('div', { class: 'panel table-wrap' }, table));
}

// ---------------------------------------------------------------- master data
const MASTER_DEFS = {
  sites: { title: 'Projects, factories & sites', cols: ['code', 'name', 'site_type', 'op_days', 'op_start', 'op_end', 'is_active'], fields: () => [
    { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'site_type', label: 'Type', type: 'select', required: true, options: enumOpts(['PROJECT', 'FACTORY', 'WAREHOUSE', 'OFFICE']) },
    { name: 'address', label: 'Address', full: true }, { name: 'op_days', label: 'Operating days', hint: '1=Mon … 7=Sun, e.g. 1,2,3,4,5,6' }, { name: 'op_start', label: 'Operating start (HH:MM)' }, { name: 'op_end', label: 'Operating end (HH:MM, 24:00 allowed)' },
    { name: 'sort_order', label: 'Sort order', type: 'number' }, { name: 'is_active', label: 'Active', type: 'checkbox' }], defaults: { site_type: 'PROJECT', op_days: '1,2,3,4,5,6', op_start: '07:00', op_end: '19:00', is_active: true } },
  locations: { title: 'Locations / operating areas', cols: ['site', 'name', 'is_active'], fields: () => [{ name: 'site_id', label: 'Site', type: 'select', required: true, options: opt(state.meta.all_sites) }, { name: 'name', label: 'Location name', required: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }], defaults: { is_active: true } },
  categories: { title: 'Equipment categories', cols: ['code', 'name', 'meter_type', 'is_active'], fields: () => [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'meter_type', label: 'Meter', type: 'select', required: true, options: [{ value: 'NONE', label: 'None' }, { value: 'HOURS', label: 'Operating hours' }, { value: 'KM', label: 'Odometer (km)' }] }, { name: 'is_active', label: 'Active', type: 'checkbox' }], defaults: { meter_type: 'NONE', is_active: true } },
  failure_codes: { title: 'Failure codes & root causes', cols: ['kind', 'code', 'label', 'is_active'], fields: () => [{ name: 'kind', label: 'Kind', type: 'select', required: true, options: enumOpts(['ROOT_CAUSE', 'FAILURE_MODE', 'BREAKDOWN_CATEGORY']) }, { name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Label', required: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }], defaults: { is_active: true } },
  suppliers: { title: 'Suppliers', cols: ['name', 'contact_person', 'phone', 'email', 'is_active'], fields: () => [{ name: 'name', label: 'Name', required: true }, { name: 'contact_person', label: 'Contact person' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'E-mail' }, { name: 'address', label: 'Address', full: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }], defaults: { is_active: true } },
  stores: { title: 'Stores / warehouses', cols: ['code', 'name', 'site', 'is_active'], fields: () => [{ name: 'site_id', label: 'Site', type: 'select', required: true, options: opt(state.meta.all_sites) }, { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'is_active', label: 'Active', type: 'checkbox' }], defaults: { is_active: true } },
};
export async function master(el) {
  mount(el, pageHead('Sites & master data', 'Add, edit, deactivate and reorganise projects, factories, locations and reference data without code changes'),
    tabs(Object.entries(MASTER_DEFS).map(([kind, d]) => ({ key: kind, label: d.title, render: () => masterTab(kind, d) }))));
}
function masterTab(kind, d) {
  const box = h('div');
  const load = async () => {
    const rows = await api(`/admin/${kind}`);
    for (const r of rows) if (r.site_id) r.site = (state.meta.all_sites.find(s => s.id === r.site_id) || {}).name;
    mount(box, h('div', { class: 'panel' }, h('button', { class: 'btn btn-primary', onclick: () => edit(null) }, '+ Add'),
      simpleTable(d.cols.map(c => ({ label: label(c), render: r => c === 'is_active' ? (r.is_active ? 'Yes' : h('span', { class: 'badge b-grey' }, 'Inactive')) : (r[c] ?? '—') })), rows, { onRow: edit })));
  };
  const edit = row => {
    const f = form(d.fields(), row ? { ...row, is_active: !!row.is_active } : d.defaults);
    modal({ title: row ? `Edit ${row.name || row.label || row.code}` : `Add – ${d.title}`, wide: true, body: f, actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => {
      await api(row ? `/admin/${kind}/${row.id}` : `/admin/${kind}`, { method: row ? 'PUT' : 'POST', body: f.values() }); toast('Saved', 'ok'); await refreshMeta(); load();
    } }] });
  };
  load();
  return box;
}

// ---------------------------------------------------------------- checklists
export async function checklists(el) {
  mount(el, pageHead('Maintenance checklists', 'Configurable checklists per equipment type. Work orders keep a snapshot of the checklist used.', h('button', { class: 'btn btn-primary', onclick: () => editChecklist(null) }, '+ New checklist')),
    h('div', { class: 'panel' }, simpleTable([{ label: 'Checklist', key: 'name' }, { label: 'Category', render: c => (state.meta.categories.find(x => x.id === c.category_id) || {}).name || 'Any' }], state.meta.checklists, { onRow: c => editChecklist(c.id) })));
  async function editChecklist(id) {
    const c = id ? await api(`/admin/checklists/${id}`) : { name: '', items: [{ section: '', description: '', response_type: 'PASS_FAIL', is_required: 1 }] };
    const head = form([{ name: 'name', label: 'Checklist name', required: true }, { name: 'category_id', label: 'Equipment category', type: 'select', options: opt(state.meta.categories) }], c);
    const items = c.items.map(i => ({ ...i }));
    const box = h('div');
    const render = () => mount(box, ...items.map((it, n) => h('div', { class: 'toolbar' },
      h('div', { class: 'field' }, h('input', { placeholder: 'Section', value: it.section || '', oninput: e => { it.section = e.target.value; } })),
      h('div', { class: 'field grow' }, h('input', { placeholder: 'Item description', value: it.description, oninput: e => { it.description = e.target.value; } })),
      h('div', { class: 'field' }, h('select', { onchange: e => { it.response_type = e.target.value; } }, ...['PASS_FAIL', 'DONE', 'VALUE', 'TEXT'].map(t => h('option', { value: t, selected: it.response_type === t }, label(t))))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!it.is_required, onchange: e => { it.is_required = e.target.checked; } }), 'Required'),
      h('button', { class: 'btn btn-sm', onclick: () => { items.splice(n, 1); render(); } }, '✕'))),
    h('button', { class: 'btn btn-sm', onclick: () => { items.push({ section: items.length ? items[items.length - 1].section : '', description: '', response_type: 'PASS_FAIL', is_required: 1 }); render(); } }, '+ Item'));
    render();
    modal({ title: id ? `Edit checklist` : 'New checklist', wide: true, body: h('div', null, head, box), actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => {
      await api(id ? `/admin/checklists/${id}` : '/admin/checklists', { method: id ? 'PUT' : 'POST', body: { ...head.values(), items } }); toast('Checklist saved', 'ok'); await refreshMeta(); checklists(el);
    } }] });
  }
}

// ---------------------------------------------------------------- settings & escalations
export async function settings(el) {
  const [rows, esc, rolesR] = await Promise.all([api('/admin/settings'), api('/admin/escalations'), api('/admin/roles')]);
  const setTab = () => h('div', { class: 'panel' }, simpleTable([{ label: 'Setting', render: s => [h('b', null, s.key), h('div', { class: 'sub' }, s.description)] }, { label: 'Value', render: s => Array.isArray(s.value) ? s.value.join(', ') : String(s.value) }, { label: 'Updated', render: s => fmt.dt(s.updated_at) },
    { label: '', render: s => h('button', { class: 'btn btn-sm', onclick: () => editSetting(s) }, 'Change') }], rows),
  h('div', { class: 'toolbar mt' }, h('button', { class: 'btn', onclick: async e => { const r = await act(e.currentTarget, () => api('/admin/run-scheduler', { method: 'POST' })); toast(`${r.generated.length} PMS WO generated, ${r.notifications} notifications`, 'ok'); } }, 'Run PMS generator & checks now'),
    h('button', { class: 'btn', onclick: async e => { const r = await act(e.currentTarget, () => api('/admin/backup', { method: 'POST' })); toast(`Backup created: ${r.file}`, 'ok'); } }, 'Create database backup'),
    h('button', { class: 'btn', onclick: async e => { const r = await act(e.currentTarget, () => api('/admin/integrity')); const issues = Object.entries(r).filter(([k, v]) => Array.isArray(v) && v.length); modal({ title: 'Data integrity check', body: issues.length ? h('div', null, ...issues.map(([k, v]) => h('div', { class: 'alert err' }, `${label(k)}: ${v.length}`))) : h('div', { class: 'alert ok' }, 'No integrity issues found'), actions: [{ label: 'Close' }] }); } }, 'Integrity check')));
  function editSetting(s) {
    const isBool = typeof s.value === 'boolean', isArr = Array.isArray(s.value), isNum = typeof s.value === 'number';
    const f = form([{ name: 'value', label: s.key, type: isBool ? 'checkbox' : isNum ? 'number' : 'text', hint: isArr ? 'Comma-separated' : s.description }], { value: isArr ? s.value.join(',') : s.value });
    modal({ title: 'Change setting', body: f, actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => {
      let v = f.values().value; if (isArr) v = String(v || '').split(',').map(x => x.trim()).filter(Boolean);
      await api(`/admin/settings/${s.key}`, { method: 'PUT', body: { value: v } }); toast('Setting saved', 'ok'); settings(el);
    } }] });
  }
  const escTab = () => h('div', { class: 'panel' }, h('button', { class: 'btn btn-primary', onclick: () => editEsc(null) }, '+ Escalation rule'), simpleTable([{ label: 'Rule', key: 'name' }, { label: 'Event', render: e => label(e.event_type) }, { label: 'Priority', render: e => e.priority ? label(e.priority) : 'Any' },
    { label: 'Site', render: e => e.site_id ? (state.meta.all_sites.find(s => s.id === e.site_id) || {}).name : 'All' }, { label: 'After (h)', num: true, key: 'threshold_hours' }, { label: 'Notify role', key: 'notify_role' }, { label: 'Active', render: e => (e.is_active ? 'Yes' : 'No') }], esc, { onRow: editEsc }));
  function editEsc(e) {
    const f = form([{ name: 'name', label: 'Name', required: true, full: true }, { name: 'event_type', label: 'Condition', type: 'select', required: true, options: enumOpts(['WO_OVERDUE', 'CRITICAL_UNASSIGNED', 'ASSET_UNAVAILABLE', 'PMS_OVERDUE', 'WAITING_PARTS']) },
      { name: 'priority', label: 'Priority', type: 'select', options: enumOpts(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']), placeholder: 'Any' }, { name: 'site_id', label: 'Site', type: 'select', options: opt(state.meta.all_sites), placeholder: 'All sites' },
      { name: 'threshold_hours', label: 'Elapsed time threshold (hours)', type: 'number', required: true, step: 'any' }, { name: 'notify_role', label: 'Notify role', type: 'select', required: true, options: opt(rolesR.roles, 'code', 'name') }, { name: 'is_active', label: 'Active', type: 'checkbox' }], e ? { ...e, is_active: !!e.is_active } : { is_active: true });
    modal({ title: e ? 'Edit escalation rule' : 'New escalation rule', body: f, actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => { await api(e ? `/admin/escalations/${e.id}` : '/admin/escalations', { method: e ? 'PUT' : 'POST', body: f.values() }); toast('Saved', 'ok'); settings(el); } }] });
  }
  mount(el, pageHead('Settings & business rules', 'Configurable rules – KPIs, availability, PMS tolerance, verification, notifications'), tabs([{ key: 's', label: 'Settings', render: setTab }, { key: 'e', label: 'Escalation rules', render: escTab }]));
}

export async function workflow(el) {
  const w = await api('/admin/workflow');
  mount(el, pageHead('Work order workflow', 'Statuses and allowed transitions. Closing is only possible from For Verification so completion guards always apply.',
    h('button', { class: 'btn', onclick: () => {
      const f = form([{ name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Label', required: true }, { name: 'category', label: 'Category', type: 'select', required: true, options: [{ value: 'OPEN', label: 'Open (work active)' }, { value: 'HOLD', label: 'On hold' }] },
        { name: 'asset_effect', label: 'Equipment status while in this state', type: 'select', options: [{ value: 'MAINT', label: 'Under maintenance (PM/CM)' }, { value: 'WAITING_PARTS', label: 'Waiting for parts' }, { value: 'WAITING_EXTERNAL', label: 'Waiting for external service' }, { value: 'FOR_TESTING', label: 'For testing' }], placeholder: 'No change' },
        { name: 'sort_order', label: 'Sort order', type: 'number' }, { name: 'description', label: 'Description', full: true }]);
      modal({ title: 'Add status', body: f, actions: [{ label: 'Cancel' }, { label: 'Add', class: 'btn-primary', onClick: async () => { await api('/admin/workflow/statuses', { method: 'POST', body: f.values() }); toast('Status added', 'ok'); await refreshMeta(); workflow(el); } }] });
    } }, '+ Status'),
    h('button', { class: 'btn btn-primary', onclick: () => {
      const st = opt(w.statuses, 'code', 'label');
      const f = form([{ name: 'wo_type', label: 'Work order type', type: 'select', required: true, options: [...['PMS', 'CM', 'INSPECTION', 'OTHER'].map(t => ({ value: t, label: t })), { value: '*', label: 'Any' }] },
        { name: 'from_status', label: 'From', type: 'select', required: true, options: st }, { name: 'to_status', label: 'To', type: 'select', required: true, options: st }, { name: 'permission', label: 'Required permission', type: 'select', required: true, options: Object.keys(state.me.permissions.reduce((m, p) => (m[p] = 1, m), {})).sort().map(p => ({ value: p, label: p })) }]);
      modal({ title: 'Add transition / cancellation rule', body: f, actions: [{ label: 'Cancel' }, { label: 'Add', class: 'btn-primary', onClick: async () => { await api('/admin/workflow/transitions', { method: 'POST', body: f.values() }); toast('Transition added', 'ok'); workflow(el); } }] });
    } }, '+ Transition')),
  h('div', { class: 'grid two' },
    h('div', { class: 'panel' }, h('h3', null, 'Statuses'), simpleTable([{ label: 'Code', key: 'code' }, { label: 'Label', key: 'label' }, { label: 'Category', key: 'category' }, { label: 'Equipment effect', render: s => s.asset_effect || '—' }, { label: 'System', render: s => (s.is_system ? 'Yes' : 'No') }], w.statuses)),
    h('div', { class: 'panel' }, h('h3', null, 'Transitions'), simpleTable([{ label: 'Type', key: 'wo_type' }, { label: 'From', key: 'from_status' }, { label: 'To', key: 'to_status' }, { label: 'Permission', key: 'permission' },
      { label: '', render: t => h('button', { class: 'btn btn-sm', onclick: async () => { if (await confirmDialog(`Remove ${t.wo_type}: ${t.from_status} → ${t.to_status}?`, { danger: true })) { await api(`/admin/workflow/transitions/${t.id}`, { method: 'DELETE' }); workflow(el); } } }, 'Remove') }], w.transitions))));
}

export async function audit(el) {
  const q = h('input', { type: 'search', placeholder: 'Search summary or record ID' });
  const et = h('select', null, h('option', { value: '' }, 'All records'), ...['asset', 'work_order', 'breakdown', 'inventory_txn', 'purchase_request', 'cost_entry', 'user', 'role', 'setting', 'pms_plan', 'report', 'import', 'system'].map(x => h('option', { value: x }, label(x))));
  const table = dataTable({ columns: [{ label: 'When', render: r => fmt.dt(r.created_at) }, { label: 'User', render: r => r.user_name || 'System' }, { label: 'Action', key: 'action' }, { label: 'Record', render: r => `${r.entity_type} ${r.entity_id || ''}` }, { label: 'Summary', key: 'summary' },
    { label: 'Changes', render: r => r.after_json ? h('button', { class: 'btn btn-sm', onclick: () => modal({ title: 'Change detail', wide: true, body: h('div', null, h('h3', null, 'Before'), h('pre', { class: 'formula', style: { whiteSpace: 'pre-wrap' } }, r.before_json || '—'), h('h3', null, 'After'), h('pre', { class: 'formula', style: { whiteSpace: 'pre-wrap' } }, r.after_json)), actions: [{ label: 'Close' }] }) }, 'View') : '' }],
  fetch: p => api('/admin/audit', { query: p }) });
  const reload = () => table.reload({ q: q.value, entity_type: et.value });
  q.addEventListener('input', debounce(reload)); et.addEventListener('change', reload);
  mount(el, pageHead('Audit log', 'Append-only record of who created, changed, approved, completed or cancelled records'), h('div', { class: 'toolbar' }, h('div', { class: 'field grow' }, h('label', null, 'Search'), q), h('div', { class: 'field' }, h('label', null, 'Record type'), et)), h('div', { class: 'panel' }, table));
  reload();
}

export async function importer(el) {
  const file = h('input', { type: 'file', accept: '.xlsx' });
  const out = h('div');
  const run = mode => async e => {
    if (!file.files[0]) return toast('Choose the filled-in template (.xlsx)', 'err');
    if (mode === 'commit' && !(await confirmDialog('Import all rows? The file is validated again and nothing is saved if any row has an error.'))) return;
    const fd = new FormData(); fd.append('file', file.files[0]);
    const r = await act(e.currentTarget, () => api(`/import/${mode}`, { method: 'POST', body: fd }));
    mount(out, h('div', { class: 'panel' },
      h('div', { class: 'alert ' + (r.error_count ? 'err' : r.committed ? 'ok' : 'info') }, r.committed ? `Imported ${r.counts.equipment} equipment, ${r.counts.parts} parts and ${r.counts.history} history records.` : r.error_count ? `${r.error_count} error(s) – nothing was imported. Fix the rows below and validate again.` : `Valid: ${r.counts.equipment} equipment, ${r.counts.parts} parts, ${r.counts.history} history records ready to import.`),
      r.errors.length ? simpleTable([{ label: 'Row', key: 'row' }, { label: 'Field', key: 'field' }, { label: 'Problem', key: 'message' }], r.errors) : null));
  };
  mount(el, pageHead('Import from Excel', 'Controlled import of equipment, spare parts (with opening stock) and historical maintenance records'),
    h('div', { class: 'panel' }, h('ol', null, h('li', null, 'Download the template – it lists the valid site, category, store and failure codes.'), h('li', null, 'Fill in the Equipment, Parts and/or Maintenance History sheets.'), h('li', null, 'Validate. Fix any reported rows.'), h('li', null, 'Import. All rows are saved in one transaction, or none.')),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: e => act(e.currentTarget, () => download('/import/template')) }, '⬇ Download template'), h('div', { class: 'field grow' }, h('label', null, 'Workbook'), file),
        h('button', { class: 'btn', onclick: run('validate') }, 'Validate'), h('button', { class: 'btn btn-primary', onclick: run('commit') }, 'Import'))), out);
}
