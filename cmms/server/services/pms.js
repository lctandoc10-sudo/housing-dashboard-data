'use strict';
// Preventive maintenance planning and automatic work order generation.
//
// A PMS plan applies either to an equipment category (every active asset of that
// type gets a schedule) or to one asset. Each schedule holds its next due date
// (calendar plans) or next due meter reading (hour/odometer plans). The generator
// creates one PMS work order per schedule when it enters its lead window; the next
// cycle is calculated only when that work order is closed (completed) or marked
// missed — never automatically.
const db = require('../db');
const audit = require('../audit');
const rbac = require('../rbac');
const wos = require('./workorders');
const { nowIso, today, addDays, addMonths, isDate, manilaToUtc } = require('../time');
const { bad, notFound, conflict } = require('../errors');

const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'CUSTOM_DAYS', 'HOURS', 'KM'];
const isMeter = f => f === 'HOURS' || f === 'KM';

function addInterval(plan, dateStr) {
  const n = Math.max(1, Math.round(plan.interval_value || 1));
  switch (plan.frequency) {
    case 'DAILY': return addDays(dateStr, n);
    case 'WEEKLY': return addDays(dateStr, 7 * n);
    case 'MONTHLY': return addMonths(dateStr, n);
    case 'QUARTERLY': return addMonths(dateStr, 3 * n);
    case 'SEMIANNUAL': return addMonths(dateStr, 6 * n);
    case 'ANNUAL': return addMonths(dateStr, 12 * n);
    case 'CUSTOM_DAYS': return addDays(dateStr, n);
    default: throw new Error('Not a calendar frequency');
  }
}

function validatePlan(b, existing) {
  const d = db.get();
  const p = { ...existing, ...b };
  if (!p.name || !String(p.name).trim()) throw bad('Plan name is required');
  if (!p.code || !String(p.code).trim()) throw bad('Plan code is required');
  if (!FREQUENCIES.includes(p.frequency)) throw bad('Invalid frequency');
  if (!!p.category_id === !!p.asset_id) throw bad('A plan applies to either an equipment category or a single asset');
  const iv = Number(p.interval_value);
  if (!Number.isFinite(iv) || iv <= 0) throw bad('Interval must be greater than zero');
  if (p.category_id && !d.prepare('SELECT 1 FROM equipment_categories WHERE id = ?').get(p.category_id)) throw bad('Invalid category');
  if (p.asset_id) {
    const a = d.prepare('SELECT * FROM assets WHERE id = ?').get(p.asset_id);
    if (!a) throw bad('Invalid asset');
    if (isMeter(p.frequency) && a.meter_type !== (p.frequency === 'HOURS' ? 'HOURS' : 'KM')) throw bad(`This equipment does not record ${p.frequency === 'HOURS' ? 'operating hours' : 'odometer'} readings`);
  }
  if (p.checklist_template_id && !d.prepare('SELECT 1 FROM checklist_templates WHERE id = ?').get(p.checklist_template_id)) throw bad('Invalid checklist');
  if (Number(p.lead_days) < 0) throw bad('Lead days cannot be negative');
  return p;
}

function assetsForPlan(plan) {
  const d = db.get();
  if (plan.asset_id) return d.prepare(`SELECT * FROM assets WHERE id = ? AND is_archived = 0`).all(plan.asset_id);
  const meter = plan.frequency === 'HOURS' ? 'HOURS' : plan.frequency === 'KM' ? 'KM' : null;
  return d.prepare(`SELECT * FROM assets WHERE category_id = ? AND is_archived = 0 AND status <> 'DECOMMISSIONED' AND (? IS NULL OR meter_type = ?)`).all(plan.category_id, meter, meter);
}

