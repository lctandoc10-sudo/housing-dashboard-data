'use strict';
// Report registry. Every report is a query over recorded data, filtered by date
// range and project/site (plus user site scope), and can be exported to CSV/XLSX.
const ExcelJS = require('exceljs');
const db = require('../db');
const rbac = require('../rbac');
const settings = require('../settings');
const A = require('./analytics');
const { now, today, addDays, manilaDate, HOUR, DAY } = require('../time');
const { notFound } = require('../errors');

const r2 = n => (n == null ? null : Math.round(n * 100) / 100);
const C = (key, label, type = 'text') => ({ key, label, type });

function woScope(user, f, alias = 'w') { return A.scope(user, f, { site: `${alias}.site_id`, asset: `${alias}.asset_id`, category: 'a.category_id', type: `${alias}.wo_type` }); }

const WO_COLS_SQL = `w.id, w.wo_number, w.wo_type, w.status, w.priority, w.title, a.asset_code, a.name AS asset_name, s.name AS site, c.name AS category,
  w.created_at, w.due_date, w.planned_end, w.actual_start, w.actual_end, w.closed_at,
  (SELECT GROUP_CONCAT(u.full_name, ', ') FROM wo_assignees x JOIN users u ON u.id = x.user_id WHERE x.work_order_id = w.id) AS assigned_to`;
const WO_FROM = `FROM work_orders w JOIN assets a ON a.id = w.asset_id JOIN sites s ON s.id = w.site_id JOIN equipment_categories c ON c.id = a.category_id`;

