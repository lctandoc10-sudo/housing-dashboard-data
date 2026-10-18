// Spare parts, stock transactions, purchase requests, maintenance costs.
import { h, mount, api, state, can, canAny, fmt, toast, act, modal, form, opt, dataTable, simpleTable, pageHead, kv, tabs, label, debounce, filterBar, uid, ApiError, download } from '../ui.js';
import { costDialog } from './workorders.js';

export async function parts(el, q) {
  const search = h('input', { type: 'search', placeholder: 'Part no., name, compatibility…' });
  const store = h('select', null, h('option', { value: '' }, 'All my stores'), ...state.meta.stores.map(s => h('option', { value: s.id }, s.name)));
  const low = h('select', null, h('option', { value: '' }, 'All parts'), h('option', { value: 'low', selected: q.low === '1' }, 'Low stock (≤ reorder / < min)'), h('option', { value: 'critical' }, 'Critical spares'));
  const showValue = can('cost.view') || can('inventory.manage_parts');
  const table = dataTable({ defaultSort: 'part_no', columns: [
    { label: 'Part no.', sort: 'part_no', render: p => h('b', null, p.part_no) }, { label: 'Name', sort: 'name', key: 'name' }, { label: 'Category', sort: 'category', key: 'category' },
    { label: 'Compatibility', key: 'compatibility' }, { label: 'On hand', num: true, sort: 'on_hand', render: p => h('span', { class: p.on_hand < p.min_qty ? 'badge b-bad' : p.reorder_point && p.on_hand <= p.reorder_point ? 'badge b-warn' : '' }, `${fmt.num(p.on_hand, 2)} ${p.uom}`) },
    { label: 'Reserved', num: true, render: p => fmt.num(p.reserved, 2) }, { label: 'Min / ROP / Max', render: p => `${fmt.num(p.min_qty)} / ${fmt.num(p.reorder_point)} / ${fmt.num(p.max_qty)}` },
    showValue ? { label: 'Avg cost', num: true, render: p => fmt.money(p.unit_cost) } : null, { label: 'Critical', render: p => p.is_critical ? h('span', { class: 'badge b-bad' }, 'Critical') : '' },
  ].filter(Boolean), fetch: p => api('/parts', { query: p }), onRow: p => { location.hash = `#/inventory/parts/${p.id}`; } });
  const reload = () => table.reload({ q: search.value, store_id: store.value, low: low.value === 'low' ? 1 : '', critical: low.value === 'critical' ? 1 : '' });
  search.addEventListener('input', debounce(reload)); store.addEventListener('change', reload); low.addEventListener('change', reload);
  const actions = [];
  if (can('inventory.receive')) actions.push(h('button', { class: 'btn btn-primary', onclick: () => txnDialog('receive', null, reload) }, 'Receive stock'));
  if (can('inventory.transfer')) actions.push(h('button', { class: 'btn', onclick: () => txnDialog('transfer', null, reload) }, 'Transfer'));
  if (can('inventory.adjust')) actions.push(h('button', { class: 'btn', onclick: () => txnDialog('adjust', null, reload) }, 'Adjustment'));
  if (can('inventory.manage_parts')) actions.push(h('button', { class: 'btn', onclick: () => partDialog(null, reload) }, '+ New part'));
  mount(el, pageHead('Spare parts inventory', 'Stock balances change only through posted transactions linked to work orders, receipts, transfers or approved adjustments', ...actions),
    tabs([
      { key: 'parts', label: 'Parts & stock', render: () => h('div', null, h('div', { class: 'toolbar' }, h('div', { class: 'field grow' }, h('label', null, 'Search'), search), h('div', { class: 'field' }, h('label', null, 'Store'), store), h('div', { class: 'field' }, h('label', null, 'Show'), low)), h('div', { class: 'panel' }, table)) },
      { key: 'txns', label: 'Transactions', render: () => txnTab() },
      { key: 'pending', label: 'Pending adjustments', show: canAny('inventory.approve', 'inventory.adjust'), render: () => pendingTab() },
    ]));
  reload();
}

