'use strict';
// Equipment status and downtime engine.
//
// Asset status is derived from open shutdown work orders whenever one exists
// (status_source = 'WO'), so equipment can only return to service through the
// approved work order workflow. Manual statuses (Available, Operational, Standby,
// Running with Restriction, Decommissioned) may be set only when no work order is
// holding the equipment. Every status change writes asset_status_history and keeps
// downtime_events contiguous: one open event per asset while it is down.
const db = require('../db');
const audit = require('../audit');
const { nowIso } = require('../time');
const { bad, conflict } = require('../errors');

const STATUSES = {
  AVAILABLE: { label: 'Available', up: true, desc: 'Serviceable and ready for use, not currently assigned to an operation.' },
  OPERATIONAL: { label: 'Operational', up: true, desc: 'Serviceable and currently in use in production/operations.' },
  RUNNING_RESTRICTED: { label: 'Running with Restriction', up: true, desc: 'In use with a known defect or operating limit (e.g. reduced capacity). Not counted as downtime; an open corrective work order should exist.' },
  UNDER_PM: { label: 'Under Preventive Maintenance', up: false, desc: 'Taken out of service for a PMS/inspection work order in progress.' },
  UNDER_CM: { label: 'Under Corrective Maintenance', up: false, desc: 'Being repaired under a corrective work order.' },
  BREAKDOWN: { label: 'Breakdown', up: false, desc: 'Stopped by a reported failure; repair not yet started.' },
  WAITING_PARTS: { label: 'Waiting for Spare Parts', up: false, desc: 'Repair/PMS stopped pending spare parts.' },
  WAITING_EXTERNAL: { label: 'Waiting for External Service', up: false, desc: 'Waiting for a supplier or third-party service provider.' },
  FOR_TESTING: { label: 'For Inspection or Testing', up: false, desc: 'Work done; functional test or verification pending. Not released for use until the work order is closed.' },
  STANDBY: { label: 'Standby', up: true, desc: 'Serviceable but intentionally idle / reserve. Counted as available.' },
  DECOMMISSIONED: { label: 'Decommissioned', up: null, desc: 'Retired from service. Excluded from availability and PMS scheduling.' },
};
const MANUAL_STATUSES = ['AVAILABLE', 'OPERATIONAL', 'STANDBY', 'RUNNING_RESTRICTED', 'DECOMMISSIONED'];
// when several open work orders hold an asset, the first matching status in this list wins
const PRECEDENCE = ['BREAKDOWN', 'WAITING_PARTS', 'WAITING_EXTERNAL', 'UNDER_CM', 'UNDER_PM', 'FOR_TESTING', 'RUNNING_RESTRICTED'];

function downtimeCategory(status, woType) {
  switch (status) {
    case 'BREAKDOWN': case 'UNDER_CM': return 'UNPLANNED';
    case 'UNDER_PM': return woType === 'PMS' || woType === 'INSPECTION' ? 'PLANNED' : 'OTHER';
    case 'WAITING_PARTS': return 'WAITING_PARTS';
    case 'WAITING_EXTERNAL': return 'EXTERNAL';
    case 'FOR_TESTING': return woType === 'CM' ? 'UNPLANNED' : woType === 'OTHER' ? 'OTHER' : 'PLANNED';
    default: return null;
  }
}

/** Asset status a single open work order implies, or null. */
function statusFromWo(wo, statusRow, breakdown) {
  if (!wo.requires_shutdown) return null;
  if (statusRow.category !== 'OPEN' && statusRow.category !== 'HOLD') return null;
  if (statusRow.asset_effect === 'MAINT') return wo.wo_type === 'PMS' || wo.wo_type === 'INSPECTION' ? 'UNDER_PM' : 'UNDER_CM';
  if (statusRow.asset_effect) return statusRow.asset_effect;
  if (breakdown) return breakdown.impact === 'STOPPED' ? 'BREAKDOWN' : breakdown.impact === 'RESTRICTED' ? 'RUNNING_RESTRICTED' : null;
  return null;
}

function deriveFromWorkOrders(assetId) {
  const d = db.get();
  const rows = d.prepare(`SELECT w.*, s.category AS s_category, s.asset_effect AS s_effect, b.impact AS b_impact
    FROM work_orders w JOIN wo_statuses s ON s.code = w.status LEFT JOIN breakdowns b ON b.work_order_id = w.id
    WHERE w.asset_id = ? AND s.category IN ('OPEN','HOLD') ORDER BY w.id`).all(assetId);
  let best = null;
  for (const w of rows) {
    const st = statusFromWo(w, { category: w.s_category, asset_effect: w.s_effect }, w.b_impact ? { impact: w.b_impact } : null);
    if (!st) continue;
    if (!best || PRECEDENCE.indexOf(st) < PRECEDENCE.indexOf(best.status)) best = { status: st, wo: w };
  }
  return best;
}

/**
 * Low-level status change. Writes history and splits/opens/closes downtime events.
 * opts: { reason, woId, woType, userId, at, downtimeStart, source, responsible, estRecovery }
 */