const REPORTS = {
  equipment_master: {
    title: 'Equipment master list', perm: 'asset.view', dated: false,
    columns: [C('asset_code', 'Equipment ID'), C('name', 'Name'), C('category', 'Category'), C('manufacturer', 'Make'), C('model', 'Model'), C('serial_no', 'Serial no.'),
      C('plate_no', 'Plate no.'), C('site', 'Project/site'), C('location', 'Location'), C('criticality', 'Criticality'), C('status', 'Status'),
      C('meter_reading', 'Meter', 'number'), C('commissioning_date', 'Commissioned', 'date'), C('custodian', 'Custodian'), C('last_pms_date', 'Last PMS', 'date'), C('next_pms_due', 'Next PMS due', 'date')],
    run(user, f) {
      const s = A.scope(user, f, { site: 'a.site_id', asset: 'a.id', category: 'a.category_id' });
      return db.get().prepare(`SELECT a.*, c.name category, si.name site, l.name location,
          (SELECT MIN(COALESCE(w.due_date, '9999')) FROM work_orders w JOIN wo_statuses st ON st.code = w.status WHERE w.asset_id = a.id AND w.wo_type = 'PMS' AND st.category IN ('OPEN','HOLD')) AS open_due,
          (SELECT MIN(ps.next_due_date) FROM pms_schedules ps WHERE ps.asset_id = a.id AND ps.is_active = 1) AS sched_due
        FROM assets a JOIN equipment_categories c ON c.id = a.category_id JOIN sites si ON si.id = a.site_id LEFT JOIN locations l ON l.id = a.location_id
        WHERE a.is_archived = 0 AND ${s.where} ORDER BY a.asset_code`).all(s.params).map(r => ({ ...r, next_pms_due: [r.open_due, r.sched_due].filter(x => x && x !== '9999').sort()[0] || null }));
    },
  },
  availability: {
    title: 'Equipment status and availability', perm: 'downtime.view',
    columns: [C('asset_code', 'Equipment ID'), C('name', 'Name'), C('site', 'Site'), C('category', 'Category'), C('status', 'Current status'),
      C('scheduled_h', 'Scheduled h', 'number'), C('qualifying_downtime_h', 'Qualifying downtime h', 'number'), C('availability_pct', 'Availability %', 'number')],
    run(user, f) { return A.availability(user, f).rows; },
    notes(user, f) { const a = A.availability(user, f); return [a.formula, `Fleet availability: ${a.availability_pct ?? 'n/a'}% (${a.scheduled_h} scheduled h, ${a.qualifying_downtime_h} qualifying downtime h)`, ...a.assumptions]; },
  },
  pms_compliance: {
    title: 'PMS schedule and compliance', perm: 'pms.view',
    columns: [C('wo_number', 'WO no.'), C('asset_code', 'Equipment'), C('site', 'Site'), C('title', 'PMS'), C('original_due_date', 'Original due', 'date'), C('due_date', 'Due', 'date'),
      C('reschedule_count', 'Rescheduled', 'number'), C('status', 'Status'), C('completed', 'Completed', 'date'), C('result', 'Compliance result')],
    run(user, f) {
      const comp = A.pmsCompliance(user, f);
      const res = {};
      const labels = { on_time: 'On time', late: 'Late', early: 'Too early', missed: 'Missed', overdue: 'Overdue', pending: 'Pending (within tolerance)', cancelled: 'Cancelled (excluded)' };
      for (const [k, ids] of Object.entries(comp.ids)) for (const id of ids) res[id] = labels[k];
      const s = woScope(user, f); const p = A.period(f);
      return db.get().prepare(`SELECT ${WO_COLS_SQL}, w.original_due_date, w.reschedule_count ${WO_FROM} WHERE w.wo_type = 'PMS' AND w.due_date BETWEEN @from AND @to AND ${s.where} ORDER BY w.due_date`)
        .all({ ...s.params, from: p.from, to: p.to }).map(r => ({ ...r, completed: r.actual_end && r.status === 'CLOSED' ? manilaDate(new Date(r.actual_end)) : null, result: res[r.id] }));
    },
    notes(user, f) { const c = A.pmsCompliance(user, f); return [c.formula, `Compliance: ${c.value == null ? 'n/a' : c.value.toFixed(1) + '%'} (${c.numerator}/${c.denominator})`, `Rescheduled: ${c.rescheduled}`, ...c.exclusions]; },
  },
  overdue_pms: {
    title: 'Overdue PMS monitoring', perm: 'pms.view', dated: false,
    columns: [C('wo_number', 'WO no.'), C('asset_code', 'Equipment'), C('asset_name', 'Name'), C('site', 'Site'), C('title', 'PMS'), C('due_date', 'Due', 'date'),
      C('days_overdue', 'Days overdue', 'number'), C('status', 'Status'), C('assigned_to', 'Assigned to')],
    run(user, f) {
      const s = woScope(user, { ...f, wo_type: null }); const t = today();
      return db.get().prepare(`SELECT ${WO_COLS_SQL} ${WO_FROM} JOIN wo_statuses st ON st.code = w.status WHERE w.wo_type = 'PMS' AND st.category IN ('OPEN','HOLD') AND w.due_date < @t AND ${s.where} ORDER BY w.due_date`)
        .all({ ...s.params, t }).map(r => ({ ...r, days_overdue: Math.round((Date.parse(t) - Date.parse(r.due_date)) / DAY) }));
    },
  },
  cm_register: {
    title: 'Corrective maintenance register', perm: 'wo.view',
    columns: [C('wo_number', 'WO no.'), C('report_no', 'Breakdown no.'), C('created_at', 'Reported', 'datetime'), C('asset_code', 'Equipment'), C('site', 'Site'), C('title', 'Description'),
      C('severity', 'Severity'), C('priority', 'Priority'), C('status', 'Status'), C('root_cause', 'Root cause'), C('repair_action', 'Repair action'), C('actual_end', 'Repair completed', 'datetime'), C('closed_at', 'Closed', 'datetime')],
    run(user, f) {
      const s = woScope(user, f); const p = A.period(f);
      return db.get().prepare(`SELECT ${WO_COLS_SQL}, b.report_no, b.severity, fc.label root_cause, w.repair_action ${WO_FROM}
        LEFT JOIN breakdowns b ON b.work_order_id = w.id LEFT JOIN failure_codes fc ON fc.kind = 'ROOT_CAUSE' AND fc.code = w.root_cause_code
        WHERE w.wo_type = 'CM' AND w.created_at >= @start AND w.created_at < @end AND ${s.where} ORDER BY w.created_at DESC`).all({ ...s.params, start: p.startIso, end: p.endIso });
    },
  },
  breakdown_history: {
    title: 'Breakdown history', perm: 'wo.view',
    columns: [C('report_no', 'Report no.'), C('wo_number', 'WO no.'), C('reported_at', 'Reported', 'datetime'), C('occurred_at', 'Occurred', 'datetime'), C('asset_code', 'Equipment'),
      C('site', 'Site'), C('category', 'Breakdown category'), C('severity', 'Severity'), C('impact', 'Impact'), C('description', 'Description'), C('root_cause', 'Root cause'),
      C('failure_mode', 'Failure mode'), C('failed_component', 'Failed component'), C('downtime_h', 'Downtime h', 'number'), C('status', 'WO status'), C('valid', 'Counted as failure')],
    run(user, f) {
      const s = A.scope(user, f, { site: 'b.site_id', asset: 'b.asset_id', category: 'a.category_id' }); const p = A.period(f);
      return db.get().prepare(`SELECT b.*, w.wo_number, w.status, w.failed_component, a.asset_code, si.name site, bc.label category, rc.label root_cause, fm.label failure_mode,
          (SELECT ROUND(SUM((julianday(COALESCE(e.end_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(e.start_at)) * 24), 2) FROM downtime_events e WHERE e.work_order_id = w.id AND e.is_void = 0) downtime_h,
          CASE WHEN b.is_failure = 1 THEN 'Yes' ELSE 'No (invalid)' END valid
        FROM breakdowns b JOIN work_orders w ON w.id = b.work_order_id JOIN assets a ON a.id = b.asset_id JOIN sites si ON si.id = b.site_id
        LEFT JOIN failure_codes bc ON bc.kind = 'BREAKDOWN_CATEGORY' AND bc.code = b.category_code
        LEFT JOIN failure_codes rc ON rc.kind = 'ROOT_CAUSE' AND rc.code = w.root_cause_code LEFT JOIN failure_codes fm ON fm.kind = 'FAILURE_MODE' AND fm.code = w.failure_mode_code
        WHERE b.reported_at >= @start AND b.reported_at < @end AND ${s.where} ORDER BY b.reported_at DESC`).all({ ...s.params, start: p.startIso, end: p.endIso });
    },
  },
  breakdown_frequency: {
    title: 'Breakdown frequency by equipment and site', perm: 'wo.view',
    columns: [C('site', 'Site'), C('asset_code', 'Equipment'), C('name', 'Name'), C('category', 'Category'), C('breakdowns', 'Breakdowns', 'number'), C('stopped', 'Equipment stopped', 'number'), C('critical', 'Critical', 'number')],
    run(user, f) {
      const s = A.scope(user, f, { site: 'b.site_id', asset: 'b.asset_id', category: 'a.category_id' }); const p = A.period(f);
      return db.get().prepare(`SELECT si.name site, a.asset_code, a.name, c.name category, COUNT(*) breakdowns, SUM(b.impact = 'STOPPED') stopped, SUM(b.severity = 'CRITICAL') critical
        FROM breakdowns b JOIN assets a ON a.id = b.asset_id JOIN sites si ON si.id = b.site_id JOIN equipment_categories c ON c.id = a.category_id
        WHERE b.is_failure = 1 AND b.reported_at >= @start AND b.reported_at < @end AND ${s.where} GROUP BY b.site_id, b.asset_id ORDER BY breakdowns DESC`).all({ ...s.params, start: p.startIso, end: p.endIso });
    },
  },
  downtime: {
    title: 'Downtime monitoring', perm: 'downtime.view',
    columns: [C('asset_code', 'Equipment'), C('site', 'Site'), C('category', 'Downtime type'), C('asset_status', 'Status'), C('reason', 'Reason'), C('wo_number', 'WO no.'),
      C('start_at', 'Start', 'datetime'), C('end_at', 'End', 'datetime'), C('hours_in_period', 'Hours in period', 'number'), C('source', 'Source')],
    run(user, f) {
      const s = A.scope(user, f, { site: 'e.site_id', asset: 'e.asset_id', category: 'a.category_id' }); const p = A.period(f);
      const nowMs = now().getTime();
      return db.get().prepare(`SELECT e.*, a.asset_code, si.name site, w.wo_number FROM downtime_events e JOIN assets a ON a.id = e.asset_id JOIN sites si ON si.id = e.site_id LEFT JOIN work_orders w ON w.id = e.work_order_id
        WHERE e.is_void = 0 AND e.start_at < @end AND (e.end_at IS NULL OR e.end_at > @start) AND ${s.where} ORDER BY e.start_at`).all({ ...s.params, start: p.startIso, end: p.endIso })
        .map(e => ({ ...e, hours_in_period: r2((Math.min(e.end_at ? Date.parse(e.end_at) : nowMs, p.endMs) - Math.max(Date.parse(e.start_at), p.startMs)) / HOUR) }));
    },
    notes(user, f) { const d = A.downtimeHours(user, f); return [`Total elapsed downtime (overlaps merged per asset): ${r2(d.total_h)} h`, 'Hours in period are clipped to the reporting period; open events are counted to now.']; },
  },
  work_orders: {
    title: 'Open and closed work orders', perm: 'wo.view',
    columns: [C('wo_number', 'WO no.'), C('wo_type', 'Type'), C('asset_code', 'Equipment'), C('site', 'Site'), C('title', 'Description'), C('priority', 'Priority'), C('status', 'Status'),
      C('created_at', 'Created', 'datetime'), C('due_date', 'Due', 'date'), C('planned_end', 'Target', 'datetime'), C('closed_at', 'Closed', 'datetime'), C('assigned_to', 'Assigned to')],
    run(user, f) {
      const s = woScope(user, f); const p = A.period(f);
      return db.get().prepare(`SELECT ${WO_COLS_SQL} ${WO_FROM} JOIN wo_statuses st ON st.code = w.status
        WHERE ((w.created_at >= @start AND w.created_at < @end) OR (w.closed_at >= @start AND w.closed_at < @end) OR (st.category IN ('OPEN','HOLD') AND w.created_at < @end)) AND ${s.where}
        ORDER BY w.created_at DESC`).all({ ...s.params, start: p.startIso, end: p.endIso });
    },
    notes(user, f) { const c = A.closureRate(user, f); return [c.formula, `Closure rate: ${c.value == null ? 'n/a' : c.value.toFixed(1) + '%'} (${c.numerator}/${c.denominator})`]; },
  },
  wo_aging: {
    title: 'Work order aging', perm: 'wo.view', dated: false,
    columns: [C('wo_number', 'WO no.'), C('wo_type', 'Type'), C('asset_code', 'Equipment'), C('priority', 'Priority'), C('status', 'Status'), C('created_at', 'Created', 'datetime'), C('age_days', 'Age (days)', 'number'), C('aging_bucket', 'Bucket')],
    run(user, f) {
      return A.backlog(user, f).rows.map(r => ({ ...r, aging_bucket: r.age_days <= 7 ? '0-7 d' : r.age_days <= 30 ? '8-30 d' : r.age_days <= 90 ? '31-90 d' : '> 90 d' }));
    },
  },
  mttr: {
    title: 'Mean Time to Repair (MTTR)', perm: 'kpi.view',
    columns: [C('asset_code', 'Equipment'), C('name', 'Name'), C('site', 'Site'), C('repairs', 'Closed repairs', 'number'), C('repair_h', 'Total repair h', 'number'), C('mttr_h', 'MTTR h', 'number'),
      C('labor_h', 'Labor person-h', 'number'), C('downtime_h', 'Equipment downtime h', 'number')],
    run(user, f) {
      const p = A.period(f); const s = woScope(user, { ...f, wo_type: null });
      return db.get().prepare(`SELECT a.asset_code, a.name, si.name site, COUNT(*) repairs,
          ROUND(SUM((julianday(w.actual_end) - julianday(w.actual_start)) * 24), 2) repair_h,
          ROUND(AVG((julianday(w.actual_end) - julianday(w.actual_start)) * 24), 2) mttr_h,
          ROUND(SUM((SELECT COALESCE(SUM(hours),0) FROM labor_entries l WHERE l.work_order_id = w.id AND l.is_void = 0)), 2) labor_h,
          ROUND(SUM((SELECT COALESCE(SUM((julianday(COALESCE(e.end_at, w.returned_to_service_at)) - julianday(e.start_at)) * 24),0) FROM downtime_events e WHERE e.work_order_id = w.id AND e.is_void = 0)), 2) downtime_h
        FROM work_orders w JOIN assets a ON a.id = w.asset_id JOIN sites si ON si.id = w.site_id
        WHERE w.wo_type = 'CM' AND w.status = 'CLOSED' AND w.actual_start IS NOT NULL AND w.actual_end >= @start AND w.actual_end < @end AND ${s.where}
        GROUP BY a.id ORDER BY mttr_h DESC`).all({ ...s.params, start: p.startIso, end: p.endIso });
    },
    notes(user, f) { const m = A.mttr(user, f); return [m.formula, `Overall MTTR: ${m.value == null ? 'n/a' : m.value.toFixed(2) + ' h'} over ${m.denominator} repairs; mean labor ${m.mean_labor_h == null ? 'n/a' : m.mean_labor_h.toFixed(2)} person-h; mean downtime ${m.mean_downtime_h == null ? 'n/a' : m.mean_downtime_h.toFixed(2)} h`, ...m.exclusions]; },
  },
  mtbf: {
    title: 'Mean Time Between Failures (MTBF)', perm: 'kpi.view',
    columns: [C('asset_code', 'Equipment'), C('name', 'Name'), C('site', 'Site'), C('operating_h', 'Operating h', 'number'), C('failures', 'Failures', 'number'), C('mtbf_h', 'MTBF h', 'number')],
    run(user, f) {
      const p = A.period(f);
      const cats = new Set(['PLANNED', 'UNPLANNED', 'WAITING_PARTS', 'EXTERNAL', 'OTHER']);
      const fails = db.get().prepare(`SELECT asset_id, COUNT(*) n FROM breakdowns WHERE is_failure = 1 AND impact = 'STOPPED' AND COALESCE(occurred_at, reported_at) >= ? AND COALESCE(occurred_at, reported_at) < ? GROUP BY asset_id`)
        .all(p.startIso, p.endIso).reduce((m, r) => (m[r.asset_id] = r.n, m), {});
      return A.scopedAssets(user, f).map(a => {
        const r = A.assetAvailability(a, p, cats); const op = r.scheduled_h - r.qualifying_h; const n = fails[a.id] || 0;
        return { asset_code: a.asset_code, name: a.name, site: a.site_name, operating_h: r2(op), failures: n, mtbf_h: n ? r2(op / n) : null };
      }).sort((x, y) => y.failures - x.failures);
    },
    notes(user, f) { const m = A.mtbf(user, f); return [m.formula, `Fleet MTBF: ${m.value == null ? (m.note || 'n/a') : m.value.toFixed(1) + ' h'} (${r2(m.numerator)} operating h / ${m.denominator} failures)`, ...m.exclusions]; },
  },
  cost_per_equipment: {
    title: 'Maintenance cost per equipment', perm: 'cost.view',
    columns: [C('asset_code', 'Equipment'), C('name', 'Name'), C('site', 'Site'), C('category', 'Category'), C('PARTS', 'Parts', 'money'), C('INTERNAL_LABOR', 'Internal labor', 'money'),
      C('EXTERNAL_LABOR', 'External labor', 'money'), C('THIRD_PARTY_SERVICE', 'Third-party service', 'money'), C('RENTAL', 'Rental', 'money'), C('OTHER', 'Other', 'money'), C('total', 'Total', 'money'), C('wo_count', 'Work orders', 'number')],
    run(user, f) {
      const p = A.period(f); const s = A.scope(user, f, { site: 'ce.site_id', asset: 'ce.asset_id', category: 'a.category_id' });
      const rows = db.get().prepare(`SELECT a.id, a.asset_code, a.name, si.name site, c.name category, ce.category cc, SUM(ce.amount) amt, COUNT(DISTINCT ce.work_order_id) wos
        FROM cost_entries ce JOIN assets a ON a.id = ce.asset_id JOIN sites si ON si.id = ce.site_id JOIN equipment_categories c ON c.id = a.category_id
        WHERE ce.kind = 'ACTUAL' AND ce.status IN ('APPROVED','PENDING') AND ce.entry_date BETWEEN @from AND @to AND ${s.where} GROUP BY a.id, si.id, ce.category`).all({ ...s.params, from: p.from, to: p.to });
      const m = {};
      for (const r of rows) {
        const k = `${r.id}:${r.site}`;
        const o = m[k] = m[k] || { asset_code: r.asset_code, name: r.name, site: r.site, category: r.category, total: 0, wo_count: 0 };
        o[r.cc] = r2((o[r.cc] || 0) + r.amt); o.total = r2(o.total + r.amt); o.wo_count = Math.max(o.wo_count, r.wos);
      }
      return Object.values(m).sort((a, b) => b.total - a.total);
    },
    notes() { return ['Actual cost entries (approved and pending approval). Parts and internal labor are generated from inventory issues/returns and labor entries, each costed once.']; },
  },
  cost_analysis: {
    title: 'Maintenance cost analysis', perm: 'cost.view', params: [{ key: 'group_by', label: 'Group by', options: ['site', 'category', 'wo_type', 'month', 'cost_category', 'asset'] }],
    columns: [C('group', 'Group'), C('kind', 'Estimate / actual'), C('PARTS', 'Parts', 'money'), C('INTERNAL_LABOR', 'Internal labor', 'money'), C('EXTERNAL_LABOR', 'External labor', 'money'),
      C('THIRD_PARTY_SERVICE', 'Third-party service', 'money'), C('RENTAL', 'Rental', 'money'), C('OTHER', 'Other', 'money'), C('total', 'Total', 'money')],
    run(user, f) {
      const p = A.period(f); const s = A.scope(user, f, { site: 'ce.site_id', asset: 'ce.asset_id', category: 'a.category_id', type: 'w.wo_type' });
      const g = { site: 'si.name', category: 'c.name', wo_type: "COALESCE(w.wo_type, 'No WO')", month: 'substr(ce.entry_date, 1, 7)', cost_category: 'ce.category', asset: "a.asset_code || ' ' || a.name" }[f.group_by] || 'si.name';
      const rows = db.get().prepare(`SELECT ${g} grp, ce.kind, ce.category cc, SUM(ce.amount) amt FROM cost_entries ce JOIN assets a ON a.id = ce.asset_id JOIN sites si ON si.id = ce.site_id
        JOIN equipment_categories c ON c.id = a.category_id LEFT JOIN work_orders w ON w.id = ce.work_order_id
        WHERE ce.status IN ('APPROVED','PENDING') AND ce.entry_date BETWEEN @from AND @to AND ${s.where} GROUP BY grp, ce.kind, ce.category ORDER BY grp`).all({ ...s.params, from: p.from, to: p.to });
      const m = {};
      for (const r of rows) { const k = `${r.grp}|${r.kind}`; const o = m[k] = m[k] || { group: r.grp, kind: r.kind, total: 0 }; o[r.cc] = r2((o[r.cc] || 0) + r.amt); o.total = r2(o.total + r.amt); }
      return Object.values(m);
    },
  },
  finance_export: {
    title: 'Approved maintenance costs (finance export)', perm: 'cost.export',
    columns: [C('id', 'Entry ID', 'number'), C('entry_date', 'Date', 'date'), C('site', 'Project/site'), C('asset_code', 'Equipment'), C('wo_number', 'WO no.'), C('wo_type', 'WO type'),
      C('category', 'Cost category'), C('description', 'Description'), C('vendor', 'Vendor'), C('reference', 'Reference'), C('amount', 'Amount (PHP)', 'money'), C('source_type', 'Source'), C('approved_by', 'Approved by'), C('approved_at', 'Approved at', 'datetime')],
    run(user, f) {
      const p = A.period(f); const s = A.scope(user, f, { site: 'ce.site_id', asset: 'ce.asset_id', category: 'a.category_id', type: 'w.wo_type' });
      return db.get().prepare(`SELECT ce.*, si.name site, a.asset_code, w.wo_number, w.wo_type, u.full_name approved_by FROM cost_entries ce JOIN assets a ON a.id = ce.asset_id JOIN sites si ON si.id = ce.site_id
        LEFT JOIN work_orders w ON w.id = ce.work_order_id LEFT JOIN users u ON u.id = ce.approved_by
        WHERE ce.kind = 'ACTUAL' AND ce.status = 'APPROVED' AND ce.entry_date BETWEEN @from AND @to AND ${s.where} ORDER BY ce.entry_date, ce.id`).all({ ...s.params, from: p.from, to: p.to });
    },
  },
  parts_consumption: {
    title: 'Spare-parts consumption', perm: 'inventory.view', params: [{ key: 'group_by', label: 'Group by', options: ['equipment', 'site', 'part'] }],
    columns: [C('group', 'Equipment / site'), C('part_no', 'Part no.'), C('part_name', 'Part'), C('uom', 'UoM'), C('qty_issued', 'Issued', 'number'), C('qty_returned', 'Returned', 'number'), C('net_qty', 'Net consumed', 'number'), C('value', 'Value (PHP)', 'money')],
    run(user, f) {
      const p = A.period(f); const s = A.scope(user, f, { site: 't.site_id', asset: 't.asset_id', category: 'a.category_id' });
      const g = f.group_by === 'site' ? 'si.name' : f.group_by === 'part' ? "'All'" : "a.asset_code || ' ' || a.name";
      return db.get().prepare(`SELECT ${g} AS "group", pt.part_no, pt.name part_name, pt.uom, SUM(CASE WHEN t.txn_type = 'ISSUE' THEN -t.qty ELSE 0 END) qty_issued,
          SUM(CASE WHEN t.txn_type = 'RETURN' THEN t.qty ELSE 0 END) qty_returned, -SUM(t.qty) net_qty, ROUND(-SUM(t.total_cost), 2) value
        FROM inventory_transactions t JOIN parts pt ON pt.id = t.part_id JOIN assets a ON a.id = t.asset_id JOIN sites si ON si.id = t.site_id
        WHERE t.status = 'POSTED' AND t.txn_type IN ('ISSUE','RETURN') AND t.created_at >= @start AND t.created_at < @end AND ${s.where}
        GROUP BY "group", pt.id ORDER BY value DESC`).all({ ...s.params, start: p.startIso, end: p.endIso });
    },
  },
  low_stock: {
    title: 'Low-stock and reorder monitoring', perm: 'inventory.view', dated: false,
    columns: [C('part_no', 'Part no.'), C('name', 'Part'), C('is_critical', 'Critical'), C('uom', 'UoM'), C('on_hand', 'On hand', 'number'), C('reserved', 'Reserved', 'number'),
      C('min_qty', 'Minimum', 'number'), C('reorder_point', 'Reorder point', 'number'), C('max_qty', 'Maximum', 'number'), C('on_order', 'On order (PR)', 'number'), C('suggested', 'Suggested order', 'number'), C('state', 'State')],
    run(user, f) {
      return stockRows(user, f).filter(r => r.on_hand <= r.reorder_point || r.on_hand < r.min_qty).map(r => ({
        ...r, suggested: Math.max(0, (r.max_qty || r.reorder_point * 2 || r.min_qty) - r.on_hand - r.on_order),
        state: r.on_hand < r.min_qty ? 'Below minimum' : 'At/below reorder point',
      }));
    },
  },
  stock_on_hand: {
    title: 'Stock on hand and inventory valuation', perm: 'inventory.view', dated: false,
    columns: [C('part_no', 'Part no.'), C('name', 'Part'), C('category', 'Category'), C('is_critical', 'Critical'), C('uom', 'UoM'), C('on_hand', 'On hand', 'number'), C('reserved', 'Reserved', 'number'),
      C('available', 'Available', 'number'), C('unit_cost', 'Avg unit cost', 'money'), C('value', 'Value (PHP)', 'money')],
    run(user, f) { return stockRows(user, f); },
    notes(user, f) { const v = stockRows(user, f).reduce((t, r) => t + (r.value || 0), 0); return [`Total inventory value: ₱${r2(v).toLocaleString('en-PH')} (moving average cost)`]; },
  },
  critical_spares: {
    title: 'Critical spare-parts availability', perm: 'inventory.view', dated: false,
    columns: [C('part_no', 'Part no.'), C('name', 'Part'), C('compatibility', 'Equipment compatibility'), C('on_hand', 'On hand', 'number'), C('available', 'Available', 'number'), C('min_qty', 'Minimum', 'number'), C('state', 'State')],
    run(user, f) { return stockRows(user, f).filter(r => r.is_critical === 'Yes').map(r => ({ ...r, state: r.available <= 0 ? 'NOT AVAILABLE' : r.on_hand < r.min_qty ? 'Below minimum' : 'OK' })); },
  },
  slow_moving: {
    title: 'Slow-moving and unused inventory', perm: 'inventory.view', params: [{ key: 'days', label: 'No movement for (days)', options: ['90', '180', '365'] }], dated: false,
    columns: [C('part_no', 'Part no.'), C('name', 'Part'), C('on_hand', 'On hand', 'number'), C('value', 'Value (PHP)', 'money'), C('last_issue', 'Last issue', 'datetime'), C('days_since', 'Days since issue', 'number')],
    run(user, f) {
      const days = Number(f.days || 180);
      const last = db.get().prepare(`SELECT part_id, MAX(created_at) d FROM inventory_transactions WHERE txn_type = 'ISSUE' AND status = 'POSTED' GROUP BY part_id`).all().reduce((m, r) => (m[r.part_id] = r.d, m), {});
      const nowMs = now().getTime();
      return stockRows(user, f).filter(r => r.on_hand > 0).map(r => ({ ...r, last_issue: last[r.id] || null, days_since: last[r.id] ? Math.floor((nowMs - Date.parse(last[r.id])) / DAY) : null }))
        .filter(r => r.days_since == null || r.days_since >= days).sort((a, b) => (b.value || 0) - (a.value || 0));
    },
  },
  repeat_breakdowns: {
    title: 'Repeat breakdown analysis', perm: 'wo.view',
    columns: [C('asset_code', 'Equipment'), C('name', 'Name'), C('site', 'Site'), C('breakdowns', 'Breakdowns', 'number'), C('root_causes', 'Root causes'), C('components', 'Failed components'),
      C('first', 'First', 'datetime'), C('last', 'Last', 'datetime'), C('avg_interval_days', 'Avg days between', 'number'), C('investigation', 'Investigation')],
    run(user, f) {
      const p = A.period(f); const s = A.scope(user, f, { site: 'b.site_id', asset: 'b.asset_id', category: 'a.category_id' });
      return db.get().prepare(`SELECT a.asset_code, a.name, si.name site, COUNT(*) breakdowns, GROUP_CONCAT(DISTINCT rc.label) root_causes, GROUP_CONCAT(DISTINCT w.failed_component) components,
          MIN(b.reported_at) first, MAX(b.reported_at) last,
          (SELECT GROUP_CONCAT(DISTINCT fi.inv_no) FROM failure_investigations fi WHERE fi.asset_id = a.id) investigation
        FROM breakdowns b JOIN work_orders w ON w.id = b.work_order_id JOIN assets a ON a.id = b.asset_id JOIN sites si ON si.id = b.site_id
        LEFT JOIN failure_codes rc ON rc.kind = 'ROOT_CAUSE' AND rc.code = w.root_cause_code
        WHERE b.is_failure = 1 AND b.reported_at >= @start AND b.reported_at < @end AND ${s.where} GROUP BY a.id HAVING COUNT(*) >= 2 ORDER BY breakdowns DESC`)
        .all({ ...s.params, start: p.startIso, end: p.endIso }).map(r => ({ ...r, avg_interval_days: r2((Date.parse(r.last) - Date.parse(r.first)) / DAY / (r.breakdowns - 1)) }));
    },
  },
  monthly_performance: {
    title: 'Monthly maintenance performance report', perm: 'kpi.view',
    columns: [C('month', 'Month'), C('availability_pct', 'Availability %', 'number'), C('pms_compliance_pct', 'PMS compliance %', 'number'), C('pms_due', 'PMS due', 'number'),
      C('breakdowns', 'Breakdowns', 'number'), C('downtime_h', 'Downtime h', 'number'), C('mttr_h', 'MTTR h', 'number'), C('mtbf_h', 'MTBF h', 'number'), C('closure_rate_pct', 'Closure rate %', 'number'), C('cost', 'Cost (PHP)', 'money')],
    run(user, f) {
      const p = A.period(f); const rows = [];
      let m = p.from.slice(0, 7) + '-01';
      while (m <= p.to) {
        const end = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
        const ff = { ...f, from: m < p.from ? p.from : m, to: end > p.to ? p.to : end };
        if (ff.from > today()) break;
        const comp = A.pmsCompliance(user, ff), mt = A.mttr(user, ff), mb = A.mtbf(user, ff), cr = A.closureRate(user, ff);
        const s = A.scope(user, ff, { site: 'b.site_id', asset: 'b.asset_id', category: 'a.category_id' }); const pp = A.period(ff);
        const bd = db.get().prepare(`SELECT COUNT(*) n FROM breakdowns b JOIN assets a ON a.id = b.asset_id WHERE b.is_failure = 1 AND b.reported_at >= @start AND b.reported_at < @end AND ${s.where}`).get({ ...s.params, start: pp.startIso, end: pp.endIso }).n;
        rows.push({ month: m.slice(0, 7), availability_pct: A.availability(user, ff).availability_pct, pms_compliance_pct: r2(comp.value), pms_due: comp.denominator, breakdowns: bd,
          downtime_h: r2(A.downtimeHours(user, ff).total_h), mttr_h: r2(mt.value), mtbf_h: r2(mb.value), closure_rate_pct: r2(cr.value), cost: rbac.can(user, 'cost.view') ? r2(A.costTotals(user, ff).total) : null });
        m = addDays(end, 1);
      }
      return rows;
    },
  },
  backlog: {
    title: 'Maintenance backlog and recovery plan', perm: 'wo.view', dated: false,
    columns: [C('wo_number', 'WO no.'), C('wo_type', 'Type'), C('asset_code', 'Equipment'), C('priority', 'Priority'), C('status', 'Status'), C('age_days', 'Age (days)', 'number'),
      C('est_labor_hours', 'Est. labor h', 'number'), C('due_date', 'Due', 'date'), C('planned_end', 'Target recovery', 'datetime'), C('parts_outstanding', 'Parts outstanding', 'number'), C('open_prs', 'Open PRs', 'number')],
    run(user, f) {
      const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return A.backlog(user, f).rows.sort((a, b) => order[a.priority] - order[b.priority] || b.age_days - a.age_days);
    },
    notes(user, f) { const b = A.backlog(user, f); return [`Open work orders: ${b.count}; estimated labor ${r2(b.est_labor_h)} h; waiting for parts ${b.waiting_parts}; with outstanding parts/PRs ${b.with_outstanding_parts}`, `Aging: ${Object.entries(b.aging).map(([k, v]) => `${k}: ${v}`).join(', ')}`]; },
  },
};