/** Ensure every applicable asset has a schedule row for the plan. */
function syncSchedules(planId, startDate) {
  const d = db.get();
  const plan = d.prepare('SELECT * FROM pms_plans WHERE id = ?').get(planId);
  const start = startDate || today();
  const ins = d.prepare(`INSERT OR IGNORE INTO pms_schedules (plan_id, asset_id, start_date, last_done_meter, next_due_date, next_due_meter, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  for (const a of assetsForPlan(plan)) {
    if (isMeter(plan.frequency)) {
      const base = a.meter_reading || 0;
      added += ins.run(plan.id, a.id, start, base, null, base + plan.interval_value, nowIso(), nowIso()).changes;
    } else {
      added += ins.run(plan.id, a.id, start, null, start, null, nowIso(), nowIso()).changes;
    }
  }
  return added;
}

/** Called when an asset is registered or changes category. */
function syncAsset(assetId) {
  const d = db.get();
  const a = d.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  for (const p of d.prepare('SELECT id FROM pms_plans WHERE category_id = ? AND is_active = 1').all(a.category_id)) syncSchedules(p.id);
}

function createPlan(ctx, b) {
  rbac.require(ctx.user, 'pms.plan');
  return db.tx(() => {
    const p = validatePlan(b, {});
    if (b.start_date && !isDate(b.start_date)) throw bad('Invalid first due date');
    const d = db.get();
    if (d.prepare('SELECT 1 FROM pms_plans WHERE code = ?').get(p.code)) throw conflict('Plan code already exists');
    const r = d.prepare(`INSERT INTO pms_plans (code, name, category_id, asset_id, frequency, interval_value, schedule_basis, lead_days, lead_meter, checklist_template_id,
        est_labor_hours, requires_shutdown, default_priority, instructions, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      String(p.code).trim(), String(p.name).trim(), p.category_id || null, p.asset_id || null, p.frequency, Number(p.interval_value),
      p.schedule_basis === 'FLOATING' ? 'FLOATING' : 'FIXED', Number(p.lead_days ?? 7), Number(p.lead_meter || 0), p.checklist_template_id || null,
      p.est_labor_hours ?? null, p.requires_shutdown === false || p.requires_shutdown === 0 ? 0 : 1, p.default_priority || 'MEDIUM', p.instructions || null,
      ctx.user.id, nowIso(), nowIso());
    const id = r.lastInsertRowid;
    setPlanParts(id, b.parts);
    const n = syncSchedules(id, b.start_date);
    audit.log(ctx, 'CREATE', 'pms_plan', id, `${p.code} ${p.name} (${n} schedule(s))`, null, b);
    return id;
  });
}

function setPlanParts(planId, parts) {
  if (!Array.isArray(parts)) return;
  const d = db.get();
  d.prepare('DELETE FROM pms_plan_parts WHERE plan_id = ?').run(planId);
  const ins = d.prepare('INSERT INTO pms_plan_parts (plan_id, part_id, qty) VALUES (?, ?, ?)');
  for (const x of parts) {
    if (!d.prepare('SELECT 1 FROM parts WHERE id = ?').get(x.part_id)) throw bad('Invalid part in plan');
    if (!(Number(x.qty) > 0)) throw bad('Part quantity must be greater than zero');
    ins.run(planId, x.part_id, Number(x.qty));
  }
}

function updatePlan(ctx, id, b) {
  rbac.require(ctx.user, 'pms.plan');
  return db.tx(() => {
    const d = db.get();
    const existing = d.prepare('SELECT * FROM pms_plans WHERE id = ?').get(id);
    if (!existing) throw notFound('PMS plan');
    const allowed = ['name', 'interval_value', 'schedule_basis', 'lead_days', 'lead_meter', 'checklist_template_id', 'est_labor_hours', 'requires_shutdown', 'default_priority', 'instructions', 'is_active'];
    if ('frequency' in b && b.frequency !== existing.frequency) throw bad('Frequency type cannot be changed; deactivate this plan and create a new one');
    const fields = {};
    for (const k of allowed) if (k in b) fields[k] = typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k];
    validatePlan(fields, existing);
    fields.updated_at = nowIso();
    db.updateRow('pms_plans', id, fields, [...allowed, 'updated_at']);
    setPlanParts(id, b.parts);
    if (fields.is_active === 1) syncSchedules(id);
    const df = audit.diff(existing, { ...existing, ...fields });
    if (df) audit.log(ctx, 'UPDATE', 'pms_plan', id, existing.code, df[0], df[1]);
  });
}

