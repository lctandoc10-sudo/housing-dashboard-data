'use strict';
// Availability/downtime, inventory, costs, KPIs, reports, workload, attachments, import.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const rbac = require('../rbac');
const audit = require('../audit');
const analytics = require('../services/analytics');
const inventory = require('../services/inventory');
const costs = require('../services/costs');
const reports = require('../services/reports');
const importer = require('../services/importer');
const wos = require('../services/workorders');
const { h, need, paging, sortBy, stripCost, csvList } = require('./util');
const { nowIso, toIso, now, today, addDays } = require('../time');
const { bad, notFound, forbidden, conflict } = require('../errors');

const router = express.Router();
const filters = q => ({ from: q.from, to: q.to, site_id: q.site_id ? Number(q.site_id) : null, category_id: q.category_id ? Number(q.category_id) : null,
  asset_id: q.asset_id ? Number(q.asset_id) : null, wo_type: q.wo_type || null, group_by: q.group_by, days: q.days });
function checkFilterSite(req) { if (req.query.site_id) rbac.requireSite(req.user, req.query.site_id); }

// ---------------------------------------------------------------- availability & downtime
router.get('/availability/board', need('downtime.view'), h(req => {
  const p = {};
  const where = [`a.is_archived = 0`, `a.status NOT IN ('AVAILABLE','OPERATIONAL','STANDBY','DECOMMISSIONED')`, rbac.siteFilter(req.user, 'a.site_id', p)];
  if (req.query.site_id) { where.push('a.site_id = @site'); p.site = Number(req.query.site_id); }
  const unavailable = db.get().prepare(`SELECT a.id, a.asset_code, a.name, a.status, a.status_reason, a.status_since, a.status_responsible, a.est_recovery_at, a.criticality, si.name site, c.name category,
      w.id wo_id, w.wo_number, w.priority, (SELECT MIN(e.start_at) FROM downtime_events e WHERE e.asset_id = a.id AND e.end_at IS NULL AND e.is_void = 0) down_since
    FROM assets a JOIN sites si ON si.id = a.site_id JOIN equipment_categories c ON c.id = a.category_id LEFT JOIN work_orders w ON w.id = a.status_wo_id
    WHERE ${where.join(' AND ')} ORDER BY CASE a.status WHEN 'BREAKDOWN' THEN 0 ELSE 1 END, a.status_since`).all(p);
  const nowMs = now().getTime();
  for (const u of unavailable) u.hours_down = u.down_since ? Math.round((nowMs - Date.parse(u.down_since)) / 36e5 * 10) / 10 : null;
  const p2 = {};
  const w2 = [`a.is_archived = 0`, rbac.siteFilter(req.user, 'a.site_id', p2)];
  if (req.query.site_id) { w2.push('a.site_id = @site'); p2.site = Number(req.query.site_id); }
  const summary = db.get().prepare(`SELECT si.id site_id, si.name site, a.status, COUNT(*) n FROM assets a JOIN sites si ON si.id = a.site_id WHERE ${w2.join(' AND ')} GROUP BY si.id, a.status ORDER BY si.sort_order`).all(p2);
  return { unavailable, summary };
}));
router.get('/availability', need('downtime.view'), h(req => { checkFilterSite(req); return analytics.availability(req.user, filters(req.query)); }));
router.get('/downtime', need('downtime.view'), h(req => { checkFilterSite(req); return reports.run(req.user, 'downtime', filters(req.query)); }));
router.post('/downtime', need('downtime.manage'), h(req => db.tx(() => {
  // manual "other authorised downtime" (e.g. site shutdown, typhoon stand-down) – recorded with start and end
  const b = req.body || {};
  const a = db.get().prepare('SELECT * FROM assets WHERE id = ?').get(b.asset_id);
  if (!a) throw notFound('Equipment');
  rbac.requireSite(req.user, a.site_id);
  const s = toIso(b.start_at), e = toIso(b.end_at);
  if (!s || !e) throw bad('Start and end date/time are required');
  if (e <= s) throw bad('End must be after start');
  if (e > nowIso()) throw bad('Manual downtime can only be recorded for past periods');
  if (!b.reason || String(b.reason).trim().length < 5) throw bad('Reason is required');
  const cat = ['OTHER', 'EXTERNAL', 'WAITING_PARTS', 'UNPLANNED', 'PLANNED'].includes(b.category) ? b.category : 'OTHER';
  const overlap = db.get().prepare(`SELECT COUNT(*) n FROM downtime_events WHERE asset_id = ? AND is_void = 0 AND start_at < ? AND COALESCE(end_at, '9999') > ?`).get(a.id, e, s).n;
  const r = db.get().prepare(`INSERT INTO downtime_events (asset_id, site_id, category, reason, start_at, end_at, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?)`)
    .run(a.id, a.site_id, cat, b.reason, s, e, req.user.id, nowIso());
  audit.log(req.ctx, 'CREATE', 'downtime', r.lastInsertRowid, `${a.asset_code} ${cat} ${s} → ${e}: ${b.reason}`);
  return { id: r.lastInsertRowid, overlapping_events: overlap, note: overlap ? 'Overlaps existing downtime; overlapping time is counted once in availability.' : null };
})));
router.post('/downtime/:id/void', need('downtime.manage'), h(req => {
  const e = db.get().prepare('SELECT * FROM downtime_events WHERE id = ?').get(req.params.id);
  if (!e) throw notFound('Downtime event');
  rbac.requireSite(req.user, e.site_id);
  if (e.source !== 'MANUAL') throw forbidden('Automatic downtime follows work order status and cannot be voided manually');
  if (!req.body.reason) throw bad('Reason is required');
  db.get().prepare('UPDATE downtime_events SET is_void = 1 WHERE id = ?').run(e.id);
  audit.log(req.ctx, 'VOID', 'downtime', e.id, req.body.reason);
  return { ok: true };
}));