function setStatus(assetId, newStatus, opts = {}) {
  if (!STATUSES[newStatus]) throw bad(`Unknown equipment status ${newStatus}`);
  const d = db.get();
  const asset = d.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  const at = opts.at || nowIso();
  const newCat = downtimeCategory(newStatus, opts.woType);
  const open = d.prepare('SELECT * FROM downtime_events WHERE asset_id = ? AND end_at IS NULL AND is_void = 0').get(assetId);
  const woId = opts.woId || null;

  const statusChanged = asset.status !== newStatus || (asset.status_wo_id || null) !== woId;
  if (open && (open.category !== newCat || (open.work_order_id || null) !== woId || open.asset_status !== newStatus)) {
    const end = at < open.start_at ? open.start_at : at;
    d.prepare('UPDATE downtime_events SET end_at = ? WHERE id = ?').run(end, open.id);
  }
  const stillOpen = open && open.category === newCat && (open.work_order_id || null) === woId && open.asset_status === newStatus;
  if (newCat && !stillOpen) {
    let start = opts.downtimeStart && opts.downtimeStart < at ? opts.downtimeStart : at;
    if (open && start < open.start_at) start = at; // never overlap the event just closed
    d.prepare(`INSERT INTO downtime_events (asset_id, site_id, work_order_id, category, asset_status, reason, start_at, source, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'AUTO', ?, ?)`).run(assetId, asset.site_id, woId, newCat, newStatus, opts.reason || STATUSES[newStatus].label, start, opts.userId || null, nowIso());
  }
  if (statusChanged) {
    d.prepare(`UPDATE assets SET status = ?, status_reason = ?, status_since = ?, status_source = ?, status_wo_id = ?,
      status_responsible = ?, est_recovery_at = ?, updated_at = ? WHERE id = ?`).run(
      newStatus, opts.reason || null, asset.status !== newStatus ? at : asset.status_since, opts.source || 'MANUAL', woId,
      opts.responsible || null, opts.estRecovery || null, nowIso(), assetId);
    if (asset.status !== newStatus) {
      d.prepare(`INSERT INTO asset_status_history (asset_id, from_status, to_status, reason, work_order_id, changed_by, changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(assetId, asset.status, newStatus, opts.reason || null, woId, opts.userId || null, at);
    }
  } else if (opts.responsible !== undefined || opts.estRecovery !== undefined) {
    d.prepare('UPDATE assets SET status_responsible = COALESCE(?, status_responsible), est_recovery_at = COALESCE(?, est_recovery_at) WHERE id = ?')
      .run(opts.responsible || null, opts.estRecovery || null, assetId);
  }
}

/**
 * Re-derive asset status from open work orders. Called after every work order
 * status change. If no work order holds the asset and its status was set by a
 * work order, the asset is returned to service (Available) at `at`.
 */
function recompute(assetId, { userId, at, reason, downtimeStart } = {}) {
  const d = db.get();
  const asset = d.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (asset.status === 'DECOMMISSIONED') return;
  const best = deriveFromWorkOrders(assetId);
  if (best) {
    const sup = best.wo.supervisor_id ? d.prepare('SELECT full_name FROM users WHERE id = ?').get(best.wo.supervisor_id) : null;
    setStatus(assetId, best.status, {
      woId: best.wo.id, woType: best.wo.wo_type, userId, at, downtimeStart, source: 'WO',
      reason: reason || `${best.wo.wo_number}: ${best.wo.title}`, responsible: sup ? sup.full_name : null, estRecovery: best.wo.planned_end,
    });
  } else if (asset.status_source === 'WO') {
    setStatus(assetId, 'AVAILABLE', { userId, at, source: 'MANUAL', reason: reason || 'Returned to service' });
  }
}

/** Manual status change by an authorised user. */
function setManualStatus(ctx, assetId, newStatus, reason) {
  if (!MANUAL_STATUSES.includes(newStatus)) throw bad(`Status ${newStatus} can only be set through a work order`);
  if (!reason || !String(reason).trim()) throw bad('A reason is required for a status change');
  const d = db.get();
  const asset = d.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  const holding = deriveFromWorkOrders(assetId);
  if (holding && holding.status !== 'RUNNING_RESTRICTED') {
    throw conflict(`Equipment is held by work order ${holding.wo.wo_number} (${STATUSES[holding.status].label}). It returns to service when that work order is verified and closed.`);
  }
  if (newStatus === 'DECOMMISSIONED') {
    const openWo = d.prepare(`SELECT w.wo_number FROM work_orders w JOIN wo_statuses s ON s.code = w.status
      WHERE w.asset_id = ? AND s.category IN ('OPEN','HOLD') LIMIT 1`).get(assetId);
    if (openWo) throw conflict(`Close or cancel open work order ${openWo.wo_number} before decommissioning`);
    d.prepare('UPDATE pms_schedules SET is_active = 0, updated_at = ? WHERE asset_id = ?').run(nowIso(), assetId);
  }
  if (asset.status === 'DECOMMISSIONED' && newStatus !== 'DECOMMISSIONED') {
    d.prepare('UPDATE pms_schedules SET is_active = 1, updated_at = ? WHERE asset_id = ?').run(nowIso(), assetId);
  }
  setStatus(assetId, newStatus, { userId: ctx.user.id, reason, source: 'MANUAL' });
  audit.log(ctx, 'STATUS_CHANGE', 'asset', assetId, `${asset.asset_code}: ${asset.status} → ${newStatus} (${reason})`, { status: asset.status }, { status: newStatus });
}

module.exports = { STATUSES, MANUAL_STATUSES, downtimeCategory, setStatus, recompute, setManualStatus, deriveFromWorkOrders };
