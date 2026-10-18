'use strict';
// KPI and availability calculations. Every figure is computed from recorded data
// and returned with its numerator, denominator, formula and exclusions so the
// dashboard can show how it was derived and drill down to the underlying records.
const db = require('../db');
const rbac = require('../rbac');
const settings = require('../settings');
const { now, today, addDays, manilaToUtc, isDate, isoWeekday, HOUR, DAY, manilaDate } = require('../time');
const { bad } = require('../errors');

const UP = ['AVAILABLE', 'OPERATIONAL', 'STANDBY'];
const MAINT = ['UNDER_PM', 'UNDER_CM', 'WAITING_PARTS', 'WAITING_EXTERNAL', 'FOR_TESTING'];
const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

// ---------------------------------------------------------------- interval math (ms epoch pairs)
function merge(iv) {
  const s = iv.filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of s) {
    if (out.length && x[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}
function intersect(a, b) {
  const out = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}
function subtract(a, b) {
  const out = [];
  for (const [s0, e0] of a) {
    let cur = [[s0, e0]];
    for (const [s, e] of b) {
      const next = [];
      for (const [cs, ce] of cur) {
        if (e <= cs || s >= ce) { next.push([cs, ce]); continue; }
        if (s > cs) next.push([cs, s]);
        if (e < ce) next.push([e, ce]);
      }
      cur = next;
    }
    out.push(...cur);
  }
  return out;
}
const total = iv => iv.reduce((t, x) => t + (x[1] - x[0]), 0);

// ---------------------------------------------------------------- periods & filters
function period(f = {}) {
  const to = f.to && isDate(f.to) ? f.to : today();
  const from = f.from && isDate(f.from) ? f.from : addDays(to, -29);
  if (from > to) throw bad('Start date must be on or before end date');
  const startMs = manilaToUtc(from).getTime();
  const endMs = Math.min(manilaToUtc(addDays(to, 1)).getTime(), now().getTime());
  return { from, to, startMs, endMs: Math.max(endMs, startMs), startIso: new Date(startMs).toISOString(), endIso: new Date(Math.max(endMs, startMs)).toISOString() };
}

/** WHERE fragment + params for user scope and dashboard filters. cols: { site, asset, category, type } */
function scope(user, f, cols) {
  const params = {};
  const parts = [rbac.siteFilter(user, cols.site, params)];
  if (f.site_id) { parts.push(`${cols.site} = @f_site`); params.f_site = Number(f.site_id); }
  if (f.asset_id && cols.asset) { parts.push(`${cols.asset} = @f_asset`); params.f_asset = Number(f.asset_id); }
  if (f.category_id && cols.category) { parts.push(`${cols.category} = @f_cat`); params.f_cat = Number(f.category_id); }
  if (f.wo_type && cols.type) { parts.push(`${cols.type} = @f_type`); params.f_type = f.wo_type; }
  return { where: parts.join(' AND '), params };
}

// ---------------------------------------------------------------- availability
function operatingWindows(site, startMs, endMs) {
  const days = new Set(String(site.op_days || '').split(',').map(Number));
  const out = [];
  let day = manilaDate(new Date(startMs));
  const last = manilaDate(new Date(endMs));
  while (day <= last) {
    if (days.has(isoWeekday(day))) {
      const s = manilaToUtc(day, site.op_start).getTime();
      const e = site.op_end === '24:00' ? manilaToUtc(addDays(day, 1)).getTime() : manilaToUtc(day, site.op_end).getTime();
      out.push([Math.max(s, startMs), Math.min(e, endMs)]);
    }
    day = addDays(day, 1);
  }
  return merge(out);
}

function decommissionedIntervals(assetId, endMs) {
  const hist = db.get().prepare('SELECT to_status, changed_at FROM asset_status_history WHERE asset_id = ? ORDER BY changed_at, id').all(assetId);
  const out = []; let start = null;
  for (const h of hist) {
    const t = Date.parse(h.changed_at);
    if (h.to_status === 'DECOMMISSIONED' && start == null) start = t;
    else if (h.to_status !== 'DECOMMISSIONED' && start != null) { out.push([start, t]); start = null; }
  }
  if (start != null) out.push([start, endMs]);
  return out;
}

function qualifyingCategories() {
  const cats = new Set(settings.get('availability_categories'));
  if (settings.get('availability_include_planned')) cats.add('PLANNED'); else cats.delete('PLANNED');
  return cats;
}

/** Availability for one asset (with joined site schedule columns). */
function assetAvailability(a, p, cats) {
  let startMs = p.startMs;
  if (a.commissioning_date) startMs = Math.max(startMs, manilaToUtc(a.commissioning_date).getTime());
  const createdMs = Date.parse(a.created_at);
  if (!a.commissioning_date && createdMs > startMs) startMs = Math.min(createdMs, p.endMs);
  const endMs = p.endMs;
  if (endMs <= startMs) return { scheduled_h: 0, qualifying_h: 0, downtime_h: 0, by_category: {}, availability: null };
  const windows = subtract(operatingWindows(a, startMs, endMs), decommissionedIntervals(a.id, endMs));
  const events = db.get().prepare(`SELECT category, start_at, end_at FROM downtime_events
    WHERE asset_id = ? AND is_void = 0 AND start_at < ? AND (end_at IS NULL OR end_at > ?)`).all(a.id, new Date(endMs).toISOString(), new Date(startMs).toISOString());
  const nowMs = now().getTime();
  const byCatIv = {};
  for (const e of events) {
    const s = Math.max(Date.parse(e.start_at), startMs), en = Math.min(e.end_at ? Date.parse(e.end_at) : nowMs, endMs);
    if (en > s) (byCatIv[e.category] = byCatIv[e.category] || []).push([s, en]);
  }
  // attribute overlapping time once, in this order, so categories never double count
  const order = ['UNPLANNED', 'WAITING_PARTS', 'EXTERNAL', 'PLANNED', 'OTHER'];
  let counted = [];
  const by_category = {};
  for (const c of order) {
    if (!byCatIv[c]) continue;
    const own = subtract(intersect(merge(byCatIv[c]), windows), counted);
    by_category[c] = total(own) / HOUR;
    counted = merge([...counted, ...own]);
  }
  const qualIv = merge(Object.entries(byCatIv).filter(([c]) => cats.has(c)).flatMap(([, iv]) => iv));
  const qualifying = total(intersect(qualIv, windows)) / HOUR;
  const scheduled = total(windows) / HOUR;
  return {
    scheduled_h: scheduled, qualifying_h: qualifying, downtime_h: total(intersect(merge(Object.values(byCatIv).flat()), windows)) / HOUR,
    by_category, availability: scheduled > 0 ? (scheduled - qualifying) / scheduled * 100 : null,
  };
}

function scopedAssets(user, f) {
  const s = scope(user, f, { site: 'a.site_id', asset: 'a.id', category: 'a.category_id' });
  return db.get().prepare(`SELECT a.*, si.op_days, si.op_start, si.op_end, si.name AS site_name, c.name AS category_name
    FROM assets a JOIN sites si ON si.id = a.site_id JOIN equipment_categories c ON c.id = a.category_id
    WHERE a.is_archived = 0 AND ${s.where} ORDER BY a.asset_code`).all(s.params);
}

function availability(user, f) {
  const p = period(f);
  const cats = qualifyingCategories();
  const rows = scopedAssets(user, f).map(a => {
    const r = assetAvailability(a, p, cats);
    return { asset_id: a.id, asset_code: a.asset_code, name: a.name, site: a.site_name, category: a.category_name, status: a.status,
      scheduled_h: round(r.scheduled_h, 2), qualifying_downtime_h: round(r.qualifying_h, 2), operating_downtime_h: round(r.downtime_h, 2),
      by_category: Object.fromEntries(Object.entries(r.by_category).map(([k, v]) => [k, round(v, 2)])), availability_pct: round(r.availability, 1),
      _s: r.scheduled_h, _q: r.qualifying_h };
  });
  const sched = rows.reduce((t, r) => t + r._s, 0), qual = rows.reduce((t, r) => t + r._q, 0);
  rows.forEach(r => { delete r._s; delete r._q; });
  return {
    period: { from: p.from, to: p.to }, rows,
    scheduled_h: round(sched, 2), qualifying_downtime_h: round(qual, 2),
    availability_pct: sched > 0 ? round((sched - qual) / sched * 100, 1) : null,
    formula: 'Availability (%) = (Scheduled Operating Time − Qualifying Downtime) ÷ Scheduled Operating Time × 100',
    assumptions: [
      'Scheduled operating time uses each site\'s operating days and hours (Asia/Manila) for the asset\'s current site.',
      'Time before commissioning (or registration when no commissioning date) and decommissioned periods are excluded.',
      `Qualifying downtime categories: ${[...cats].join(', ')}${settings.get('availability_include_planned') ? '' : ' (planned PMS downtime excluded by setting)'}.`,
      'Overlapping downtime intervals are merged so time is never counted twice; downtime outside operating hours is ignored.',
      'Open (ongoing) downtime is counted up to the current time. Downtime of breakdown reports cancelled as invalid is voided.',
    ],
  };
}

/** Total elapsed downtime (calendar hours, overlaps merged per asset) by category. */
function downtimeHours(user, f) {
  const p = period(f);
  const s = scope(user, f, { site: 'e.site_id', asset: 'e.asset_id', category: 'a.category_id' });
  const rows = db.get().prepare(`SELECT e.*, a.asset_code FROM downtime_events e JOIN assets a ON a.id = e.asset_id
    WHERE e.is_void = 0 AND e.start_at < @end AND (e.end_at IS NULL OR e.end_at > @start) AND ${s.where}`).all({ ...s.params, start: p.startIso, end: p.endIso });
  const nowMs = now().getTime();
  const perAsset = {};
  const byCat = {};
  for (const e of rows) {
    const st = Math.max(Date.parse(e.start_at), p.startMs), en = Math.min(e.end_at ? Date.parse(e.end_at) : nowMs, p.endMs);
    if (en <= st) continue;
    (perAsset[e.asset_id] = perAsset[e.asset_id] || []).push([st, en]);
    byCat[e.category] = (byCat[e.category] || 0) + (en - st) / HOUR;
  }
  const totalH = Object.values(perAsset).reduce((t, iv) => t + total(merge(iv)), 0) / HOUR;
  return { total_h: totalH, by_category: byCat, events: rows.length };
}

// ---------------------------------------------------------------- PMS compliance
function pmsCompliance(user, f) {
  const p = period(f);
  const tol = settings.get('pms_tolerance_days');
  const early = settings.get('pms_early_window_days');
  const s = scope(user, f, { site: 'w.site_id', asset: 'w.asset_id', category: 'a.category_id' });
  const rows = db.get().prepare(`SELECT w.id, w.wo_number, w.status, w.due_date, w.original_due_date, w.actual_end, w.reschedule_count, st.category, a.asset_code
    FROM work_orders w JOIN wo_statuses st ON st.code = w.status JOIN assets a ON a.id = w.asset_id
    WHERE w.wo_type = 'PMS' AND w.due_date BETWEEN @from AND @to AND ${s.where}`).all({ ...s.params, from: p.from, to: p.to });
  const t = today();
  const b = { on_time: [], late: [], early: [], missed: [], overdue: [], pending: [], cancelled: [] };
  let rescheduled = 0;
  for (const r of rows) {
    if (r.reschedule_count > 0) rescheduled++;
    const deadline = addDays(r.due_date, tol);
    if (r.category === 'CANCELLED') b.cancelled.push(r.id);
    else if (r.category === 'MISSED') b.missed.push(r.id);
    else if (r.category === 'DONE') {
      const done = manilaDate(new Date(r.actual_end));
      if (done > deadline) b.late.push(r.id);
      else if (done < addDays(r.due_date, -early)) b.early.push(r.id);
      else b.on_time.push(r.id);
    } else if (deadline < t) b.overdue.push(r.id);
    else b.pending.push(r.id);
  }
  const denominator = b.on_time.length + b.late.length + b.early.length + b.missed.length + b.overdue.length;
  return {
    numerator: b.on_time.length, denominator,
    value: denominator ? b.on_time.length / denominator * 100 : null,
    buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.length])), ids: b, rescheduled,
    formula: `PMS completed within window (due − ${early} d … due + ${tol} d) ÷ PMS due in period × 100`,
    exclusions: [
      'Cancelled PMS (e.g. equipment decommissioned) are excluded from the denominator.',
      `Open PMS still inside the tolerance window (due + ${tol} days not yet passed) are pending and excluded until they are completed or become overdue.`,
      'Missed PMS, overdue open PMS and PMS completed late or too early count as non-compliant.',
      settings.get('reschedule_uses_new_due') ? 'Approved rescheduling moves the compliance due date to the new date (rescheduled count shown separately).'
        : 'Approved rescheduling does not change the compliance due date.',
    ],
  };
}

