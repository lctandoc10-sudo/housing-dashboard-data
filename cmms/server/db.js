'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;
let db = null;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const row = db.prepare('SELECT version FROM schema_version').get();
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  return db;
}
function get() { if (!db) throw new Error('Database not opened'); return db; }
function close() { if (db) { db.close(); db = null; } }

/** Run fn inside a transaction (nested calls reuse the outer transaction via savepoints). */
function tx(fn) { return get().transaction(fn)(); }

/** Build a parameterised UPDATE from an object of column -> value, restricted to allowed columns. */
function updateRow(table, id, fields, allowed) {
  const cols = Object.keys(fields).filter(k => allowed.includes(k));
  if (!cols.length) return 0;
  const sql = `UPDATE ${table} SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @__id`;
  const params = { __id: id };
  for (const c of cols) params[c] = fields[c];
  return get().prepare(sql).run(params).changes;
}

function backup(dest) { return get().backup(dest); }

module.exports = { open, get, close, tx, updateRow, backup };