// ---------------------------------------------------------------- inventory
const PART_FIELDS = ['part_no', 'name', 'description', 'category', 'uom', 'compatibility', 'supplier_id', 'min_qty', 'max_qty', 'reorder_point', 'is_critical', 'is_active'];
router.get('/parts', need('inventory.view'), h(req => {
  const q = req.query; const { page, size, offset } = paging(q);
  const p = { size, offset };
  const sp = {};
  const storeScope = q.store_id ? 's.id = @store' : rbac.siteFilter(req.user, 's.site_id', sp);
  Object.assign(p, sp); if (q.store_id) p.store = Number(q.store_id);
  const where = ['1=1'];
  if (q.q) { where.push('(p.part_no LIKE @q OR p.name LIKE @q OR p.compatibility LIKE @q OR p.category LIKE @q)'); p.q = `%${q.q}%`; }
  if (q.active !== 'all') where.push('p.is_active = 1');
  if (q.critical === '1') where.push('p.is_critical = 1');
  const having = q.low === '1' ? 'HAVING on_hand < p.min_qty OR (p.reorder_point > 0 AND on_hand <= p.reorder_point)' : '';
  const order = sortBy(q, { part_no: 'p.part_no', name: 'p.name', on_hand: 'on_hand', category: 'p.category' }, 'p.part_no');
  const base = `FROM parts p LEFT JOIN stock_balances b ON b.part_id = p.id LEFT JOIN stores s ON s.id = b.store_id AND ${storeScope} WHERE ${where.join(' AND ')} GROUP BY p.id ${having}`;
  const sel = `SELECT p.*, COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN b.qty_on_hand END),0) on_hand, COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN b.qty_reserved END),0) reserved, sup.name supplier`;
  const rows = db.get().prepare(`${sel} ${base.replace('WHERE', 'LEFT JOIN suppliers sup ON sup.id = p.supplier_id WHERE')} ORDER BY ${order} LIMIT @size OFFSET @offset`).all(p);
  const total = db.get().prepare(`SELECT COUNT(*) n FROM (SELECT p.id, p.min_qty, p.reorder_point, COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN b.qty_on_hand END),0) on_hand ${base})`).get(p).n;
  const canValue = rbac.can(req.user, 'cost.view') || rbac.can(req.user, 'inventory.manage_parts');
  return { rows: canValue ? rows : stripCost(req.user, rows), total, page, page_size: size };
}));
router.get('/parts/:id', need('inventory.view'), h(req => {
  const d = db.get();
  const p = d.prepare('SELECT p.*, s.name supplier FROM parts p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?').get(req.params.id);
  if (!p) throw notFound('Part');
  const sp = {};
  const sf = rbac.siteFilter(req.user, 'st.site_id', sp);
  p.balances = d.prepare(`SELECT b.*, st.code store_code, st.name store, st.site_id FROM stock_balances b JOIN stores st ON st.id = b.store_id WHERE b.part_id = @id AND ${sf}`).all({ ...sp, id: p.id });
  p.transactions = d.prepare(`SELECT t.*, st.code store_code, w.wo_number, u.full_name by_name FROM inventory_transactions t JOIN stores st ON st.id = t.store_id LEFT JOIN work_orders w ON w.id = t.work_order_id
    LEFT JOIN users u ON u.id = t.created_by WHERE t.part_id = @id AND ${sf} ORDER BY t.id DESC LIMIT 100`).all({ ...sp, id: p.id });
  const canValue = rbac.can(req.user, 'cost.view') || rbac.can(req.user, 'inventory.manage_parts');
  if (!canValue) { stripCost(req.user, p); stripCost(req.user, p.transactions); }
  return p;
}));
function validatePart(b) {
  if (b.part_no !== undefined && !String(b.part_no || '').trim()) throw bad('Part number is required');
  if (b.name !== undefined && !String(b.name || '').trim()) throw bad('Part name is required');
  for (const f of ['min_qty', 'max_qty', 'reorder_point']) if (b[f] != null && b[f] !== '' && !(Number(b[f]) >= 0)) throw bad(`${f} must be zero or more`);
  if (b.max_qty && b.min_qty && Number(b.max_qty) < Number(b.min_qty)) throw bad('Maximum stock must be at least the minimum');
}
router.post('/parts', need('inventory.manage_parts'), h(req => {
  const b = req.body || {};
  if (!b.part_no || !b.name) throw bad('Part number and name are required');
  validatePart(b);
  if (db.get().prepare('SELECT 1 FROM parts WHERE part_no = ?').get(b.part_no)) throw conflict('Part number already exists');
  const cols = PART_FIELDS.filter(f => f in b);
  const vals = cols.map(f => (typeof b[f] === 'boolean' ? (b[f] ? 1 : 0) : b[f] === '' ? null : b[f]));
  const r = db.get().prepare(`INSERT INTO parts (${cols.join(',')}, unit_cost, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?, ?)`).run(...vals, Number(b.unit_cost) || 0, nowIso(), nowIso());
  audit.log(req.ctx, 'CREATE', 'part', r.lastInsertRowid, `${b.part_no} ${b.name}`);
  return { id: r.lastInsertRowid };
}));
router.put('/parts/:id', need('inventory.manage_parts'), h(req => {
  const before = db.get().prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  if (!before) throw notFound('Part');
  const b = req.body || {};
  validatePart(b);
  const fields = {};
  for (const f of PART_FIELDS) if (f in b) fields[f] = typeof b[f] === 'boolean' ? (b[f] ? 1 : 0) : b[f] === '' ? null : b[f];
  fields.updated_at = nowIso();
  try { db.updateRow('parts', before.id, fields, [...PART_FIELDS, 'updated_at']); } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('Part number already exists'); throw e; }
  const df = audit.diff(before, { ...before, ...fields });
  if (df) audit.log(req.ctx, 'UPDATE', 'part', before.id, before.part_no, df[0], df[1]);
  return { ok: true };
}));
router.put('/parts/:id/bin', need('inventory.manage_parts'), h(req => {
  const st = db.get().prepare('SELECT * FROM stores WHERE id = ?').get(req.body.store_id);
  if (!st) throw notFound('Store');
  rbac.requireSite(req.user, st.site_id);
  inventory.balance(Number(req.params.id), st.id);
  db.get().prepare('UPDATE stock_balances SET bin_location = ? WHERE part_id = ? AND store_id = ?').run(req.body.bin_location || null, req.params.id, st.id);
  return { ok: true };
}));

