'use strict';
// Auth, reference data and administration routes.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const rbac = require('../rbac');
const audit = require('../audit');
const settings = require('../settings');
const assetStatus = require('../services/assetStatus');
const notify = require('../services/notify');
const pms = require('../services/pms');
const inventory = require('../services/inventory');
const { h, need, paging } = require('./util');
const { nowIso } = require('../time');
const { bad, notFound, conflict, forbidden } = require('../errors');

const publicRouter = express.Router();
const router = express.Router();

const COOKIE = 'cmms_session';
function cookieOpts(req, expires) {
  return { httpOnly: true, sameSite: 'strict', secure: req.secure || process.env.CMMS_SECURE_COOKIE === '1', expires: new Date(expires), path: '/' };
}

publicRouter.post('/auth/login', h((req, res) => {
  const { username, password } = req.body || {};
  const s = auth.login(username, password, { ip: req.ip, userAgent: req.headers['user-agent'] });
  res.cookie(COOKIE, s.token, cookieOpts(req, s.expires_at));
  audit.log({ user: { id: s.user_id }, ip: req.ip }, 'LOGIN', 'user', s.user_id, 'Signed in');
  return { ok: true, token: s.token, expires_at: s.expires_at };
}));

router.post('/auth/logout', h((req, res) => { auth.logout(req.token); res.clearCookie(COOKIE, { path: '/' }); return { ok: true }; }));

router.get('/auth/me', h(req => {
  const u = db.get().prepare('SELECT id, username, full_name, email, phone, role_code, all_sites, position, department, must_change_password FROM users WHERE id = ?').get(req.user.id);
  const role = db.get().prepare('SELECT name FROM roles WHERE code = ?').get(u.role_code);
  return { ...u, role_name: role && role.name, permissions: [...req.user.perms], sites: req.user.sites };
}));

router.post('/auth/change-password', h(req => {
  const { current_password, new_password } = req.body || {};
  const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(String(current_password || ''), u.password_hash)) throw bad('Current password is incorrect');
  auth.validatePassword(new_password);
  if (current_password === new_password) throw bad('New password must be different');
  db.get().prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(auth.hashPassword(new_password), nowIso(), u.id);
  db.get().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(u.id, require('crypto').createHash('sha256').update(req.token).digest('hex'));
  audit.log(req.ctx, 'CHANGE_PASSWORD', 'user', u.id, 'Password changed');
  return { ok: true };
}));

// ---------------------------------------------------------------- reference data
router.get('/meta', h(req => {
  const d = db.get();
  const params = {};
  const sf = rbac.siteFilter(req.user, 'id', params);
  const sites = d.prepare(`SELECT id, code, name, site_type, is_active, op_days, op_start, op_end FROM sites WHERE ${sf} ORDER BY sort_order, name`).all(params);
  const siteIds = new Set(sites.map(s => s.id));
  return {
    company: settings.get('company_name'), currency: settings.get('currency'), timezone: settings.get('timezone'),
    sites,
    all_sites: d.prepare('SELECT id, code, name FROM sites WHERE is_active = 1 ORDER BY sort_order, name').all(),
    locations: d.prepare('SELECT id, site_id, name, is_active FROM locations ORDER BY name').all().filter(l => siteIds.has(l.site_id)),
    categories: d.prepare('SELECT * FROM equipment_categories ORDER BY name').all(),
    asset_statuses: Object.entries(assetStatus.STATUSES).map(([code, s]) => ({ code, ...s, manual: assetStatus.MANUAL_STATUSES.includes(code) })),
    wo_statuses: d.prepare('SELECT * FROM wo_statuses ORDER BY sort_order').all(),
    failure_codes: d.prepare('SELECT * FROM failure_codes WHERE is_active = 1 ORDER BY kind, label').all(),
    suppliers: d.prepare('SELECT id, name FROM suppliers WHERE is_active = 1 ORDER BY name').all(),
    stores: d.prepare('SELECT * FROM stores WHERE is_active = 1 ORDER BY name').all().filter(s => siteIds.has(s.site_id)),
    all_stores: d.prepare('SELECT id, code, name, site_id FROM stores WHERE is_active = 1 ORDER BY name').all(),
    checklists: d.prepare('SELECT id, name, category_id FROM checklist_templates WHERE is_active = 1 ORDER BY name').all(),
    personnel: d.prepare(`SELECT u.id, u.full_name, u.role_code, u.skills, u.all_sites, (SELECT GROUP_CONCAT(site_id) FROM user_sites WHERE user_id = u.id) AS site_ids
      FROM users u WHERE u.is_active = 1 AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_code = u.role_code AND rp.permission = 'wo.execute') ORDER BY u.full_name`).all(),
    pms_frequencies: pms.FREQUENCIES,
    cost_categories: ['PARTS', 'INTERNAL_LABOR', 'EXTERNAL_LABOR', 'THIRD_PARTY_SERVICE', 'RENTAL', 'OTHER'],
    settings: { pms_tolerance_days: settings.get('pms_tolerance_days'), availability_include_planned: settings.get('availability_include_planned'), require_independent_verification: settings.get('require_independent_verification') },
  };
}));

