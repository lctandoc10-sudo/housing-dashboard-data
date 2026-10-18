'use strict';
// Spare parts inventory. Balances change only by posting inventory_transactions
// inside a database transaction, so stock_balances always reconciles with the sum
// of posted transactions (see reconcile()). Negative balances are rejected unless
// explicitly allowed in settings. Adjustments require approval by a second person.
const db = require('../db');
const audit = require('../audit');
const rbac = require('../rbac');
const settings = require('../settings');
const numbering = require('../numbering');
const costs = require('./costs');
const { nowIso, isDate } = require('../time');
const { bad, notFound, forbidden, conflict } = require('../errors');

const EPS = 1e-9;
const round4 = n => Math.round(n * 10000) / 10000;

function posQty(q, what = 'Quantity') {
  const n = Number(q);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${what} must be greater than zero`);
  return round4(n);
}
function getPart(id) { const p = db.get().prepare('SELECT * FROM parts WHERE id = ?').get(id); if (!p) throw notFound('Part'); return p; }
function getStore(ctx, id) {
  const s = db.get().prepare('SELECT * FROM stores WHERE id = ?').get(id);
  if (!s) throw notFound('Store');
  if (ctx) rbac.requireSite(ctx.user, s.site_id);
  return s;
}
function balance(partId, storeId) {
  const d = db.get();
  d.prepare('INSERT OR IGNORE INTO stock_balances (part_id, store_id) VALUES (?, ?)').run(partId, storeId);
  return d.prepare('SELECT * FROM stock_balances WHERE part_id = ? AND store_id = ?').get(partId, storeId);
}
function openWo(id) {
  const wo = db.get().prepare(`SELECT w.*, s.category FROM work_orders w JOIN wo_statuses s ON s.code = w.status WHERE w.id = ?`).get(id);
  if (!wo) throw notFound('Work order');
  if (!['OPEN', 'HOLD'].includes(wo.category)) throw conflict(`Work order ${wo.wo_number} is ${wo.status}; parts can only be issued to open work orders`);
  return wo;
}
function checkIdempotent(clientRequestId) {
  if (!clientRequestId) return null;
  return db.get().prepare('SELECT * FROM inventory_transactions WHERE client_request_id = ?').get(clientRequestId) || null;
}

/** Post a transaction and update the balance. qty is signed. */
function post(ctx, t) {
  const d = db.get();
  const bal = balance(t.part_id, t.store_id);
  const newQty = round4(bal.qty_on_hand + t.qty);
  if (newQty < -EPS && !settings.get('allow_negative_stock')) {
    throw conflict(`Insufficient stock: ${bal.qty_on_hand} on hand, ${-t.qty} requested. Negative inventory is not allowed.`);
  }
  const part = getPart(t.part_id);
  let unitCost = t.unit_cost != null ? Number(t.unit_cost) : part.unit_cost;
  if (t.txn_type === 'RECEIPT') {
    // moving average cost across all stores
    const tot = d.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM stock_balances WHERE part_id = ?').get(t.part_id).q;
    const base = Math.max(tot, 0);
    const avg = base + t.qty > 0 ? (base * part.unit_cost + t.qty * unitCost) / (base + t.qty) : unitCost;
    d.prepare('UPDATE parts SET unit_cost = ?, updated_at = ? WHERE id = ?').run(round4(avg), nowIso(), t.part_id);
  }
  d.prepare('UPDATE stock_balances SET qty_on_hand = ? WHERE part_id = ? AND store_id = ?').run(newQty, t.part_id, t.store_id);
  const txnNo = t.txn_no || numbering.next('TXN');
  const r = d.prepare(`INSERT INTO inventory_transactions (txn_no, txn_type, status, part_id, store_id, qty, unit_cost, total_cost, balance_after,
      work_order_id, asset_id, site_id, recipient, reference, reason, related_txn_id, purchase_request_id, client_request_id, created_by, created_at, approved_by, approved_at)
    VALUES (?, ?, 'POSTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    txnNo, t.txn_type, t.part_id, t.store_id, t.qty, round4(unitCost), round4(t.qty * unitCost), newQty,
    t.work_order_id || null, t.asset_id || null, t.site_id || null, t.recipient || null, t.reference || null, t.reason || null,
    t.related_txn_id || null, t.purchase_request_id || null, t.client_request_id || null, t.created_by || ctx.user.id, t.created_at || nowIso(),
    t.approved_by || null, t.approved_by ? nowIso() : null);
  return d.prepare('SELECT * FROM inventory_transactions WHERE id = ?').get(r.lastInsertRowid);
}

