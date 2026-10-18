'use strict';
const db = require('./db');
const { nowIso } = require('./time');

function log(ctx, action, entityType, entityId, summary, before, after) {
  db.get().prepare(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, summary, before_json, after_json, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ctx && ctx.user ? ctx.user.id : null, action, entityType, entityId == null ? null : String(entityId), summary || null,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ctx && ctx.ip ? ctx.ip : null, nowIso());
}
/** Shallow diff of two row objects, returning only changed keys. */
function diff(before, after) {
  const b = {}, a = {};
  for (const k of Object.keys(after)) {
    if (k === 'updated_at' || k === 'version') continue;
    if ((before[k] ?? null) !== (after[k] ?? null)) { b[k] = before[k] ?? null; a[k] = after[k] ?? null; }
  }
  return Object.keys(a).length ? [b, a] : null;
}
module.exports = { log, diff };
