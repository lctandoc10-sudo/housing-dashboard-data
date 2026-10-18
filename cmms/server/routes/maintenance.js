'use strict';
// Equipment registry, PMS, work orders, breakdowns and investigations.
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const rbac = require('../rbac');
const audit = require('../audit');
const numbering = require('../numbering');
const assetStatus = require('../services/assetStatus');
const pms = require('../services/pms');
const wos = require('../services/workorders');
const { h, need, paging, sortBy, stripCost, csvList } = require('./util');
const { nowIso, isDate, today, toIso } = require('../time');
const { bad, notFound, conflict, forbidden } = require('../errors');

const router = express.Router();

// ---------------------------------------------------------------- equipment registry
const ASSET_FIELDS = ['asset_code', 'name', 'description', 'category_id', 'manufacturer', 'model', 'serial_no', 'plate_no', 'location_id', 'date_acquired',
  'commissioning_date', 'purchase_value', 'supplier_id', 'warranty_expiry', 'warranty_details', 'custodian', 'department', 'criticality'];

function validateAsset(b, existing) {
  const d = db.get();
  const a = { ...existing, ...b };
  if (!a.asset_code || !/^[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/.test(a.asset_code)) throw bad('Equipment ID: 2-40 letters, digits, . _ / -');
  if (!a.name || !String(a.name).trim()) throw bad('Equipment name is required');
  if (!a.category_id || !d.prepare('SELECT 1 FROM equipment_categories WHERE id = ?').get(a.category_id)) throw bad('Select the equipment category');
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(a.criticality || 'MEDIUM')) throw bad('Invalid criticality');
  for (const f of ['date_acquired', 'commissioning_date', 'warranty_expiry']) if (a[f] && !isDate(a[f])) throw bad(`Invalid date: ${f.replace('_', ' ')}`);
  for (const f of ['date_acquired', 'commissioning_date']) if (a[f] && a[f] > today()) throw bad(`${f.replace('_', ' ')} cannot be in the future`);
  if (a.date_acquired && a.commissioning_date && a.commissioning_date < a.date_acquired) throw bad('Commissioning date cannot be before the acquisition date');
  if (a.purchase_value != null && a.purchase_value !== '' && !(Number(a.purchase_value) >= 0)) throw bad('Invalid purchase value');
  if (a.location_id) {
    const l = d.prepare('SELECT * FROM locations WHERE id = ?').get(a.location_id);
    if (!l || l.site_id !== Number(a.site_id)) throw bad('Location does not belong to the selected site');
  }
  const dupCode = d.prepare('SELECT id FROM assets WHERE asset_code = ? AND id <> ?').get(a.asset_code, existing ? existing.id : 0);
  if (dupCode) throw conflict(`Equipment ID ${a.asset_code} is already registered`);
  if (a.serial_no) {
    const dupSerial = d.prepare(`SELECT asset_code FROM assets WHERE serial_no = ? COLLATE NOCASE AND COALESCE(manufacturer,'') = COALESCE(?, '') COLLATE NOCASE AND id <> ?`).get(a.serial_no, a.manufacturer || null, existing ? existing.id : 0);
    if (dupSerial) throw conflict(`Serial number already registered on ${dupSerial.asset_code}`);
  }
}

router.get('/assets', need('asset.view'), h(req => {
  const q = req.query; const { page, size, offset } = paging(q);
  const p = { size, offset };
  const where = ['a.is_archived = ' + (q.archived === '1' ? 1 : 0), rbac.siteFilter(req.user, 'a.site_id', p)];
  if (q.q) { where.push('(a.asset_code LIKE @q OR a.name LIKE @q OR a.serial_no LIKE @q OR a.plate_no LIKE @q OR a.model LIKE @q OR a.manufacturer LIKE @q)'); p.q = `%${q.q}%`; }
  if (q.site_id) { where.push('a.site_id = @site'); p.site = Number(q.site_id); }
  if (q.category_id) { where.push('a.category_id = @cat'); p.cat = Number(q.category_id); }
  if (q.criticality) { where.push('a.criticality = @crit'); p.crit = q.criticality; }
  const st = csvList(q.status);
  if (st.length) { where.push(`a.status IN (${st.map((s, i) => { p['st' + i] = s; return '@st' + i; }).join(',')})`); }
  if (q.pms_overdue === '1') { where.push(`EXISTS (SELECT 1 FROM work_orders w JOIN wo_statuses s ON s.code = w.status WHERE w.asset_id = a.id AND w.wo_type = 'PMS' AND s.category IN ('OPEN','HOLD') AND w.due_date < @today)`); p.today = today(); }
  const order = sortBy(q, { asset_code: 'a.asset_code', name: 'a.name', status: 'a.status', criticality: "CASE a.criticality WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END", site: 'si.name', category: 'c.name', next_pms_due: 'next_pms_due' }, 'a.asset_code ASC');
  const sql = `FROM assets a JOIN sites si ON si.id = a.site_id JOIN equipment_categories c ON c.id = a.category_id LEFT JOIN locations l ON l.id = a.location_id WHERE ${where.join(' AND ')}`;
  const rows = db.get().prepare(`SELECT a.id, a.asset_code, a.name, a.manufacturer, a.model, a.serial_no, a.plate_no, a.criticality, a.status, a.status_since, a.status_reason, a.meter_type, a.meter_reading,
      a.last_pms_date, a.site_id, si.name site, c.name category, l.name location, a.custodian,
      (SELECT MIN(d) FROM (SELECT w.due_date d FROM work_orders w JOIN wo_statuses s ON s.code = w.status WHERE w.asset_id = a.id AND w.wo_type = 'PMS' AND s.category IN ('OPEN','HOLD')
         UNION ALL SELECT ps.next_due_date FROM pms_schedules ps JOIN pms_plans pp ON pp.id = ps.plan_id WHERE ps.asset_id = a.id AND ps.is_active = 1 AND pp.is_active = 1)) next_pms_due
    ${sql} ORDER BY ${order} LIMIT @size OFFSET @offset`).all(p);
  const total = db.get().prepare(`SELECT COUNT(*) n ${sql}`).get(p).n;
  return { rows, total, page, page_size: size };
}));

