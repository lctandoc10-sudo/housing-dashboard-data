'use strict';
// Test harness: fresh in-memory database, master data, one user per role, and an
// HTTP client against the real Express app.
const db = require('../server/db');
const seed = require('../server/seed');
const auth = require('../server/auth');
const time = require('../server/time');
const { createApp } = require('../server/app');

const PW = 'Passw0rd123';

async function setup() {
  time.setClock(null);
  db.close();
  db.open(':memory:');
  seed.initMasterData({ adminPassword: PW });
  const d = db.get();
  d.prepare('UPDATE users SET must_change_password = 0').run();
  const site = code => d.prepare('SELECT id FROM sites WHERE code = ?').get(code).id;
  const ts = time.nowIso();
  const mk = (username, role, sites, all = 0, rate = null) => {
    const id = d.prepare(`INSERT INTO users (username, full_name, password_hash, role_code, all_sites, hourly_rate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(username, username.toUpperCase(), auth.hashPassword(PW), role, all, rate, ts, ts).lastInsertRowid;
    for (const s of sites) d.prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)').run(id, site(s));
    return id;
  };
  const ids = {
    admin: 1,
    manager: mk('manager', 'MANAGER', [], 1),
    sup: mk('sup', 'SUPERVISOR', ['CPF', 'CAL']),
    sup2: mk('sup2', 'SUPERVISOR', ['CPF']),
    tech: mk('tech', 'TECHNICIAN', ['CPF'], 0, 200),
    tech2: mk('tech2', 'TECHNICIAN', ['CPF']),
    store: mk('store', 'STOREKEEPER', ['CPF', 'CAL']),
    custodian: mk('custodian', 'CUSTODIAN', ['CAL']),
    prod: mk('prod', 'OPERATIONS', ['CPF']),
    viewer: mk('viewer', 'VIEWER', [], 1),
  };
  const server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = {};
  async function login(user, pw = PW) {
    const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) });
    const j = await r.json();
    if (r.ok) tokens[user] = j.token;
    return { status: r.status, body: j };
  }
  for (const u of Object.keys(ids)) await login(u);
  async function call(user, method, path, body) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tokens[user] ? { Authorization: `Bearer ${tokens[user]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  }
  const as = user => ({
    get: (p) => call(user, 'GET', p), post: (p, b) => call(user, 'POST', p, b || {}), put: (p, b) => call(user, 'PUT', p, b || {}), del: (p) => call(user, 'DELETE', p),
  });
  const meta = {
    site,
    cat: code => d.prepare('SELECT id FROM equipment_categories WHERE code = ?').get(code).id,
    store: code => d.prepare('SELECT id FROM stores WHERE code = ?').get(code).id,
    tpl: () => d.prepare('SELECT id FROM checklist_templates LIMIT 1').get().id,
  };
  async function close() { await new Promise(r => server.close(r)); time.setClock(null); }
  return { ids, as, login, base, meta, close, d, tokens };
}

/** Register an asset via the API as admin. */
async function asset(t, code, catCode = 'TL', siteCode = 'CPF', extra = {}) {
  const r = await t.as('admin').post('/assets', { asset_code: code, name: `${catCode} ${code}`, category_id: t.meta.cat(catCode), site_id: t.meta.site(siteCode), criticality: 'HIGH', commissioning_date: '2024-01-01', ...extra });
  if (r.status !== 200) throw new Error(`asset create failed: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Drive a work order from its current state to CLOSED with valid data. */
async function completeWo(t, woId, { tech = 'tech', verifier = 'sup', cm = false, rts } = {}) {
  let w = (await t.as(verifier).get(`/work-orders/${woId}`)).body;
  if (['REPORTED', 'SCHEDULED', 'UNDER_ASSESSMENT'].includes(w.status)) {
    const r = await t.as(verifier).post(`/work-orders/${woId}/assign`, { user_ids: [t.ids[tech]] });
    if (r.status !== 200) throw new Error('assign ' + JSON.stringify(r.body));
  }
  let r;
  w = (await t.as(verifier).get(`/work-orders/${woId}`)).body;
  if (w.status !== 'IN_PROGRESS') {
    r = await t.as(tech).post(`/work-orders/${woId}/transition`, { to: 'IN_PROGRESS' });
    if (r.status !== 200) throw new Error('start ' + JSON.stringify(r.body));
  }
  w = (await t.as(tech).get(`/work-orders/${woId}`)).body;
  if (w.checklist.length) await t.as(tech).put(`/work-orders/${woId}/checklist`, { results: w.checklist.map(c => ({ id: c.id, result: c.response_type === 'PASS_FAIL' ? 'PASS' : c.response_type === 'DONE' ? 'DONE' : '1' })) });
  await t.as(tech).post(`/work-orders/${woId}/labor`, { hours: 2 });
  const fields = { work_performed: 'Done', condition_after: 'Good / serviceable' };
  if (cm) Object.assign(fields, { root_cause_code: 'HYD', failure_mode_code: 'LEAK', failed_component: 'Hose', repair_action: 'Replaced hose', test_results: 'OK', test_passed: true });
  if (w.asset.meter_type !== 'NONE') fields.meter_at_completion = w.asset.meter_reading;
  r = await t.as(tech).put(`/work-orders/${woId}`, fields);
  if (r.status !== 200) throw new Error('update ' + JSON.stringify(r.body));
  if (cm) { r = await t.as(tech).post(`/work-orders/${woId}/transition`, { to: 'FOR_TESTING' }); if (r.status !== 200) throw new Error('testing ' + JSON.stringify(r.body)); }
  r = await t.as(tech).post(`/work-orders/${woId}/transition`, { to: 'FOR_VERIFICATION' });
  if (r.status !== 200) throw new Error('submit ' + JSON.stringify(r.body));
  r = await t.as(verifier).post(`/work-orders/${woId}/transition`, { to: 'CLOSED', remarks: 'Verified', returned_to_service_at: rts });
  if (r.status !== 200) throw new Error('close ' + JSON.stringify(r.body));
  return r.body;
}

module.exports = { setup, asset, completeWo, PW };
