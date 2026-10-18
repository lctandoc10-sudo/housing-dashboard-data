'use strict';
// Time handling. Timestamps are stored as UTC ISO strings; operational calendar
// dates use Asia/Manila (UTC+08:00, no daylight saving time).
const MANILA_OFFSET_MS = 8 * 3600 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let override = null; // injectable clock for tests and historical seeding

function now() { return override ? new Date(override.getTime()) : new Date(); }
function nowIso() { return now().toISOString(); }
function setClock(d) { override = d ? new Date(d) : null; }

/** Manila calendar date (YYYY-MM-DD) of an instant. */
function manilaDate(d = now()) {
  const t = (d instanceof Date ? d : new Date(d)).getTime() + MANILA_OFFSET_MS;
  return new Date(t).toISOString().slice(0, 10);
}
function today() { return manilaDate(now()); }

/** UTC instant for a Manila local date + "HH:MM" time. */
function manilaToUtc(dateStr, hhmm = '00:00') {
  const [h, m] = hhmm.split(':').map(Number);
  const base = Date.parse(dateStr + 'T00:00:00.000Z');
  return new Date(base + (h * 60 + m) * 60000 - MANILA_OFFSET_MS);
}

function addDays(dateStr, n) {
  const d = new Date(Date.parse(dateStr + 'T00:00:00Z') + n * DAY);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY); }
/** ISO weekday (1=Mon..7=Sun) of a calendar date. */
function isoWeekday(dateStr) { const w = new Date(dateStr + 'T00:00:00Z').getUTCDay(); return w === 0 ? 7 : w; }

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s); }
function isInstant(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !isNaN(Date.parse(s)); }
/** Normalise any parseable timestamp to UTC ISO. Strings without zone are interpreted as Manila local time. */
function toIso(s) {
  if (s == null || s === '') return null;
  if (s instanceof Date) return s.toISOString();
  if (typeof s !== 'string') return null;
  if (isDate(s)) return manilaToUtc(s, '00:00').toISOString();
  if (!isInstant(s)) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const t = Date.parse(hasZone ? s : s + '+08:00');
  return isNaN(t) ? null : new Date(t).toISOString();
}
function hoursBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / HOUR; }

module.exports = { HOUR, DAY, now, nowIso, setClock, manilaDate, today, manilaToUtc, addDays, addMonths, daysBetween, isoWeekday, isDate, isInstant, toIso, hoursBetween };
