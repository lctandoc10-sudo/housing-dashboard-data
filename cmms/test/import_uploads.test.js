'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { setup, asset } = require('./helpers');
const importer = require('../server/services/importer');

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    ws.addRow(importer.SHEETS[name].map(c => c.replace('*', '')));
    for (const r of rows) ws.addRow(importer.SHEETS[name].map(c => r[c.replace('*', '')] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function upload(T, user, url, buf, name, type, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(T.base + url, { method: 'POST', headers: { Authorization: `Bearer ${T.tokens[user]}` }, body: fd });
  return { status: r.status, body: await r.json() };
}

test('Excel import and secure uploads', async t => {
  process.env.CMMS_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmms-up-'));
  const T = await setup();
  t.after(async () => { await T.close(); fs.rmSync(process.env.CMMS_UPLOAD_DIR, { recursive: true, force: true }); });

  await t.test('invalid rows are reported and nothing is imported', async () => {
    const buf = await workbook({
      Equipment: [{ asset_code: 'FL-IMP-1', name: 'Forklift', category_code: 'FL', site_code: 'CPF' }, { asset_code: 'FL-IMP-1', name: 'Dup', category_code: 'FL', site_code: 'CPF' }, { asset_code: 'X-2', name: 'Bad', category_code: 'NOPE', site_code: 'CPF' }],
    });
    const r = await upload(T, 'admin', '/import/commit', buf, 'a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(r.status, 200);
    assert.equal(r.body.committed, false);
    assert.equal(r.body.error_count, 2);
    assert.equal(T.d.prepare(`SELECT COUNT(*) n FROM assets WHERE asset_code = 'FL-IMP-1'`).get().n, 0);
  });

  await t.test('valid workbook imports equipment, parts with opening stock and history', async () => {
    const buf = await workbook({
      Equipment: [{ asset_code: 'FL-IMP-1', name: 'Forklift 5T', category_code: 'FL', site_code: 'CPF', location: 'Stockyard', criticality: 'HIGH', commissioning_date: '2023-02-01', meter_reading: 4200 }],
      Parts: [{ part_no: 'FLT-IMP', name: 'Filter', uom: 'pc', unit_cost: 500, min_qty: 2, reorder_point: 3, store_code: 'WH-CPF', opening_qty: 10 }],
      'Maintenance History': [{ asset_code: 'FL-IMP-1', wo_type: 'CM', date_completed: '2025-11-03', title: 'Mast chain replaced', root_cause_code: 'WEAR', downtime_hours: 6, cost_parts: 12000, labor_hours: 4 },
        { asset_code: 'FL-IMP-1', wo_type: 'PMS', date_completed: '2025-12-01', title: 'Monthly PMS' }],
    });
    assert.equal((await upload(T, 'manager', '/import/validate', buf, 'a.xlsx', 'application/octet-stream')).status, 403, 'import restricted to administrators');
    const v = await upload(T, 'admin', '/import/validate', buf, 'a.xlsx', 'application/octet-stream');
    assert.equal(v.body.error_count, 0, JSON.stringify(v.body.errors));
    const c = await upload(T, 'admin', '/import/commit', buf, 'a.xlsx', 'application/octet-stream');
    assert.equal(c.body.committed, true);
    const a = T.d.prepare(`SELECT * FROM assets WHERE asset_code = 'FL-IMP-1'`).get();
    assert.equal(a.meter_reading, 4200); assert.equal(a.last_pms_date, '2025-12-01');
    assert.equal(T.d.prepare(`SELECT COUNT(*) n FROM work_orders WHERE asset_id = ? AND source = 'IMPORT' AND status = 'CLOSED'`).get(a.id).n, 2);
    assert.equal(T.d.prepare(`SELECT COUNT(*) n FROM breakdowns WHERE asset_id = ?`).get(a.id).n, 1);
    assert.equal(T.d.prepare(`SELECT SUM(qty_on_hand) q FROM stock_balances b JOIN parts p ON p.id = b.part_id WHERE p.part_no = 'FLT-IMP'`).get().q, 10);
    assert.deepEqual(require('../server/services/inventory').reconcile(), []);
    const again = await upload(T, 'admin', '/import/validate', buf, 'a.xlsx', 'application/octet-stream');
    assert.ok(again.body.error_count >= 2, 'reimport detects existing records');
  });

  await t.test('uploads: allowed types only, content checked, access controlled', async () => {
    const id = await asset(T, 'TL-UP', 'TL');
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const ok = await upload(T, 'sup', '/attachments', png, 'photo.png', 'image/png', { entity_type: 'asset', entity_id: id, caption: 'Nameplate' });
    assert.equal(ok.status, 200);
    const fake = await upload(T, 'sup', '/attachments', Buffer.from('<script>alert(1)</script>'), 'x.png', 'image/png', { entity_type: 'asset', entity_id: id });
    assert.equal(fake.status, 400, 'content does not match type');
    const html = await upload(T, 'sup', '/attachments', Buffer.from('<html></html>'), 'x.html', 'text/html', { entity_type: 'asset', entity_id: id });
    assert.equal(html.status, 400);
    const ro = await upload(T, 'tech', '/attachments', png, 'p.png', 'image/png', { entity_type: 'asset', entity_id: id });
    assert.equal(ro.status, 403, 'technician cannot attach to asset master');
    const dl = await fetch(`${T.base}/attachments/${ok.body.id}`, { headers: { Authorization: `Bearer ${T.tokens.custodian}` } });
    assert.equal(dl.status, 403, 'other-site user cannot download');
    const dl2 = await fetch(`${T.base}/attachments/${ok.body.id}`, { headers: { Authorization: `Bearer ${T.tokens.tech}` } });
    assert.equal(dl2.status, 200);
    assert.equal(dl2.headers.get('x-content-type-options'), 'nosniff');
  });
});