router.post('/inventory/receive', need('inventory.receive'), h(req => inventory.receive(req.ctx, req.body || {})));
router.post('/inventory/issue', need('inventory.issue'), h(req => inventory.issue(req.ctx, req.body || {})));
router.post('/inventory/return', need('inventory.issue'), h(req => inventory.returnToStock(req.ctx, req.body || {})));
router.post('/inventory/transfer', need('inventory.transfer'), h(req => inventory.transfer(req.ctx, req.body || {})));
router.post('/inventory/adjust', need('inventory.adjust'), h(req => ({ id: inventory.requestAdjustment(req.ctx, req.body || {}) })));
router.post('/inventory/adjust/:id/decide', need('inventory.approve'), h(req => { inventory.decideAdjustment(req.ctx, Number(req.params.id), !!req.body.approve, req.body.remarks); return { ok: true }; }));
router.post('/inventory/reserve', need('inventory.reserve'), h(req => ({ id: inventory.reserve(req.ctx, req.body || {}) })));
router.post('/inventory/reservations/:id/release', need('inventory.reserve'), h(req => db.tx(() => {
  const r = db.get().prepare('SELECT r.*, w.site_id FROM part_reservations r JOIN work_orders w ON w.id = r.work_order_id WHERE r.id = ?').get(req.params.id);
  if (!r || r.status !== 'ACTIVE') throw notFound('Active reservation');
  rbac.requireSite(req.user, r.site_id);
  db.get().prepare('UPDATE stock_balances SET qty_reserved = MAX(0, qty_reserved - ?) WHERE part_id = ? AND store_id = ?').run(r.qty_reserved - r.qty_issued, r.part_id, r.store_id);
  db.get().prepare(`UPDATE part_reservations SET status = 'RELEASED' WHERE id = ?`).run(r.id);
  audit.log(req.ctx, 'RELEASE_RESERVATION', 'work_order', r.work_order_id, `Reservation ${r.id} released`);
  return { ok: true };
})));
router.get('/inventory/transactions', need('inventory.view'), h(req => {
  const q = req.query; const { page, size, offset } = paging(q);
  const p = { size, offset };
  const where = [rbac.siteFilter(req.user, 'st.site_id', p)];
  if (q.type) { const t = csvList(q.type); where.push(`t.txn_type IN (${t.map((x, i) => { p['t' + i] = x; return '@t' + i; }).join(',')})`); }
  if (q.status) { where.push('t.status = @status'); p.status = q.status; }
  if (q.part_id) { where.push('t.part_id = @part'); p.part = Number(q.part_id); }
  if (q.store_id) { where.push('t.store_id = @store'); p.store = Number(q.store_id); }
  if (q.work_order_id) { where.push('t.work_order_id = @wo'); p.wo = Number(q.work_order_id); }
  if (q.from) { where.push('t.created_at >= @from'); p.from = toIso(q.from); }
  if (q.to) { where.push('t.created_at < @to'); p.to = toIso(addDays(q.to, 1)); }
  const sql = `FROM inventory_transactions t JOIN parts pt ON pt.id = t.part_id JOIN stores st ON st.id = t.store_id LEFT JOIN work_orders w ON w.id = t.work_order_id
    LEFT JOIN users u ON u.id = t.created_by LEFT JOIN users ap ON ap.id = t.approved_by WHERE ${where.join(' AND ')}`;
  const rows = db.get().prepare(`SELECT t.*, pt.part_no, pt.name part_name, pt.uom, st.code store_code, w.wo_number, u.full_name by_name, ap.full_name approved_by_name ${sql} ORDER BY t.id DESC LIMIT @size OFFSET @offset`).all(p);
  const canValue = rbac.can(req.user, 'cost.view') || rbac.can(req.user, 'inventory.manage_parts');
  return { rows: canValue ? rows : stripCost(req.user, rows), total: db.get().prepare(`SELECT COUNT(*) n ${sql}`).get(p).n, page, page_size: size };
}));
router.get('/inventory/reconcile', need('inventory.view'), h(() => ({ mismatches: inventory.reconcile(), checked_at: nowIso() })));