function stockRows(user, f) {
  const params = {};
  const sf = f.site_id ? 'st.site_id = @site' : rbac.siteFilter(user, 'st.site_id', params);
  if (f.site_id) params.site = Number(f.site_id);
  return db.get().prepare(`SELECT p.id, p.part_no, p.name, p.category, p.uom, p.compatibility, p.unit_cost, p.min_qty, p.max_qty, p.reorder_point,
      CASE WHEN p.is_critical = 1 THEN 'Yes' ELSE 'No' END is_critical,
      COALESCE(SUM(CASE WHEN ${sf} THEN b.qty_on_hand END), 0) on_hand, COALESCE(SUM(CASE WHEN ${sf} THEN b.qty_reserved END), 0) reserved,
      (SELECT COALESCE(SUM(pr.qty - pr.qty_received),0) FROM purchase_requests pr WHERE pr.part_id = p.id AND pr.status IN ('SUBMITTED','APPROVED','ORDERED','PARTIAL')) on_order
    FROM parts p LEFT JOIN stock_balances b ON b.part_id = p.id LEFT JOIN stores st ON st.id = b.store_id WHERE p.is_active = 1 GROUP BY p.id ORDER BY p.part_no`).all(params)
    .map(r => ({ ...r, available: r.on_hand - r.reserved, value: r2(r.on_hand * r.unit_cost) }));
}