// ---------------------------------------------------------------- reliability
function mttr(user, f) {
  const p = period(f);
  const s = scope(user, f, { site: 'w.site_id', asset: 'w.asset_id', category: 'a.category_id' });
  const rows = db.get().prepare(`SELECT w.id, w.wo_number, w.actual_start, w.actual_end,
      (SELECT COALESCE(SUM(hours),0) FROM labor_entries l WHERE l.work_order_id = w.id AND l.is_void = 0) AS labor_h,
      (SELECT COALESCE(SUM((julianday(COALESCE(e.end_at, w.returned_to_service_at)) - julianday(e.start_at)) * 24),0) FROM downtime_events e WHERE e.work_order_id = w.id AND e.is_void = 0) AS downtime_h
    FROM work_orders w JOIN assets a ON a.id = w.asset_id
    WHERE w.wo_type = 'CM' AND w.status = 'CLOSED' AND w.actual_start IS NOT NULL AND w.actual_end IS NOT NULL
      AND w.actual_end >= @start AND w.actual_end < @end AND ${s.where}`).all({ ...s.params, start: p.startIso, end: p.endIso });
  const repairH = rows.reduce((t, r) => t + (Date.parse(r.actual_end) - Date.parse(r.actual_start)) / HOUR, 0);
  const laborH = rows.reduce((t, r) => t + r.labor_h, 0);
  const dtH = rows.reduce((t, r) => t + r.downtime_h, 0);
  return {
    numerator: repairH, denominator: rows.length, value: rows.length ? repairH / rows.length : null,
    mean_labor_h: rows.length ? laborH / rows.length : null, mean_downtime_h: rows.length ? dtH / rows.length : null, ids: rows.map(r => r.id),
    formula: 'MTTR (h) = Σ elapsed repair time (actual start → actual completion) of closed corrective WOs ÷ number of those WOs',
    exclusions: ['Only corrective work orders closed (verified) with repair completion in the period.',
      'Repair labor hours (person-hours) and elapsed equipment downtime are reported separately and are not part of MTTR.'],
  };
}