router.get('/purchase-requests', need('inventory.view', 'pr.create'), h(req => {
  const q = req.query; const p = {};
  const where = [rbac.siteFilter(req.user, 'st.site_id', p)];
  if (q.status) { const s = csvList(q.status); where.push(`pr.status IN (${s.map((x, i) => { p['s' + i] = x; return '@s' + i; }).join(',')})`); }
  return db.get().prepare(`SELECT pr.*, pt.part_no, pt.name part_name, pt.uom, st.code store_code, w.wo_number, u.full_name requested_by_name, ap.full_name approved_by_name, sup.name supplier
    FROM purchase_requests pr JOIN parts pt ON pt.id = pr.part_id JOIN stores st ON st.id = pr.store_id LEFT JOIN work_orders w ON w.id = pr.work_order_id
    LEFT JOIN users u ON u.id = pr.requested_by LEFT JOIN users ap ON ap.id = pr.approved_by LEFT JOIN suppliers sup ON sup.id = pr.supplier_id
    WHERE ${where.join(' AND ')} ORDER BY pr.id DESC LIMIT 500`).all(p);
}));
router.post('/purchase-requests', need('pr.create'), h(req => ({ id: inventory.createPR(req.ctx, req.body || {}) })));
router.post('/purchase-requests/:id/:action(approve|reject|order|cancel)', need('pr.create', 'pr.approve', 'inventory.receive'), h(req => {
  inventory.actPR(req.ctx, Number(req.params.id), req.params.action.toUpperCase(), req.body || {});
  return { ok: true };
}));

