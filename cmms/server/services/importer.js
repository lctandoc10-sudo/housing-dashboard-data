'use strict';
// Controlled Excel import of equipment, parts (with opening balances) and
// historical maintenance records. Every import is validated first; a commit only
// runs when every row is valid and is applied in a single transaction.
const ExcelJS = require('exceljs');
const db = require('../db');
const audit = require('../audit');
const rbac = require('../rbac');
const numbering = require('../numbering');
const pms = require('./pms');
const inventory = require('./inventory');
const { nowIso, isDate, manilaToUtc, today } = require('../time');
const { bad } = require('../errors');

const SHEETS = {
  Equipment: ['asset_code*', 'name*', 'category_code*', 'site_code*', 'location', 'manufacturer', 'model', 'serial_no', 'plate_no', 'criticality',
    'date_acquired', 'commissioning_date', 'purchase_value', 'supplier', 'warranty_expiry', 'warranty_details', 'custodian', 'department', 'meter_reading', 'description'],
  Parts: ['part_no*', 'name*', 'uom', 'category', 'compatibility', 'unit_cost', 'min_qty', 'reorder_point', 'max_qty', 'is_critical', 'supplier', 'store_code', 'opening_qty', 'bin_location'],
  'Maintenance History': ['asset_code*', 'wo_type*', 'date_completed*', 'title*', 'work_performed', 'severity', 'root_cause_code', 'failure_mode_code', 'failed_component', 'repair_action',
    'labor_hours', 'downtime_hours', 'cost_parts', 'cost_labor', 'cost_external', 'performed_by', 'reference'],
};

async function template() {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('Instructions');
  const d = db.get();
  info.addRow(['CMMS import template']).font = { bold: true, size: 14 };
  info.addRow(['Columns marked * are required. Dates use YYYY-MM-DD. Do not rename the sheets or header cells.']);
  info.addRow(['Equipment: category_code and site_code must match the codes below. criticality = CRITICAL/HIGH/MEDIUM/LOW.']);
  info.addRow(['Parts: opening_qty is posted as an opening-balance receipt into store_code at unit_cost.']);
  info.addRow(['Maintenance History: wo_type = PMS/CM/INSPECTION/OTHER. CM rows also create a breakdown record (downtime_hours > 0 = equipment stopped). Imported records are closed and marked source IMPORT.']);
  info.addRow([]);
  info.addRow(['Category codes']).font = { bold: true };
  for (const c of d.prepare('SELECT code, name FROM equipment_categories WHERE is_active = 1').all()) info.addRow([c.code, c.name]);
  info.addRow(['Site codes']).font = { bold: true };
  for (const s of d.prepare('SELECT code, name FROM sites WHERE is_active = 1').all()) info.addRow([s.code, s.name]);
  info.addRow(['Store codes']).font = { bold: true };
  for (const s of d.prepare('SELECT code, name FROM stores WHERE is_active = 1').all()) info.addRow([s.code, s.name]);
  info.addRow(['Root cause codes']).font = { bold: true };
  for (const s of d.prepare(`SELECT code, label FROM failure_codes WHERE kind = 'ROOT_CAUSE'`).all()) info.addRow([s.code, s.label]);
  info.addRow(['Failure mode codes']).font = { bold: true };
  for (const s of d.prepare(`SELECT code, label FROM failure_codes WHERE kind = 'FAILURE_MODE'`).all()) info.addRow([s.code, s.label]);
  info.getColumn(1).width = 18; info.getColumn(2).width = 60;
  for (const [name, cols] of Object.entries(SHEETS)) {
    const ws = wb.addWorksheet(name);
    const h = ws.addRow(cols); h.font = { bold: true };
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(14, c.length + 4); });
  }
  return wb.xlsx.writeBuffer();
}

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellValue(v.result);
    if (v.text !== undefined) return String(v.text).trim() || null;
    if (v.richText) return v.richText.map(t => t.text).join('').trim() || null;
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function parse(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw bad('The file is not a valid .xlsx workbook'); }
  const out = {};
  for (const [name, cols] of Object.entries(SHEETS)) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    const header = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { header[i] = String(cellValue(c.value) || '').replace('*', '').trim(); });
    const expected = cols.map(c => c.replace('*', ''));
    for (const c of expected.filter((c, i) => cols[i].endsWith('*'))) if (!header.includes(c)) throw bad(`Sheet ${name} is missing required column ${c}`);
    const rows = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const o = { _row: n };
      let any = false;
      header.forEach((h, i) => { if (h && expected.includes(h)) { const v = cellValue(row.getCell(i).value); o[h] = v; if (v != null) any = true; } });
      if (any) rows.push(o);
    });
    out[name] = rows;
  }
  if (!Object.keys(out).length) throw bad('No Equipment, Parts or Maintenance History sheet found. Download the template.');
  return out;
}