function mtbf(user, f) {
  const p = period(f);
  const assets = scopedAssets(user, f);
  const allCats = new Set(['PLANNED', 'UNPLANNED', 'WAITING_PARTS', 'EXTERNAL', 'OTHER']);
  let opH = 0;
  for (const a of assets) { const r = assetAvailability(a, p, allCats); opH += r.scheduled_h - r.qualifying_h; }
  const s = scope(user, f, { site: 'b.site_id', asset: 'b.asset_id', category: 'a.category_id' });
  const fails = db.get().prepare(`SELECT b.id, b.work_order_id FROM breakdowns b JOIN assets a ON a.id = b.asset_id
    WHERE b.is_failure = 1 AND b.impact = 'STOPPED' AND COALESCE(b.occurred_at, b.reported_at) >= @start AND COALESCE(b.occurred_at, b.reported_at) < @end AND ${s.where}`)
    .all({ ...s.params, start: p.startIso, end: p.endIso });
  return {
    numerator: opH, denominator: fails.length, value: fails.length ? opH / fails.length : null, ids: fails.map(x => x.work_order_id),
    note: fails.length ? null : 'No qualifying failures in the period — MTBF not computed.',
    formula: 'MTBF (h) = Σ operating hours (scheduled operating time − all downtime) ÷ number of qualifying failures',
    exclusions: ['A qualifying failure is a breakdown report with impact "equipment stopped", dated in the period, not cancelled as invalid.',
      'Defects reported while running (restricted / no impact) and PMS findings are not counted as failures.'],
  };
}

