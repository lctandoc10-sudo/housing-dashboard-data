'use strict';
// Maintenance cost entries. Parts and internal labor costs are generated
// automatically from inventory issues/returns and labor entries, keyed by
// (source_type, source_id) so each source can only be costed once. Manual entries
// cover external labor, third-party services, rentals and other direct costs.
const db = require('../db');
const audit = require('../audit');
const rbac = require('../rbac');
const { nowIso, today, isDate } = require('../time');
const { bad, notFound, forbidden, conflict } = require('../errors');

const CATEGORIES = ['PARTS', 'INTERNAL_LABOR', 'EXTERNAL_LABOR', 'THIRD_PARTY_SERVICE', 'RENTAL', 'OTHER'];
const round2 = n => Math.round(n * 100) / 100;

function insertSystem({ wo, assetId, siteId, category, amount, description, sourceType, sourceId, userId, entryDate }) {
  db.get().prepare(`INSERT INTO cost_entries (work_order_id, asset_id, site_id, category, kind, amount, entry_date, description, source_type, source_id, status, created_by, created_at)
    VALUES (?, ?, ?, ?, 'ACTUAL', ?, ?, ?, ?, ?, 'PENDING', ?, ?)`).run(
    wo ? wo.id : null, assetId, siteId, category, round2(amount), entryDate || today(), description, sourceType, sourceId, userId, nowIso());
}

function fromLabor(entry, wo, userId) {
  insertSystem({ wo, assetId: wo.asset_id, siteId: wo.site_id, category: 'INTERNAL_LABOR', amount: entry.cost,
    description: `Labor ${entry.hours} h @ ${entry.rate}/h`, sourceType: 'LABOR', sourceId: entry.id, userId, entryDate: entry.work_date });
}
function fromInventory(txn, wo, userId) {
  // issue: qty negative -> positive cost; return: qty positive -> negative cost (credit)
  insertSystem({ wo, assetId: txn.asset_id, siteId: txn.site_id, category: 'PARTS', amount: -txn.qty * txn.unit_cost,
    description: `${txn.txn_type} ${txn.txn_no}`, sourceType: 'INV_TXN', sourceId: txn.id, userId });
}
function voidSource(sourceType, sourceId) {
  db.get().prepare(`UPDATE cost_entries SET status = 'VOID' WHERE source_type = ? AND source_id = ?`).run(sourceType, sourceId);
}
/** On work order closure, system-generated actual costs are approved by the closer. */
function approveSystemCosts(woId, userId) {
  db.get().prepare(`UPDATE cost_entries SET status = 'APPROVED', approved_by = ?, approved_at = ?
    WHERE work_order_id = ? AND status = 'PENDING' AND source_type IN ('LABOR','INV_TXN')`).run(userId, nowIso(), woId);
}

function createManual(ctx, b) {
  const d = db.get();
  if (!CATEGORIES.includes(b.category)) throw bad('Invalid cost category');
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount === 0) throw bad('Amount must be a non-zero number');
  const kind = b.kind === 'ESTIMATE' ? 'ESTIMATE' : 'ACTUAL';
  const entryDate = b.entry_date || today();
  if (!isDate(entryDate)) throw bad('Invalid entry date');
  if (entryDate > today()) throw bad('Cost entry date cannot be in the future');
  let wo = null, assetId = b.asset_id, siteId;
  if (b.work_order_id) {
    wo = d.prepare('SELECT * FROM work_orders WHERE id = ?').get(b.work_order_id);
    if (!wo) throw notFound('Work order');
    assetId = wo.asset_id; siteId = wo.site_id;
    if (wo.status === 'CANCELLED') throw bad('Cannot add costs to a cancelled work order');
  } else {
    const a = d.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!a) throw bad('A work order or asset is required');
    siteId = a.site_id;
  }
  rbac.requireSite(ctx.user, siteId);
  if (b.category === 'INTERNAL_LABOR') throw bad('Internal labor is costed automatically from labor entries; record hours on the work order instead to avoid double counting');
  if (b.category === 'PARTS' && !b.reference) throw bad('Manual parts costs are only for direct purchases not drawn from inventory; an OR/invoice reference is required. Parts issued from stores are costed automatically.');
  if (!b.description || !String(b.description).trim()) throw bad('Description is required');
  if (b.reference) {
    const dup = d.prepare(`SELECT id FROM cost_entries WHERE reference = ? AND category = ? AND COALESCE(work_order_id,0) = COALESCE(?,0) AND status <> 'VOID' AND kind = ?`).get(b.reference, b.category, wo ? wo.id : null, kind);
    if (dup && !b.confirm_duplicate) throw conflict('A cost entry with the same reference already exists for this work order. Confirm to record it anyway.', { duplicate_id: dup.id });
  }
  const r = d.prepare(`INSERT INTO cost_entries (work_order_id, asset_id, site_id, category, kind, amount, entry_date, description, vendor, reference, source_type, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 'PENDING', ?, ?)`).run(
    wo ? wo.id : null, assetId, siteId, b.category, kind, round2(amount), entryDate, b.description, b.vendor || null, b.reference || null, ctx.user.id, nowIso());
  audit.log(ctx, 'CREATE', 'cost_entry', r.lastInsertRowid, `${kind} ${b.category} ${amount}`, null, b);
  return r.lastInsertRowid;
}

function decide(ctx, id, approve, remarks) {
  const d = db.get();
  const c = d.prepare('SELECT * FROM cost_entries WHERE id = ?').get(id);
  if (!c) throw notFound('Cost entry');
  rbac.requireSite(ctx.user, c.site_id);
  if (c.status !== 'PENDING') throw conflict(`Cost entry is already ${c.status}`);
  if (c.created_by === ctx.user.id) throw forbidden('You cannot approve a cost entry you recorded');
  const status = approve ? 'APPROVED' : 'REJECTED';
  d.prepare('UPDATE cost_entries SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?').run(status, ctx.user.id, nowIso(), id);
  d.prepare(`INSERT INTO approvals (entity_type, entity_id, action, decision, remarks, decided_by, decided_at) VALUES ('cost_entry', ?, 'COST_APPROVAL', ?, ?, ?, ?)`)
    .run(id, status, remarks || null, ctx.user.id, nowIso());
  audit.log(ctx, status, 'cost_entry', id, remarks);
}

module.exports = { CATEGORIES, fromLabor, fromInventory, voidSource, approveSystemCosts, createManual, decide };