function list(user) {
  return Object.entries(REPORTS).filter(([, r]) => rbac.can(user, r.perm)).map(([id, r]) => ({ id, title: r.title, dated: r.dated !== false, params: r.params || [] }));
}

function run(user, id, f) {
  const r = REPORTS[id];
  if (!r) throw notFound('Report');
  rbac.require(user, r.perm);
  if (f.site_id) rbac.requireSite(user, f.site_id);
  const p = A.period(f);
  let columns = r.columns;
  if (!rbac.can(user, 'cost.view')) columns = columns.filter(c => c.type !== 'money' || ['inventory.view'].includes(r.perm));
  return { id, title: r.title, period: r.dated === false ? null : { from: p.from, to: p.to }, columns, rows: r.run(user, f), notes: r.notes ? r.notes(user, f) : [], generated_at: now().toISOString() };
}

function fmt(v, type) {
  if (v == null) return '';
  if (type === 'datetime') return new Date(v).toLocaleString('en-PH', { timeZone: 'Asia/Manila', hour12: false });
  return v;
}

function toCsv(rep) {
  const esc = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) && isNaN(Number(s)) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  const lines = [rep.columns.map(c => esc(c.label)).join(',')];
  for (const row of rep.rows) lines.push(rep.columns.map(c => esc(fmt(row[c.key], c.type))).join(','));
  return '﻿' + lines.join('\r\n');
}