function closureRate(user, f) {
  const p = period(f);
  const s = scope(user, f, { site: 'w.site_id', asset: 'w.asset_id', category: 'a.category_id', type: 'w.wo_type' });
  const q = (extra) => db.get().prepare(`SELECT w.id FROM work_orders w JOIN assets a ON a.id = w.asset_id WHERE ${s.where} AND ${extra}`).all({ ...s.params, start: p.startIso, end: p.endIso }).map(r => r.id);
  const openAtStart = q(`w.created_at < @start AND (w.closed_at IS NULL OR w.closed_at >= @start) AND (w.cancelled_at IS NULL OR w.cancelled_at >= @start)`);
  const created = q(`w.created_at >= @start AND w.created_at < @end`);
  const cancelled = new Set(q(`w.cancelled_at >= @start AND w.cancelled_at < @end`));
  const closed = q(`w.status = 'CLOSED' AND w.closed_at >= @start AND w.closed_at < @end`);
  const denomIds = [...openAtStart, ...created].filter(id => !cancelled.has(id));
  return {
    numerator: closed.length, denominator: denomIds.length, value: denomIds.length ? closed.length / denomIds.length * 100 : null, ids: closed,
    formula: 'Closure rate (%) = WOs closed in period ÷ (WOs open at period start + WOs created in period − WOs cancelled/missed in period) × 100',
    exclusions: ['Cancelled and missed work orders are removed from the denominator.'],
  };
}