/**
 * Generate PMS work orders that have entered their lead window.
 * Returns the list of created work orders.
 */
function generate(ctx = { user: null }) {
  return db.tx(() => {
    const d = db.get();
    const t = today();
    const rows = d.prepare(`SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.frequency, p.interval_value, p.lead_days, p.lead_meter, p.checklist_template_id,
        p.est_labor_hours, p.requires_shutdown, p.default_priority, p.instructions, a.meter_reading, a.asset_code
      FROM pms_schedules s JOIN pms_plans p ON p.id = s.plan_id JOIN assets a ON a.id = s.asset_id
      WHERE s.is_active = 1 AND p.is_active = 1 AND a.is_archived = 0 AND a.status <> 'DECOMMISSIONED'
        AND NOT EXISTS (SELECT 1 FROM work_orders w JOIN wo_statuses st ON st.code = w.status WHERE w.schedule_id = s.id AND st.category IN ('OPEN','HOLD'))`).all();
    const created = [];
    for (const s of rows) {
      let due = null, dueMeter = null;
      if (isMeter(s.frequency)) {
        if (s.next_due_meter == null || s.meter_reading == null) continue;
        if (s.meter_reading < s.next_due_meter - (s.lead_meter || 0)) continue;
        due = s.meter_reading >= s.next_due_meter ? t : addDays(t, Math.max(1, s.lead_days || 0));
        dueMeter = s.next_due_meter;
      } else {
        if (!s.next_due_date) continue;
        if (addDays(s.next_due_date, -(s.lead_days || 0)) > t) continue;
        due = s.next_due_date;
      }
      const desc = [s.instructions, isMeter(s.frequency) ? `Due at ${dueMeter} ${s.frequency === 'HOURS' ? 'operating hours' : 'km'} (current ${s.meter_reading})` : null].filter(Boolean).join('\n');
      const wo = wos.createInternal(ctx, {
        wo_type: 'PMS', asset_id: s.asset_id, source: 'PMS_SCHEDULE', schedule_id: s.id, title: `${s.plan_name}`, description: desc || null,
        priority: s.default_priority, due_date: due, due_meter: dueMeter, planned_start: manilaToUtc(due, '08:00').toISOString(),
        planned_end: manilaToUtc(due, '17:00').toISOString(), est_labor_hours: s.est_labor_hours, requires_shutdown: !!s.requires_shutdown,
        checklist_template_id: s.checklist_template_id,
      });
      created.push({ ...wo, asset_code: s.asset_code, due_date: due });
    }
    return created;
  });
}

function onCompleted(wo, completionDate) {
  const d = db.get();
  const s = d.prepare('SELECT s.*, p.frequency, p.interval_value, p.schedule_basis FROM pms_schedules s JOIN pms_plans p ON p.id = s.plan_id WHERE s.id = ?').get(wo.schedule_id);
  if (!s) return;
  const plan = { frequency: s.frequency, interval_value: s.interval_value };
  if (isMeter(s.frequency)) {
    const asset = d.prepare('SELECT meter_reading FROM assets WHERE id = ?').get(wo.asset_id);
    const meter = wo.meter_at_completion ?? asset.meter_reading ?? s.next_due_meter;
    let next;
    if (s.schedule_basis === 'FIXED' && wo.due_meter != null) { next = wo.due_meter + s.interval_value; while (next <= meter) next += s.interval_value; }
    else next = meter + s.interval_value;
    d.prepare('UPDATE pms_schedules SET last_done_date = ?, last_done_meter = ?, next_due_meter = ?, updated_at = ? WHERE id = ?').run(completionDate, meter, next, nowIso(), s.id);
  } else {
    let next;
    if (s.schedule_basis === 'FIXED') {
      next = addInterval(plan, wo.original_due_date || wo.due_date || completionDate);
      while (next <= completionDate) next = addInterval(plan, next);
    } else next = addInterval(plan, completionDate);
    d.prepare('UPDATE pms_schedules SET last_done_date = ?, next_due_date = ?, updated_at = ? WHERE id = ?').run(completionDate, next, nowIso(), s.id);
  }
}

