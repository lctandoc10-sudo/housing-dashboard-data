'use strict';
const db = require('./db');
const { today } = require('./time');

// Consistent document numbering: PREFIX-YYYY-NNNNN, sequence restarts each year.
const PREFIX = { PMS: 'PM', CM: 'CM', INSPECTION: 'IN', OTHER: 'OT', BREAKDOWN: 'BR', TXN: 'IT', PR: 'PR', INVESTIGATION: 'FI' };

function next(kind) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`Unknown numbering kind ${kind}`);
  const year = today().slice(0, 4);
  const key = `${prefix}-${year}`;
  const d = db.get();
  d.prepare('INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1').run(key);
  const { value } = d.prepare('SELECT value FROM counters WHERE key = ?').get(key);
  return `${key}-${String(value).padStart(5, '0')}`;
}
module.exports = { next, PREFIX };