const num = (v, row, field, errors, { min = 0 } = {}) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) { errors.push({ row, field, message: `${field} must be a number ≥ ${min}` }); return null; }
  return n;
};
const date = (v, row, field, errors) => {
  if (v == null) return null;
  if (!isDate(v)) { errors.push({ row, field, message: `${field} must be a date (YYYY-MM-DD)` }); return null; }
  if (v > today()) { errors.push({ row, field, message: `${field} cannot be in the future` }); return null; }
  return v;
};

function validate(user, data) {
  const d = db.get();
  const errors = [];
  const cat = code => d.prepare('SELECT * FROM equipment_categories WHERE code = ?').get(code);
  const site = code => d.prepare('SELECT * FROM sites WHERE code = ?').get(code);
  const store = code => d.prepare('SELECT * FROM stores WHERE code = ?').get(code);
  const seenAssets = new Map();
  const plan = { assets: [], parts: [], history: [] };

  for (const r of data.Equipment || []) {
    const e = [];
    const row = `Equipment!${r._row}`;
    if (!r.asset_code) e.push({ row, field: 'asset_code', message: 'Required' });
    if (!r.name) e.push({ row, field: 'name', message: 'Required' });
    const c = r.category_code && cat(r.category_code);
    if (!c) e.push({ row, field: 'category_code', message: `Unknown category ${r.category_code || ''}` });
    const s = r.site_code && site(r.site_code);
    if (!s) e.push({ row, field: 'site_code', message: `Unknown site ${r.site_code || ''}` });
    else if (!rbac.canSite(user, s.id)) e.push({ row, field: 'site_code', message: 'You have no access to this site' });
    if (r.asset_code) {
      const key = r.asset_code.toUpperCase();
      if (seenAssets.has(key)) e.push({ row, field: 'asset_code', message: `Duplicate of row ${seenAssets.get(key)}` });
      seenAssets.set(key, r._row);
      if (d.prepare('SELECT 1 FROM assets WHERE asset_code = ?').get(r.asset_code)) e.push({ row, field: 'asset_code', message: 'Equipment ID already registered' });
    }
    if (r.serial_no && d.prepare('SELECT 1 FROM assets WHERE serial_no = ? AND COALESCE(manufacturer,\'\') = COALESCE(?, \'\')').get(r.serial_no, r.manufacturer)) e.push({ row, field: 'serial_no', message: 'Serial number already registered for this manufacturer' });
    const crit = (r.criticality || 'MEDIUM').toUpperCase();
    if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(crit)) e.push({ row, field: 'criticality', message: 'Use CRITICAL/HIGH/MEDIUM/LOW' });
    const acq = date(r.date_acquired, row, 'date_acquired', e), com = date(r.commissioning_date, row, 'commissioning_date', e);
    if (acq && com && com < acq) e.push({ row, field: 'commissioning_date', message: 'Commissioning date is before acquisition date' });
    const wexp = r.warranty_expiry && isDate(r.warranty_expiry) ? r.warranty_expiry : (r.warranty_expiry ? (e.push({ row, field: 'warranty_expiry', message: 'Invalid date' }), null) : null);
    const pv = num(r.purchase_value, row, 'purchase_value', e);
    const meter = num(r.meter_reading, row, 'meter_reading', e);
    if (meter != null && c && c.meter_type === 'NONE') e.push({ row, field: 'meter_reading', message: 'This category has no meter' });
    errors.push(...e);
    if (!e.length) plan.assets.push({ ...r, category: c, site: s, criticality: crit, date_acquired: acq, commissioning_date: com, warranty_expiry: wexp, purchase_value: pv, meter_reading: meter });
  }

  const seenParts = new Set();
  for (const r of data.Parts || []) {
    const e = [];
    const row = `Parts!${r._row}`;
    if (!r.part_no) e.push({ row, field: 'part_no', message: 'Required' });
    if (!r.name) e.push({ row, field: 'name', message: 'Required' });
    if (r.part_no) {
      if (seenParts.has(r.part_no.toUpperCase())) e.push({ row, field: 'part_no', message: 'Duplicate in file' });
      seenParts.add(r.part_no.toUpperCase());
      if (d.prepare('SELECT 1 FROM parts WHERE part_no = ?').get(r.part_no)) e.push({ row, field: 'part_no', message: 'Part number already exists' });
    }
    const vals = {};
    for (const f of ['unit_cost', 'min_qty', 'reorder_point', 'max_qty', 'opening_qty']) vals[f] = num(r[f], row, f, e);
    let st = null;
    if (vals.opening_qty) {
      st = r.store_code && store(r.store_code);
      if (!st) e.push({ row, field: 'store_code', message: 'A valid store_code is required for opening quantity' });
      else if (!rbac.canSite(user, st.site_id)) e.push({ row, field: 'store_code', message: 'You have no access to this store' });
    }
    errors.push(...e);
    if (!e.length) plan.parts.push({ ...r, ...vals, store: st });
  }

  for (const r of data['Maintenance History'] || []) {
    const e = [];
    const row = `Maintenance History!${r._row}`;
    const a = r.asset_code && (d.prepare('SELECT * FROM assets WHERE asset_code = ?').get(r.asset_code) || plan.assets.find(x => x.asset_code.toUpperCase() === r.asset_code.toUpperCase()));
    if (!a) e.push({ row, field: 'asset_code', message: `Unknown equipment ${r.asset_code || ''}` });
    const type = (r.wo_type || '').toUpperCase();
    if (!['PMS', 'CM', 'INSPECTION', 'OTHER'].includes(type)) e.push({ row, field: 'wo_type', message: 'Use PMS, CM, INSPECTION or OTHER' });
    const dc = date(r.date_completed, row, 'date_completed', e);
    if (!r.date_completed) e.push({ row, field: 'date_completed', message: 'Required' });
    if (!r.title) e.push({ row, field: 'title', message: 'Required' });
    if (r.root_cause_code && !d.prepare(`SELECT 1 FROM failure_codes WHERE kind = 'ROOT_CAUSE' AND code = ?`).get(r.root_cause_code)) e.push({ row, field: 'root_cause_code', message: 'Unknown root cause code' });
    if (r.failure_mode_code && !d.prepare(`SELECT 1 FROM failure_codes WHERE kind = 'FAILURE_MODE' AND code = ?`).get(r.failure_mode_code)) e.push({ row, field: 'failure_mode_code', message: 'Unknown failure mode code' });
    const sev = (r.severity || 'MEDIUM').toUpperCase();
    if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(sev)) e.push({ row, field: 'severity', message: 'Use CRITICAL/HIGH/MEDIUM/LOW' });
    const vals = {};
    for (const f of ['labor_hours', 'downtime_hours', 'cost_parts', 'cost_labor', 'cost_external']) vals[f] = num(r[f], row, f, e);
    if (vals.downtime_hours > 24 * 90) e.push({ row, field: 'downtime_hours', message: 'Downtime above 90 days — check the value' });
    if (a && a.site_id && !rbac.canSite(user, a.site_id)) e.push({ row, field: 'asset_code', message: 'You have no access to this equipment\'s site' });
    errors.push(...e);
    if (!e.length) plan.history.push({ ...r, ...vals, wo_type: type, severity: sev, date_completed: dc });
  }
  return { errors, plan, counts: { equipment: plan.assets.length, parts: plan.parts.length, history: plan.history.length } };
}