function receive(ctx, b) {
  return db.tx(() => {
    const dup = checkIdempotent(b.client_request_id); if (dup) return dup;
    const store = getStore(ctx, b.store_id); getPart(b.part_id);
    const qty = posQty(b.qty);
    const cost = Number(b.unit_cost);
    if (!Number.isFinite(cost) || cost < 0) throw bad('Unit cost must be zero or more');
    if (!b.reference) throw bad('Delivery receipt / PO reference is required');
    let pr = null;
    if (b.purchase_request_id) {
      pr = db.get().prepare('SELECT * FROM purchase_requests WHERE id = ?').get(b.purchase_request_id);
      if (!pr) throw notFound('Purchase request');
      if (!['APPROVED', 'ORDERED', 'PARTIAL'].includes(pr.status)) throw conflict(`Purchase request ${pr.pr_no} is ${pr.status}`);
      if (pr.part_id !== Number(b.part_id)) throw bad('Part does not match the purchase request');
    }
    const t = post(ctx, { txn_type: 'RECEIPT', part_id: b.part_id, store_id: store.id, qty, unit_cost: cost, site_id: store.site_id,
      reference: b.reference, reason: b.remarks, purchase_request_id: pr ? pr.id : null, client_request_id: b.client_request_id });
    if (pr) {
      const got = round4(pr.qty_received + qty);
      db.get().prepare('UPDATE purchase_requests SET qty_received = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(got, got + EPS >= pr.qty ? 'RECEIVED' : 'PARTIAL', nowIso(), pr.id);
    }
    audit.log(ctx, 'RECEIPT', 'inventory_txn', t.id, `${t.txn_no} +${qty}`);
    return t;
  });
}

function issue(ctx, b) {
  return db.tx(() => {
    const dup = checkIdempotent(b.client_request_id); if (dup) return dup;
    const store = getStore(ctx, b.store_id); getPart(b.part_id);
    const qty = posQty(b.qty);
    if (!b.work_order_id) throw bad('Every issue must be linked to a work order');
    if (!b.recipient || !String(b.recipient).trim()) throw bad('Recipient is required');
    const wo = openWo(b.work_order_id);
    rbac.requireSite(ctx.user, wo.site_id);
    const d = db.get();
    const bal = balance(b.part_id, store.id);
    const res = d.prepare(`SELECT * FROM part_reservations WHERE work_order_id = ? AND part_id = ? AND store_id = ? AND status = 'ACTIVE'`).get(wo.id, b.part_id, store.id);
    const ownReserved = res ? res.qty_reserved - res.qty_issued : 0;
    const available = bal.qty_on_hand - (bal.qty_reserved - ownReserved);
    if (qty > available + EPS && !settings.get('allow_negative_stock')) {
      throw conflict(`Insufficient available stock: ${round4(available)} available (${bal.qty_on_hand} on hand, ${round4(bal.qty_reserved - ownReserved)} reserved for other work orders)`);
    }
    const t = post(ctx, { txn_type: 'ISSUE', part_id: b.part_id, store_id: store.id, qty: -qty, work_order_id: wo.id, asset_id: wo.asset_id,
      site_id: wo.site_id, recipient: b.recipient, reference: b.reference, reason: b.remarks, client_request_id: b.client_request_id });
    if (res) {
      const use = Math.min(qty, ownReserved);
      const issued = round4(res.qty_issued + use);
      d.prepare('UPDATE part_reservations SET qty_issued = ?, status = ? WHERE id = ?').run(issued, issued + EPS >= res.qty_reserved ? 'FULFILLED' : 'ACTIVE', res.id);
      d.prepare('UPDATE stock_balances SET qty_reserved = MAX(0, qty_reserved - ?) WHERE part_id = ? AND store_id = ?').run(use, b.part_id, store.id);
    }
    costs.fromInventory(t, wo, ctx.user.id);
    audit.log(ctx, 'ISSUE', 'inventory_txn', t.id, `${t.txn_no} -${qty} to ${wo.wo_number} (${b.recipient})`);
    return t;
  });
}

function returnToStock(ctx, b) {
  return db.tx(() => {
    const dup = checkIdempotent(b.client_request_id); if (dup) return dup;
    const store = getStore(ctx, b.store_id); getPart(b.part_id);
    const qty = posQty(b.qty);
    if (!b.work_order_id) throw bad('Returns must reference the work order the parts were issued to');
    const d = db.get();
    const wo = d.prepare('SELECT * FROM work_orders WHERE id = ?').get(b.work_order_id);
    if (!wo) throw notFound('Work order');
    const net = -d.prepare(`SELECT COALESCE(SUM(qty),0) q FROM inventory_transactions WHERE work_order_id = ? AND part_id = ? AND txn_type IN ('ISSUE','RETURN') AND status = 'POSTED'`).get(wo.id, b.part_id).q;
    if (qty > net + EPS) throw conflict(`Cannot return ${qty}; only ${round4(net)} net issued to ${wo.wo_number}`);
    const lastIssue = d.prepare(`SELECT unit_cost FROM inventory_transactions WHERE work_order_id = ? AND part_id = ? AND txn_type = 'ISSUE' ORDER BY id DESC LIMIT 1`).get(wo.id, b.part_id);
    const t = post(ctx, { txn_type: 'RETURN', part_id: b.part_id, store_id: store.id, qty, unit_cost: lastIssue.unit_cost, work_order_id: wo.id,
      asset_id: wo.asset_id, site_id: wo.site_id, recipient: b.returned_by || null, reason: b.reason || 'Unused parts returned', client_request_id: b.client_request_id });
    costs.fromInventory(t, wo, ctx.user.id);
    audit.log(ctx, 'RETURN', 'inventory_txn', t.id, `${t.txn_no} +${qty} from ${wo.wo_number}`);
    return t;
  });
}

function transfer(ctx, b) {
  return db.tx(() => {
    const dup = checkIdempotent(b.client_request_id); if (dup) return dup;
    const from = getStore(ctx, b.from_store_id);
    const to = getStore(null, b.to_store_id);
    if (from.id === to.id) throw bad('Source and destination stores must differ');
    getPart(b.part_id);
    const qty = posQty(b.qty);
    if (!b.reason) throw bad('Transfer reason is required');
    const bal = balance(b.part_id, from.id);
    if (qty > bal.qty_on_hand - bal.qty_reserved + EPS) throw conflict(`Insufficient unreserved stock in ${from.name}: ${round4(bal.qty_on_hand - bal.qty_reserved)} available`);
    const out = post(ctx, { txn_type: 'TRANSFER_OUT', part_id: b.part_id, store_id: from.id, qty: -qty, site_id: from.site_id, reason: b.reason, reference: b.reference, client_request_id: b.client_request_id });
    const inn = post(ctx, { txn_type: 'TRANSFER_IN', part_id: b.part_id, store_id: to.id, qty, unit_cost: out.unit_cost, site_id: to.site_id, reason: b.reason, reference: b.reference, related_txn_id: out.id });
    db.get().prepare('UPDATE inventory_transactions SET related_txn_id = ? WHERE id = ?').run(inn.id, out.id);
    audit.log(ctx, 'TRANSFER', 'inventory_txn', out.id, `${out.txn_no}/${inn.txn_no} ${qty} ${from.code} → ${to.code}`);
    return { out, in: inn };
  });
}

function requestAdjustment(ctx, b) {
  return db.tx(() => {
    const store = getStore(ctx, b.store_id); getPart(b.part_id);
    const qty = round4(Number(b.qty));
    if (!Number.isFinite(qty) || qty === 0) throw bad('Adjustment quantity must be a non-zero number (+ to add, − to remove)');
    if (!b.reason || String(b.reason).trim().length < 5) throw bad('A documented reason is required for stock adjustments');
    const part = getPart(b.part_id);
    const r = db.get().prepare(`INSERT INTO inventory_transactions (txn_no, txn_type, status, part_id, store_id, qty, unit_cost, total_cost, site_id, reason, reference, created_by, created_at)
      VALUES (?, 'ADJUSTMENT', 'PENDING_APPROVAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      numbering.next('TXN'), part.id, store.id, qty, part.unit_cost, round4(qty * part.unit_cost), store.site_id, b.reason, b.reference || null, ctx.user.id, nowIso());
    audit.log(ctx, 'REQUEST_ADJUSTMENT', 'inventory_txn', r.lastInsertRowid, `${qty} (${b.reason})`);
    return r.lastInsertRowid;
  });
}

function decideAdjustment(ctx, id, approve, remarks) {
  return db.tx(() => {
    const d = db.get();
    const t = d.prepare('SELECT * FROM inventory_transactions WHERE id = ?').get(id);
    if (!t || t.txn_type !== 'ADJUSTMENT') throw notFound('Adjustment');
    getStore(ctx, t.store_id);
    if (t.status !== 'PENDING_APPROVAL') throw conflict(`Adjustment is already ${t.status}`);
    if (t.created_by === ctx.user.id) throw forbidden('You cannot approve your own stock adjustment');
    if (approve) {
      const bal = balance(t.part_id, t.store_id);
      const newQty = round4(bal.qty_on_hand + t.qty);
      if (newQty < -EPS && !settings.get('allow_negative_stock')) throw conflict(`Adjustment would make stock negative (${newQty})`);
      d.prepare('UPDATE stock_balances SET qty_on_hand = ? WHERE part_id = ? AND store_id = ?').run(newQty, t.part_id, t.store_id);
      d.prepare(`UPDATE inventory_transactions SET status = 'POSTED', balance_after = ?, approved_by = ?, approved_at = ? WHERE id = ?`).run(newQty, ctx.user.id, nowIso(), id);
    } else {
      d.prepare(`UPDATE inventory_transactions SET status = 'REJECTED', approved_by = ?, approved_at = ? WHERE id = ?`).run(ctx.user.id, nowIso(), id);
    }
    d.prepare(`INSERT INTO approvals (entity_type, entity_id, action, decision, remarks, decided_by, decided_at) VALUES ('inventory_txn', ?, 'STOCK_ADJUSTMENT', ?, ?, ?, ?)`)
      .run(id, approve ? 'APPROVED' : 'REJECTED', remarks || null, ctx.user.id, nowIso());
    audit.log(ctx, approve ? 'APPROVE_ADJUSTMENT' : 'REJECT_ADJUSTMENT', 'inventory_txn', id, remarks);
  });
}

function reserve(ctx, b) {
  return db.tx(() => {
    const store = getStore(ctx, b.store_id); getPart(b.part_id);
    const qty = posQty(b.qty);
    const wo = openWo(b.work_order_id);
    rbac.requireSite(ctx.user, wo.site_id);
    const bal = balance(b.part_id, store.id);
    if (qty > bal.qty_on_hand - bal.qty_reserved + EPS) throw conflict(`Only ${round4(bal.qty_on_hand - bal.qty_reserved)} unreserved in ${store.name}. Raise a purchase request for the shortfall.`);
    const d = db.get();
    d.prepare('UPDATE stock_balances SET qty_reserved = qty_reserved + ? WHERE part_id = ? AND store_id = ?').run(qty, b.part_id, store.id);
    const r = d.prepare(`INSERT INTO part_reservations (work_order_id, part_id, store_id, qty_reserved, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(wo.id, b.part_id, store.id, qty, ctx.user.id, nowIso());
    audit.log(ctx, 'RESERVE', 'work_order', wo.id, `Reserved ${qty} of part ${b.part_id}`);
    return r.lastInsertRowid;
  });
}

function releaseReservations(woId) {
  const d = db.get();
  for (const r of d.prepare(`SELECT * FROM part_reservations WHERE work_order_id = ? AND status = 'ACTIVE'`).all(woId)) {
    d.prepare('UPDATE stock_balances SET qty_reserved = MAX(0, qty_reserved - ?) WHERE part_id = ? AND store_id = ?').run(r.qty_reserved - r.qty_issued, r.part_id, r.store_id);
    d.prepare(`UPDATE part_reservations SET status = 'RELEASED' WHERE id = ?`).run(r.id);
  }
}

// ---------------------------------------------------------------- purchase requests
function createPR(ctx, b) {
  return db.tx(() => {
    const store = getStore(ctx, b.store_id); const part = getPart(b.part_id);
    const qty = posQty(b.qty);
    if (b.needed_by && !isDate(b.needed_by)) throw bad('Invalid needed-by date');
    if (b.work_order_id && !db.get().prepare('SELECT 1 FROM work_orders WHERE id = ?').get(b.work_order_id)) throw notFound('Work order');
    const prNo = numbering.next('PR');
    const r = db.get().prepare(`INSERT INTO purchase_requests (pr_no, part_id, store_id, qty, est_unit_cost, supplier_id, work_order_id, status, needed_by, remarks, requested_by, requested_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?, ?)`).run(prNo, part.id, store.id, qty, b.est_unit_cost ?? part.unit_cost, b.supplier_id || part.supplier_id || null,
      b.work_order_id || null, b.needed_by || null, b.remarks || null, ctx.user.id, nowIso(), nowIso());
    audit.log(ctx, 'CREATE', 'purchase_request', r.lastInsertRowid, `${prNo} ${part.part_no} x${qty}`);
    return r.lastInsertRowid;
  });
}
const PR_FLOW = { APPROVE: ['SUBMITTED', 'APPROVED'], REJECT: ['SUBMITTED', 'REJECTED'], ORDER: ['APPROVED', 'ORDERED'], CANCEL: [null, 'CANCELLED'] };
function actPR(ctx, id, action, b = {}) {
  return db.tx(() => {
    const d = db.get();
    const pr = d.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id);
    if (!pr) throw notFound('Purchase request');
    getStore(ctx, pr.store_id);
    const flow = PR_FLOW[action];
    if (!flow) throw bad('Unknown action');
    if (action === 'APPROVE' || action === 'REJECT') {
      rbac.require(ctx.user, 'pr.approve');
      if (pr.requested_by === ctx.user.id) throw forbidden('You cannot approve your own purchase request');
    } else if (action === 'ORDER') rbac.require(ctx.user, 'pr.approve', 'inventory.receive');
    else if (action === 'CANCEL') {
      if (pr.requested_by !== ctx.user.id) rbac.require(ctx.user, 'pr.approve');
      if (['RECEIVED', 'CANCELLED', 'REJECTED'].includes(pr.status) || pr.qty_received > 0) throw conflict(`Cannot cancel a ${pr.status} purchase request`);
    }
    if (flow[0] && pr.status !== flow[0]) throw conflict(`Purchase request is ${pr.status}; expected ${flow[0]}`);
    if (action === 'ORDER' && !b.po_reference) throw bad('PO reference is required');
    d.prepare(`UPDATE purchase_requests SET status = ?, po_reference = COALESCE(?, po_reference), approved_by = CASE WHEN ? IN ('APPROVE','REJECT') THEN ? ELSE approved_by END,
      approved_at = CASE WHEN ? IN ('APPROVE','REJECT') THEN ? ELSE approved_at END, remarks = COALESCE(?, remarks), updated_at = ? WHERE id = ?`)
      .run(flow[1], b.po_reference || null, action, ctx.user.id, action, nowIso(), b.remarks || null, nowIso(), id);
    if (action === 'APPROVE' || action === 'REJECT') {
      d.prepare(`INSERT INTO approvals (entity_type, entity_id, action, decision, remarks, decided_by, decided_at) VALUES ('purchase_request', ?, 'PR_APPROVAL', ?, ?, ?, ?)`)
        .run(id, action === 'APPROVE' ? 'APPROVED' : 'REJECTED', b.remarks || null, ctx.user.id, nowIso());
    }
    audit.log(ctx, action, 'purchase_request', id, `${pr.pr_no} → ${flow[1]}`);
  });
}

/** Integrity check: balance must equal the sum of posted transactions for every part/store. */
function reconcile() {
  return db.get().prepare(`SELECT b.part_id, b.store_id, b.qty_on_hand, COALESCE(t.q, 0) AS txn_sum
    FROM stock_balances b LEFT JOIN (SELECT part_id, store_id, SUM(qty) q FROM inventory_transactions WHERE status = 'POSTED' GROUP BY part_id, store_id) t
      ON t.part_id = b.part_id AND t.store_id = b.store_id
    WHERE ABS(b.qty_on_hand - COALESCE(t.q, 0)) > 0.0001`).all();
}

module.exports = { receive, issue, returnToStock, transfer, requestAdjustment, decideAdjustment, reserve, releaseReservations, createPR, actPR, reconcile, balance };