function txnTab() {
  const type = h('select', null, h('option', { value: '' }, 'All types'), ...['RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT'].map(t => h('option', { value: t }, label(t))));
  const showValue = can('cost.view') || can('inventory.manage_parts');
  const table = dataTable({ columns: [
    { label: 'Txn', render: t => h('b', null, t.txn_no) }, { label: 'When', render: t => fmt.dt(t.created_at) }, { label: 'Type', render: t => label(t.txn_type) }, { label: 'Status', render: t => label(t.status) },
    { label: 'Part', render: t => `${t.part_no} ${t.part_name}` }, { label: 'Store', key: 'store_code' }, { label: 'Qty', num: true, render: t => `${t.qty > 0 ? '+' : ''}${fmt.num(t.qty, 2)}` },
    { label: 'Balance after', num: true, render: t => fmt.num(t.balance_after, 2) }, showValue ? { label: 'Value', num: true, render: t => fmt.money(t.total_cost) } : null,
    { label: 'WO', render: t => t.work_order_id ? h('a', { href: `#/wo/${t.work_order_id}` }, t.wo_number) : '—' }, { label: 'Recipient / ref.', render: t => [t.recipient, t.reference].filter(Boolean).join(' · ') || '—' },
    { label: 'By', key: 'by_name' },
  ].filter(Boolean), fetch: p => api('/inventory/transactions', { query: { ...p, type: type.value } }) });
  type.addEventListener('change', () => table.reload({}));
  const recon = h('div');
  const check = h('button', { class: 'btn', onclick: async e => { const r = await act(e.currentTarget, () => api('/inventory/reconcile')); mount(recon, h('div', { class: 'alert ' + (r.mismatches.length ? 'err' : 'ok') }, r.mismatches.length ? `${r.mismatches.length} balance(s) do not match transactions – contact the administrator` : `All stock balances reconcile with posted transactions (${fmt.dt(r.checked_at)})`)); } }, 'Reconcile balances');
  setTimeout(() => table.reload({}), 0);
  return h('div', null, h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', null, 'Type'), type), check), recon, h('div', { class: 'panel' }, table));
}
function pendingTab() {
  const box = h('div');
  const load = async () => {
    const r = await api('/inventory/transactions', { query: { status: 'PENDING_APPROVAL', page_size: 200 } });
    mount(box, h('div', { class: 'panel' }, simpleTable([{ label: 'Txn', key: 'txn_no' }, { label: 'Part', render: t => `${t.part_no} ${t.part_name}` }, { label: 'Store', key: 'store_code' }, { label: 'Qty', num: true, render: t => `${t.qty > 0 ? '+' : ''}${t.qty}` },
      { label: 'Reason', key: 'reason' }, { label: 'Requested by', key: 'by_name' }, { label: 'When', render: t => fmt.dt(t.created_at) },
      can('inventory.approve') ? { label: '', render: t => t.created_by === state.me.id ? h('span', { class: 'muted' }, 'needs another approver') : h('div', { class: 'inline-actions' },
        h('button', { class: 'btn btn-sm btn-ok', onclick: async e => { await act(e.currentTarget, () => api(`/inventory/adjust/${t.id}/decide`, { method: 'POST', body: { approve: true } }), 'Adjustment approved and posted'); load(); } }, 'Approve'),
        h('button', { class: 'btn btn-sm', onclick: async e => { await act(e.currentTarget, () => api(`/inventory/adjust/${t.id}/decide`, { method: 'POST', body: { approve: false } }), 'Adjustment rejected'); load(); } }, 'Reject')) } : null].filter(Boolean), r.rows, { empty: 'No pending adjustments' })));
  };
  load();
  return box;
}

async function txnDialog(mode, part, reload) {
  const plist = part ? [part] : (await api('/parts', { query: { page_size: 200 } })).rows;
  const fields = [{ name: 'part_id', label: 'Part', type: 'select', required: true, options: opt(plist, 'id', p => `${p.part_no} – ${p.name}`) }];
  if (mode === 'receive') fields.push({ name: 'store_id', label: 'Into store', type: 'select', required: true, options: opt(state.meta.stores) }, { name: 'qty', label: 'Quantity received', type: 'number', step: 'any', required: true },
    { name: 'unit_cost', label: 'Unit cost (₱)', type: 'number', step: '0.01', required: true }, { name: 'reference', label: 'DR / PO / invoice reference', required: true },
    { name: 'purchase_request_id', label: 'Against purchase request', type: 'select', options: opt((await api('/purchase-requests', { query: { status: 'APPROVED,ORDERED,PARTIAL' } }).catch(() => [])), 'id', r => `${r.pr_no} – ${r.part_no} x${r.qty - r.qty_received}`) }, { name: 'remarks', label: 'Remarks' });
  if (mode === 'transfer') fields.push({ name: 'from_store_id', label: 'From store', type: 'select', required: true, options: opt(state.meta.stores) }, { name: 'to_store_id', label: 'To store', type: 'select', required: true, options: opt(state.meta.all_stores) },
    { name: 'qty', label: 'Quantity', type: 'number', step: 'any', required: true }, { name: 'reason', label: 'Reason', required: true }, { name: 'reference', label: 'Transfer slip ref.' });
  if (mode === 'adjust') fields.push({ name: 'store_id', label: 'Store', type: 'select', required: true, options: opt(state.meta.stores) }, { name: 'qty', label: 'Adjustment (+ add / − remove)', type: 'number', step: 'any', required: true },
    { name: 'reason', label: 'Documented reason', type: 'textarea', required: true, full: true }, { name: 'reference', label: 'Count sheet / reference' });
  const f = form(fields, { part_id: part && part.id });
  const rid = uid();
  const titles = { receive: 'Receive stock', transfer: 'Transfer between stores', adjust: 'Request stock adjustment' };
  modal({ title: titles[mode], body: h('div', null, mode === 'adjust' ? h('div', { class: 'alert info' }, 'Adjustments are posted only after approval by another authorised person.') : null, f), actions: [{ label: 'Cancel' }, { label: 'Post', class: 'btn-primary', onClick: async () => {
    const v = f.values();
    await api(`/inventory/${mode}`, { method: 'POST', body: { ...v, client_request_id: rid } });
    toast(mode === 'adjust' ? 'Adjustment submitted for approval' : 'Transaction posted', 'ok'); reload && reload();
  } }] });
}

function partDialog(p, reload) {
  const f = form([
    { name: 'part_no', label: 'Part number', required: true }, { name: 'name', label: 'Part name', required: true }, { name: 'category', label: 'Category' }, { name: 'uom', label: 'Unit of measure', required: true },
    { name: 'compatibility', label: 'Equipment compatibility', full: true }, { name: 'supplier_id', label: 'Supplier', type: 'select', options: opt(state.meta.suppliers) },
    ...(p ? [] : [{ name: 'unit_cost', label: 'Initial unit cost (₱)', type: 'number', step: '0.01', hint: 'Moving average is updated by receipts' }]),
    { name: 'min_qty', label: 'Minimum stock', type: 'number', step: 'any' }, { name: 'reorder_point', label: 'Reorder point', type: 'number', step: 'any' }, { name: 'max_qty', label: 'Maximum stock', type: 'number', step: 'any' },
    { name: 'is_critical', label: 'Critical spare part', type: 'checkbox' }, ...(p ? [{ name: 'is_active', label: 'Active', type: 'checkbox' }] : []), { name: 'description', label: 'Description', type: 'textarea', full: true },
  ], p || { uom: 'pc' });
  modal({ title: p ? `Edit ${p.part_no}` : 'New part', wide: true, body: f, actions: [{ label: 'Cancel' }, { label: 'Save', class: 'btn-primary', onClick: async () => { await api(p ? `/parts/${p.id}` : '/parts', { method: p ? 'PUT' : 'POST', body: f.values() }); toast('Part saved', 'ok'); reload(); } }] });
}

export async function part(el, id) {
  const p = await api(`/parts/${id}`);
  const reload = () => part(el, id);
  const total = p.balances.reduce((t, b) => t + b.qty_on_hand, 0);
  mount(el, pageHead(`${p.part_no} – ${p.name}`, p.compatibility || '',
    can('inventory.receive') ? h('button', { class: 'btn btn-primary', onclick: () => txnDialog('receive', p, reload) }, 'Receive') : null,
    can('inventory.transfer') ? h('button', { class: 'btn', onclick: () => txnDialog('transfer', p, reload) }, 'Transfer') : null,
    can('inventory.adjust') ? h('button', { class: 'btn', onclick: () => txnDialog('adjust', p, reload) }, 'Adjust') : null,
    can('pr.create') ? h('button', { class: 'btn', onclick: () => prDialog(p, reload) }, 'Purchase request') : null,
    can('inventory.manage_parts') ? h('button', { class: 'btn', onclick: () => partDialog(p, reload) }, 'Edit') : null),
  h('div', { class: 'grid two' },
    h('div', { class: 'panel' }, kv([['Category', p.category], ['Unit', p.uom], ['Supplier', p.supplier], ['Critical', p.is_critical ? 'Yes' : 'No'], ['Min / reorder / max', `${p.min_qty} / ${p.reorder_point} / ${p.max_qty ?? '—'}`],
      p.unit_cost !== undefined ? ['Moving average cost', fmt.money(p.unit_cost)] : null, ['Total on hand (my stores)', h('b', null, `${fmt.num(total, 2)} ${p.uom}`)], ['Description', p.description]])),
    h('div', { class: 'panel' }, h('h3', null, 'Balances by store'), simpleTable([{ label: 'Store', key: 'store' }, { label: 'On hand', num: true, render: b => fmt.num(b.qty_on_hand, 2) }, { label: 'Reserved', num: true, render: b => fmt.num(b.qty_reserved, 2) }, { label: 'Available', num: true, render: b => fmt.num(b.qty_on_hand - b.qty_reserved, 2) }, { label: 'Bin', key: 'bin_location' }], p.balances, { empty: 'No stock in your stores' }))),
  h('div', { class: 'panel' }, h('h3', null, 'Transaction history'), simpleTable([{ label: 'Txn', key: 'txn_no' }, { label: 'When', render: t => fmt.dt(t.created_at) }, { label: 'Type', render: t => label(t.txn_type) }, { label: 'Status', render: t => label(t.status) }, { label: 'Store', key: 'store_code' },
    { label: 'Qty', num: true, render: t => `${t.qty > 0 ? '+' : ''}${fmt.num(t.qty, 2)}` }, { label: 'Balance', num: true, render: t => fmt.num(t.balance_after, 2) }, { label: 'WO', render: t => t.work_order_id ? h('a', { href: `#/wo/${t.work_order_id}` }, t.wo_number) : '—' }, { label: 'Ref / reason', render: t => [t.reference, t.reason, t.recipient].filter(Boolean).join(' · ') }, { label: 'By', key: 'by_name' }], p.transactions)));
}

function prDialog(p, reload) {
  const f = form([{ name: 'store_id', label: 'For store', type: 'select', required: true, options: opt(state.meta.stores) }, { name: 'qty', label: 'Quantity', type: 'number', step: 'any', required: true },
    { name: 'needed_by', label: 'Needed by', type: 'date' }, { name: 'supplier_id', label: 'Preferred supplier', type: 'select', options: opt(state.meta.suppliers) }, { name: 'remarks', label: 'Justification', full: true }], { supplier_id: p && p.supplier_id });
  modal({ title: `Purchase request – ${p.part_no}`, body: f, actions: [{ label: 'Cancel' }, { label: 'Submit', class: 'btn-primary', onClick: async () => { await api('/purchase-requests', { method: 'POST', body: { ...f.values(), part_id: p.id } }); toast('Purchase request submitted', 'ok'); reload && reload(); } }] });
}

export async function prs(el) {
  const status = h('select', null, h('option', { value: '' }, 'All'), ...['SUBMITTED', 'APPROVED', 'ORDERED', 'PARTIAL', 'RECEIVED', 'REJECTED', 'CANCELLED'].map(s => h('option', { value: s }, label(s))));
  const box = h('div');
  mount(el, pageHead('Purchase requests', 'Spare parts purchase request monitoring'), h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', null, 'Status'), status)), box);
  status.addEventListener('change', load);
  async function load() {
    const rows = await api('/purchase-requests', { query: { status: status.value } });
    const act2 = (r, action, text, cls, extra) => h('button', { class: 'btn btn-sm ' + (cls || ''), onclick: async e => {
      let body = {};
      if (extra) { const v = window.prompt(extra); if (!v) return; body = { po_reference: v }; }
      await act(e.currentTarget, () => api(`/purchase-requests/${r.id}/${action}`, { method: 'POST', body }), `${r.pr_no}: ${text}`); load();
    } }, text);
    mount(box, h('div', { class: 'panel' }, simpleTable([
      { label: 'PR', render: r => h('b', null, r.pr_no) }, { label: 'Requested', render: r => fmt.date(r.requested_at) }, { label: 'Part', render: r => h('a', { href: `#/inventory/parts/${r.part_id}` }, `${r.part_no} ${r.part_name}`) },
      { label: 'Qty', num: true, render: r => `${fmt.num(r.qty_received, 2)} / ${fmt.num(r.qty, 2)} ${r.uom}` }, { label: 'Store', key: 'store_code' }, { label: 'WO', render: r => r.work_order_id ? h('a', { href: `#/wo/${r.work_order_id}` }, r.wo_number) : '—' },
      { label: 'Needed by', render: r => fmt.date(r.needed_by) }, { label: 'Status', render: r => h('span', { class: 'badge ' + ({ SUBMITTED: 'b-warn', APPROVED: 'b-info', ORDERED: 'b-info', PARTIAL: 'b-purple', RECEIVED: 'b-ok', REJECTED: 'b-bad', CANCELLED: 'b-grey' }[r.status]) }, label(r.status)) },
      { label: 'PO', key: 'po_reference' }, { label: 'Requested by', key: 'requested_by_name' },
      { label: '', render: r => h('div', { class: 'inline-actions' },
        r.status === 'SUBMITTED' && can('pr.approve') && r.requested_by !== state.me.id ? [act2(r, 'approve', 'Approve', 'btn-ok'), act2(r, 'reject', 'Reject')] : null,
        r.status === 'APPROVED' && canAny('pr.approve', 'inventory.receive') ? act2(r, 'order', 'Mark ordered', '', 'PO reference number') : null,
        ['SUBMITTED', 'APPROVED', 'ORDERED'].includes(r.status) && r.qty_received === 0 && (r.requested_by === state.me.id || can('pr.approve')) ? act2(r, 'cancel', 'Cancel') : null) },
    ], rows, { empty: 'No purchase requests' })));
  }
  load();
}

export async function costs(el, q) {
  const sum = h('div'); const list = h('div');
  const bar = filterBar({ category: true, woType: true, initial: q, onChange: f => load(f), extras: [h('div', { class: 'field' }, h('label', null, 'Status'), h('select', { name: 'status' }, h('option', { value: '' }, 'All'), ...['PENDING', 'APPROVED', 'REJECTED', 'VOID'].map(s => h('option', { value: s }, label(s)))))] });
  mount(el, pageHead('Maintenance costs', 'Actual vs estimated costs by equipment, site, work order type and category (PHP)',
    can('cost.manage') ? h('button', { class: 'btn btn-primary', onclick: () => costDialogAsset(() => load(bar.values())) }, '+ Cost entry') : null,
    can('cost.export') ? h('button', { class: 'btn', onclick: () => download('/reports/finance_export', { ...bar.values(), format: 'xlsx' }) }, '⬇ Finance export (approved)') : null), bar, sum, list);
  async function load(f) {
    const s = await api('/costs/summary', { query: f });
    mount(sum, h('div', { class: 'grid kpis' },
      h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Total actual cost'), h('div', { class: 'value' }, fmt.money(s.total)), h('div', { class: 'note' }, `Approved ${fmt.money(s.approved)} · pending ${fmt.money(s.pending)}`)),
      ...Object.entries(s.by_category).map(([k, v]) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label(k)), h('div', { class: 'value', style: { fontSize: '1.3rem' } }, fmt.money(v))))),
    h('div', { class: 'grid two mt' },
      h('div', { class: 'panel' }, h('h3', null, 'Most expensive equipment to maintain'), simpleTable([{ label: 'Equipment', render: r => `${r.asset_code} ${r.name}` }, { label: 'Site', key: 'site' }, { label: 'Work orders', num: true, key: 'wo_count' }, { label: 'Total', num: true, render: r => fmt.money(r.total) }], s.top_assets)),
      h('div', { class: 'panel' }, h('h3', null, 'By project / site'), simpleTable([{ label: 'Site', key: 'group' }, { label: 'Parts', num: true, render: r => fmt.money(r.PARTS) }, { label: 'Labor', num: true, render: r => fmt.money((r.INTERNAL_LABOR || 0) + (r.EXTERNAL_LABOR || 0)) }, { label: 'Services/rental/other', num: true, render: r => fmt.money((r.THIRD_PARTY_SERVICE || 0) + (r.RENTAL || 0) + (r.OTHER || 0)) }, { label: 'Total', num: true, render: r => fmt.money(r.total) }], s.by_site)),
      h('div', { class: 'panel' }, h('h3', null, 'By work order type (estimate vs actual)'), simpleTable([{ label: 'Type', key: 'group' }, { label: 'Kind', render: r => label(r.kind) }, { label: 'Total', num: true, render: r => fmt.money(r.total) }], s.by_wo_type)),
      h('div', { class: 'panel' }, h('h3', null, 'By month'), simpleTable([{ label: 'Month', key: 'group' }, { label: 'Total', num: true, render: r => fmt.money(r.total) }], s.by_month))));
    const table = dataTable({ columns: [
      { label: 'Date', render: c => fmt.date(c.entry_date) }, { label: 'Equipment', key: 'asset_code' }, { label: 'Site', key: 'site' }, { label: 'WO', render: c => c.work_order_id ? h('a', { href: `#/wo/${c.work_order_id}` }, c.wo_number) : '—' },
      { label: 'Category', render: c => label(c.category) }, { label: 'Kind', render: c => label(c.kind) }, { label: 'Description', key: 'description' }, { label: 'Source', render: c => label(c.source_type) },
      { label: 'Amount', num: true, render: c => fmt.money(c.amount) }, { label: 'Status', render: c => h('span', { class: 'badge ' + ({ APPROVED: 'b-ok', PENDING: 'b-warn', REJECTED: 'b-bad', VOID: 'b-grey' }[c.status]) }, label(c.status)) },
      { label: '', render: c => c.status === 'PENDING' && c.source_type === 'MANUAL' && can('cost.approve') && c.created_by !== state.me.id ? h('div', { class: 'inline-actions' },
        h('button', { class: 'btn btn-sm btn-ok', onclick: async e => { await act(e.currentTarget, () => api(`/costs/${c.id}/decide`, { method: 'POST', body: { approve: true } }), 'Approved'); load(bar.values()); } }, 'Approve'),
        h('button', { class: 'btn btn-sm', onclick: async e => { await act(e.currentTarget, () => api(`/costs/${c.id}/decide`, { method: 'POST', body: { approve: false } }), 'Rejected'); load(bar.values()); } }, 'Reject')) : '' },
    ], fetch: p => api('/costs', { query: { ...p, ...f } }) });
    mount(list, h('div', { class: 'panel' }, h('h3', null, 'Cost entries'), h('p', { class: 'sub' }, 'Parts and internal labor entries are generated from stock issues and labor and approved when the work order is closed. Manual entries need approval by someone other than the person who recorded them.'), table));
    table.reload({});
  }
  load(bar.values());
}
function costDialogAsset(reload) {
  const f = form([{ name: 'wo', label: 'Work order number', required: true, hint: 'e.g. CM-2026-00012' }]);
  modal({ title: 'Cost entry – select work order', body: f, actions: [{ label: 'Cancel' }, { label: 'Next', class: 'btn-primary', onClick: async () => {
    const r = await api('/work-orders', { query: { q: f.values().wo, page_size: 1 } });
    if (!r.rows.length) throw new ApiError(404, 'Work order not found');
    costDialog({ work_order_id: r.rows[0].id }, reload);
  } }] });
}