function backlog(user, f) {
  const s = scope(user, f, { site: 'w.site_id', asset: 'w.asset_id', category: 'a.category_id', type: 'w.wo_type' });
  const rows = db.get().prepare(`SELECT w.id, w.wo_number, w.wo_type, w.priority, w.status, w.created_at, w.est_labor_hours, w.due_date, w.planned_end, a.asset_code,
      (SELECT COALESCE(SUM(r.qty_reserved - r.qty_issued),0) FROM part_reservations r WHERE r.work_order_id = w.id AND r.status = 'ACTIVE') AS parts_outstanding,
      (SELECT COUNT(*) FROM purchase_requests pr WHERE pr.work_order_id = w.id AND pr.status IN ('SUBMITTED','APPROVED','ORDERED','PARTIAL')) AS open_prs
    FROM work_orders w JOIN wo_statuses st ON st.code = w.status JOIN assets a ON a.id = w.asset_id
    WHERE st.category IN ('OPEN','HOLD') AND ${s.where} ORDER BY w.created_at`).all(s.params);
  const nowMs = now().getTime();
  const aging = { '0-7 d': 0, '8-30 d': 0, '31-90 d': 0, '> 90 d': 0 };
  const byPriority = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let estH = 0;
  for (const r of rows) {
    const days = (nowMs - Date.parse(r.created_at)) / DAY;
    r.age_days = Math.floor(days);
    aging[days <= 7 ? '0-7 d' : days <= 30 ? '8-30 d' : days <= 90 ? '31-90 d' : '> 90 d']++;
    byPriority[r.priority]++;
    estH += r.est_labor_hours || 0;
  }
  return { count: rows.length, aging, by_priority: byPriority, est_labor_h: estH, waiting_parts: rows.filter(r => r.status === 'WAITING_PARTS').length,
    with_outstanding_parts: rows.filter(r => r.parts_outstanding > 0 || r.open_prs > 0).length, rows };
}

function costTotals(user, f) {
  const p = period(f);
  const s = scope(user, f, { site: 'c.site_id', asset: 'c.asset_id', category: 'a.category_id', type: 'w.wo_type' });
  const rows = db.get().prepare(`SELECT c.category, c.status, SUM(c.amount) amt, COUNT(*) n FROM cost_entries c JOIN assets a ON a.id = c.asset_id LEFT JOIN work_orders w ON w.id = c.work_order_id
    WHERE c.kind = 'ACTUAL' AND c.status IN ('APPROVED','PENDING') AND c.entry_date BETWEEN @from AND @to AND ${s.where} GROUP BY c.category, c.status`).all({ ...s.params, from: p.from, to: p.to });
  const byCat = {}; let tot = 0, approved = 0;
  for (const r of rows) { byCat[r.category] = (byCat[r.category] || 0) + r.amt; tot += r.amt; if (r.status === 'APPROVED') approved += r.amt; }
  return { total: tot, approved, pending: tot - approved, by_category: byCat };
}

