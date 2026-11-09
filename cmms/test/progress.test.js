'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { setup, PW } = require('./helpers');
const auth = require('../server/auth');
const rbac = require('../server/rbac');
const time = require('../server/time');
const progress = require('../server/services/progress');

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
async function photo(T, user, id, fields = {}, buf = JPEG, name = 'site.jpg', type = 'image/jpeg') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(`${T.base}/progress-reports/${id}/photos`, { method: 'POST', headers: { Authorization: `Bearer ${T.tokens[user]}` }, body: fd });
  return { status: r.status, body: await r.json() };
}

test('site progress reports', async t => {
  process.env.CMMS_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmms-prog-'));
  const T = await setup();
  t.after(async () => { await T.close(); fs.rmSync(process.env.CMMS_UPLOAD_DIR, { recursive: true, force: true }); });
  const CAL = T.meta.site('CAL'), CPF = T.meta.site('CPF');
  // a field reporter with the new role, limited to Calauan
  const ts = time.nowIso();
  const eng = T.d.prepare(`INSERT INTO users (username, full_name, password_hash, role_code, all_sites, created_at, updated_at) VALUES ('eng', 'ENG', ?, 'PROGRESS', 0, ?, ?)`).run(auth.hashPassword(PW), ts, ts).lastInsertRowid;
  T.d.prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)').run(eng, CAL);
  await T.login('eng');
  const today = time.today();
  const yday = time.addDays(today, -1);
  let rep;

  await t.test('a field reporter submits a report; a retried upload returns the same report', async () => {
    const body = { site_id: CAL, report_date: yday, area: 'Phase 2 Blk 14', weather: 'SUNNY', work_done: 'Installed 6 FTB', ftb_installed: 6, volume_installed_m3: 12.5,
      manpower_installation: 10, manhours_installation: 80, client_request_id: 'req-1' };
    const r = await T.as('eng').post('/progress-reports', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.report_no, /^SP-\d{4}-00001$/);
    assert.equal(r.body.can.edit, true);
    assert.equal(r.body.client_request_id, undefined, 'the upload key is not sent back');
    rep = r.body;
    const again = await T.as('eng').post('/progress-reports', body);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, rep.id);
    assert.equal(again.body.already_saved, true);
    assert.equal(T.d.prepare('SELECT COUNT(*) n FROM progress_reports').get().n, 1);
    const stolen = await T.as('custodian').post('/progress-reports', { ...body, client_request_id: 'req-1' });
    assert.equal(stolen.status, 409, 'another user cannot reuse an upload key');
  });

  await t.test('validation', async () => {
    const base = { site_id: CAL, work_done: 'x', confirm_duplicate: true };
    const cases = [
      [{ report_date: time.addDays(today, 1) }, /future/],
      [{ ftb_installed: -1 }, /zero or a positive/],
      [{ ftb_installed: 1.5 }, /whole number/],
      [{ manpower_production: 2, manhours_production: 49 }, /cannot exceed manpower/],
      [{ manpower_production: 0, manhours_production: 4 }, /manpower is 0/],
      [{ work_done: '  ' }, /work accomplished/],
      [{ weather: 'FOGGY' }, /weather/],
      [{ latitude: 14.2 }, /both latitude and longitude/],
    ];
    for (const [extra, msg] of cases) {
      const r = await T.as('eng').post('/progress-reports', { ...base, ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.match(r.body.error, msg);
    }
    assert.equal((await T.as('eng').post('/progress-reports', { ...base, site_id: CPF })).status, 403, 'site outside the user scope');
    assert.equal((await T.as('tech').post('/progress-reports', { ...base, site_id: CPF })).status, 403, 'technicians do not submit progress reports');
    const noDate = await T.as('eng').post('/progress-reports', { ...base, report_date: '' });
    assert.equal(noDate.status, 200, 'an empty date means today');
    assert.equal(noDate.body.report_date, today);
  });

  await t.test('a second report for the same site and day must be confirmed', async () => {
    const r = await T.as('custodian').post('/progress-reports', { site_id: CAL, report_date: yday, work_done: 'Panel delivery', ftb_installed: 4, manpower_installation: 6 });
    assert.equal(r.status, 409);
    assert.equal(r.body.details.duplicates[0].report_no, rep.report_no);
    const ok = await T.as('custodian').post('/progress-reports', { site_id: CAL, report_date: yday, area: 'Phase 3', work_done: 'Panel delivery', ftb_installed: 4, manpower_installation: 6, manhours_installation: 48, confirm_duplicate: true });
    assert.equal(ok.status, 200);
    const check = await T.as('custodian').get(`/progress-reports/check-duplicates?site_id=${CAL}&report_date=${yday}`);
    assert.equal(check.body.length, 2);
    assert.equal((await T.as('prod').get(`/progress-reports/check-duplicates?site_id=${CAL}&report_date=${yday}`)).status, 403);
  });

  await t.test('photos: images only, de-duplicated retries, access controlled', async () => {
    const p1 = await photo(T, 'eng', rep.id, { client_photo_id: 'ph-1', caption: 'Blk 14 lots 1-3', taken_at: `${yday}T09:30` });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    const retry = await photo(T, 'eng', rep.id, { client_photo_id: 'ph-1' });
    assert.equal(retry.body.id, p1.body.id);
    assert.equal(retry.body.already_saved, true);
    assert.equal((await photo(T, 'eng', rep.id, { client_photo_id: 'ph-2' })).status, 200);
    assert.equal((await photo(T, 'eng', rep.id, {}, Buffer.from('%PDF-1.4'), 'a.pdf', 'application/pdf')).status, 400, 'PDF is not a photo');
    assert.equal((await photo(T, 'eng', rep.id, {}, Buffer.from('<svg/>'), 'x.jpg', 'image/jpeg')).status, 400, 'content must match the type');
    assert.equal((await photo(T, 'custodian', rep.id, {})).status, 403, 'only the author or a manager adds photos');
    const d = (await T.as('eng').get(`/progress-reports/${rep.id}`)).body;
    assert.equal(d.photos.length, 2);
    assert.equal(d.photos[0].caption, 'Blk 14 lots 1-3');
    assert.equal(d.photos[0].taken_at, new Date(`${yday}T09:30:00+08:00`).toISOString());
    const dl = await fetch(`${T.base}/attachments/${p1.body.id}`, { headers: { Authorization: `Bearer ${T.tokens.viewer}` } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'image/jpeg');
    const other = await fetch(`${T.base}/attachments/${p1.body.id}`, { headers: { Authorization: `Bearer ${T.tokens.prod}` } });
    assert.equal(other.status, 403, 'a CPF user cannot open Calauan photos');
    const generic = new FormData();
    generic.append('file', new Blob([JPEG], { type: 'image/jpeg' }), 'x.jpg'); generic.append('entity_type', 'progress_report'); generic.append('entity_id', String(rep.id));
    assert.equal((await fetch(`${T.base}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${T.tokens.eng}` }, body: generic })).status, 400);
    const del = await T.as('custodian').post(`/attachments/${p1.body.id}/delete`);
    assert.equal(del.status, 403);
    assert.equal((await T.as('manager').post(`/attachments/${p1.body.id}/delete`)).status, 200, 'a progress manager can remove a photo');
    assert.equal((await T.as('eng').get(`/progress-reports/${rep.id}`)).body.photos.length, 1);
  });

  await t.test('visibility: own reports without progress.view; site scope with it', async () => {
    const own = await T.as('prod').post('/progress-reports', { site_id: CPF, work_done: 'Cast 24 wall panels', volume_produced_m3: 30.25, manpower_production: 12, manhours_production: 96 });
    assert.equal(own.status, 200);
    const prodList = (await T.as('prod').get('/progress-reports?status=ALL')).body;
    assert.deepEqual(prodList.rows.map(r => r.id), [own.body.id], 'production user sees only their own report');
    assert.equal((await T.as('prod').get(`/progress-reports/${rep.id}`)).status, 403);
    assert.equal((await T.as('prod').get('/progress-reports/monthly')).status, 403, 'monthly summary needs progress.view');
    const custList = (await T.as('custodian').get('/progress-reports')).body;
    assert.ok(custList.rows.every(r => r.site_id === CAL));
    assert.equal(custList.total, 3);
    assert.equal(custList.rows.find(r => r.id === rep.id).photo_count, 1);
    assert.equal((await T.as('viewer').get('/progress-reports')).body.total, 4);
  });

  await t.test('corrections: author within the edit window, managers always; audited and versioned', async () => {
    assert.equal((await T.as('custodian').put(`/progress-reports/${rep.id}`, { ftb_installed: 7 })).status, 403, 'not the author');
    const ok = await T.as('eng').put(`/progress-reports/${rep.id}`, { ftb_installed: 7, version: rep.version });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ftb_installed, 7);
    assert.equal((await T.as('eng').put(`/progress-reports/${rep.id}`, { ftb_installed: 8, version: rep.version })).status, 409, 'stale version');
    assert.equal((await T.as('eng').put(`/progress-reports/${rep.id}`, { manhours_installation: 300 })).status, 400, 'merged values are re-checked');
    const log = T.d.prepare(`SELECT * FROM audit_logs WHERE entity_type = 'progress_report' AND entity_id = ? AND action = 'UPDATE'`).get(String(rep.id));
    assert.deepEqual(JSON.parse(log.after_json), { ftb_installed: 7 });
    T.d.prepare(`UPDATE sessions SET expires_at = '2999-01-01T00:00:00.000Z'`).run(); // keep the test sessions valid
    time.setClock(new Date(Date.now() + 9 * 864e5));
    try {
      const late = await T.as('eng').put(`/progress-reports/${rep.id}`, { area: 'Phase 2 Blk 15' });
      assert.equal(late.status, 403);
      assert.match(late.body.error, /7 days/);
      assert.equal((await T.as('manager').put(`/progress-reports/${rep.id}`, { area: 'Phase 2 Blk 15' })).status, 200);
    } finally { time.setClock(null); }
  });

  await t.test('void needs a reason, is excluded from totals and reports cannot be deleted', async () => {
    const extra = await T.as('custodian').post('/progress-reports', { site_id: CAL, report_date: yday, work_done: 'Entered twice by mistake', ftb_installed: 50, confirm_duplicate: true });
    assert.equal((await T.as('custodian').post(`/progress-reports/${extra.body.id}/void`, {})).status, 400);
    const v = await T.as('custodian').post(`/progress-reports/${extra.body.id}/void`, { reason: 'Duplicate entry' });
    assert.equal(v.status, 200);
    assert.equal(v.body.status, 'VOID');
    assert.equal(v.body.can.edit, false);
    assert.equal((await photo(T, 'custodian', extra.body.id, {})).status, 403, 'no photos on a void report');
    assert.throws(() => T.d.prepare('DELETE FROM progress_reports WHERE id = ?').run(extra.body.id), /cannot be deleted/);
    assert.equal((await T.as('custodian').get('/progress-reports?status=VOID')).body.total, 1);
  });

  await t.test('monthly roll-up sums quantities, averages daily manpower and exports the Monthly History layout', async () => {
    const month = yday.slice(0, 7);
    const m = (await T.as('manager').get(`/progress-reports/monthly?from=${month}&to=${month}&site_id=${CAL}`)).body;
    assert.equal(m.rows.length >= 1, true);
    const row = m.rows.find(r => r.month === month);
    // yesterday: eng 7 FTB / 10 people / 80 h  +  custodian 4 FTB / 6 people / 48 h  (void report excluded)
    const sameMonthToday = today.slice(0, 7) === month;
    assert.equal(row.ftb_installed, 11);
    assert.equal(row.manhours_installation, 128);
    assert.equal(row.manpower_installation, 16, 'one day of reports: 10 + 6 people');
    assert.equal(row.reports, sameMonthToday ? 3 : 2);
    assert.equal(row.photos, 1);
    assert.equal(row.workbook_site, 'Calauan (Alora+Amani)');
    assert.equal(row.installation_efficiency, Math.round((12.5 / 128) * 1e4) / 1e4);
    // a second day with 20 people: monthly manpower is the daily average (16 + 20) / 2 = 18
    const day2 = time.addDays(yday, -1);
    if (day2.slice(0, 7) === month) {
      await T.as('custodian').post('/progress-reports', { site_id: CAL, report_date: day2, work_done: 'Installation', manpower_installation: 20 });
      const m2 = (await T.as('manager').get(`/progress-reports/monthly?from=${month}&to=${month}&site_id=${CAL}`)).body;
      assert.equal(m2.rows.find(r => r.month === month).manpower_installation, 18);
    }
    assert.equal((await T.as('manager').get('/progress-reports/monthly?from=2026-13')).status, 400);
    const res = await fetch(`${T.base}/progress-reports/monthly.xlsx?from=${month}&to=${month}`, { headers: { Authorization: `Bearer ${T.tokens.manager}` } });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet('Monthly History');
    assert.deepEqual(ws.getRow(1).values.slice(1), progress.MONTHLY_HISTORY_COLUMNS);
    const cal = ws.getRows(2, ws.rowCount - 1).find(r => r.getCell(1).value === 'Calauan (Alora+Amani)');
    assert.equal(cal.getCell(2).value, month);
    assert.equal(cal.getCell(4).value, 11, 'Installed column');
    assert.equal(cal.getCell(11).value, null, 'targets are left blank');
  });

  await t.test('existing databases receive the new permissions once; later admin changes are kept', async () => {
    T.d.prepare(`DELETE FROM role_permissions WHERE permission LIKE 'progress.%' AND role_code <> 'ADMIN'`).run();
    T.d.prepare('DELETE FROM rbac_migrations').run();
    rbac.initRoles();
    const has = (role, p) => !!T.d.prepare('SELECT 1 FROM role_permissions WHERE role_code = ? AND permission = ?').get(role, p);
    assert.ok(has('CUSTODIAN', 'progress.submit') && has('CUSTODIAN', 'progress.view') && has('MANAGER', 'progress.manage') && has('VIEWER', 'progress.view'));
    assert.ok(!has('TECHNICIAN', 'progress.submit'));
    T.d.prepare(`DELETE FROM role_permissions WHERE role_code = 'CUSTODIAN' AND permission = 'progress.submit'`).run();
    rbac.initRoles();
    assert.ok(!has('CUSTODIAN', 'progress.submit'), 'an administrator\'s removal is not undone');
  });
});
