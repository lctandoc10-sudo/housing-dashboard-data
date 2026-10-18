'use strict';
const db = require('./db');
const { nowIso } = require('./time');

// Configurable business rules. Defaults are inserted on initialisation and can be
// changed by administrators from the Settings screen without code changes.
const DEFAULTS = {
  company_name: ['Precast Construction Solutions by Megawide', 'Company name shown on reports'],
  currency: ['PHP', 'Reporting currency (Philippine Peso)'],
  timezone: ['Asia/Manila', 'Operational timezone'],
  availability_include_planned: [true, 'Count planned (PMS) downtime against availability'],
  availability_categories: [['UNPLANNED', 'WAITING_PARTS', 'EXTERNAL', 'OTHER'], 'Downtime categories that always reduce availability (PLANNED is controlled separately)'],
  pms_tolerance_days: [3, 'PMS is compliant if completed no later than due date + this many days'],
  pms_early_window_days: [7, 'PMS completed up to this many days before due date still counts as on time'],
  reschedule_uses_new_due: [true, 'Approved rescheduling moves the compliance due date to the new date'],
  default_labor_rate: [250, 'Default internal labor rate (PHP/hour) when a technician has no rate'],
  require_independent_verification: [true, 'Verifier/closer must be different from the person who submitted the work'],
  repeat_failure_window_days: [30, 'Window for detecting repeat breakdowns of the same asset'],
  repeat_failure_threshold: [2, 'Number of breakdowns in the window that flags a repeat failure'],
  unavailable_threshold_hours: [24, 'Notify when equipment stays unavailable longer than this'],
  allow_negative_stock: [false, 'Allow issues that drive stock below zero (not recommended)'],
  scheduler_interval_minutes: [60, 'How often the PMS generator and notification checks run'],
  email_enabled: [false, 'Send notifications by e-mail (requires SMTP configuration on the server)'],
  session_hours: [12, 'Login session lifetime in hours'],
  audit_retention_days: [3650, 'Audit log retention (records are never auto-deleted below this age)'],
  pms_horizon_days: [90, 'Look-ahead horizon used by the PMS calendar forecast'],
};

function init() {
  const ins = db.get().prepare('INSERT OR IGNORE INTO settings (key, value, description, updated_at) VALUES (?, ?, ?, ?)');
  for (const [k, [v, d]] of Object.entries(DEFAULTS)) ins.run(k, JSON.stringify(v), d, nowIso());
}
function get(key) {
  const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return DEFAULTS[key] ? DEFAULTS[key][0] : undefined;
  return JSON.parse(row.value);
}
function all() {
  return db.get().prepare('SELECT key, value, description, updated_at FROM settings ORDER BY key').all()
    .map(r => ({ ...r, value: JSON.parse(r.value) }));
}
function set(key, value, userId) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  const def = DEFAULTS[key][0];
  if (typeof def !== typeof value || Array.isArray(def) !== Array.isArray(value)) throw new Error(`Setting ${key} must be of type ${Array.isArray(def) ? 'array' : typeof def}`);
  db.get().prepare('UPDATE settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(value), userId, nowIso(), key);
}
module.exports = { DEFAULTS, init, get, all, set };