// ---------------------------------------------------------------- dashboard
function dashboard(user, f) {
  const d = db.get();
  const p = period(f);
  const canCost = rbac.can(user, 'cost.view');
  const sa = scope(user, f, { site: 'a.site_id', asset: 'a.id', category: 'a.category_id' });
  const statusCounts = Object.fromEntries(d.prepare(`SELECT a.status, COUNT(*) n FROM assets a WHERE a.is_archived = 0 AND ${sa.where} GROUP BY a.status`).all(sa.params).map(r => [r.status, r.n]));
  const sum = list => list.reduce((t, k) => t + (statusCounts[k] || 0), 0);
  const registered = Object.entries(statusCounts).filter(([k]) => k !== 'DECOMMISSIONED').reduce((t, [, n]) => t + n, 0);
  const sw = scope(user, f, { site: 'w.site_id', asset: 'w.asset_id', category: 'a.category_id', type: 'w.wo_type' });
  const woCount = extra => d.prepare(`SELECT COUNT(*) n FROM work_orders w JOIN wo_statuses st ON st.code = w.status JOIN assets a ON a.id = w.asset_id WHERE ${sw.where} AND ${extra}`).get({ ...sw.params, today: today() }).n;
  const avail = availability(user, f);
  const comp = pmsCompliance(user, f);
  const dt = downtimeHours(user, f);
  const lowParams = {};
  const lowScope = f.site_id ? 's.site_id = @site' : rbac.siteFilter(user, 's.site_id', lowParams);
  if (f.site_id) lowParams.site = Number(f.site_id);
  const lowStock = d.prepare(`SELECT COUNT(*) n FROM (SELECT p.id, p.min_qty, COALESCE(SUM(CASE WHEN ${lowScope} THEN b.qty_on_hand END),0) q
    FROM parts p LEFT JOIN stock_balances b ON b.part_id = p.id LEFT JOIN stores s ON s.id = b.store_id WHERE p.is_active = 1 AND p.min_qty > 0 GROUP BY p.id HAVING q < p.min_qty)`).get(lowParams).n;
  const k = (key, label, value, extra = {}) => ({ key, label, value, ...extra });
  const kpis = [
    k('registered', 'Total registered equipment', registered, { unit: 'units', basis: 'current', formula: 'Count of non-archived equipment excluding decommissioned', numerator: registered, drill: { view: 'assets', query: {} }, note: statusCounts.DECOMMISSIONED ? `${statusCounts.DECOMMISSIONED} decommissioned not included` : null }),
    k('available', 'Available / operational', sum(UP), { unit: 'units', basis: 'current', formula: 'Equipment with status Available, Operational or Standby', numerator: sum(UP), denominator: registered, note: statusCounts.RUNNING_RESTRICTED ? `${statusCounts.RUNNING_RESTRICTED} more running with restriction` : null, drill: { view: 'assets', query: { status: UP.join(',') } } }),
    k('under_maintenance', 'Under maintenance', sum(MAINT), { unit: 'units', basis: 'current', formula: 'Status Under PM, Under CM, Waiting for Parts, Waiting for External Service, For Testing', numerator: sum(MAINT), drill: { view: 'assets', query: { status: MAINT.join(',') } } }),
    k('breakdown', 'Breakdown / out of service', sum(['BREAKDOWN']), { unit: 'units', basis: 'current', severity: sum(['BREAKDOWN']) ? 'bad' : null, formula: 'Equipment with status Breakdown (repair not yet started)', numerator: sum(['BREAKDOWN']), drill: { view: 'assets', query: { status: 'BREAKDOWN' } } }),
    k('availability', 'Equipment availability', avail.availability_pct, { unit: '%', basis: 'period', formula: avail.formula, numerator: round(avail.scheduled_h - avail.qualifying_downtime_h, 2), denominator: avail.scheduled_h, numerator_label: 'Available operating hours', denominator_label: 'Scheduled operating hours', exclusions: avail.assumptions, drill: { view: 'availability', query: {} } }),
    k('pms_compliance', 'PMS compliance', round(comp.value, 1), { unit: '%', basis: 'period', formula: comp.formula, numerator: comp.numerator, denominator: comp.denominator, numerator_label: 'PMS completed on time', denominator_label: 'PMS due (excl. pending & cancelled)', exclusions: comp.exclusions, breakdown: comp.buckets, rescheduled: comp.rescheduled, drill: { view: 'workorders', query: { ids: [...comp.ids.on_time, ...comp.ids.late, ...comp.ids.early, ...comp.ids.missed, ...comp.ids.overdue].join(',') } } }),
    k('overdue_pms', 'Overdue PMS work orders', woCount(`w.wo_type = 'PMS' AND st.category IN ('OPEN','HOLD') AND w.due_date < @today`), { unit: 'WOs', basis: 'current', formula: 'Open PMS work orders past their due date', drill: { view: 'workorders', query: { wo_type: 'PMS', overdue: 1 } } }),
    k('open_cm', 'Open corrective work orders', woCount(`w.wo_type = 'CM' AND st.category IN ('OPEN','HOLD')`), { unit: 'WOs', basis: 'current', formula: 'Corrective work orders not closed/cancelled', drill: { view: 'workorders', query: { wo_type: 'CM', open: 1 } } }),
    k('critical', 'Critical breakdowns needing action', woCount(`w.wo_type = 'CM' AND st.category IN ('OPEN','HOLD') AND w.priority = 'CRITICAL'`), { unit: 'WOs', basis: 'current', formula: 'Open corrective work orders with Critical priority', drill: { view: 'workorders', query: { wo_type: 'CM', open: 1, priority: 'CRITICAL' } } }),
    k('downtime', 'Total equipment downtime', round(dt.total_h, 1), { unit: 'h', basis: 'period', formula: 'Σ elapsed downtime hours in the period (overlaps merged per asset, voided events excluded)', breakdown: Object.fromEntries(Object.entries(dt.by_category).map(([a, b]) => [a, round(b, 1)])), drill: { view: 'downtime', query: {} } }),
  ];
  if (canCost) {
    const c = costTotals(user, f);
    kpis.push(k('cost', 'Total maintenance cost', round(c.total, 2), { unit: 'PHP', basis: 'period', formula: 'Σ actual cost entries dated in the period (approved + pending approval; rejected/void excluded)', breakdown: Object.fromEntries(Object.entries(c.by_category).map(([a, b]) => [a, round(b, 2)])), note: `Approved ₱${round(c.approved, 2).toLocaleString('en-PH')}; pending ₱${round(c.pending, 2).toLocaleString('en-PH')}`, drill: { view: 'costs', query: {} } }));
  }
  kpis.push(k('low_stock', 'Spare parts below minimum', lowStock, { unit: 'parts', basis: 'current', severity: lowStock ? 'warn' : null, formula: 'Active parts whose total on-hand quantity (stores in scope) is below the minimum stock level', drill: { view: 'inventory', query: { low: 1 } } }));
  for (const x of kpis) if (x.value == null && x.unit === '%') x.note = x.note || 'No valid data for this period';
  return { period: { from: p.from, to: p.to }, kpis };
}

