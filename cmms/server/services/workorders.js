'use strict';
// Unified work order engine for PMS, corrective (breakdown), inspection and other
// work. Allowed status transitions and the permission each needs come from the
// wo_transitions table (configurable). Guards below enforce the data required
// before work can be submitted, verified and closed — a work order is never closed
// just because a technician updated it.
const db = require('../db');
const audit = require('../audit');
const rbac = require('../rbac');
const settings = require('../settings');
const numbering = require('../numbering');
const assetStatus = require('./assetStatus');
const notify = require('./notify');
const costs = require('./costs');
const inventory = require('./inventory');
const { nowIso, today, toIso, isDate, addDays, manilaDate } = require('../time');
const { bad, notFound, forbidden, conflict } = require('../errors');

const TYPES = ['PMS', 'CM', 'INSPECTION', 'OTHER'];
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const PLANNING_FIELDS = ['title', 'description', 'priority', 'planned_start', 'planned_end', 'est_labor_hours', 'est_cost', 'supervisor_id', 'requires_shutdown'];
const EXECUTION_FIELDS = ['work_performed', 'findings', 'defects_found', 'recommendations', 'condition_after', 'test_results', 'test_passed',
  'completion_remarks', 'root_cause_code', 'root_cause_remarks', 'failure_mode_code', 'failed_component', 'repair_action', 'is_recurrence',
  'actual_start', 'actual_end', 'meter_at_completion'];
const INSTANT_FIELDS = ['planned_start', 'planned_end', 'actual_start', 'actual_end'];
const EXEC_STATUSES = ['IN_PROGRESS', 'WAITING_PARTS', 'WAITING_EXTERNAL', 'FOR_TESTING'];

const statusRow = code => db.get().prepare('SELECT * FROM wo_statuses WHERE code = ?').get(code);
const isOpenCat = c => c === 'OPEN' || c === 'HOLD';

function load(id) {
  const wo = db.get().prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
  if (!wo) throw notFound('Work order');
  return wo;
}
function isAssignee(woId, userId) { return !!db.get().prepare('SELECT 1 FROM wo_assignees WHERE work_order_id = ? AND user_id = ?').get(woId, userId); }

/** Can the user see this work order? */
function canView(user, wo) {
  if (!rbac.canSite(user, wo.site_id)) return false;
  if (rbac.can(user, 'wo.view')) return true;
  if (rbac.can(user, 'wo.view_assigned')) return isAssignee(wo.id, user.id) || wo.requested_by === user.id;
  return false;
}
function loadVisible(user, id) {
  const wo = load(id);
  if (!canView(user, wo)) throw forbidden('You do not have access to this work order');
  return wo;
}
function canExecute(user, wo) {
  return rbac.can(user, 'wo.execute') && rbac.canSite(user, wo.site_id) && (isAssignee(wo.id, user.id) || rbac.can(user, 'wo.assign'));
}

function openDuplicates(assetId, woType, excludeId) {
  return db.get().prepare(`SELECT w.id, w.wo_number, w.wo_type, w.title, w.status, w.created_at FROM work_orders w JOIN wo_statuses s ON s.code = w.status
    WHERE w.asset_id = ? AND s.category IN ('OPEN','HOLD') AND (? IS NULL OR w.wo_type = ?) AND w.id <> COALESCE(?, 0)`).all(assetId, woType, woType, excludeId || null);
}

function snapshotChecklist(woId, templateId) {
  if (!templateId) return;
  const d = db.get();
  const items = d.prepare('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY seq').all(templateId);
  const ins = d.prepare('INSERT INTO wo_checklist_results (work_order_id, seq, section, description, response_type, is_required) VALUES (?, ?, ?, ?, ?, ?)');
  for (const it of items) ins.run(woId, it.seq, it.section, it.description, it.response_type, it.is_required);
}