function onMissed(wo) {
  const d = db.get();
  const s = d.prepare('SELECT s.*, p.frequency, p.interval_value FROM pms_schedules s JOIN pms_plans p ON p.id = s.plan_id WHERE s.id = ?').get(wo.schedule_id);
  if (!s) return;
  if (isMeter(s.frequency)) {
    const asset = d.prepare('SELECT meter_reading FROM assets WHERE id = ?').get(wo.asset_id);
    let next = (wo.due_meter ?? s.next_due_meter) + s.interval_value;
    while (asset.meter_reading != null && next <= asset.meter_reading) next += s.interval_value;
    d.prepare('UPDATE pms_schedules SET next_due_meter = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), s.id);
  } else {
    const plan = { frequency: s.frequency, interval_value: s.interval_value };
    let next = addInterval(plan, wo.original_due_date || wo.due_date);
    while (next < today()) next = addInterval(plan, next);
    d.prepare('UPDATE pms_schedules SET next_due_date = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), s.id);
  }
}

/** Calendar view: actual PMS work orders plus forecast occurrences of calendar schedules. */
function calendar(user, from, to, siteId) {
  const d = db.get();
  const params = { from, to, site: siteId || null };
  const sf = rbac.siteFilter(user, 'w.site_id', params);
  const wosRows = d.prepare(`SELECT w.id, w.wo_number, w.title, w.status, w.due_date, w.priority, a.asset_code, a.name AS asset_name, st.category
    FROM work_orders w JOIN assets a ON a.id = w.asset_id JOIN wo_statuses st ON st.code = w.status
    WHERE w.wo_type = 'PMS' AND w.due_date BETWEEN @from AND @to AND (@site IS NULL OR w.site_id = @site) AND ${sf} ORDER BY w.due_date`).all(params);
  const p2 = { site: siteId || null };
  const sf2 = rbac.siteFilter(user, 'a.site_id', p2);
  const scheds = d.prepare(`SELECT s.id, s.next_due_date, p.name AS plan_name, p.frequency, p.interval_value, a.asset_code, a.name AS asset_name
    FROM pms_schedules s JOIN pms_plans p ON p.id = s.plan_id JOIN assets a ON a.id = s.asset_id
    WHERE s.is_active = 1 AND p.is_active = 1 AND a.status <> 'DECOMMISSIONED' AND a.is_archived = 0 AND s.next_due_date IS NOT NULL
      AND (@site IS NULL OR a.site_id = @site) AND ${sf2}`).all(p2);
  const generatedFor = new Set(d.prepare(`SELECT schedule_id || ':' || original_due_date k FROM work_orders WHERE schedule_id IS NOT NULL`).all().map(r => r.k));
  const forecast = [];
  for (const s of scheds) {
    let due = s.next_due_date, guard = 0;
    while (due <= to && guard++ < 400) {
      if (due >= from && !generatedFor.has(`${s.id}:${due}`)) forecast.push({ schedule_id: s.id, due_date: due, title: s.plan_name, asset_code: s.asset_code, asset_name: s.asset_name, forecast: true });
      due = addInterval(s, due);
    }
  }
  return { work_orders: wosRows, forecast };
}

module.exports = { FREQUENCIES, addInterval, createPlan, updatePlan, syncSchedules, syncAsset, generate, onCompleted, onMissed, calendar };