// ---------------------------------------------------------------- charts
function buckets(p) {
  const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / DAY) + 1;
  const gran = days > 62 ? 'month' : days > 14 ? 'week' : 'day';
  const list = [];
  let cur = p.from;
  while (cur <= p.to) {
    let end;
    if (gran === 'month') { const monthEnd = new Date(Date.UTC(+cur.slice(0, 4), +cur.slice(5, 7), 0)).toISOString().slice(0, 10); end = monthEnd < p.to ? monthEnd : p.to; }
    else if (gran === 'week') end = addDays(cur, 6) < p.to ? addDays(cur, 6) : p.to;
    else end = cur;
    list.push({ from: cur, to: end, label: gran === 'month' ? cur.slice(0, 7) : cur.slice(5) });
    cur = addDays(end, 1);
  }
  return { gran, list };
}

function charts(user, f) {
  const d = db.get();
  const p = period(f);
  const out = {};
  const sb = scope(user, f, { site: 'b.site_id', asset: 'b.asset_id', category: 'a.category_id' });
  const bp = { ...sb.params, start: p.startIso, end: p.endIso };
  const bdBase = `FROM breakdowns b JOIN assets a ON a.id = b.asset_id JOIN sites s ON s.id = b.site_id WHERE b.is_failure = 1 AND b.reported_at >= @start AND b.reported_at < @end AND ${sb.where}`;
  out.breakdowns_by_site = d.prepare(`SELECT s.name label, COUNT(*) value ${bdBase} GROUP BY s.id ORDER BY value DESC`).all(bp);
  out.breakdowns_by_category = d.prepare(`SELECT c.name label, COUNT(*) value ${bdBase.replace('JOIN sites s', 'JOIN equipment_categories c ON c.id = a.category_id JOIN sites s')} GROUP BY c.id ORDER BY value DESC`).all(bp);
  out.top_failures = d.prepare(`SELECT a.id asset_id, a.asset_code || ' ' || a.name label, COUNT(*) value,
      (SELECT fc.label FROM work_orders w2 JOIN failure_codes fc ON fc.kind = 'ROOT_CAUSE' AND fc.code = w2.root_cause_code WHERE w2.asset_id = a.id AND w2.wo_type = 'CM' AND w2.root_cause_code IS NOT NULL GROUP BY w2.root_cause_code ORDER BY COUNT(*) DESC LIMIT 1) AS top_cause
    ${bdBase} GROUP BY a.id ORDER BY value DESC LIMIT 10`).all(bp);

  const bk = buckets(p);
  out.granularity = bk.gran;
  const sw = scope(user, f, { site: 'w.site_id', asset: 'w.asset_id', category: 'a.category_id' });
  const woRows = d.prepare(`SELECT w.wo_type, w.created_at FROM work_orders w JOIN assets a ON a.id = w.asset_id WHERE w.created_at >= @start AND w.created_at < @end AND w.status <> 'CANCELLED' AND ${sw.where}`).all({ ...sw.params, start: p.startIso, end: p.endIso });
  out.pms_vs_cm = bk.list.map(b => {
    const inB = woRows.filter(r => { const dd = manilaDate(new Date(r.created_at)); return dd >= b.from && dd <= b.to; });
    return { label: b.label, PMS: inB.filter(r => r.wo_type === 'PMS').length, CM: inB.filter(r => r.wo_type === 'CM').length, OTHER: inB.filter(r => r.wo_type !== 'PMS' && r.wo_type !== 'CM').length };
  });
  out.downtime_trend = [];
  out.availability_trend = [];
  for (const b of bk.list) {
    const ff = { ...f, from: b.from, to: b.to };
    if (b.from > today()) break;
    const dt = downtimeHours(user, ff);
    out.downtime_trend.push({ label: b.label, total: round(dt.total_h, 1), ...Object.fromEntries(Object.entries(dt.by_category).map(([k, v]) => [k, round(v, 1)])) });
    const av = availability(user, ff);
    out.availability_trend.push({ label: b.label, value: av.availability_pct });
  }
  if (rbac.can(user, 'cost.view')) {
    const sc = scope(user, f, { site: 'c.site_id', asset: 'c.asset_id', category: 'a.category_id' });
    out.cost_by_site = d.prepare(`SELECT s.name label, ROUND(SUM(c.amount),2) value FROM cost_entries c JOIN assets a ON a.id = c.asset_id JOIN sites s ON s.id = c.site_id
      WHERE c.kind = 'ACTUAL' AND c.status IN ('APPROVED','PENDING') AND c.entry_date BETWEEN @from AND @to AND ${sc.where} GROUP BY s.id ORDER BY value DESC`).all({ ...sc.params, from: p.from, to: p.to });
  }
  const so = scope(user, f, { site: 'w.site_id', asset: 'w.asset_id', category: 'a.category_id', type: 'w.wo_type' });
  out.wo_by_status = d.prepare(`SELECT st.label, COUNT(*) value FROM work_orders w JOIN wo_statuses st ON st.code = w.status JOIN assets a ON a.id = w.asset_id
    WHERE st.category IN ('OPEN','HOLD') AND ${so.where} GROUP BY st.code ORDER BY st.sort_order`).all(so.params);
  out.wo_aging = backlog(user, f).aging;
  return out;
}

module.exports = { merge, intersect, subtract, total, operatingWindows, period, scope, availability, assetAvailability, downtimeHours, pmsCompliance, mttr, mtbf, closureRate, backlog, costTotals, dashboard, charts, scopedAssets, qualifyingCategories, round, UP, MAINT };