function commit(ctx, plan) {
  const d = db.get();
  return db.tx(() => {
    const ts = nowIso();
    const supplierId = name => {
      if (!name) return null;
      const s = d.prepare('SELECT id FROM suppliers WHERE name = ?').get(name);
      return s ? s.id : d.prepare('INSERT INTO suppliers (name, created_at) VALUES (?, ?)').run(name, ts).lastInsertRowid;
    };
    const locationId = (siteId, name) => {
      if (!name) return null;
      const l = d.prepare('SELECT id FROM locations WHERE site_id = ? AND name = ?').get(siteId, name);
      return l ? l.id : d.prepare('INSERT INTO locations (site_id, name, created_at) VALUES (?, ?, ?)').run(siteId, name, ts).lastInsertRowid;
    };
    for (const a of plan.assets) {
      const r = d.prepare(`INSERT INTO assets (asset_code, name, description, category_id, manufacturer, model, serial_no, plate_no, site_id, location_id, date_acquired, commissioning_date,
          purchase_value, supplier_id, warranty_expiry, warranty_details, custodian, department, criticality, status, status_since, meter_type, meter_reading, meter_read_at, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        a.asset_code, a.name, a.description || null, a.category.id, a.manufacturer || null, a.model || null, a.serial_no || null, a.plate_no || null, a.site.id,
        locationId(a.site.id, a.location), a.date_acquired, a.commissioning_date, a.purchase_value, supplierId(a.supplier), a.warranty_expiry, a.warranty_details || null,
        a.custodian || null, a.department || null, a.criticality, ts, a.category.meter_type, a.meter_reading, a.meter_reading != null ? ts : null, ctx.user.id, ts, ctx.user.id, ts);
      if (a.meter_reading != null) d.prepare(`INSERT INTO meter_readings (asset_id, reading, reading_at, source, recorded_by, created_at) VALUES (?, ?, ?, 'IMPORT', ?, ?)`).run(r.lastInsertRowid, a.meter_reading, ts, ctx.user.id, ts);
      d.prepare(`INSERT INTO asset_status_history (asset_id, from_status, to_status, reason, changed_by, changed_at) VALUES (?, NULL, 'AVAILABLE', 'Imported', ?, ?)`).run(r.lastInsertRowid, ctx.user.id, ts);
      pms.syncAsset(r.lastInsertRowid);
    }
    for (const p of plan.parts) {
      const r = d.prepare(`INSERT INTO parts (part_no, name, description, category, uom, compatibility, supplier_id, unit_cost, min_qty, max_qty, reorder_point, is_critical, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.part_no, p.name, p.category || null, p.uom || 'pc', p.compatibility || null, supplierId(p.supplier),
        p.unit_cost || 0, p.min_qty || 0, p.max_qty, p.reorder_point || 0, /^(y|yes|1|true)$/i.test(p.is_critical || '') ? 1 : 0, ts, ts);
      if (p.opening_qty) {
        inventory.receive(ctx, { part_id: r.lastInsertRowid, store_id: p.store.id, qty: p.opening_qty, unit_cost: p.unit_cost || 0, reference: 'OPENING BALANCE (import)' });
        if (p.bin_location) d.prepare('UPDATE stock_balances SET bin_location = ? WHERE part_id = ? AND store_id = ?').run(p.bin_location, r.lastInsertRowid, p.store.id);
      }
    }
    for (const h of plan.history) {
      const a = d.prepare('SELECT * FROM assets WHERE asset_code = ?').get(h.asset_code);
      const end = manilaToUtc(h.date_completed, '17:00');
      const endIso = end.toISOString();
      const startIso = new Date(end.getTime() - Math.max(h.downtime_hours || h.labor_hours || 1, 0.25) * 3600000).toISOString();
      const woNo = numbering.next(h.wo_type);
      const r = d.prepare(`INSERT INTO work_orders (wo_number, wo_type, source, asset_id, site_id, title, priority, status, requires_shutdown, due_date, original_due_date,
          actual_start, actual_end, returned_to_service_at, work_performed, root_cause_code, failure_mode_code, failed_component, repair_action, completion_remarks,
          closed_by, closed_at, verified_by, verified_at, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, 'IMPORT', ?, ?, ?, ?, 'CLOSED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        woNo, h.wo_type, a.id, a.site_id, h.title, h.wo_type === 'CM' ? h.severity : 'MEDIUM', h.downtime_hours > 0 ? 1 : 0,
        h.wo_type === 'PMS' ? h.date_completed : null, h.wo_type === 'PMS' ? h.date_completed : null, startIso, endIso, h.downtime_hours > 0 ? endIso : null,
        h.work_performed || null, h.root_cause_code || null, h.failure_mode_code || null, h.failed_component || null, h.repair_action || null,
        `Imported history${h.performed_by ? ' – performed by ' + h.performed_by : ''}${h.reference ? ' – ref ' + h.reference : ''}`,
        ctx.user.id, ts, ctx.user.id, ts, ctx.user.id, ts, ctx.user.id, ts);
      const woId = r.lastInsertRowid;
      d.prepare(`INSERT INTO wo_status_history (work_order_id, from_status, to_status, remarks, changed_by, changed_at) VALUES (?, NULL, 'CLOSED', 'Imported historical record', ?, ?)`).run(woId, ctx.user.id, ts);
      if (h.wo_type === 'CM') {
        d.prepare(`INSERT INTO breakdowns (report_no, asset_id, site_id, work_order_id, reported_by, reported_at, occurred_at, category_code, description, impact, severity)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'OTHER', ?, ?, ?)`).run(numbering.next('BREAKDOWN'), a.id, a.site_id, woId, ctx.user.id, startIso, startIso, h.title, h.downtime_hours > 0 ? 'STOPPED' : 'RESTRICTED', h.severity);
      }
      if (h.downtime_hours > 0) {
        d.prepare(`INSERT INTO downtime_events (asset_id, site_id, work_order_id, category, asset_status, reason, start_at, end_at, source, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?)`).run(a.id, a.site_id, woId, h.wo_type === 'CM' ? 'UNPLANNED' : h.wo_type === 'PMS' ? 'PLANNED' : 'OTHER',
          h.wo_type === 'CM' ? 'UNDER_CM' : 'UNDER_PM', `Imported: ${h.title}`, startIso, endIso, ctx.user.id, ts);
      }
      if (h.wo_type === 'PMS') d.prepare('UPDATE assets SET last_pms_date = MAX(COALESCE(last_pms_date, ?), ?) WHERE id = ?').run(h.date_completed, h.date_completed, a.id);
      const costIns = d.prepare(`INSERT INTO cost_entries (work_order_id, asset_id, site_id, category, kind, amount, entry_date, description, reference, source_type, status, created_by, created_at, approved_by, approved_at)
        VALUES (?, ?, ?, ?, 'ACTUAL', ?, ?, ?, ?, 'IMPORT', 'APPROVED', ?, ?, ?, ?)`);
      for (const [f, cat] of [['cost_parts', 'PARTS'], ['cost_labor', 'INTERNAL_LABOR'], ['cost_external', 'EXTERNAL_LABOR']]) {
        if (h[f]) costIns.run(woId, a.id, a.site_id, cat, h[f], h.date_completed, `Imported history ${woNo}`, h.reference || null, ctx.user.id, ts, ctx.user.id, ts);
      }
    }
    audit.log(ctx, 'IMPORT', 'import', null, `Imported ${plan.assets.length} equipment, ${plan.parts.length} parts, ${plan.history.length} history records`);
  });
}

module.exports = { SHEETS, template, parse, validate, commit };