// ---------------------------------------------------------------- notifications
router.get('/notifications', h(req => {
  const { size, offset } = paging(req.query);
  const unreadOnly = req.query.unread === '1';
  const rows = db.get().prepare(`SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(req.user.id, size, offset);
  const unread = db.get().prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).n;
  return { rows, unread };
}));
router.get('/notifications/count', h(req => ({ unread: db.get().prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).n })));
router.post('/notifications/:id/read', h(req => { db.get().prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id); return { ok: true }; }));
router.post('/notifications/read-all', h(req => { db.get().prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id); return { ok: true }; }));

// ---------------------------------------------------------------- admin: users & roles
const USER_FIELDS = 'id, username, full_name, email, phone, role_code, all_sites, position, department, skills, hourly_rate, is_active, must_change_password, locked_until, failed_logins, last_login_at, created_at';
router.get('/admin/users', need('admin.users'), h(() => db.get().prepare(`SELECT ${USER_FIELDS}, (SELECT GROUP_CONCAT(site_id) FROM user_sites WHERE user_id = users.id) site_ids FROM users ORDER BY full_name`).all()));

function saveUserSites(userId, siteIds) {
  if (!Array.isArray(siteIds)) return;
  const d = db.get();
  d.prepare('DELETE FROM user_sites WHERE user_id = ?').run(userId);
  for (const s of siteIds) {
    if (!d.prepare('SELECT 1 FROM sites WHERE id = ?').get(s)) throw bad('Invalid site');
    d.prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)').run(userId, s);
  }
}
function validateUser(b, isNew) {
  if (isNew && (!b.username || !/^[A-Za-z0-9._-]{3,40}$/.test(b.username))) throw bad('Username: 3-40 letters, digits, dot, dash or underscore');
  if (b.full_name !== undefined && !String(b.full_name).trim()) throw bad('Full name is required');
  if (b.role_code !== undefined && !db.get().prepare('SELECT 1 FROM roles WHERE code = ?').get(b.role_code)) throw bad('Invalid role');
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw bad('Invalid e-mail');
  if (b.hourly_rate != null && b.hourly_rate !== '' && !(Number(b.hourly_rate) >= 0)) throw bad('Invalid hourly rate');
}
router.post('/admin/users', need('admin.users'), h(req => db.tx(() => {
  const b = req.body || {};
  validateUser(b, true);
  if (!b.role_code) throw bad('Role is required');
  auth.validatePassword(b.password);
  if (db.get().prepare('SELECT 1 FROM users WHERE username = ?').get(b.username)) throw conflict('Username already exists');
  const r = db.get().prepare(`INSERT INTO users (username, full_name, email, phone, password_hash, role_code, all_sites, position, department, skills, hourly_rate, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(b.username, b.full_name, b.email || null, b.phone || null, auth.hashPassword(b.password), b.role_code, b.all_sites ? 1 : 0,
    b.position || null, b.department || null, b.skills || null, b.hourly_rate === '' || b.hourly_rate == null ? null : Number(b.hourly_rate), nowIso(), nowIso());
  saveUserSites(r.lastInsertRowid, b.site_ids);
  audit.log(req.ctx, 'CREATE', 'user', r.lastInsertRowid, `${b.username} (${b.role_code})`);
  return { id: r.lastInsertRowid };
})));
router.put('/admin/users/:id', need('admin.users'), h(req => db.tx(() => {
  const d = db.get();
  const before = d.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(req.params.id);
  if (!before) throw notFound('User');
  const b = req.body || {};
  validateUser(b, false);
  if (Number(req.params.id) === req.user.id && (b.is_active === false || b.is_active === 0 || (b.role_code && b.role_code !== before.role_code))) throw forbidden('You cannot deactivate yourself or change your own role');
  const fields = {};
  for (const k of ['full_name', 'email', 'phone', 'role_code', 'position', 'department', 'skills']) if (k in b) fields[k] = b[k] || null;
  if ('hourly_rate' in b) fields.hourly_rate = b.hourly_rate === '' || b.hourly_rate == null ? null : Number(b.hourly_rate);
  for (const k of ['all_sites', 'is_active']) if (k in b) fields[k] = b[k] ? 1 : 0;
  fields.updated_at = nowIso();
  db.updateRow('users', req.params.id, fields, Object.keys(fields));
  saveUserSites(Number(req.params.id), b.site_ids);
  if (fields.is_active === 0) d.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  if (b.unlock) d.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(req.params.id);
  if (b.password) {
    auth.validatePassword(b.password);
    d.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?').run(auth.hashPassword(b.password), req.params.id);
    d.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  }
  const after = d.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(req.params.id);
  const df = audit.diff(before, after);
  audit.log(req.ctx, 'UPDATE', 'user', req.params.id, `${before.username}${b.password ? ' (password reset)' : ''}${b.unlock ? ' (unlocked)' : ''}${b.site_ids ? ' (sites: ' + b.site_ids.join(',') + ')' : ''}`, df && df[0], df && df[1]);
  return { ok: true };
})));

router.get('/admin/roles', need('admin.users'), h(() => {
  const d = db.get();
  return {
    permissions: rbac.PERMISSIONS,
    roles: d.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all().map(r => ({ ...r, permissions: [...rbac.permissionsFor(r.code)] })),
  };
}));
router.post('/admin/roles', need('admin.users'), h(req => {
  const b = req.body || {};
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(b.code || '')) throw bad('Role code: upper-case letters, digits, underscore');
  if (!b.name) throw bad('Role name is required');
  db.get().prepare('INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 0)').run(b.code, b.name, b.description || null);
  audit.log(req.ctx, 'CREATE', 'role', b.code, b.name);
  return { ok: true };
}));
router.put('/admin/roles/:code/permissions', need('admin.users'), h(req => db.tx(() => {
  const d = db.get();
  const code = req.params.code;
  if (!d.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)) throw notFound('Role');
  if (code === 'ADMIN') throw forbidden('System Administrator always holds every permission');
  const perms = (req.body.permissions || []).filter(p => p in rbac.PERMISSIONS);
  const before = [...rbac.permissionsFor(code)];
  d.prepare('DELETE FROM role_permissions WHERE role_code = ?').run(code);
  for (const p of perms) d.prepare('INSERT INTO role_permissions (role_code, permission) VALUES (?, ?)').run(code, p);
  audit.log(req.ctx, 'UPDATE_PERMISSIONS', 'role', code, null, { permissions: before }, { permissions: perms });
  return { ok: true };
})));