function history(woId, from, to, userId, remarks, at) {
  db.get().prepare('INSERT INTO wo_status_history (work_order_id, from_status, to_status, remarks, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(woId, from, to, remarks || null, userId || null, at || nowIso());
}

function normaliseInstant(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const iso = toIso(v);
  if (!iso) throw bad(`Invalid date/time for ${field}`);
  return iso;
}

/**
 * Create a work order (internal; callers check permissions).
 * b: { wo_type, asset_id, title, description, priority, due_date, planned_start, planned_end, est_labor_hours,
 *      requires_shutdown, supervisor_id, checklist_template_id, schedule_id, parent_wo_id, investigation_id, source,
 *      due_meter, client_request_id, confirm_duplicate }
 */
function createInternal(ctx, b) {
  const d = db.get();
  if (!TYPES.includes(b.wo_type)) throw bad('Invalid work order type');
  const asset = d.prepare('SELECT * FROM assets WHERE id = ?').get(b.asset_id);
  if (!asset || asset.is_archived) throw bad('Equipment not found or archived');
  if (asset.status === 'DECOMMISSIONED') throw conflict('Equipment is decommissioned');
  if (ctx.user) rbac.requireSite(ctx.user, asset.site_id);
  if (!b.title || !String(b.title).trim()) throw bad('Title / description of work is required');
  const priority = b.priority || 'MEDIUM';
  if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
  if (b.due_date && !isDate(b.due_date)) throw bad('Invalid due date');
  const ps = normaliseInstant(b.planned_start, 'planned start');
  const pe = normaliseInstant(b.planned_end, 'planned completion');
  if (ps && pe && pe < ps) throw bad('Planned completion must be after planned start');
  if (b.client_request_id) {
    const prev = d.prepare('SELECT id FROM work_orders WHERE client_request_id = ?').get(b.client_request_id);
    if (prev) return { id: prev.id, duplicate_submission: true };
  }
  if (!b.confirm_duplicate && b.source !== 'PMS_SCHEDULE') {
    const dups = openDuplicates(asset.id, b.wo_type === 'PMS' ? 'PMS' : b.wo_type === 'CM' ? 'CM' : null);
    if (dups.length) throw conflict(`There ${dups.length === 1 ? 'is an open work order' : `are ${dups.length} open work orders`} for this equipment. Review them or confirm to create another.`, { duplicates: dups });
  }
  const initial = b.wo_type === 'CM' ? 'REPORTED' : 'SCHEDULED';
  const ts = nowIso();
  const woNumber = numbering.next(b.wo_type);
  const r = d.prepare(`INSERT INTO work_orders (wo_number, wo_type, source, asset_id, site_id, schedule_id, parent_wo_id, investigation_id, title, description,
      priority, status, requires_shutdown, requested_by, supervisor_id, due_date, original_due_date, due_meter, planned_start, planned_end, est_labor_hours, est_cost,
      checklist_template_id, client_request_id, created_by, created_at, updated_by, updated_at)
    VALUES (@wo_number, @wo_type, @source, @asset_id, @site_id, @schedule_id, @parent_wo_id, @investigation_id, @title, @description,
      @priority, @status, @requires_shutdown, @requested_by, @supervisor_id, @due_date, @due_date, @due_meter, @planned_start, @planned_end, @est_labor_hours, @est_cost,
      @checklist_template_id, @client_request_id, @uid, @ts, @uid, @ts)`).run({
    wo_number: woNumber, wo_type: b.wo_type, source: b.source || 'MANUAL', asset_id: asset.id, site_id: asset.site_id,
    schedule_id: b.schedule_id || null, parent_wo_id: b.parent_wo_id || null, investigation_id: b.investigation_id || null,
    title: String(b.title).trim().slice(0, 300), description: b.description || null, priority, status: initial,
    requires_shutdown: b.requires_shutdown === undefined ? (b.wo_type === 'INSPECTION' ? 0 : 1) : (b.requires_shutdown ? 1 : 0),
    requested_by: b.requested_by || (ctx.user ? ctx.user.id : null), supervisor_id: b.supervisor_id || null,
    due_date: b.due_date || null, due_meter: b.due_meter ?? null, planned_start: ps, planned_end: pe,
    est_labor_hours: b.est_labor_hours ?? null, est_cost: b.est_cost ?? null, checklist_template_id: b.checklist_template_id || null,
    client_request_id: b.client_request_id || null, uid: ctx.user ? ctx.user.id : null, ts,
  });
  const id = r.lastInsertRowid;
  snapshotChecklist(id, b.checklist_template_id);
  history(id, null, initial, ctx.user ? ctx.user.id : null, b.source === 'PMS_SCHEDULE' ? 'Generated from PMS schedule' : 'Created');
  audit.log(ctx, 'CREATE', 'work_order', id, `${woNumber} ${b.wo_type} for ${asset.asset_code}: ${b.title}`);
  return { id, wo_number: woNumber };
}

function create(ctx, b) {
  rbac.require(ctx.user, 'wo.create');
  return db.tx(() => createInternal(ctx, { ...b, schedule_id: null, source: b.parent_wo_id ? 'PMS_FINDING' : (b.investigation_id ? 'INVESTIGATION' : 'MANUAL') }));
}

const SEVERITY_PRIORITY = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };

/** Breakdown / defect report: creates the breakdown record and its corrective work order. */
function reportBreakdown(ctx, b) {
  rbac.require(ctx.user, 'breakdown.report');
  return db.tx(() => {
    const d = db.get();
    if (b.client_request_id) {
      const prev = d.prepare('SELECT w.id, b.id AS breakdown_id FROM work_orders w JOIN breakdowns b ON b.work_order_id = w.id WHERE w.client_request_id = ?').get(b.client_request_id);
      if (prev) return { ...prev, duplicate_submission: true };
    }
    const asset = d.prepare('SELECT * FROM assets WHERE id = ?').get(b.asset_id);
    if (!asset || asset.is_archived) throw bad('Select the equipment');
    rbac.requireSite(ctx.user, asset.site_id);
    if (!PRIORITIES.includes(b.severity)) throw bad('Select the breakdown severity');
    if (!['STOPPED', 'RESTRICTED', 'NONE'].includes(b.impact)) throw bad('Select the operational impact (stopped / running with restriction / no impact)');
    if (!b.category_code || !d.prepare(`SELECT 1 FROM failure_codes WHERE kind = 'BREAKDOWN_CATEGORY' AND code = ?`).get(b.category_code)) throw bad('Select the breakdown category');
    if (!b.description || String(b.description).trim().length < 5) throw bad('Describe the defect or failure');
    const reportedAt = nowIso();
    let occurredAt = null;
    if (b.occurred_at) {
      occurredAt = toIso(b.occurred_at);
      if (!occurredAt) throw bad('Invalid breakdown date/time');
      if (occurredAt > reportedAt) throw bad('Breakdown time cannot be in the future');
      if (asset.commissioning_date && manilaDate(new Date(occurredAt)) < asset.commissioning_date) throw bad('Breakdown time is before the equipment commissioning date');
    }
    const target = b.target_recovery_at ? normaliseInstant(b.target_recovery_at, 'target recovery') : null;
    if (target && target < reportedAt) throw bad('Target recovery must be in the future');
    const wo = createInternal(ctx, {
      wo_type: 'CM', asset_id: asset.id, source: 'BREAKDOWN', title: b.title || String(b.description).trim().slice(0, 120),
      description: b.description, priority: b.priority || SEVERITY_PRIORITY[b.severity], requires_shutdown: b.impact !== 'NONE',
      planned_end: target, supervisor_id: b.supervisor_id || null, client_request_id: b.client_request_id, confirm_duplicate: b.confirm_duplicate,
    });
    const reportNo = numbering.next('BREAKDOWN');
    const r = d.prepare(`INSERT INTO breakdowns (report_no, asset_id, site_id, work_order_id, reported_by, reported_at, occurred_at, category_code, description,
        operating_condition, impact, safety_impact, production_impact, severity, temporary_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(reportNo, asset.id, asset.site_id, wo.id, ctx.user.id, reportedAt, occurredAt,
      b.category_code, b.description, b.operating_condition || null, b.impact, b.safety_impact || null, b.production_impact || null, b.severity, b.temporary_action || null);
    assetStatus.recompute(asset.id, { userId: ctx.user.id, downtimeStart: occurredAt || reportedAt });
    const woRow = load(wo.id);
    // repeat breakdown detection
    const windowDays = settings.get('repeat_failure_window_days');
    const since = new Date(Date.parse(reportedAt) - windowDays * 86400000).toISOString();
    const count = d.prepare('SELECT COUNT(*) n FROM breakdowns WHERE asset_id = ? AND is_failure = 1 AND reported_at >= ?').get(asset.id, since).n;
    if (count >= settings.get('repeat_failure_threshold')) {
      d.prepare('UPDATE work_orders SET is_recurrence = 1 WHERE id = ?').run(wo.id);
      notify.onRepeatFailure(woRow, asset, count, windowDays);
    }
    if (b.severity === 'CRITICAL') notify.onCriticalBreakdown(woRow, asset);
    audit.log(ctx, 'REPORT_BREAKDOWN', 'breakdown', r.lastInsertRowid, `${reportNo} ${asset.asset_code} ${b.severity} ${b.impact}`);
    return { id: wo.id, wo_number: wo.wo_number, breakdown_id: r.lastInsertRowid, report_no: reportNo, repeat_count: count };
  });
}

function checkVersion(wo, version) {
  if (version !== undefined && version !== null && Number(version) !== wo.version) {
    throw conflict('This work order was changed by someone else since you opened it. Reload to see the latest version.', { current_version: wo.version });
  }
}
function bump(id, userId) {
  db.get().prepare('UPDATE work_orders SET version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(userId, nowIso(), id);
}

function update(ctx, id, b) {
  return db.tx(() => {
    const d = db.get();
    const wo = loadVisible(ctx.user, id);
    checkVersion(wo, b.version);
    const st = statusRow(wo.status);
    if (!isOpenCat(st.category)) throw conflict(`Work order is ${st.label} and can no longer be edited`);
    const changes = {};
    const wantsPlanning = PLANNING_FIELDS.filter(f => b[f] !== undefined);
    const wantsExec = EXECUTION_FIELDS.filter(f => b[f] !== undefined);
    if (wantsPlanning.length) {
      rbac.require(ctx.user, 'wo.assign', 'wo.assess', 'wo.create');
      for (const f of wantsPlanning) changes[f] = b[f];
      if ('priority' in changes && !PRIORITIES.includes(changes.priority)) throw bad('Invalid priority');
      if ('title' in changes && !String(changes.title || '').trim()) throw bad('Title is required');
      if ('requires_shutdown' in changes) changes.requires_shutdown = changes.requires_shutdown ? 1 : 0;
    }
    if (wantsExec.length) {
      if (!canExecute(ctx.user, wo)) throw forbidden('Only assigned personnel or supervisors can record work on this job');
      if (!EXEC_STATUSES.includes(wo.status) && wo.status !== 'ASSIGNED') throw conflict('Start the work order before recording work details');
      for (const f of wantsExec) changes[f] = b[f] === '' ? null : b[f];
      for (const f of ['test_passed', 'is_recurrence']) if (f in changes && changes[f] !== null) changes[f] = changes[f] ? 1 : 0;
      if (changes.root_cause_code && !d.prepare(`SELECT 1 FROM failure_codes WHERE kind = 'ROOT_CAUSE' AND code = ?`).get(changes.root_cause_code)) throw bad('Invalid root cause');
      if (changes.failure_mode_code && !d.prepare(`SELECT 1 FROM failure_codes WHERE kind = 'FAILURE_MODE' AND code = ?`).get(changes.failure_mode_code)) throw bad('Invalid failure mode');
      if ('meter_at_completion' in changes && changes.meter_at_completion !== null) {
        const m = Number(changes.meter_at_completion);
        const asset = d.prepare('SELECT meter_reading FROM assets WHERE id = ?').get(wo.asset_id);
        if (!Number.isFinite(m) || m < 0) throw bad('Invalid meter reading');
        if (asset.meter_reading != null && m < asset.meter_reading) throw bad(`Meter reading cannot be lower than the last recorded reading (${asset.meter_reading})`);
        changes.meter_at_completion = m;
      }
    }
    for (const f of INSTANT_FIELDS) if (f in changes) changes[f] = normaliseInstant(changes[f], f.replace('_', ' '));
    const merged = { ...wo, ...changes };
    if (merged.planned_start && merged.planned_end && merged.planned_end < merged.planned_start) throw bad('Planned completion must be after planned start');
    if (merged.actual_start && merged.actual_end && merged.actual_end < merged.actual_start) throw bad('Actual completion must be after actual start');
    if ((changes.actual_start && changes.actual_start > nowIso()) || (changes.actual_end && changes.actual_end > nowIso())) throw bad('Actual dates cannot be in the future');
    if (changes.supervisor_id) {
      const s = d.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(changes.supervisor_id);
      if (!s) throw bad('Invalid supervisor');
    }
    const n = db.updateRow('work_orders', id, changes, [...PLANNING_FIELDS, ...EXECUTION_FIELDS]);
    if (n) {
      bump(id, ctx.user.id);
      const df = audit.diff(wo, merged);
      if (df) audit.log(ctx, 'UPDATE', 'work_order', id, wo.wo_number, df[0], df[1]);
      if ('planned_end' in changes || 'supervisor_id' in changes) assetStatus.recompute(wo.asset_id, { userId: ctx.user.id });
    }
    return load(id);
  });
}

function assign(ctx, id, userIds, opts = {}) {
  rbac.require(ctx.user, 'wo.assign');
  return db.tx(() => {
    const d = db.get();
    const wo = loadVisible(ctx.user, id);
    checkVersion(wo, opts.version);
    const st = statusRow(wo.status);
    if (!isOpenCat(st.category)) throw conflict('Cannot assign a closed or cancelled work order');
    const ids = [...new Set((userIds || []).map(Number))];
    if (!ids.length) throw bad('Select at least one technician');
    for (const uid of ids) {
      const u = d.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(uid);
      if (!u) throw bad(`User ${uid} not found or inactive`);
      if (!rbac.permissionsFor(u.role_code).has('wo.execute')) throw bad(`${u.full_name} cannot execute work orders`);
      if (!u.all_sites && !d.prepare('SELECT 1 FROM user_sites WHERE user_id = ? AND site_id = ?').get(uid, wo.site_id)) throw bad(`${u.full_name} has no access to this site`);
    }
    const before = d.prepare('SELECT user_id FROM wo_assignees WHERE work_order_id = ?').all(id).map(r => r.user_id);
    d.prepare('DELETE FROM wo_assignees WHERE work_order_id = ?').run(id);
    const ins = d.prepare('INSERT INTO wo_assignees (work_order_id, user_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)');
    for (const uid of ids) ins.run(id, uid, ctx.user.id, nowIso());
    if (!wo.supervisor_id) d.prepare('UPDATE work_orders SET supervisor_id = ? WHERE id = ?').run(ctx.user.id, id);
    bump(id, ctx.user.id);
    audit.log(ctx, before.length ? 'REASSIGN' : 'ASSIGN', 'work_order', id, wo.wo_number, { assignees: before }, { assignees: ids });
    notify.onAssigned(wo, ids.filter(x => !before.includes(x)));
    const fresh = load(id);
    if (['REPORTED', 'UNDER_ASSESSMENT', 'SCHEDULED'].includes(fresh.status) && opts.advance !== false) {
      transitionInternal(ctx, fresh, 'ASSIGNED', { remarks: opts.remarks || 'Assigned' });
    }
    return load(id);
  });
}

function allowedTransitions(user, wo) {
  const rows = db.get().prepare(`SELECT t.to_status, t.permission, s.label, s.category FROM wo_transitions t JOIN wo_statuses s ON s.code = t.to_status
    WHERE t.from_status = ? AND t.wo_type IN (?, '*') AND s.is_active = 1 ORDER BY s.sort_order`).all(wo.status, wo.wo_type);
  return rows.filter(r => rbac.can(user, r.permission) && (r.permission !== 'wo.execute' || canExecute(user, wo)));
}

function labourHours(woId) {
  return db.get().prepare('SELECT COALESCE(SUM(hours),0) h FROM labor_entries WHERE work_order_id = ? AND is_void = 0').get(woId).h;
}

function guard(ctx, wo, to, p) {
  const d = db.get();
  const missing = [];
  const toCat = statusRow(to).category;
  if (to === 'ASSIGNED' && !d.prepare('SELECT 1 FROM wo_assignees WHERE work_order_id = ?').get(wo.id)) missing.push('assigned technician');
  if (to === 'FOR_TESTING' && !wo.work_performed) missing.push('work performed');
  if (to === 'FOR_VERIFICATION') {
    if (!wo.work_performed) missing.push('work performed');
    if (!wo.actual_start) missing.push('actual start');
    if (labourHours(wo.id) <= 0) missing.push('labor hours (at least one labor entry)');
    const unanswered = d.prepare(`SELECT COUNT(*) n FROM wo_checklist_results WHERE work_order_id = ? AND is_required = 1 AND (result IS NULL OR result = '')`).get(wo.id).n;
    if (unanswered) missing.push(`${unanswered} required checklist item(s)`);
    if (wo.wo_type === 'PMS' && !wo.condition_after) missing.push('equipment condition after maintenance');
    if (wo.wo_type === 'CM') {
      if (!wo.root_cause_code) missing.push('root cause');
      if (wo.root_cause_code === 'OTHER' && !wo.root_cause_remarks) missing.push('root cause remarks');
      if (!wo.failure_mode_code) missing.push('failure mode');
      if (!wo.failed_component) missing.push('failed component');
      if (!wo.repair_action) missing.push('repair action');
      if (!wo.test_results) missing.push('testing results');
      if (wo.test_passed !== 1) missing.push('passed functional test');
    }
    if (wo.schedule_id) {
      const plan = d.prepare('SELECT p.frequency FROM pms_schedules s JOIN pms_plans p ON p.id = s.plan_id WHERE s.id = ?').get(wo.schedule_id);
      if (plan && (plan.frequency === 'HOURS' || plan.frequency === 'KM') && wo.meter_at_completion == null) missing.push('meter reading at completion');
    }
  }
  if (missing.length) throw bad(`Cannot move to ${statusRow(to).label}. Missing: ${missing.join(', ')}`, { missing });
  if (toCat === 'CANCELLED' || toCat === 'MISSED') {
    if (!p.remarks || String(p.remarks).trim().length < 5) throw bad('A reason is required');
  }
  if (wo.status === 'FOR_VERIFICATION' && to === 'IN_PROGRESS' && (!p.remarks || String(p.remarks).trim().length < 3)) throw bad('State why the work is returned for rework');
  if (toCat === 'DONE') {
    if (settings.get('require_independent_verification')) {
      if (wo.submitted_by === ctx.user.id) throw forbidden('Independent verification required: you submitted this work, another authorised person must verify and close it');
      if (isAssignee(wo.id, ctx.user.id) && labourHours(wo.id) > 0 &&
        d.prepare('SELECT 1 FROM labor_entries WHERE work_order_id = ? AND user_id = ? AND is_void = 0').get(wo.id, ctx.user.id)) {
        throw forbidden('Independent verification required: you performed work on this job');
      }
    }
  }
}

function transitionInternal(ctx, wo, to, p = {}) {
  const d = db.get();
  const target = statusRow(to);
  if (!target || !target.is_active) throw bad('Unknown status');
  const t = d.prepare(`SELECT * FROM wo_transitions WHERE from_status = ? AND to_status = ? AND wo_type IN (?, '*')`).get(wo.status, to, wo.wo_type);
  if (!t) throw conflict(`A ${wo.wo_type} work order cannot move from ${statusRow(wo.status).label} to ${target.label}`);
  rbac.require(ctx.user, t.permission);
  if (t.permission === 'wo.execute' && !canExecute(ctx.user, wo)) throw forbidden('Only assigned personnel or supervisors can progress this job');
  const ts = nowIso();
  const set = {};
  if (to === 'IN_PROGRESS' && !wo.actual_start) set.actual_start = ts;
  if (to === 'FOR_VERIFICATION' || (to === 'FOR_TESTING' && !wo.actual_end)) {
    if (!wo.actual_end) set.actual_end = ts;
  }
  if (wo.status === 'FOR_VERIFICATION' && to === 'IN_PROGRESS') { set.submitted_by = null; set.submitted_at = null; set.actual_end = null; }
  if (wo.status === 'FOR_TESTING' && to === 'IN_PROGRESS') set.actual_end = null; // test failed: repair continues
  // re-evaluate guards against the values that will be stored
  const effective = { ...wo, ...set };
  guard(ctx, effective, to, p);
  if (to === 'FOR_VERIFICATION') { set.submitted_by = ctx.user.id; set.submitted_at = ts; }

  let rts = null;
  if (target.category === 'DONE') {
    rts = p.returned_to_service_at ? toIso(p.returned_to_service_at) : ts;
    if (!rts) throw bad('Invalid return-to-service time');
    if (rts > ts) throw bad('Return-to-service time cannot be in the future');
    if (effective.actual_end && rts < effective.actual_end) throw bad('Return-to-service time cannot be before actual completion');
    Object.assign(set, { verified_by: ctx.user.id, verified_at: ts, closed_by: ctx.user.id, closed_at: ts, returned_to_service_at: wo.requires_shutdown ? rts : null });
  }
  if (target.category === 'CANCELLED' || target.category === 'MISSED') Object.assign(set, { cancelled_by: ctx.user.id, cancelled_at: ts, cancel_reason: p.remarks });
  set.status = to;
  db.updateRow('work_orders', wo.id, set, ['status', 'actual_start', 'actual_end', 'submitted_by', 'submitted_at', 'verified_by', 'verified_at', 'closed_by', 'closed_at', 'returned_to_service_at', 'cancelled_by', 'cancelled_at', 'cancel_reason']);
  bump(wo.id, ctx.user.id);
  history(wo.id, wo.status, to, ctx.user.id, p.remarks, ts);

  if (target.category === 'DONE' || (wo.status === 'FOR_VERIFICATION' && to === 'IN_PROGRESS')) {
    d.prepare(`INSERT INTO approvals (entity_type, entity_id, action, decision, remarks, decided_by, decided_at) VALUES ('work_order', ?, 'VERIFY_CLOSE', ?, ?, ?, ?)`)
      .run(wo.id, target.category === 'DONE' ? 'APPROVED' : 'REJECTED', p.remarks || null, ctx.user.id, ts);
  }

  const fresh = load(wo.id);
  if (target.category === 'DONE') {
    costs.approveSystemCosts(wo.id, ctx.user.id);
    inventory.releaseReservations(wo.id);
    const completionDate = manilaDate(new Date(fresh.actual_end || ts));
    if (fresh.meter_at_completion != null) recordMeterInternal(ctx, fresh.asset_id, fresh.meter_at_completion, fresh.actual_end || ts, 'WORK_ORDER', wo.id);
    if (wo.wo_type === 'PMS') {
      d.prepare('UPDATE assets SET last_pms_date = MAX(COALESCE(last_pms_date, ?), ?) WHERE id = ?').run(completionDate, completionDate, wo.asset_id);
      if (wo.schedule_id) require('./pms').onCompleted(fresh, completionDate);
    }
  }
  if (target.category === 'CANCELLED' || target.category === 'MISSED') {
    inventory.releaseReservations(wo.id);
    if (target.category === 'MISSED' && wo.schedule_id) require('./pms').onMissed(fresh);
    if (wo.wo_type === 'CM' && p.invalid_report) {
      d.prepare('UPDATE breakdowns SET is_failure = 0 WHERE work_order_id = ?').run(wo.id);
      d.prepare('UPDATE downtime_events SET is_void = 1, end_at = COALESCE(end_at, ?) WHERE work_order_id = ?').run(ts, wo.id);
    }
  }
  assetStatus.recompute(wo.asset_id, { userId: ctx.user.id, at: target.category === 'DONE' && rts ? rts : ts });
  notify.onStatusChange(fresh, to);
  audit.log(ctx, 'STATUS', 'work_order', wo.id, `${wo.wo_number}: ${wo.status} → ${to}${p.remarks ? ' (' + p.remarks + ')' : ''}`, { status: wo.status }, { status: to });
  return fresh;
}

function transition(ctx, id, to, p = {}) {
  return db.tx(() => {
    const wo = loadVisible(ctx.user, id);
    checkVersion(wo, p.version);
    return transitionInternal(ctx, wo, to, p);
  });
}

function saveChecklist(ctx, id, results) {
  return db.tx(() => {
    const d = db.get();
    const wo = loadVisible(ctx.user, id);
    if (!canExecute(ctx.user, wo)) throw forbidden('Only assigned personnel or supervisors can fill in the checklist');
    if (!EXEC_STATUSES.includes(wo.status)) throw conflict('Start the work order before filling in the checklist');
    const upd = d.prepare('UPDATE wo_checklist_results SET result = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ? AND work_order_id = ?');
    for (const r of results || []) {
      const row = d.prepare('SELECT * FROM wo_checklist_results WHERE id = ? AND work_order_id = ?').get(r.id, id);
      if (!row) throw bad('Checklist item does not belong to this work order');
      let v = r.result == null ? null : String(r.result).trim();
      if (v && row.response_type === 'PASS_FAIL' && !['PASS', 'FAIL', 'NA'].includes(v)) throw bad('Checklist result must be PASS, FAIL or NA');
      if (v && row.response_type === 'DONE' && !['DONE', 'NA'].includes(v)) throw bad('Checklist result must be DONE or NA');
      if (v === 'FAIL' && !r.remarks) throw bad(`Remarks are required for failed item: ${row.description}`);
      upd.run(v || null, r.remarks || null, ctx.user.id, nowIso(), r.id, id);
    }
    bump(id, ctx.user.id);
    audit.log(ctx, 'CHECKLIST', 'work_order', id, `${(results || []).length} item(s) updated`);
  });
}

function addLabor(ctx, id, b) {
  return db.tx(() => {
    const d = db.get();
    const wo = loadVisible(ctx.user, id);
    if (!canExecute(ctx.user, wo)) throw forbidden('Only assigned personnel or supervisors can record labor');
    const st = statusRow(wo.status);
    if (!isOpenCat(st.category) || ['REPORTED', 'SCHEDULED', 'UNDER_ASSESSMENT'].includes(wo.status)) throw conflict('Labor can be recorded once the job is assigned and before it is closed');
    const userId = Number(b.user_id || ctx.user.id);
    if (userId !== ctx.user.id && !rbac.can(ctx.user, 'wo.assign')) throw forbidden('You can only record your own labor');
    if (!isAssignee(id, userId) && !rbac.permissionsFor(d.prepare('SELECT role_code FROM users WHERE id = ?').get(userId)?.role_code || '').has('wo.execute')) throw bad('Labor can only be recorded for maintenance personnel');
    const hours = Number(b.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw bad('Hours must be between 0 and 24');
    const workDate = b.work_date || today();
    if (!isDate(workDate)) throw bad('Invalid work date');
    if (workDate > today()) throw bad('Work date cannot be in the future');
    if (workDate < manilaDate(new Date(wo.created_at))) throw bad('Work date cannot be before the work order was created');
    const dayTotal = d.prepare('SELECT COALESCE(SUM(hours),0) h FROM labor_entries WHERE user_id = ? AND work_date = ? AND is_void = 0').get(userId, workDate).h;
    if (dayTotal + hours > 24) throw bad(`Total labor for this person on ${workDate} would exceed 24 hours (${dayTotal} already recorded)`);
    const u = d.prepare('SELECT hourly_rate FROM users WHERE id = ?').get(userId);
    const rate = u && u.hourly_rate != null ? u.hourly_rate : settings.get('default_labor_rate');
    const cost = Math.round(hours * rate * 100) / 100;
    const r = d.prepare('INSERT INTO labor_entries (work_order_id, user_id, work_date, hours, rate, cost, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, workDate, hours, rate, cost, b.notes || null, ctx.user.id, nowIso());
    const entry = d.prepare('SELECT * FROM labor_entries WHERE id = ?').get(r.lastInsertRowid);
    costs.fromLabor(entry, wo, ctx.user.id);
    bump(id, ctx.user.id);
    audit.log(ctx, 'LABOR', 'work_order', id, `${hours} h on ${workDate} for user ${userId}`);
    return entry;
  });
}

function voidLabor(ctx, id, laborId, reason) {
  return db.tx(() => {
    const d = db.get();
    const wo = loadVisible(ctx.user, id);
    const e = d.prepare('SELECT * FROM labor_entries WHERE id = ? AND work_order_id = ?').get(laborId, id);
    if (!e || e.is_void) throw notFound('Labor entry');
    if (!isOpenCat(statusRow(wo.status).category)) throw conflict('Labor on closed work orders cannot be changed');
    if (e.created_by !== ctx.user.id && !rbac.can(ctx.user, 'wo.assign')) throw forbidden();
    if (!reason) throw bad('Reason is required');
    d.prepare('UPDATE labor_entries SET is_void = 1 WHERE id = ?').run(laborId);
    costs.voidSource('LABOR', laborId);
    audit.log(ctx, 'VOID_LABOR', 'work_order', id, `Labor ${laborId} voided: ${reason}`);
  });
}

function addNote(ctx, id, note) {
  const wo = loadVisible(ctx.user, id);
  if (!note || !String(note).trim()) throw bad('Note is empty');
  if (!canExecute(ctx.user, wo) && !rbac.can(ctx.user, 'wo.assign') && wo.requested_by !== ctx.user.id) throw forbidden();
  db.get().prepare('INSERT INTO wo_progress_notes (work_order_id, note, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, String(note).trim(), ctx.user.id, nowIso());
}

function reschedule(ctx, id, b) {
  rbac.require(ctx.user, 'pms.reschedule');
  return db.tx(() => {
    const d = db.get();
    const wo = loadVisible(ctx.user, id);
    if (!isOpenCat(statusRow(wo.status).category)) throw conflict('Only open work orders can be rescheduled');
    if (!isDate(b.new_due_date)) throw bad('New due date is required');
    if (b.new_due_date < today()) throw bad('New due date cannot be in the past');
    if (!b.reason || String(b.reason).trim().length < 5) throw bad('A reason for rescheduling is required');
    d.prepare('INSERT INTO wo_reschedules (work_order_id, old_due_date, new_due_date, reason, authorized_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, wo.due_date, b.new_due_date, b.reason, ctx.user.id, nowIso());
    const useNew = settings.get('reschedule_uses_new_due');
    d.prepare('UPDATE work_orders SET due_date = ?, reschedule_count = reschedule_count + 1, planned_start = NULL, planned_end = NULL WHERE id = ?')
      .run(useNew || wo.wo_type !== 'PMS' ? b.new_due_date : wo.due_date, id);
    if (!useNew && wo.wo_type === 'PMS') d.prepare('UPDATE work_orders SET planned_start = ? WHERE id = ?').run(toIso(b.new_due_date), id);
    d.prepare(`INSERT INTO approvals (entity_type, entity_id, action, decision, remarks, decided_by, decided_at) VALUES ('work_order', ?, 'RESCHEDULE', 'APPROVED', ?, ?, ?)`)
      .run(id, b.reason, ctx.user.id, nowIso());
    bump(id, ctx.user.id);
    audit.log(ctx, 'RESCHEDULE', 'work_order', id, `${wo.wo_number}: ${wo.due_date} → ${b.new_due_date} (${b.reason})`, { due_date: wo.due_date }, { due_date: b.new_due_date });
    return load(id);
  });
}

function createLinkedCorrective(ctx, id, b) {
  rbac.require(ctx.user, 'wo.create', 'wo.execute');
  return db.tx(() => {
    const parent = loadVisible(ctx.user, id);
    if (parent.wo_type !== 'PMS' && parent.wo_type !== 'INSPECTION') throw bad('Linked corrective work orders are raised from PMS or inspection findings');
    if (!b.title) throw bad('Describe the defect requiring corrective repair');
    return createInternal(ctx, { wo_type: 'CM', asset_id: parent.asset_id, title: b.title, description: b.description || `Defect found during ${parent.wo_number}`,
      priority: b.priority || 'MEDIUM', parent_wo_id: parent.id, source: 'PMS_FINDING', requires_shutdown: b.requires_shutdown ?? 1, confirm_duplicate: true });
  });
}

function recordMeterInternal(ctx, assetId, reading, at, source, woId) {
  const d = db.get();
  const a = d.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (a.meter_type === 'NONE') throw bad('This equipment has no meter');
  const v = Number(reading);
  if (!Number.isFinite(v) || v < 0) throw bad('Invalid meter reading');
  const readAt = at || nowIso();
  if (readAt > nowIso()) throw bad('Reading time cannot be in the future');
  const prevBefore = d.prepare('SELECT reading FROM meter_readings WHERE asset_id = ? AND reading_at <= ? ORDER BY reading_at DESC, id DESC LIMIT 1').get(assetId, readAt);
  const nextAfter = d.prepare('SELECT reading FROM meter_readings WHERE asset_id = ? AND reading_at > ? ORDER BY reading_at ASC, id ASC LIMIT 1').get(assetId, readAt);
  if (prevBefore && v < prevBefore.reading) throw bad(`Reading ${v} is lower than the previous reading ${prevBefore.reading}`);
  if (nextAfter && v > nextAfter.reading) throw bad(`Reading ${v} is higher than a later reading ${nextAfter.reading}`);
  d.prepare('INSERT INTO meter_readings (asset_id, reading, reading_at, source, work_order_id, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(assetId, v, readAt, source || 'MANUAL', woId || null, ctx.user ? ctx.user.id : null, nowIso());
  if (!a.meter_read_at || readAt >= a.meter_read_at) d.prepare('UPDATE assets SET meter_reading = ?, meter_read_at = ? WHERE id = ?').run(v, readAt, assetId);
}

function recordMeter(ctx, assetId, reading, at) {
  rbac.require(ctx.user, 'asset.meter');
  return db.tx(() => {
    const a = db.get().prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!a) throw notFound('Equipment');
    rbac.requireSite(ctx.user, a.site_id);
    const readAt = at ? toIso(at) : nowIso();
    if (!readAt) throw bad('Invalid reading time');
    recordMeterInternal(ctx, assetId, reading, readAt, 'MANUAL');
    audit.log(ctx, 'METER', 'asset', assetId, `${a.asset_code} reading ${reading}`);
  });
}

module.exports = {
  TYPES, PRIORITIES, load, loadVisible, canView, canExecute, openDuplicates, createInternal, create, reportBreakdown, update, assign,
  allowedTransitions, transition, transitionInternal, saveChecklist, addLabor, voidLabor, addNote, reschedule, createLinkedCorrective,
  recordMeter, labourHours,
};