function assetDetail(user, a) {
  const d = db.get();
  const canWo = rbac.can(user, 'wo.view');
  const woVisible = canWo ? '1=1' : `(w.requested_by = ${Number(user.id)} OR EXISTS (SELECT 1 FROM wo_assignees x WHERE x.work_order_id = w.id AND x.user_id = ${Number(user.id)}))`;
  const out = {
    ...a,
    site: d.prepare('SELECT id, code, name FROM sites WHERE id = ?').get(a.site_id),
    location: a.location_id ? d.prepare('SELECT id, name FROM locations WHERE id = ?').get(a.location_id) : null,
    category: d.prepare('SELECT * FROM equipment_categories WHERE id = ?').get(a.category_id),
    supplier: a.supplier_id ? d.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(a.supplier_id) : null,
    status_info: assetStatus.STATUSES[a.status],
    open_work_orders: d.prepare(`SELECT w.id, w.wo_number, w.wo_type, w.title, w.status, w.priority, w.due_date, w.planned_end FROM work_orders w JOIN wo_statuses s ON s.code = w.status
      WHERE w.asset_id = ? AND s.category IN ('OPEN','HOLD') AND ${woVisible} ORDER BY w.created_at DESC`).all(a.id),
    history: d.prepare(`SELECT w.id, w.wo_number, w.wo_type, w.title, w.status, w.priority, w.created_at, w.actual_end, w.closed_at, w.root_cause_code, w.repair_action, s.name site
      FROM work_orders w JOIN sites s ON s.id = w.site_id WHERE w.asset_id = ? AND ${woVisible} ORDER BY w.created_at DESC LIMIT 200`).all(a.id),
    breakdowns: d.prepare(`SELECT b.id, b.report_no, b.reported_at, b.severity, b.impact, b.description, b.is_failure, w.wo_number, w.id work_order_id, w.status
      FROM breakdowns b JOIN work_orders w ON w.id = b.work_order_id WHERE b.asset_id = ? AND ${woVisible} ORDER BY b.reported_at DESC LIMIT 20`).all(a.id),
    status_history: d.prepare(`SELECT h.*, u.full_name changed_by_name, w.wo_number FROM asset_status_history h LEFT JOIN users u ON u.id = h.changed_by LEFT JOIN work_orders w ON w.id = h.work_order_id
      WHERE h.asset_id = ? ORDER BY h.changed_at DESC, h.id DESC LIMIT 50`).all(a.id),
    transfers: d.prepare(`SELECT t.*, fs.name from_site, ts.name to_site, u.full_name by_name FROM asset_transfers t JOIN sites fs ON fs.id = t.from_site_id JOIN sites ts ON ts.id = t.to_site_id
      JOIN users u ON u.id = t.transferred_by WHERE t.asset_id = ? ORDER BY t.transferred_at DESC`).all(a.id),
    meter_readings: d.prepare('SELECT m.*, u.full_name by_name FROM meter_readings m LEFT JOIN users u ON u.id = m.recorded_by WHERE m.asset_id = ? ORDER BY m.reading_at DESC LIMIT 20').all(a.id),
    pms_schedules: d.prepare(`SELECT s.*, p.code plan_code, p.name plan_name, p.frequency, p.interval_value FROM pms_schedules s JOIN pms_plans p ON p.id = s.plan_id WHERE s.asset_id = ? AND p.is_active = 1`).all(a.id),
    attachments: d.prepare(`SELECT id, filename, mime_type, size_bytes, caption, uploaded_at FROM attachments WHERE entity_type = 'asset' AND entity_id = ? AND is_deleted = 0 ORDER BY id DESC`).all(a.id),
    downtime_open: d.prepare('SELECT * FROM downtime_events WHERE asset_id = ? AND end_at IS NULL AND is_void = 0').get(a.id) || null,
  };
  out.next_pms_due = [...out.open_work_orders.filter(w => w.wo_type === 'PMS').map(w => w.due_date), ...out.pms_schedules.filter(s => s.is_active).map(s => s.next_due_date)].filter(Boolean).sort()[0] || null;
  if (rbac.can(user, 'cost.view')) {
    out.cost_summary = d.prepare(`SELECT category, ROUND(SUM(amount),2) amount FROM cost_entries WHERE asset_id = ? AND kind = 'ACTUAL' AND status IN ('APPROVED','PENDING') GROUP BY category`).all(a.id);
  }
  out.actions = {
    report_breakdown: rbac.can(user, 'breakdown.report'), create_wo: rbac.can(user, 'wo.create'), edit: rbac.can(user, 'asset.edit'),
    set_status: rbac.can(user, 'asset.status'), transfer: rbac.can(user, 'asset.transfer'), meter: rbac.can(user, 'asset.meter') && a.meter_type !== 'NONE',
  };
  return stripCost(user, out);
}