async function toXlsx(rep, filtersLabel) {
  const wb = new ExcelJS.Workbook();
  wb.creator = settings.get('company_name');
  const ws = wb.addWorksheet(rep.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([rep.title]).font = { bold: true, size: 14 };
  ws.addRow([settings.get('company_name')]);
  ws.addRow([`Generated ${fmt(rep.generated_at, 'datetime')} (Asia/Manila)${rep.period ? ` · Period ${rep.period.from} to ${rep.period.to}` : ''}${filtersLabel ? ' · ' + filtersLabel : ''}`]);
  for (const n of rep.notes) ws.addRow([n]).font = { italic: true, color: { argb: 'FF555555' } };
  ws.addRow([]);
  const header = ws.addRow(rep.columns.map(c => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }; });
  for (const row of rep.rows) {
    ws.addRow(rep.columns.map(c => {
      const v = row[c.key];
      if (v == null) return null;
      if (c.type === 'datetime') return fmt(v, 'datetime');
      if ((c.type === 'number' || c.type === 'money') && typeof v === 'number') return v;
      return v;
    }));
  }
  rep.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(45, Math.max(10, c.label.length + 2));
    if (c.type === 'money') col.numFmt = '#,##0.00';
  });
  ws.views = [{ state: 'frozen', ySplit: header.number }];
  return wb.xlsx.writeBuffer();
}

module.exports = { REPORTS, list, run, toCsv, toXlsx, stockRows };
