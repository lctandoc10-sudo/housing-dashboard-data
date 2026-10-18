'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, asset, completeWo } = require('./helpers');
const time = require('../server/time');

test('spare parts inventory and maintenance costs', async t => {
  const T = await setup();
  t.after(() => T.close());
  time.setClock(time.manilaToUtc('2026-06-01', '08:00'));
  const tl = await asset(T, 'TL-1', 'TL');
  const WH = T.meta.store('WH-CPF'), WHC = T.meta.store('WH-CAL');
  const p = (await T.as('store').post('/parts', { part_no: 'HOSE-1', name: 'Hydraulic hose', uom: 'pc', min_qty: 2, reorder_point: 3, max_qty: 10, is_critical: true })).body.id;
  const bd = (await T.as('prod').post('/breakdowns', { asset_id: tl, category_code: 'HYD', description: 'Hose burst on boom', severity: 'HIGH', impact: 'STOPPED' })).body.id;
  await T.as('sup').post(`/work-orders/${bd}/assign`, { user_ids: [T.ids.tech] });
  await T.as('tech').post(`/work-orders/${bd}/transition`, { to: 'IN_PROGRESS' });

  await t.test('receipts update balance and moving-average cost', async () => {
    assert.equal((await T.as('store').post('/inventory/receive', { part_id: p, store_id: WH, qty: 4, unit_cost: 1000 })).status, 400, 'reference required');
    await T.as('store').post('/inventory/receive', { part_id: p, store_id: WH, qty: 4, unit_cost: 1000, reference: 'DR-1' });
    await T.as('store').post('/inventory/receive', { part_id: p, store_id: WH, qty: 4, unit_cost: 1600, reference: 'DR-2' });
    const part = (await T.as('store').get(`/parts/${p}`)).body;
    assert.equal(part.unit_cost, 1300);
    assert.equal(part.balances.find(b => b.store_id === WH).qty_on_hand, 8);
  });

  await t.test('issues must link to an open work order and recipient; stock is deducted on confirmation', async () => {
    assert.equal((await T.as('store').post('/inventory/issue', { part_id: p, store_id: WH, qty: 1, recipient: 'Jun' })).status, 400);
    assert.equal((await T.as('store').post('/inventory/issue', { part_id: p, store_id: WH, qty: 1, work_order_id: bd })).status, 400);
    assert.equal((await T.as('prod').post('/inventory/issue', { part_id: p, store_id: WH, qty: 1, work_order_id: bd, recipient: 'Jun' })).status, 403);
    const r = await T.as('store').post('/inventory/issue', { part_id: p, store_id: WH, qty: 2, work_order_id: bd, recipient: 'Jun Santos', client_request_id: 'iss-1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.balance_after, 6);
    const again = await T.as('store').post('/inventory/issue', { part_id: p, store_id: WH, qty: 2, work_order_id: bd, recipient: 'Jun Santos', client_request_id: 'iss-1' });
    assert.equal(again.body.id, r.body.id, 'retry does not double-issue');
    assert.equal(r.body.asset_id, tl); assert.equal(r.body.site_id, T.meta.site('CPF'));
    const cost = T.d.prepare(`SELECT * FROM cost_entries WHERE source_type = 'INV_TXN' AND source_id = ?`).get(r.body.id);
    assert.equal(cost.amount, 2600); assert.equal(cost.work_order_id, bd);
  });

  await t.test('negative stock is refused; reservations protect stock for approved jobs', async () => {
    const over = await T.as('store').post('/inventory/issue', { part_id: p, store_id: WH, qty: 7, work_order_id: bd, recipient: 'Jun' });
    assert.equal(over.status, 409);
    const other = (await T.as('sup').post('/work-orders', { wo_type: 'INSPECTION', asset_id: tl, title: 'Hose inspection', confirm_duplicate: true })).body.id;
    await T.as('sup').post(`/work-orders/${other}/assign`, { user_ids: [T.ids.tech2] });
    assert.equal((await T.as('sup').post('/inventory/reserve', { part_id: p, store_id: WH, qty: 5, work_order_id: other })).status, 200);
    const blocked = await T.as('store').post('/inventory/issue', { part_id: p, store_id: WH, qty: 2, work_order_id: bd, recipient: 'Jun' });
    assert.equal(blocked.status, 409, 'only 1 unreserved');
    assert.equal((await T.as('store').post('/inventory/issue', { part_id: p, store_id: WH, qty: 2, work_order_id: other, recipient: 'Tech 2' })).status, 200, 'reserved job can draw');
    await T.as('sup').post(`/work-orders/${other}/transition`, { to: 'CANCELLED', remarks: 'Not required after all' });
    const bal = T.d.prepare('SELECT * FROM stock_balances WHERE part_id = ? AND store_id = ?').get(p, WH);
    assert.equal(bal.qty_reserved, 0, 'cancel releases remaining reservation');
  });

  await t.test('returns, transfers and approved adjustments; balances reconcile (AC9)', async () => {
    assert.equal((await T.as('store').post('/inventory/return', { part_id: p, store_id: WH, qty: 3, work_order_id: bd })).status, 409, 'cannot return more than issued');
    const ret = await T.as('store').post('/inventory/return', { part_id: p, store_id: WH, qty: 1, work_order_id: bd, reason: 'Unused' });
    assert.equal(ret.status, 200);
    assert.equal(T.d.prepare(`SELECT amount FROM cost_entries WHERE source_type = 'INV_TXN' AND source_id = ?`).get(ret.body.id).amount, -1300, 'credit to work order');
    const tr = await T.as('store').post('/inventory/transfer', { part_id: p, from_store_id: WH, to_store_id: WHC, qty: 2, reason: 'Project stock' });
    assert.equal(tr.status, 200);
    const adj = await T.as('store').post('/inventory/adjust', { part_id: p, store_id: WH, qty: -1, reason: 'Damaged in storage' });
    assert.equal(adj.status, 200);
    const before = T.d.prepare('SELECT qty_on_hand FROM stock_balances WHERE part_id = ? AND store_id = ?').get(p, WH).qty_on_hand;
    assert.equal((await T.as('store').post(`/inventory/adjust/${adj.body.id}/decide`, { approve: true })).status, 403, 'storekeeper cannot approve');
    assert.equal((await T.as('manager').post(`/inventory/adjust/${adj.body.id}/decide`, { approve: true })).status, 200);
    const after = T.d.prepare('SELECT qty_on_hand FROM stock_balances WHERE part_id = ? AND store_id = ?').get(p, WH).qty_on_hand;
    assert.equal(after, before - 1);
    assert.deepEqual((await T.as('store').get('/inventory/reconcile')).body.mismatches, []);
    const total = T.d.prepare('SELECT SUM(qty_on_hand) q FROM stock_balances WHERE part_id = ?').get(p).q;
    const txSum = T.d.prepare(`SELECT SUM(qty) q FROM inventory_transactions WHERE part_id = ? AND status = 'POSTED'`).get(p).q;
    assert.equal(total, txSum);
    assert.throws(() => T.d.prepare('DELETE FROM inventory_transactions WHERE id = 1').run(), /cannot be deleted/);
  });

  await t.test('low stock notification fires once per condition', async () => {
    const notify = require('../server/services/notify');
    notify.runChecks(); notify.runChecks();
    const n = T.d.prepare(`SELECT COUNT(*) n FROM notifications WHERE type = 'LOW_STOCK' AND user_id = ?`).get(T.ids.store).n;
    assert.equal(n, 1);
  });

  await t.test('purchase requests: no self-approval, receipt closes the PR', async () => {
    const pr = (await T.as('tech').post('/purchase-requests', { part_id: p, store_id: WH, qty: 5, work_order_id: bd })).body.id;
    assert.equal((await T.as('manager').post(`/purchase-requests/${pr}/order`, { po_reference: 'PO-1' })).status, 409, 'must be approved first');
    assert.equal((await T.as('manager').post(`/purchase-requests/${pr}/approve`)).status, 200);
    assert.equal((await T.as('store').post(`/purchase-requests/${pr}/order`, { po_reference: 'PO-1' })).status, 200);
    await T.as('store').post('/inventory/receive', { part_id: p, store_id: WH, qty: 5, unit_cost: 1300, reference: 'DR-9', purchase_request_id: pr });
    assert.equal(T.d.prepare('SELECT status FROM purchase_requests WHERE id = ?').get(pr).status, 'RECEIVED');
    const own = (await T.as('manager').post('/purchase-requests', { part_id: p, store_id: WH, qty: 1 })).body.id;
    assert.equal((await T.as('manager').post(`/purchase-requests/${own}/approve`)).status, 403);
  });

  await t.test('costs trace to asset, work order and project without double counting (AC10)', async () => {
    assert.equal((await T.as('sup').post('/costs', { work_order_id: bd, category: 'INTERNAL_LABOR', amount: 500, description: 'labor' })).status, 400, 'internal labor only via labor entries');
    assert.equal((await T.as('sup').post('/costs', { work_order_id: bd, category: 'PARTS', amount: 500, description: 'hose' })).status, 400, 'parts need a direct-purchase reference');
    const ext = await T.as('sup').post('/costs', { work_order_id: bd, category: 'THIRD_PARTY_SERVICE', amount: 15000, description: 'Hydraulic specialist', reference: 'SI-1' });
    assert.equal(ext.status, 200);
    assert.equal((await T.as('sup').post('/costs', { work_order_id: bd, category: 'THIRD_PARTY_SERVICE', amount: 15000, description: 'again', reference: 'SI-1' })).status, 409, 'duplicate reference warning');
    await T.as('sup').post('/costs', { work_order_id: bd, category: 'RENTAL', kind: 'ESTIMATE', amount: 8000, description: 'Possible crane rental', reference: 'Q-1' });
    assert.equal((await T.as('sup').post(`/costs/${ext.body.id}/decide`, { approve: true })).status, 403, 'supervisor lacks approval permission');
    assert.equal((await T.as('manager').post(`/costs/${ext.body.id}/decide`, { approve: true })).status, 200);
    await completeWo(T, bd, { tech: 'tech', verifier: 'sup', cm: true });
    const rows = T.d.prepare(`SELECT * FROM cost_entries WHERE work_order_id = ? AND kind = 'ACTUAL' AND status <> 'VOID'`).all(bd);
    assert.ok(rows.every(r => r.asset_id === tl && r.site_id === T.meta.site('CPF')));
    assert.ok(rows.filter(r => r.source_type !== 'MANUAL').every(r => r.status === 'APPROVED'), 'system costs approved at closure');
    const labor = rows.filter(r => r.category === 'INTERNAL_LABOR');
    assert.equal(labor.length, 1); assert.equal(labor[0].amount, 400, '2 h × ₱200 technician rate');
    const expected = 2600 - 1300 + 15000 + 400;
    assert.equal(rows.reduce((s, r) => s + r.amount, 0), expected);
    const kpi = (await T.as('manager').get('/kpi/dashboard?from=2026-06-01&to=2026-06-01')).body.kpis.find(k => k.key === 'cost');
    const allActual = T.d.prepare(`SELECT SUM(amount) s FROM cost_entries WHERE kind = 'ACTUAL' AND status IN ('APPROVED','PENDING')`).get().s;
    assert.equal(allActual, expected + 2600, 'includes parts issued to the cancelled inspection and not returned');
    assert.equal(kpi.value, allActual, 'dashboard reconciles with cost entries (estimates excluded)');
    const rep = (await T.as('manager').get('/reports/cost_per_equipment?from=2026-06-01&to=2026-06-01')).body;
    assert.equal(rep.rows[0].total, allActual);
    const fin = (await T.as('manager').get('/reports/finance_export?from=2026-06-01&to=2026-06-01')).body;
    assert.ok(fin.rows.every(r => r.amount !== undefined));
    assert.equal((await T.as('sup').get('/reports/finance_export?format=csv')).status, 403, 'finance export restricted');
    const prodWo = (await T.as('prod').get(`/work-orders/${bd}`));
    assert.equal(prodWo.status, 200, 'requester can follow the WO');
    assert.equal(prodWo.body.costs, undefined, 'but sees no cost data');
    assert.ok(prodWo.body.labor.every(l => l.cost === undefined && l.rate === undefined));
  });
});