function loadAsset(user, idOrCode, byCode) {
  const a = db.get().prepare(`SELECT * FROM assets WHERE ${byCode ? 'asset_code = ?' : 'id = ?'}`).get(idOrCode);
  if (!a) throw notFound('Equipment');
  rbac.requireSite(user, a.site_id);
  return a;
}
router.get('/assets/by-code/:code', need('asset.view'), h(req => assetDetail(req.user, loadAsset(req.user, req.params.code, true))));
router.get('/assets/:id', need('asset.view'), h(req => assetDetail(req.user, loadAsset(req.user, req.params.id))));

router.post('/assets', need('asset.create'), h(req => db.tx(() => {
  const b = req.body || {};
  if (!b.site_id) throw bad('Select the project/site');
  rbac.requireSite(req.user, b.site_id);
  if (!db.get().prepare('SELECT 1 FROM sites WHERE id = ? AND is_active = 1').get(b.site_id)) throw bad('Invalid or inactive site');
  validateAsset(b, null);
  const cat = db.get().prepare('SELECT * FROM equipment_categories WHERE id = ?').get(b.category_id);
  const meter = b.meter_reading === '' || b.meter_reading == null ? null : Number(b.meter_reading);
  if (meter != null && (!Number.isFinite(meter) || meter < 0)) throw bad('Invalid meter reading');
  const ts = nowIso();
  const vals = Object.fromEntries(ASSET_FIELDS.map(f => [f, b[f] === '' || b[f] === undefined ? null : b[f]]));
  vals.criticality = vals.criticality || 'MEDIUM';
  const r = db.get().prepare(`INSERT INTO assets (${ASSET_FIELDS.join(',')}, site_id, status, status_since, meter_type, meter_reading, meter_read_at, created_by, created_at, updated_by, updated_at)
    VALUES (${ASSET_FIELDS.map(f => '@' + f).join(',')}, @site_id, 'AVAILABLE', @ts, @meter_type, @meter, @meter_at, @uid, @ts, @uid, @ts)`).run({
    ...vals, site_id: b.site_id, ts, meter_type: cat.meter_type, meter: cat.meter_type === 'NONE' ? null : meter, meter_at: meter != null ? ts : null, uid: req.user.id });
  const id = r.lastInsertRowid;
  db.get().prepare(`INSERT INTO asset_status_history (asset_id, from_status, to_status, reason, changed_by, changed_at) VALUES (?, NULL, 'AVAILABLE', 'Registered', ?, ?)`).run(id, req.user.id, ts);
  if (meter != null && cat.meter_type !== 'NONE') db.get().prepare(`INSERT INTO meter_readings (asset_id, reading, reading_at, source, recorded_by, created_at) VALUES (?, ?, ?, 'REGISTRATION', ?, ?)`).run(id, meter, ts, req.user.id, ts);
  pms.syncAsset(id);
  audit.log(req.ctx, 'CREATE', 'asset', id, `${b.asset_code} ${b.name}`, null, vals);
  return { id };
})));

router.put('/assets/:id', need('asset.edit'), h(req => db.tx(() => {
  const a = loadAsset(req.user, req.params.id);
  const b = req.body || {};
  if ('site_id' in b && Number(b.site_id) !== a.site_id) throw bad('Use Transfer to move equipment to another site');
  validateAsset(b, a);
  const fields = {};
  for (const f of ASSET_FIELDS) if (f in b) fields[f] = b[f] === '' ? null : b[f];
  if (fields.category_id && Number(fields.category_id) !== a.category_id) {
    const cat = db.get().prepare('SELECT * FROM equipment_categories WHERE id = ?').get(fields.category_id);
    fields.meter_type = cat.meter_type;
  }
  fields.updated_by = req.user.id; fields.updated_at = nowIso();
  db.updateRow('assets', a.id, fields, [...ASSET_FIELDS, 'meter_type', 'updated_by', 'updated_at']);
  if (fields.category_id) pms.syncAsset(a.id);
  const df = audit.diff(a, { ...a, ...fields });
  if (df) audit.log(req.ctx, 'UPDATE', 'asset', a.id, a.asset_code, df[0], df[1]);
  return { ok: true };
})));

router.post('/assets/:id/status', need('asset.status'), h(req => db.tx(() => {
  const a = loadAsset(req.user, req.params.id);
  assetStatus.setManualStatus(req.ctx, a.id, req.body.status, req.body.reason);
  return { ok: true };
})));

