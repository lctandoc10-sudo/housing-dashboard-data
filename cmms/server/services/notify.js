'use strict';
// In-app notifications, e-mail outbox and scheduled escalation checks.
// Duplicate alerts for unchanged conditions are prevented two ways: notifications
// are unique per (user, dedupe_key), and condition-based checks are tracked in
// alert_conditions so a condition only alerts again after it has cleared.
const db = require('../db');
const settings = require('../settings');
const { nowIso, now, today, HOUR, addDays, manilaDate } = require('../time');

function usersWith({ perm, role, siteId }) {
  const d = db.get();
  const params = { perm: perm || null, role: role || null, site: siteId || null };
  return d.prepare(`SELECT u.id, u.email, u.full_name FROM users u
    WHERE u.is_active = 1
      AND (@role IS NULL OR u.role_code = @role)
      AND (@perm IS NULL OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_code = u.role_code AND rp.permission = @perm))
      AND (@site IS NULL OR u.all_sites = 1 OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = @site))`).all(params);
}

function notify(userIds, n) {
  const d = db.get();
  const ins = d.prepare(`INSERT OR IGNORE INTO notifications (user_id, type, severity, title, body, entity_type, entity_id, dedupe_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ids = [...new Set(userIds.filter(Boolean))];
  let created = 0;
  for (const uid of ids) created += ins.run(uid, n.type, n.severity || 'INFO', n.title, n.body || null, n.entity_type || null, n.entity_id || null, n.dedupe_key, nowIso()).changes;
  if (created && settings.get('email_enabled')) {
    const outbox = d.prepare(`INSERT INTO notification_outbox (channel, recipient, subject, body, status, error, created_at) VALUES ('email', ?, ?, ?, ?, ?, ?)`);
    const configured = !!process.env.CMMS_SMTP_URL;
    for (const uid of ids) {
      const u = d.prepare('SELECT email FROM users WHERE id = ?').get(uid);
      if (!u || !u.email) continue;
      outbox.run(u.email, n.title, n.body || '', configured ? 'QUEUED' : 'CHANNEL_NOT_CONFIGURED', configured ? null : 'CMMS_SMTP_URL not set; e-mail not sent', nowIso());
    }
  }
  return created;
}

/** Returns true the first time a condition is seen (until it is cleared). */
function raise(key) {
  const d = db.get();
  const r = d.prepare('INSERT OR IGNORE INTO alert_conditions (key, raised_at, last_seen) VALUES (?, ?, ?)').run(key, nowIso(), nowIso());
  if (!r.changes) d.prepare('UPDATE alert_conditions SET last_seen = ? WHERE key = ?').run(nowIso(), key);
  return r.changes > 0;
}
/** Clear conditions with the prefix that are no longer active, so they can alert again in future. */
function clearExcept(prefix, activeKeys) {
  const d = db.get();
  const rows = d.prepare('SELECT key FROM alert_conditions WHERE key LIKE ?').all(prefix + '%');
  const del = d.prepare('DELETE FROM alert_conditions WHERE key = ?');
  for (const r of rows) if (!activeKeys.has(r.key)) del.run(r.key);
}

function woRecipients(wo, perm = 'wo.assign') {
  const ids = usersWith({ perm, siteId: wo.site_id }).map(u => u.id);
  const assignees = db.get().prepare('SELECT user_id FROM wo_assignees WHERE work_order_id = ?').all(wo.id).map(r => r.user_id);
  return [...ids, ...assignees];
}

// ---------------------------------------------------------------- event notifications (called from workflows)
function onCriticalBreakdown(wo, asset) {
  notify([...usersWith({ perm: 'wo.assign', siteId: wo.site_id }), ...usersWith({ perm: 'wo.close', siteId: wo.site_id })].map(u => u.id), {
    type: 'CRITICAL_BREAKDOWN', severity: 'CRITICAL', title: `CRITICAL breakdown: ${asset.asset_code} ${asset.name}`,
    body: `${wo.wo_number} – ${wo.title}`, entity_type: 'work_order', entity_id: wo.id, dedupe_key: `BD_CRITICAL:${wo.id}`,
  });
}
function onStatusChange(wo, toStatus) {
  if (toStatus === 'WAITING_PARTS') {
    notify([...woRecipients(wo), ...usersWith({ perm: 'inventory.issue', siteId: wo.site_id }).map(u => u.id)], {
      type: 'WAITING_PARTS', severity: 'WARNING', title: `Waiting for parts: ${wo.wo_number}`, body: wo.title,
      entity_type: 'work_order', entity_id: wo.id, dedupe_key: `WAITING_PARTS:${wo.id}:${nowIso()}`,
    });
  } else if (toStatus === 'FOR_TESTING' || toStatus === 'FOR_VERIFICATION') {
    notify(usersWith({ perm: 'wo.verify', siteId: wo.site_id }).map(u => u.id), {
      type: toStatus, severity: 'INFO', title: `${toStatus === 'FOR_TESTING' ? 'Ready for testing' : 'Ready for verification'}: ${wo.wo_number}`,
      body: wo.title, entity_type: 'work_order', entity_id: wo.id, dedupe_key: `${toStatus}:${wo.id}:${nowIso()}`,
    });
  }
}
function onAssigned(wo, userIds) {
  notify(userIds, { type: 'ASSIGNED', title: `Assigned to you: ${wo.wo_number}`, body: wo.title, entity_type: 'work_order', entity_id: wo.id, dedupe_key: `ASSIGNED:${wo.id}` });
}
function onRepeatFailure(wo, asset, count, windowDays) {
  notify(usersWith({ perm: 'investigation.manage', siteId: wo.site_id }).map(u => u.id), {
    type: 'REPEAT_FAILURE', severity: 'WARNING', title: `Repeat breakdown: ${asset.asset_code} (${count} in ${windowDays} days)`,
    body: `${wo.wo_number} – consider linking to a failure investigation`, entity_type: 'work_order', entity_id: wo.id, dedupe_key: `REPEAT:${wo.id}`,
  });
}

// ---------------------------------------------------------------- scheduled checks
function runChecks() {
  const d = db.get();
  const t = today();
  const nowStr = nowIso();
  const stats = { notifications: 0 };
  const add = n => { stats.notifications += n; };

  // PMS upcoming / overdue
  const tol = settings.get('pms_tolerance_days');
  const pms = d.prepare(`SELECT w.* FROM work_orders w JOIN wo_statuses s ON s.code = w.status
    WHERE w.wo_type = 'PMS' AND s.category IN ('OPEN','HOLD') AND w.due_date IS NOT NULL`).all();
  const active = new Set();
  for (const wo of pms) {
    if (wo.due_date < t) {
      const key = `PMS_OVERDUE:${wo.id}:${wo.due_date}`; active.add(key);
      if (raise(key)) add(notify(woRecipients(wo), { type: 'PMS_OVERDUE', severity: 'WARNING', title: `PMS overdue: ${wo.wo_number}`, body: `${wo.title} – due ${wo.due_date}${wo.due_date < addDays(t, -tol) ? ' (beyond tolerance)' : ''}`, entity_type: 'work_order', entity_id: wo.id, dedupe_key: key }));
    } else {
      const key = `PMS_UPCOMING:${wo.id}:${wo.due_date}`; active.add(key);
      if (raise(key)) add(notify(woRecipients(wo), { type: 'PMS_UPCOMING', title: `PMS due ${wo.due_date}: ${wo.wo_number}`, body: wo.title, entity_type: 'work_order', entity_id: wo.id, dedupe_key: key }));
    }
  }
  clearExcept('PMS_OVERDUE:', active); clearExcept('PMS_UPCOMING:', active);

  // Work orders exceeding target completion
  const late = d.prepare(`SELECT w.* FROM work_orders w JOIN wo_statuses s ON s.code = w.status
    WHERE s.category IN ('OPEN','HOLD') AND w.planned_end IS NOT NULL AND w.planned_end < ?`).all(nowStr);
  const lateKeys = new Set();
  for (const wo of late) {
    const key = `WO_LATE:${wo.id}:${wo.planned_end}`; lateKeys.add(key);
    if (raise(key)) add(notify(woRecipients(wo), { type: 'WO_LATE', severity: 'WARNING', title: `Past target completion: ${wo.wo_number}`, body: wo.title, entity_type: 'work_order', entity_id: wo.id, dedupe_key: key }));
  }
  clearExcept('WO_LATE:', lateKeys);

  // Low stock: total on hand across stores at or below the part's reorder point
  const low = d.prepare(`SELECT p.id, p.part_no, p.name, p.reorder_point, p.is_critical, COALESCE(SUM(b.qty_on_hand),0) AS qty_on_hand
    FROM parts p LEFT JOIN stock_balances b ON b.part_id = p.id
    WHERE p.is_active = 1 AND p.reorder_point > 0 GROUP BY p.id HAVING qty_on_hand <= p.reorder_point`).all();
  const lowKeys = new Set();
  for (const r of low) {
    const key = `LOW_STOCK:${r.id}`; lowKeys.add(key);
    if (raise(key)) add(notify([...usersWith({ perm: 'inventory.receive' }), ...usersWith({ perm: 'pr.approve' })].map(u => u.id), {
      type: 'LOW_STOCK', severity: r.is_critical ? 'CRITICAL' : 'WARNING', title: `${r.is_critical ? 'Critical spare' : 'Spare part'} at reorder point: ${r.part_no}`,
      body: `${r.name} – ${r.qty_on_hand} on hand (reorder point ${r.reorder_point})`, entity_type: 'part', entity_id: r.id, dedupe_key: `${key}:${nowStr}`,
    }));
  }
  clearExcept('LOW_STOCK:', lowKeys);

  // Equipment unavailable beyond threshold
  const thr = settings.get('unavailable_threshold_hours');
  const cutoff = new Date(now().getTime() - thr * HOUR).toISOString();
  const down = d.prepare(`SELECT a.*, MIN(e.start_at) AS down_since FROM assets a JOIN downtime_events e ON e.asset_id = a.id AND e.end_at IS NULL AND e.is_void = 0
    GROUP BY a.id HAVING down_since <= ?`).all(cutoff);
  const downKeys = new Set();
  for (const a of down) {
    const key = `UNAVAILABLE:${a.id}:${a.status_since}`; downKeys.add(key);
    if (raise(key)) add(notify(usersWith({ perm: 'wo.assign', siteId: a.site_id }).map(u => u.id), {
      type: 'UNAVAILABLE', severity: 'WARNING', title: `Unavailable > ${thr} h: ${a.asset_code} ${a.name}`, body: a.status_reason || a.status,
      entity_type: 'asset', entity_id: a.id, dedupe_key: key,
    }));
  }
  clearExcept('UNAVAILABLE:', downKeys);

  stats.notifications += runEscalations();
  return stats;
}

function runEscalations() {
  const d = db.get();
  const rules = d.prepare('SELECT * FROM escalation_rules WHERE is_active = 1').all();
  let created = 0;
  const nowMs = now().getTime();
  for (const r of rules) {
    const cutoff = new Date(nowMs - r.threshold_hours * HOUR).toISOString();
    let rows = [];
    const p = { cutoff, prio: r.priority, site: r.site_id };
    const scope = `(@prio IS NULL OR w.priority = @prio) AND (@site IS NULL OR w.site_id = @site)`;
    if (r.event_type === 'CRITICAL_UNASSIGNED') {
      rows = d.prepare(`SELECT w.*, w.created_at AS since FROM work_orders w JOIN wo_statuses s ON s.code = w.status
        WHERE s.category = 'OPEN' AND ${scope} AND w.created_at <= @cutoff
        AND NOT EXISTS (SELECT 1 FROM wo_assignees a WHERE a.work_order_id = w.id)`).all(p);
    } else if (r.event_type === 'WO_OVERDUE') {
      rows = d.prepare(`SELECT w.*, w.planned_end AS since FROM work_orders w JOIN wo_statuses s ON s.code = w.status
        WHERE s.category IN ('OPEN','HOLD') AND ${scope} AND w.planned_end IS NOT NULL AND w.planned_end <= @cutoff`).all(p);
    } else if (r.event_type === 'PMS_OVERDUE') {
      const dueCut = manilaDate(new Date(nowMs - r.threshold_hours * HOUR));
      rows = d.prepare(`SELECT w.*, w.due_date AS since FROM work_orders w JOIN wo_statuses s ON s.code = w.status
        WHERE w.wo_type = 'PMS' AND s.category IN ('OPEN','HOLD') AND ${scope} AND w.due_date < @due`).all({ ...p, due: dueCut });
    } else if (r.event_type === 'WAITING_PARTS') {
      rows = d.prepare(`SELECT w.*, h.changed_at AS since FROM work_orders w
        JOIN wo_status_history h ON h.id = (SELECT MAX(id) FROM wo_status_history WHERE work_order_id = w.id)
        WHERE w.status = 'WAITING_PARTS' AND ${scope} AND h.changed_at <= @cutoff`).all(p);
    } else if (r.event_type === 'ASSET_UNAVAILABLE') {
      rows = d.prepare(`SELECT a.id, a.site_id, a.asset_code AS wo_number, a.name AS title, MIN(e.start_at) AS since FROM assets a
        JOIN downtime_events e ON e.asset_id = a.id AND e.end_at IS NULL AND e.is_void = 0
        WHERE (@site IS NULL OR a.site_id = @site) GROUP BY a.id HAVING since <= @cutoff`).all(p);
    }
    for (const w of rows) {
      const entity = r.event_type === 'ASSET_UNAVAILABLE' ? 'asset' : 'work_order';
      const key = `ESC:${r.id}:${entity}:${w.id}:${w.since}`;
      created += notify(usersWith({ role: r.notify_role, siteId: w.site_id }).map(u => u.id), {
        type: 'ESCALATION', severity: 'CRITICAL', title: `Escalation – ${r.name}: ${w.wo_number}`, body: w.title,
        entity_type: entity, entity_id: w.id, dedupe_key: key,
      });
    }
  }
  return created;
}

module.exports = { usersWith, notify, raise, clearExcept, onCriticalBreakdown, onStatusChange, onAssigned, onRepeatFailure, runChecks, runEscalations };