// ---------------------------------------------------------------- costs
router.get('/costs', need('cost.view'), h(req => {
  const q = req.query; const { page, size, offset } = paging(q);
  const p = { size, offset };
  const where = [rbac.siteFilter(req.user, 'c.site_id', p)];
  if (q.site_id) { where.push('c.site_id = @site'); p.site = Number(q.site_id); }
  if (q.asset_id) { where.push('c.asset_id = @asset'); p.asset = Number(q.asset_id); }
  if (q.category) { where.push('c.category = @cat'); p.cat = q.category; }
  if (q.status) { where.push('c.status = @status'); p.status = q.status; }
  if (q.kind) { where.push('c.kind = @kind'); p.kind = q.kind; }
  if (q.work_order_id) { where.push('c.work_order_id = @wo'); p.wo = Number(q.work_order_id); }
  if (q.from) { where.push('c.entry_date >= @from'); p.from = q.from; }
  if (q.to) { where.push('c.entry_date <= @to'); p.to = q.to; }
  const sql = `FROM cost_entries c JOIN assets a ON a.id = c.asset_id JOIN sites si ON si.id = c.site_id LEFT JOIN work_orders w ON w.id = c.work_order_id LEFT JOIN users u ON u.id = c.created_by WHERE ${where.join(' AND ')}`;
  return {
    rows: db.get().prepare(`SELECT c.*, a.asset_code, si.name site, w.wo_number, w.wo_type, u.full_name created_by_name ${sql} ORDER BY c.entry_date DESC, c.id DESC LIMIT @size OFFSET @offset`).all(p),
    total: db.get().prepare(`SELECT COUNT(*) n ${sql}`).get(p).n,
    sum: db.get().prepare(`SELECT ROUND(COALESCE(SUM(CASE WHEN c.status IN ('APPROVED','PENDING') THEN c.amount END),0),2) s ${sql}`).get(p).s, page, page_size: size,
  };
}));
router.post('/costs', need('cost.manage'), h(req => ({ id: costs.createManual(req.ctx, req.body || {}) })));
router.post('/costs/:id/decide', need('cost.approve'), h(req => { costs.decide(req.ctx, Number(req.params.id), !!req.body.approve, req.body.remarks); return { ok: true }; }));
router.get('/costs/summary', need('cost.view'), h(req => {
  checkFilterSite(req);
  const f = filters(req.query);
  const c = analytics.costTotals(req.user, f);
  const top = reports.run(req.user, 'cost_per_equipment', f).rows.slice(0, 10);
  const byMonth = reports.run(req.user, 'cost_analysis', { ...f, group_by: 'month' }).rows.filter(r => r.kind === 'ACTUAL');
  const bySite = reports.run(req.user, 'cost_analysis', { ...f, group_by: 'site' }).rows.filter(r => r.kind === 'ACTUAL');
  const byType = reports.run(req.user, 'cost_analysis', { ...f, group_by: 'wo_type' }).rows;
  return { ...c, top_assets: top, by_month: byMonth, by_site: bySite, by_wo_type: byType, period: analytics.period(f) };
}));