router.post('/assets/:id/transfer', need('asset.transfer'), h(req => db.tx(() => {
  const d = db.get();
  const a = loadAsset(req.user, req.params.id);
  const b = req.body || {};
  const to = d.prepare('SELECT * FROM sites WHERE id = ? AND is_active = 1').get(b.to_site_id);
  if (!to) throw bad('Select the destination site');
  if (to.id === a.site_id && (b.to_location_id || null) === a.location_id) throw bad('Equipment is already at this site/location');
  if (!b.reason || String(b.reason).trim().length < 3) throw bad('Transfer reason is required');
  if (b.to_location_id) { const l = d.prepare('SELECT * FROM locations WHERE id = ?').get(b.to_location_id); if (!l || l.site_id !== to.id) throw bad('Location does not belong to the destination site'); }
  const open = d.prepare(`SELECT w.wo_number FROM work_orders w JOIN wo_statuses s ON s.code = w.status WHERE w.asset_id = ? AND s.category IN ('OPEN','HOLD') AND w.status NOT IN ('SCHEDULED')`).all(a.id);
  if (open.length && to.id !== a.site_id) throw conflict(`Complete or cancel active work orders before transfer: ${open.map(o => o.wo_number).join(', ')}`);
  const ts = nowIso();
  d.prepare(`INSERT INTO asset_transfers (asset_id, from_site_id, to_site_id, from_location_id, to_location_id, reason, transferred_by, transferred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(a.id, a.site_id, to.id, a.location_id, b.to_location_id || null, b.reason, req.user.id, ts);
  d.prepare('UPDATE assets SET site_id = ?, location_id = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(to.id, b.to_location_id || null, req.user.id, ts, a.id);
  // scheduled (not started) PMS work orders follow the equipment
  d.prepare(`UPDATE work_orders SET site_id = ? WHERE asset_id = ? AND status = 'SCHEDULED'`).run(to.id, a.id);
  const openDt = d.prepare('SELECT * FROM downtime_events WHERE asset_id = ? AND end_at IS NULL AND is_void = 0').get(a.id);
  if (openDt) d.prepare('UPDATE downtime_events SET site_id = ? WHERE id = ?').run(to.id, openDt.id);
  audit.log(req.ctx, 'TRANSFER', 'asset', a.id, `${a.asset_code}: site ${a.site_id} → ${to.id} (${b.reason})`, { site_id: a.site_id, location_id: a.location_id }, { site_id: to.id, location_id: b.to_location_id || null });
  return { ok: true };
})));

router.post('/assets/:id/meter', need('asset.meter'), h(req => { wos.recordMeter(req.ctx, Number(req.params.id), req.body.reading, req.body.reading_at); return { ok: true }; }));

router.post('/assets/:id/archive', need('asset.edit'), h(req => db.tx(() => {
  const a = loadAsset(req.user, req.params.id);
  if (a.status !== 'DECOMMISSIONED') throw conflict('Decommission the equipment before archiving it');
  if (!req.body.reason) throw bad('Reason is required');
  db.get().prepare('UPDATE assets SET is_archived = 1, updated_by = ?, updated_at = ? WHERE id = ?').run(req.user.id, nowIso(), a.id);
  audit.log(req.ctx, 'ARCHIVE', 'asset', a.id, `${a.asset_code}: ${req.body.reason}`);
  return { ok: true };
})));

router.get('/assets/:id/qr.svg', need('asset.view'), h(async (req, res) => {
  const a = loadAsset(req.user, req.params.id);
  const base = process.env.CMMS_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const svg = await QRCode.toString(`${base}/#/a/${encodeURIComponent(a.asset_code)}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
}));

// ---------------------------------------------------------------- PMS
router.get('/pms/plans', need('pms.view'), h(req => {
  const p = {};
  const sf = rbac.siteFilter(req.user, 'a.site_id', p);
  return db.get().prepare(`SELECT pl.*, c.name category, a.asset_code, ct.name checklist,
      (SELECT COUNT(*) FROM pms_schedules s JOIN assets a ON a.id = s.asset_id WHERE s.plan_id = pl.id AND s.is_active = 1 AND ${sf}) schedules,
      (SELECT MIN(s.next_due_date) FROM pms_schedules s JOIN assets a ON a.id = s.asset_id WHERE s.plan_id = pl.id AND s.is_active = 1 AND ${sf}) next_due
    FROM pms_plans pl LEFT JOIN equipment_categories c ON c.id = pl.category_id LEFT JOIN assets a ON a.id = pl.asset_id LEFT JOIN checklist_templates ct ON ct.id = pl.checklist_template_id
    ORDER BY pl.is_active DESC, pl.code`).all(p);
}));
router.get('/pms/plans/:id', need('pms.view'), h(req => {
  const d = db.get();
  const plan = d.prepare('SELECT * FROM pms_plans WHERE id = ?').get(req.params.id);
  if (!plan) throw notFound('PMS plan');
  const p = { id: plan.id };
  const sf = rbac.siteFilter(req.user, 'a.site_id', p);
  plan.parts = d.prepare('SELECT pp.*, pt.part_no, pt.name FROM pms_plan_parts pp JOIN parts pt ON pt.id = pp.part_id WHERE pp.plan_id = ?').all(plan.id);
  plan.schedules = d.prepare(`SELECT s.*, a.asset_code, a.name asset_name, a.meter_reading, si.name site,
      (SELECT w.wo_number || '|' || w.id || '|' || w.status FROM work_orders w JOIN wo_statuses st ON st.code = w.status WHERE w.schedule_id = s.id AND st.category IN ('OPEN','HOLD')) open_wo
    FROM pms_schedules s JOIN assets a ON a.id = s.asset_id JOIN sites si ON si.id = a.site_id WHERE s.plan_id = @id AND ${sf} ORDER BY a.asset_code`).all(p);
  return plan;
}));
router.post('/pms/plans', need('pms.plan'), h(req => ({ id: pms.createPlan(req.ctx, req.body || {}) })));
router.put('/pms/plans/:id', need('pms.plan'), h(req => { pms.updatePlan(req.ctx, Number(req.params.id), req.body || {}); return { ok: true }; }));
router.put('/pms/schedules/:id', need('pms.plan'), h(req => db.tx(() => {
  const d = db.get();
  const s = d.prepare('SELECT s.*, a.site_id FROM pms_schedules s JOIN assets a ON a.id = s.asset_id WHERE s.id = ?').get(req.params.id);
  if (!s) throw notFound('Schedule');
  rbac.requireSite(req.user, s.site_id);
  const b = req.body || {};
  if (b.next_due_date !== undefined && b.next_due_date !== null && !isDate(b.next_due_date)) throw bad('Invalid next due date');
  if (b.next_due_meter !== undefined && b.next_due_meter !== null && !(Number(b.next_due_meter) >= 0)) throw bad('Invalid next due meter');
  if (!b.reason) throw bad('Reason is required to change a schedule');
  const fields = {};
  for (const k of ['next_due_date', 'next_due_meter', 'is_active']) if (k in b) fields[k] = typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k];
  fields.updated_at = nowIso();
  db.updateRow('pms_schedules', s.id, fields, ['next_due_date', 'next_due_meter', 'is_active', 'updated_at']);
  audit.log(req.ctx, 'UPDATE', 'pms_schedule', s.id, b.reason, { next_due_date: s.next_due_date, next_due_meter: s.next_due_meter, is_active: s.is_active }, fields);
  return { ok: true };
})));
router.get('/pms/calendar', need('pms.view'), h(req => {
  const from = isDate(req.query.from) ? req.query.from : today().slice(0, 8) + '01';
  const to = isDate(req.query.to) ? req.query.to : require('../time').addDays(from, 41);
  if (req.query.site_id) rbac.requireSite(req.user, req.query.site_id);
  return pms.calendar(req.user, from, to, req.query.site_id ? Number(req.query.site_id) : null);
}));
router.post('/pms/generate', need('pms.plan'), h(req => {
  const created = pms.generate(req.ctx);
  audit.log(req.ctx, 'GENERATE_PMS', 'system', null, `${created.length} PMS work orders generated`);
  return { generated: created };
}));

// ---------------------------------------------------------------- work orders
router.get('/work-orders', need('wo.view', 'wo.view_assigned'), h(req => {
  const q = req.query; const { page, size, offset } = paging(q);
  const p = { size, offset, uid: req.user.id, today: today(), now: nowIso() };
  const where = [rbac.siteFilter(req.user, 'w.site_id', p)];
  if (!rbac.can(req.user, 'wo.view') || q.mine === '1') where.push('(EXISTS (SELECT 1 FROM wo_assignees x WHERE x.work_order_id = w.id AND x.user_id = @uid)' + (q.mine === '1' ? ')' : ' OR w.requested_by = @uid)'));
  if (q.q) { where.push('(w.wo_number LIKE @q OR w.title LIKE @q OR a.asset_code LIKE @q OR a.name LIKE @q)'); p.q = `%${q.q}%`; }
  const add = (field, col, cast) => { if (q[field]) { const vals = csvList(q[field]); where.push(`${col} IN (${vals.map((v, i) => { p[field + i] = cast ? Number(v) : v; return '@' + field + i; }).join(',')})`); } };
  add('site_id', 'w.site_id', true); add('asset_id', 'w.asset_id', true); add('wo_type', 'w.wo_type'); add('priority', 'w.priority'); add('status', 'w.status'); add('ids', 'w.id', true);
  if (q.category_id) { where.push('a.category_id = @cat'); p.cat = Number(q.category_id); }
  if (q.assignee_id) { where.push('EXISTS (SELECT 1 FROM wo_assignees x WHERE x.work_order_id = w.id AND x.user_id = @asg)'); p.asg = Number(q.assignee_id); }
  if (q.open === '1') where.push(`st.category IN ('OPEN','HOLD')`);
  if (q.closed === '1') where.push(`st.category IN ('DONE','CANCELLED','MISSED')`);
  if (q.overdue === '1') where.push(`st.category IN ('OPEN','HOLD') AND ((w.due_date IS NOT NULL AND w.due_date < @today) OR (w.planned_end IS NOT NULL AND w.planned_end < @now))`);
  if (q.unassigned === '1') where.push(`st.category = 'OPEN' AND NOT EXISTS (SELECT 1 FROM wo_assignees x WHERE x.work_order_id = w.id)`);
  if (q.from) { where.push('w.created_at >= @from'); p.from = toIso(q.from); }
  if (q.to) { where.push('w.created_at < @to'); p.to = toIso(require('../time').addDays(q.to, 1)); }
  const order = sortBy(q, { wo_number: 'w.wo_number', created_at: 'w.created_at', due_date: 'COALESCE(w.due_date, substr(w.planned_end,1,10))', priority: "CASE w.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END", status: 'st.sort_order', asset: 'a.asset_code' },
    "CASE WHEN st.category IN ('OPEN','HOLD') THEN 0 ELSE 1 END, CASE w.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, w.created_at DESC");
  const sql = `FROM work_orders w JOIN assets a ON a.id = w.asset_id JOIN sites si ON si.id = w.site_id JOIN wo_statuses st ON st.code = w.status WHERE ${where.join(' AND ')}`;
  const rows = db.get().prepare(`SELECT w.id, w.wo_number, w.wo_type, w.title, w.priority, w.status, st.label status_label, st.category status_category, w.due_date, w.planned_end, w.created_at, w.actual_end,
      a.asset_code, a.name asset_name, si.name site, w.is_recurrence,
      (SELECT GROUP_CONCAT(u.full_name, ', ') FROM wo_assignees x JOIN users u ON u.id = x.user_id WHERE x.work_order_id = w.id) assigned_to,
      CASE WHEN st.category IN ('OPEN','HOLD') AND ((w.due_date IS NOT NULL AND w.due_date < @today) OR (w.planned_end IS NOT NULL AND w.planned_end < @now)) THEN 1 ELSE 0 END is_overdue,
      CASE WHEN st.category = 'OPEN' AND NOT EXISTS (SELECT 1 FROM wo_assignees x WHERE x.work_order_id = w.id) THEN 1 ELSE 0 END is_unassigned
    ${sql} ORDER BY ${order} LIMIT @size OFFSET @offset`).all(p);
  const total = db.get().prepare(`SELECT COUNT(*) n ${sql}`).get(p).n;
  return { rows, total, page, page_size: size };
}));

router.get('/work-orders/check-duplicates', need('wo.create', 'breakdown.report'), h(req => {
  const a = loadAsset(req.user, req.query.asset_id);
  return wos.openDuplicates(a.id, req.query.wo_type || null);
}));

router.get('/work-orders/:id', need('wo.view', 'wo.view_assigned'), h(req => {
  const d = db.get();
  const wo = wos.loadVisible(req.user, Number(req.params.id));
  const canCost = rbac.can(req.user, 'cost.view');
  const out = {
    ...wo,
    asset: d.prepare('SELECT id, asset_code, name, status, meter_type, meter_reading, criticality FROM assets WHERE id = ?').get(wo.asset_id),
    site: d.prepare('SELECT id, name FROM sites WHERE id = ?').get(wo.site_id),
    status_info: d.prepare('SELECT * FROM wo_statuses WHERE code = ?').get(wo.status),
    assignees: d.prepare('SELECT u.id, u.full_name, a.assigned_at FROM wo_assignees a JOIN users u ON u.id = a.user_id WHERE a.work_order_id = ?').all(wo.id),
    people: Object.fromEntries(d.prepare(`SELECT id, full_name FROM users WHERE id IN (?, ?, ?, ?, ?, ?, ?)`).all(wo.requested_by, wo.supervisor_id, wo.submitted_by, wo.verified_by, wo.closed_by, wo.cancelled_by, wo.created_by).map(u => [u.id, u.full_name])),
    history: d.prepare('SELECT h.*, u.full_name by_name FROM wo_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.work_order_id = ? ORDER BY h.id').all(wo.id),
    checklist: d.prepare('SELECT * FROM wo_checklist_results WHERE work_order_id = ? ORDER BY seq').all(wo.id),
    labor: stripCost(req.user, d.prepare('SELECT l.*, u.full_name FROM labor_entries l JOIN users u ON u.id = l.user_id WHERE l.work_order_id = ? ORDER BY l.work_date, l.id').all(wo.id)),
    labor_hours: wos.labourHours(wo.id),
    notes: d.prepare('SELECT n.*, u.full_name FROM wo_progress_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.work_order_id = ? ORDER BY n.id DESC').all(wo.id),
    parts: stripCost(req.user, d.prepare(`SELECT t.id, t.txn_no, t.txn_type, t.qty, t.unit_cost, t.total_cost, t.recipient, t.created_at, p.part_no, p.name, p.uom, s.name store
      FROM inventory_transactions t JOIN parts p ON p.id = t.part_id JOIN stores s ON s.id = t.store_id WHERE t.work_order_id = ? AND t.status = 'POSTED' ORDER BY t.id`).all(wo.id)),
    reservations: d.prepare(`SELECT r.*, p.part_no, p.name, p.uom, s.name store FROM part_reservations r JOIN parts p ON p.id = r.part_id JOIN stores s ON s.id = r.store_id WHERE r.work_order_id = ?`).all(wo.id),
    required_parts: wo.schedule_id ? d.prepare(`SELECT pp.qty, p.id part_id, p.part_no, p.name, p.uom FROM pms_schedules s JOIN pms_plan_parts pp ON pp.plan_id = s.plan_id JOIN parts p ON p.id = pp.part_id WHERE s.id = ?`).all(wo.schedule_id) : [],
    purchase_requests: d.prepare(`SELECT pr.id, pr.pr_no, pr.status, pr.qty, p.part_no, p.name FROM purchase_requests pr JOIN parts p ON p.id = pr.part_id WHERE pr.work_order_id = ?`).all(wo.id),
    breakdown: d.prepare('SELECT b.*, u.full_name reported_by_name FROM breakdowns b JOIN users u ON u.id = b.reported_by WHERE b.work_order_id = ?').get(wo.id) || null,
    reschedules: d.prepare('SELECT r.*, u.full_name by_name FROM wo_reschedules r JOIN users u ON u.id = r.authorized_by WHERE r.work_order_id = ? ORDER BY r.id').all(wo.id),
    approvals: d.prepare(`SELECT ap.*, u.full_name by_name FROM approvals ap JOIN users u ON u.id = ap.decided_by WHERE ap.entity_type = 'work_order' AND ap.entity_id = ? ORDER BY ap.id`).all(wo.id),
    linked: d.prepare('SELECT id, wo_number, wo_type, title, status FROM work_orders WHERE parent_wo_id = ? OR id = ?').all(wo.id, wo.parent_wo_id || 0),
    investigation: wo.investigation_id ? d.prepare('SELECT id, inv_no, title, status FROM failure_investigations WHERE id = ?').get(wo.investigation_id) : null,
    downtime: d.prepare('SELECT * FROM downtime_events WHERE work_order_id = ? ORDER BY start_at').all(wo.id),
    attachments: d.prepare(`SELECT id, filename, mime_type, size_bytes, caption, uploaded_at FROM attachments WHERE entity_type = 'work_order' AND entity_id = ? AND is_deleted = 0 ORDER BY id DESC`).all(wo.id),
    transitions: wos.allowedTransitions(req.user, wo),
    can: {
      edit_plan: ['OPEN', 'HOLD'].includes(d.prepare('SELECT category FROM wo_statuses WHERE code = ?').get(wo.status).category) && (rbac.can(req.user, 'wo.assign') || rbac.can(req.user, 'wo.assess')),
      execute: wos.canExecute(req.user, wo), assign: rbac.can(req.user, 'wo.assign'), reschedule: rbac.can(req.user, 'pms.reschedule'),
      reserve: rbac.can(req.user, 'inventory.reserve'), issue: rbac.can(req.user, 'inventory.issue'), cost: canCost, cost_manage: rbac.can(req.user, 'cost.manage'),
    },
  };
  if (canCost) out.costs = d.prepare('SELECT c.*, u.full_name created_by_name FROM cost_entries c LEFT JOIN users u ON u.id = c.created_by WHERE c.work_order_id = ? ORDER BY c.id').all(wo.id);
  else delete out.est_cost;
  return out;
}));

router.post('/work-orders', need('wo.create'), h(req => wos.create(req.ctx, req.body || {})));
router.put('/work-orders/:id', need('wo.view', 'wo.view_assigned'), h(req => wos.update(req.ctx, Number(req.params.id), req.body || {})));
router.post('/work-orders/:id/assign', need('wo.assign'), h(req => wos.assign(req.ctx, Number(req.params.id), req.body.user_ids, { version: req.body.version, remarks: req.body.remarks })));
router.post('/work-orders/:id/transition', need('wo.view', 'wo.view_assigned'), h(req => wos.transition(req.ctx, Number(req.params.id), req.body.to, req.body)));
router.put('/work-orders/:id/checklist', need('wo.execute'), h(req => { wos.saveChecklist(req.ctx, Number(req.params.id), req.body.results); return { ok: true }; }));
router.post('/work-orders/:id/labor', need('wo.execute'), h(req => stripCost(req.user, wos.addLabor(req.ctx, Number(req.params.id), req.body || {}))));
router.post('/work-orders/:id/labor/:lid/void', need('wo.execute'), h(req => { wos.voidLabor(req.ctx, Number(req.params.id), Number(req.params.lid), req.body.reason); return { ok: true }; }));
router.post('/work-orders/:id/notes', need('wo.view', 'wo.view_assigned'), h(req => { wos.addNote(req.ctx, Number(req.params.id), req.body.note); return { ok: true }; }));
router.post('/work-orders/:id/reschedule', need('pms.reschedule'), h(req => wos.reschedule(req.ctx, Number(req.params.id), req.body || {})));
router.post('/work-orders/:id/linked-cm', need('wo.create', 'wo.execute'), h(req => wos.createLinkedCorrective(req.ctx, Number(req.params.id), req.body || {})));

// ---------------------------------------------------------------- breakdowns
router.post('/breakdowns', need('breakdown.report'), h(req => wos.reportBreakdown(req.ctx, req.body || {})));
router.get('/breakdowns', need('wo.view'), h(req => {
  const q = req.query; const { page, size, offset } = paging(q);
  const p = { size, offset };
  const where = [rbac.siteFilter(req.user, 'b.site_id', p)];
  if (q.site_id) { where.push('b.site_id = @site'); p.site = Number(q.site_id); }
  if (q.asset_id) { where.push('b.asset_id = @asset'); p.asset = Number(q.asset_id); }
  if (q.severity) { where.push('b.severity = @sev'); p.sev = q.severity; }
  const sql = `FROM breakdowns b JOIN work_orders w ON w.id = b.work_order_id JOIN assets a ON a.id = b.asset_id JOIN sites si ON si.id = b.site_id WHERE ${where.join(' AND ')}`;
  return { rows: db.get().prepare(`SELECT b.*, w.wo_number, w.status, a.asset_code, a.name asset_name, si.name site ${sql} ORDER BY b.reported_at DESC LIMIT @size OFFSET @offset`).all(p),
    total: db.get().prepare(`SELECT COUNT(*) n ${sql}`).get(p).n, page, page_size: size };
}));

// ---------------------------------------------------------------- failure investigations
router.get('/investigations', need('wo.view'), h(req => {
  const p = {};
  return db.get().prepare(`SELECT i.*, a.asset_code, a.name asset_name, (SELECT COUNT(*) FROM work_orders w WHERE w.investigation_id = i.id) linked
    FROM failure_investigations i JOIN assets a ON a.id = i.asset_id WHERE ${rbac.siteFilter(req.user, 'a.site_id', p)} ORDER BY i.status, i.created_at DESC`).all(p);
}));
router.get('/investigations/:id', need('wo.view'), h(req => {
  const d = db.get();
  const i = d.prepare('SELECT i.*, a.asset_code, a.name asset_name, a.site_id FROM failure_investigations i JOIN assets a ON a.id = i.asset_id WHERE i.id = ?').get(req.params.id);
  if (!i) throw notFound('Investigation');
  rbac.requireSite(req.user, i.site_id);
  i.work_orders = d.prepare(`SELECT w.id, w.wo_number, w.wo_type, w.title, w.status, w.created_at, w.root_cause_code, w.failed_component FROM work_orders w WHERE w.investigation_id = ? ORDER BY w.created_at`).all(i.id);
  i.candidates = d.prepare(`SELECT w.id, w.wo_number, w.title, w.created_at FROM work_orders w WHERE w.asset_id = ? AND w.wo_type = 'CM' AND w.investigation_id IS NULL ORDER BY w.created_at DESC LIMIT 30`).all(i.asset_id);
  return i;
}));
router.post('/investigations', need('investigation.manage'), h(req => db.tx(() => {
  const b = req.body || {};
  const a = loadAsset(req.user, b.asset_id);
  if (!b.title) throw bad('Title is required');
  const no = numbering.next('INVESTIGATION');
  const r = db.get().prepare('INSERT INTO failure_investigations (inv_no, asset_id, title, problem_statement, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(no, a.id, b.title, b.problem_statement || null, req.user.id, nowIso());
  linkWos(req, r.lastInsertRowid, a.id, b.work_order_ids);
  audit.log(req.ctx, 'CREATE', 'investigation', r.lastInsertRowid, `${no} ${a.asset_code}: ${b.title}`);
  return { id: r.lastInsertRowid, inv_no: no };
})));
function linkWos(req, invId, assetId, ids) {
  for (const id of ids || []) {
    const w = db.get().prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
    if (!w || w.asset_id !== assetId) throw bad('Linked work orders must belong to the same equipment');
    db.get().prepare('UPDATE work_orders SET investigation_id = ?, is_recurrence = 1 WHERE id = ?').run(invId, id);
  }
}
router.put('/investigations/:id', need('investigation.manage'), h(req => db.tx(() => {
  const d = db.get();
  const i = d.prepare('SELECT i.*, a.site_id FROM failure_investigations i JOIN assets a ON a.id = i.asset_id WHERE i.id = ?').get(req.params.id);
  if (!i) throw notFound('Investigation');
  rbac.requireSite(req.user, i.site_id);
  const b = req.body || {};
  if (i.status === 'CLOSED' && b.status !== 'OPEN') throw conflict('Investigation is closed');
  const fields = {};
  for (const k of ['title', 'problem_statement', 'root_cause', 'preventive_actions']) if (k in b) fields[k] = b[k];
  if (b.status === 'CLOSED') {
    if (!(fields.root_cause || i.root_cause) || !(fields.preventive_actions || i.preventive_actions)) throw bad('Root cause and preventive actions are required to close an investigation');
    Object.assign(fields, { status: 'CLOSED', closed_by: req.user.id, closed_at: nowIso() });
  } else if (b.status === 'OPEN') Object.assign(fields, { status: 'OPEN', closed_by: null, closed_at: null });
  db.updateRow('failure_investigations', i.id, fields, ['title', 'problem_statement', 'root_cause', 'preventive_actions', 'status', 'closed_by', 'closed_at']);
  linkWos(req, i.id, i.asset_id, b.link_work_order_ids);
  audit.log(req.ctx, 'UPDATE', 'investigation', i.id, i.inv_no, null, fields);
  return { ok: true };
})));
router.post('/investigations/:id/follow-up', need('investigation.manage'), h(req => db.tx(() => {
  const i = db.get().prepare('SELECT * FROM failure_investigations WHERE id = ?').get(req.params.id);
  if (!i) throw notFound('Investigation');
  const b = req.body || {};
  return wos.create(req.ctx, { wo_type: b.wo_type === 'OTHER' ? 'OTHER' : 'INSPECTION', asset_id: i.asset_id, title: b.title || `Follow-up preventive action – ${i.inv_no}`,
    description: b.description || i.preventive_actions, priority: b.priority || 'MEDIUM', investigation_id: i.id, due_date: b.due_date, confirm_duplicate: true, requires_shutdown: b.requires_shutdown ? 1 : 0 });
})));

module.exports = router;