// ---------------------------------------------------------------- admin: master data (generic)
const MASTER = {
  sites: { table: 'sites', fields: ['code', 'name', 'site_type', 'address', 'op_days', 'op_start', 'op_end', 'is_active', 'sort_order'], required: ['code', 'name'], ts: true },
  locations: { table: 'locations', fields: ['site_id', 'name', 'is_active'], required: ['site_id', 'name'] },
  categories: { table: 'equipment_categories', fields: ['code', 'name', 'meter_type', 'is_active'], required: ['code', 'name'] },
  failure_codes: { table: 'failure_codes', fields: ['kind', 'code', 'label', 'is_active'], required: ['kind', 'code', 'label'], noCreatedAt: true },
  suppliers: { table: 'suppliers', fields: ['name', 'contact_person', 'phone', 'email', 'address', 'is_active'], required: ['name'] },
  stores: { table: 'stores', fields: ['site_id', 'code', 'name', 'is_active'], required: ['site_id', 'code', 'name'], noCreatedAt: true },
};
function validateMaster(kind, b) {
  if (kind === 'sites') {
    if (b.op_start && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.op_start)) throw bad('Operating start must be HH:MM');
    if (b.op_end && !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(b.op_end)) throw bad('Operating end must be HH:MM (24:00 allowed)');
    if (b.op_start && b.op_end && b.op_end !== '24:00' && b.op_end <= b.op_start) throw bad('Operating end must be after start (use 00:00–24:00 for round-the-clock)');
    if (b.op_days && !/^[1-7](,[1-7])*$/.test(b.op_days)) throw bad('Operating days: comma-separated 1 (Mon) … 7 (Sun)');
  }
}
router.get('/admin/:kind(sites|locations|categories|failure_codes|suppliers|stores)', need('admin.master'), h(req => db.get().prepare(`SELECT * FROM ${MASTER[req.params.kind].table} ORDER BY 1`).all()));
router.post('/admin/:kind(sites|locations|categories|failure_codes|suppliers|stores)', need('admin.master'), h(req => db.tx(() => {
  const m = MASTER[req.params.kind]; const b = req.body || {};
  for (const f of m.required) if (b[f] == null || b[f] === '') throw bad(`${f} is required`);
  validateMaster(req.params.kind, b);
  const cols = m.fields.filter(f => f in b);
  const vals = cols.map(f => typeof b[f] === 'boolean' ? (b[f] ? 1 : 0) : b[f]);
  if (m.ts) { cols.push('created_at', 'updated_at'); vals.push(nowIso(), nowIso()); } else if (!m.noCreatedAt) { cols.push('created_at'); vals.push(nowIso()); }
  let r;
  try { r = db.get().prepare(`INSERT INTO ${m.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('A record with this code/name already exists'); throw e; }
  if (req.params.kind === 'sites') db.get().prepare('INSERT OR IGNORE INTO stores (site_id, code, name) VALUES (?, ?, ?)').run(r.lastInsertRowid, `WH-${b.code}`, `${b.name} Warehouse`);
  audit.log(req.ctx, 'CREATE', req.params.kind, r.lastInsertRowid, JSON.stringify(b));
  return { id: r.lastInsertRowid };
})));
router.put('/admin/:kind(sites|locations|categories|failure_codes|suppliers|stores)/:id', need('admin.master'), h(req => {
  const m = MASTER[req.params.kind]; const b = req.body || {};
  const before = db.get().prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(req.params.id);
  if (!before) throw notFound();
  validateMaster(req.params.kind, { ...before, ...b });
  const fields = {};
  for (const f of m.fields) if (f in b) fields[f] = typeof b[f] === 'boolean' ? (b[f] ? 1 : 0) : b[f];
  if (m.ts) fields.updated_at = nowIso();
  try { db.updateRow(m.table, req.params.id, fields, [...m.fields, 'updated_at']); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('A record with this code/name already exists'); throw e; }
  const df = audit.diff(before, { ...before, ...fields });
  if (df) audit.log(req.ctx, 'UPDATE', req.params.kind, req.params.id, before.code || before.name, df[0], df[1]);
  return { ok: true };
}));

// checklists
router.get('/admin/checklists/:id', need('pms.view', 'admin.master'), h(req => {
  const t = db.get().prepare('SELECT * FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!t) throw notFound('Checklist');
  return { ...t, items: db.get().prepare('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY seq').all(t.id) };
}));
router.post('/admin/checklists', need('pms.plan', 'admin.master'), h(req => db.tx(() => saveChecklist(req, null))));
router.put('/admin/checklists/:id', need('pms.plan', 'admin.master'), h(req => db.tx(() => saveChecklist(req, Number(req.params.id)))));
function saveChecklist(req, id) {
  const d = db.get(); const b = req.body || {};
  if (!b.name) throw bad('Checklist name is required');
  const items = (b.items || []).filter(i => i.description && String(i.description).trim());
  if (!items.length) throw bad('Add at least one checklist item');
  for (const i of items) if (!['PASS_FAIL', 'VALUE', 'TEXT', 'DONE'].includes(i.response_type || 'PASS_FAIL')) throw bad('Invalid response type');
  if (id) {
    if (!d.prepare('SELECT 1 FROM checklist_templates WHERE id = ?').get(id)) throw notFound('Checklist');
    d.prepare('UPDATE checklist_templates SET name = ?, category_id = ?, is_active = ? WHERE id = ?').run(b.name, b.category_id || null, b.is_active === false ? 0 : 1, id);
    d.prepare('DELETE FROM checklist_items WHERE template_id = ?').run(id); // existing work orders keep their own snapshot
  } else {
    id = d.prepare('INSERT INTO checklist_templates (name, category_id, created_at) VALUES (?, ?, ?)').run(b.name, b.category_id || null, nowIso()).lastInsertRowid;
  }
  const ins = d.prepare('INSERT INTO checklist_items (template_id, seq, section, description, response_type, is_required) VALUES (?, ?, ?, ?, ?, ?)');
  items.forEach((i, n) => ins.run(id, n + 1, i.section || null, String(i.description).trim(), i.response_type || 'PASS_FAIL', i.is_required === false ? 0 : 1));
  audit.log(req.ctx, 'SAVE', 'checklist', id, `${b.name} (${items.length} items)`);
  return { id };
}

// settings
router.get('/admin/settings', need('admin.settings'), h(() => settings.all()));
router.put('/admin/settings/:key', need('admin.settings'), h(req => {
  const before = settings.get(req.params.key);
  try { settings.set(req.params.key, req.body.value, req.user.id); } catch (e) { throw bad(e.message); }
  audit.log(req.ctx, 'UPDATE', 'setting', req.params.key, null, { value: before }, { value: req.body.value });
  return { ok: true };
}));

// escalation rules
router.get('/admin/escalations', need('admin.settings'), h(() => db.get().prepare('SELECT * FROM escalation_rules ORDER BY id').all()));
router.post('/admin/escalations', need('admin.settings'), h(req => {
  const b = req.body || {};
  if (!b.name || !b.event_type || !(Number(b.threshold_hours) > 0) || !b.notify_role) throw bad('Name, event, threshold (h) and role are required');
  const r = db.get().prepare('INSERT INTO escalation_rules (name, event_type, priority, site_id, threshold_hours, notify_role, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(b.name, b.event_type, b.priority || null, b.site_id || null, Number(b.threshold_hours), b.notify_role, nowIso());
  audit.log(req.ctx, 'CREATE', 'escalation_rule', r.lastInsertRowid, b.name);
  return { id: r.lastInsertRowid };
}));
router.put('/admin/escalations/:id', need('admin.settings'), h(req => {
  const b = req.body || {};
  const fields = {};
  for (const k of ['name', 'event_type', 'priority', 'site_id', 'threshold_hours', 'notify_role', 'is_active']) if (k in b) fields[k] = typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : (b[k] === '' ? null : b[k]);
  db.updateRow('escalation_rules', req.params.id, fields, Object.keys(fields));
  audit.log(req.ctx, 'UPDATE', 'escalation_rule', req.params.id, JSON.stringify(fields));
  return { ok: true };
}));

// work order statuses & transitions (configurable workflow)
router.get('/admin/workflow', need('admin.settings'), h(() => ({
  statuses: db.get().prepare('SELECT * FROM wo_statuses ORDER BY sort_order').all(),
  transitions: db.get().prepare('SELECT * FROM wo_transitions ORDER BY wo_type, from_status, to_status').all(),
})));
router.post('/admin/workflow/statuses', need('admin.settings'), h(req => {
  const b = req.body || {};
  if (!/^[A-Z][A-Z0-9_]{2,30}$/.test(b.code || '')) throw bad('Status code: upper-case letters, digits, underscore');
  if (!b.label || !['OPEN', 'HOLD'].includes(b.category)) throw bad('Label and category (OPEN or HOLD) are required; closing states are system-defined');
  if (b.asset_effect && !['MAINT', 'WAITING_PARTS', 'WAITING_EXTERNAL', 'FOR_TESTING'].includes(b.asset_effect)) throw bad('Invalid equipment status effect');
  db.get().prepare('INSERT INTO wo_statuses (code, label, category, asset_effect, sort_order, description, is_system) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(b.code, b.label, b.category, b.asset_effect || null, Number(b.sort_order) || 85, b.description || null);
  audit.log(req.ctx, 'CREATE', 'wo_status', b.code, b.label);
  return { ok: true };
}));
router.post('/admin/workflow/transitions', need('admin.settings'), h(req => {
  const b = req.body || {};
  if (!['PMS', 'CM', 'INSPECTION', 'OTHER', '*'].includes(b.wo_type)) throw bad('Invalid work order type');
  if (!(b.permission in rbac.PERMISSIONS)) throw bad('Invalid permission');
  const st = code => db.get().prepare('SELECT * FROM wo_statuses WHERE code = ?').get(code);
  const from = st(b.from_status), to = st(b.to_status);
  if (!from || !to) throw bad('Invalid status');
  if (['DONE', 'CANCELLED', 'MISSED'].includes(from.category)) throw bad('Closed states cannot be re-opened');
  if (to.category === 'DONE' && from.code !== 'FOR_VERIFICATION') throw bad('Closure is only allowed from For Verification, so verification guards always apply');
  db.get().prepare('INSERT INTO wo_transitions (wo_type, from_status, to_status, permission) VALUES (?, ?, ?, ?)').run(b.wo_type, b.from_status, b.to_status, b.permission);
  audit.log(req.ctx, 'CREATE', 'wo_transition', `${b.wo_type}:${b.from_status}>${b.to_status}`, b.permission);
  return { ok: true };
}));
router.delete('/admin/workflow/transitions/:id', need('admin.settings'), h(req => {
  const t = db.get().prepare('SELECT * FROM wo_transitions WHERE id = ?').get(req.params.id);
  if (!t) throw notFound('Transition');
  db.get().prepare('DELETE FROM wo_transitions WHERE id = ?').run(req.params.id);
  audit.log(req.ctx, 'DELETE', 'wo_transition', req.params.id, `${t.wo_type}:${t.from_status}>${t.to_status}`);
  return { ok: true };
}));

// audit log
router.get('/admin/audit', need('audit.view'), h(req => {
  const { size, offset } = paging(req.query);
  const q = req.query; const p = { size, offset };
  const where = ['1=1'];
  if (q.entity_type) { where.push('l.entity_type = @et'); p.et = q.entity_type; }
  if (q.entity_id) { where.push('l.entity_id = @eid'); p.eid = String(q.entity_id); }
  if (q.user_id) { where.push('l.user_id = @uid'); p.uid = Number(q.user_id); }
  if (q.action) { where.push('l.action = @act'); p.act = q.action; }
  if (q.from) { where.push('l.created_at >= @from'); p.from = q.from; }
  if (q.q) { where.push('(l.summary LIKE @q OR l.entity_id LIKE @q)'); p.q = `%${q.q}%`; }
  const rows = db.get().prepare(`SELECT l.*, u.full_name user_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT @size OFFSET @offset`).all(p);
  const total = db.get().prepare(`SELECT COUNT(*) n FROM audit_logs l WHERE ${where.join(' AND ')}`).get(p).n;
  return { rows, total };
}));

// operations
router.post('/admin/run-scheduler', need('admin.settings', 'pms.plan'), h(req => {
  const created = pms.generate({ user: null, ip: req.ip });
  const checks = notify.runChecks();
  audit.log(req.ctx, 'RUN_SCHEDULER', 'system', null, `${created.length} PMS work orders generated, ${checks.notifications} notifications`);
  return { generated: created, notifications: checks.notifications };
}));
router.get('/admin/integrity', need('admin.settings', 'audit.view'), h(() => {
  const d = db.get();
  return {
    inventory_mismatches: inventory.reconcile(),
    assets_with_multiple_open_downtime: d.prepare('SELECT asset_id, COUNT(*) n FROM downtime_events WHERE end_at IS NULL AND is_void = 0 GROUP BY asset_id HAVING n > 1').all(),
    down_assets_without_open_downtime: d.prepare(`SELECT id, asset_code, status FROM assets WHERE status IN ('BREAKDOWN','UNDER_PM','UNDER_CM','WAITING_PARTS','WAITING_EXTERNAL','FOR_TESTING')
      AND NOT EXISTS (SELECT 1 FROM downtime_events e WHERE e.asset_id = assets.id AND e.end_at IS NULL AND e.is_void = 0)`).all(),
    closed_wo_missing_verification: d.prepare(`SELECT id, wo_number FROM work_orders WHERE status = 'CLOSED' AND source <> 'IMPORT' AND (verified_by IS NULL OR closed_at IS NULL)`).all(),
    negative_balances: d.prepare('SELECT * FROM stock_balances WHERE qty_on_hand < 0').all(),
    checked_at: nowIso(),
  };
}));
router.post('/admin/backup', need('admin.settings'), h(async req => {
  const path = require('path');
  const dir = process.env.CMMS_BACKUP_DIR || path.join(process.cwd(), 'data', 'backups');
  require('fs').mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cmms-${nowIso().replace(/[:.]/g, '-')}.db`);
  await db.backup(file);
  audit.log(req.ctx, 'BACKUP', 'system', null, file);
  return { ok: true, file: path.basename(file) };
}));

module.exports = { publicRouter, router, COOKIE };