// ---------------------------------------------------------------- KPIs
router.get('/kpi/dashboard', need('kpi.view'), h(req => { checkFilterSite(req); return analytics.dashboard(req.user, filters(req.query)); }));
router.get('/kpi/charts', need('kpi.view'), h(req => { checkFilterSite(req); return analytics.charts(req.user, filters(req.query)); }));
router.get('/kpi/reliability', need('kpi.view'), h(req => {
  checkFilterSite(req);
  const f = filters(req.query);
  const strip = o => { const { ids, ...rest } = o; return { ...rest, record_count: ids ? ids.length : undefined, ids }; };
  return { mttr: strip(analytics.mttr(req.user, f)), mtbf: strip(analytics.mtbf(req.user, f)), closure_rate: strip(analytics.closureRate(req.user, f)),
    pms_compliance: strip(analytics.pmsCompliance(req.user, f)), backlog: (({ rows, ...r }) => r)(analytics.backlog(req.user, f)), period: analytics.period(f) };
}));

// ---------------------------------------------------------------- reports
router.get('/reports', need('report.view'), h(req => reports.list(req.user)));
router.get('/reports/:id', need('report.view'), h(async (req, res) => {
  checkFilterSite(req);
  const fmt = req.query.format || 'json';
  if (fmt !== 'json') rbac.require(req.user, req.params.id === 'finance_export' ? 'cost.export' : 'report.export');
  const rep = reports.run(req.user, req.params.id, filters(req.query));
  // only return the declared columns (prevents leaking hidden fields such as costs)
  const keys = new Set(['id', 'asset_id', ...rep.columns.map(c => c.key)]);
  rep.rows = rep.rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => keys.has(k))));
  if (fmt === 'json') return rep;
  const name = `${req.params.id}-${today()}`;
  const siteLbl = req.query.site_id ? `Site: ${(db.get().prepare('SELECT name FROM sites WHERE id = ?').get(req.query.site_id) || {}).name}` : 'All permitted sites';
  audit.log(req.ctx, 'EXPORT', 'report', req.params.id, `${fmt.toUpperCase()} ${rep.rows.length} rows (${siteLbl})`);
  if (fmt === 'csv') { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`); res.send(reports.toCsv(rep)); return; }
  if (fmt === 'xlsx') {
    const buf = await reports.toXlsx(rep, siteLbl);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.send(Buffer.from(buf)); return;
  }
  throw bad('Unknown format');
}));

// ---------------------------------------------------------------- workforce
router.get('/team/workload', need('team.view', 'wo.assign'), h(req => {
  const p = analytics.period(filters(req.query));
  const sp = {};
  const siteCond = rbac.siteFilter(req.user, 'w.site_id', sp);
  const users = db.get().prepare(`SELECT u.id, u.full_name, u.role_code, u.skills, u.position FROM users u WHERE u.is_active = 1
    AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_code = u.role_code AND rp.permission = 'wo.execute') AND u.role_code IN ('TECHNICIAN','SUPERVISOR') ORDER BY u.full_name`).all();
  return users.map(u => {
    const q = { ...sp, uid: u.id, start: p.startIso, end: p.endIso, from: p.from, to: p.to, today: today(), now: nowIso() };
    const open = db.get().prepare(`SELECT w.id, w.wo_number, w.wo_type, w.priority, w.status, w.title, w.due_date, w.planned_end, w.est_labor_hours,
        CASE WHEN (w.due_date IS NOT NULL AND w.due_date < @today) OR (w.planned_end IS NOT NULL AND w.planned_end < @now) THEN 1 ELSE 0 END overdue
      FROM work_orders w JOIN wo_assignees x ON x.work_order_id = w.id JOIN wo_statuses st ON st.code = w.status WHERE x.user_id = @uid AND st.category IN ('OPEN','HOLD') AND ${siteCond}`).all(q);
    const closed = db.get().prepare(`SELECT COUNT(*) n, COALESCE(SUM(w.est_labor_hours),0) planned FROM work_orders w JOIN wo_assignees x ON x.work_order_id = w.id
      WHERE x.user_id = @uid AND w.status = 'CLOSED' AND w.closed_at >= @start AND w.closed_at < @end AND ${siteCond}`).get(q);
    const actual = db.get().prepare(`SELECT COALESCE(SUM(l.hours),0) h FROM labor_entries l JOIN work_orders w ON w.id = l.work_order_id WHERE l.user_id = @uid AND l.is_void = 0 AND l.work_date BETWEEN @from AND @to AND ${siteCond}`).get(q).h;
    return { ...u, open_count: open.length, overdue_count: open.filter(o => o.overdue).length, open_est_hours: open.reduce((t, o) => t + (o.est_labor_hours || 0), 0),
      closed_in_period: closed.n, planned_hours_closed: closed.planned, actual_hours: actual, open };
  });
}));

// ---------------------------------------------------------------- attachments
const UPLOAD_DIR = () => process.env.CMMS_UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');
const ALLOWED = {
  'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'], 'image/heic': ['.heic'], 'application/pdf': ['.pdf'],
  'video/mp4': ['.mp4'], 'video/quicktime': ['.mov'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};
const MAGIC = { '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff], '.png': [0x89, 0x50, 0x4e, 0x47], '.pdf': [0x25, 0x50, 0x44, 0x46], '.xlsx': [0x50, 0x4b], '.docx': [0x50, 0x4b], '.webp': [0x52, 0x49, 0x46, 0x46] };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

function checkEntityAccess(user, type, id, write) {
  const d = db.get();
  if (type === 'asset') {
    const a = d.prepare('SELECT site_id FROM assets WHERE id = ?').get(id);
    if (!a) throw notFound('Equipment');
    rbac.requireSite(user, a.site_id); rbac.require(user, write ? 'asset.edit' : 'asset.view');
  } else if (type === 'work_order') {
    const wo = wos.loadVisible(user, id);
    if (write && !(wos.canExecute(user, wo) || rbac.can(user, 'wo.assign') || wo.requested_by === user.id)) throw forbidden();
  } else if (type === 'investigation') {
    const i = d.prepare('SELECT a.site_id FROM failure_investigations i JOIN assets a ON a.id = i.asset_id WHERE i.id = ?').get(id);
    if (!i) throw notFound('Investigation');
    rbac.requireSite(user, i.site_id); rbac.require(user, write ? 'investigation.manage' : 'wo.view');
  } else if (type === 'part') {
    rbac.require(user, write ? 'inventory.manage_parts' : 'inventory.view');
  } else throw bad('Unsupported attachment type');
}

router.post('/attachments', upload.single('file'), h(req => {
  const f = req.file;
  if (!f) throw bad('No file uploaded');
  const type = req.body.entity_type; const id = Number(req.body.entity_id);
  checkEntityAccess(req.user, type, id, true);
  const ext = path.extname(f.originalname || '').toLowerCase();
  const allowedExt = ALLOWED[f.mimetype];
  if (!allowedExt || !allowedExt.includes(ext)) throw bad('File type not allowed (photos, videos, PDF, XLSX, DOCX only)');
  const magic = MAGIC[ext];
  if (magic && !magic.every((b, i) => f.buffer[i] === b)) throw bad('File content does not match its type');
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  fs.mkdirSync(UPLOAD_DIR(), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR(), stored), f.buffer, { flag: 'wx' });
  const safeName = path.basename(f.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 150);
  const r = db.get().prepare(`INSERT INTO attachments (entity_type, entity_id, filename, stored_name, mime_type, size_bytes, caption, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(type, id, safeName, stored, f.mimetype, f.size, req.body.caption || null, req.user.id, nowIso());
  audit.log(req.ctx, 'UPLOAD', type, id, `${safeName} (${f.size} bytes)`);
  return { id: r.lastInsertRowid };
}));
router.get('/attachments/:id', h((req, res) => {
  const a = db.get().prepare('SELECT * FROM attachments WHERE id = ? AND is_deleted = 0').get(req.params.id);
  if (!a) throw notFound('Attachment');
  checkEntityAccess(req.user, a.entity_type, a.entity_id, false);
  const inline = a.mime_type.startsWith('image/') || a.mime_type === 'application/pdf' || a.mime_type.startsWith('video/');
  res.setHeader('Content-Type', a.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${a.filename.replace(/"/g, '')}"`);
  res.sendFile(path.join(UPLOAD_DIR(), a.stored_name));
}));
router.post('/attachments/:id/delete', h(req => {
  const a = db.get().prepare('SELECT * FROM attachments WHERE id = ? AND is_deleted = 0').get(req.params.id);
  if (!a) throw notFound('Attachment');
  checkEntityAccess(req.user, a.entity_type, a.entity_id, true);
  if (a.uploaded_by !== req.user.id && !rbac.can(req.user, 'wo.assign') && !rbac.can(req.user, 'admin.master')) throw forbidden();
  db.get().prepare('UPDATE attachments SET is_deleted = 1 WHERE id = ?').run(a.id); // soft delete; file retained for audit
  audit.log(req.ctx, 'DELETE', 'attachment', a.id, a.filename);
  return { ok: true };
}));

// ---------------------------------------------------------------- import
router.get('/import/template', need('import.run'), h(async (req, res) => {
  const buf = await importer.template();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="cmms-import-template.xlsx"');
  res.send(Buffer.from(buf));
}));
router.post('/import/:mode(validate|commit)', need('import.run'), importUpload.single('file'), h(async req => {
  if (!req.file) throw bad('No file uploaded');
  const data = await importer.parse(req.file.buffer);
  const v = importer.validate(req.user, data);
  if (req.params.mode === 'validate' || v.errors.length) return { mode: req.params.mode, committed: false, counts: v.counts, errors: v.errors.slice(0, 500), error_count: v.errors.length };
  importer.commit(req.ctx, v.plan);
  return { mode: 'commit', committed: true, counts: v.counts, errors: [] };
}));

module.exports = router;
