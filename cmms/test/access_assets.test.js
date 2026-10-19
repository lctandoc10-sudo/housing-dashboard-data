'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, asset } = require('./helpers');

test('access control and equipment registry', async t => {
  const T = await setup();
  t.after(() => T.close());
  const tl = await asset(T, 'TL-CPF-01', 'TL', 'CPF', { serial_no: 'SN-1', manufacturer: 'HPS' });
  const gs = await asset(T, 'GS-CAL-01', 'GS', 'CAL', { meter_reading: 1000 });

  await t.test('admin registers equipment and assigns it to a project (AC1)', async () => {
    const a = (await T.as('admin').get(`/assets/${tl}`)).body;
    assert.equal(a.asset_code, 'TL-CPF-01'); assert.equal(a.status, 'AVAILABLE'); assert.equal(a.site.code, 'CPF');
    assert.equal(a.status_history.length, 1);
  });

  await t.test('duplicate equipment ID and serial number are rejected', async () => {
    const dupCode = await T.as('admin').post('/assets', { asset_code: 'tl-cpf-01', name: 'x', category_id: T.meta.cat('TL'), site_id: T.meta.site('CPF') });
    assert.equal(dupCode.status, 409);
    const dupSerial = await T.as('admin').post('/assets', { asset_code: 'TL-X', name: 'x', category_id: T.meta.cat('TL'), site_id: T.meta.site('CPF'), serial_no: 'sn-1', manufacturer: 'hps' });
    assert.equal(dupSerial.status, 409);
    const badDates = await T.as('admin').post('/assets', { asset_code: 'TL-Y', name: 'x', category_id: T.meta.cat('TL'), site_id: T.meta.site('CPF'), date_acquired: '2025-05-01', commissioning_date: '2025-01-01' });
    assert.equal(badDates.status, 400);
  });

  await t.test('users cannot access unauthorised sites or functions (AC11)', async () => {
    assert.equal((await T.as('tech').get(`/assets/${gs}`)).status, 403, 'CPF technician cannot see CAL asset');
    const list = (await T.as('tech').get('/assets')).body;
    assert.ok(list.rows.every(r => r.site_id === T.meta.site('CPF')));
    assert.equal((await T.as('tech').post('/assets', { asset_code: 'X1', name: 'x', category_id: T.meta.cat('TL'), site_id: T.meta.site('CPF') })).status, 403);
    assert.equal((await T.as('custodian').post('/assets', { asset_code: 'X2', name: 'x', category_id: T.meta.cat('TL'), site_id: T.meta.site('CAL') })).status, 403);
    assert.equal((await T.as('sup2').post('/assets', { asset_code: 'X3', name: 'x', category_id: T.meta.cat('TL'), site_id: T.meta.site('CAL') })).status, 403, 'supervisor limited to own sites');
    assert.equal((await T.as('prod').get('/costs')).status, 403, 'production users have no cost access');
    assert.equal((await T.as('viewer').post('/breakdowns', { asset_id: tl })).status, 403, 'management viewer is read-only');
    assert.equal((await T.as('viewer').get('/kpi/dashboard')).status, 200);
    assert.equal((await T.as('tech').get('/admin/audit')).status, 403);
    const anon = await fetch(T.base + '/assets');
    assert.equal(anon.status, 401);
  });

  await t.test('asset value hidden from users without cost permission', async () => {
    await T.as('admin').put(`/assets/${tl}`, { purchase_value: 1000000 });
    assert.equal((await T.as('sup').get(`/assets/${tl}`)).body.purchase_value, 1000000);
    assert.equal((await T.as('prod').get(`/assets/${tl}`)).body.purchase_value, undefined);
  });

  await t.test('transfer preserves history; work done stays with the site where it happened', async () => {
    const r = await T.as('custodian').post('/breakdowns', { asset_id: gs, category_code: 'ELEC', description: 'Fails to start', severity: 'LOW', impact: 'NONE' });
    assert.equal(r.status, 200);
    await T.as('sup').post(`/work-orders/${r.body.id}/transition`, { to: 'CANCELLED', remarks: 'Battery recharged by operator' });
    const tr = await T.as('manager').post(`/assets/${gs}/transfer`, { to_site_id: T.meta.site('NAIC'), reason: 'Moved to Naic project' });
    assert.equal(tr.status, 200);
    const a = (await T.as('manager').get(`/assets/${gs}`)).body;
    assert.equal(a.site.code, 'NAIC');
    assert.equal(a.transfers.length, 1);
    assert.equal(a.history.length, 1);
    assert.equal(a.history[0].site, 'Calauan (Alora + Amani)');
    assert.equal((await T.as('custodian').get(`/assets/${gs}`)).status, 403, 'CAL custodian no longer sees it');
  });

  await t.test('manual status rules: maintenance statuses only via work orders', async () => {
    assert.equal((await T.as('sup').post(`/assets/${tl}/status`, { status: 'BREAKDOWN', reason: 'x' })).status, 400);
    assert.equal((await T.as('sup').post(`/assets/${tl}/status`, { status: 'OPERATIONAL' })).status, 400, 'reason required');
    assert.equal((await T.as('sup').post(`/assets/${tl}/status`, { status: 'OPERATIONAL', reason: 'Assigned to casting' })).status, 200);
  });

  await t.test('meter readings must not go backwards', async () => {
    await T.as('admin').post(`/assets/${gs}/meter`, { reading: 1100 });
    assert.equal((await T.as('admin').post(`/assets/${gs}/meter`, { reading: 1050 })).status, 400);
    assert.equal((await T.as('admin').post(`/assets/${tl}/meter`, { reading: 10 })).status, 200, 'travel lifts have hour meters');
  });

  await t.test('QR code returns SVG pointing at the asset profile', async () => {
    const r = await fetch(`${T.base}/assets/${tl}/qr.svg`, { headers: { Authorization: `Bearer ${T.tokens.tech}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /svg/);
    const byCode = await T.as('tech').get('/assets/by-code/TL-CPF-01');
    assert.equal(byCode.body.id, tl);
    assert.equal(byCode.body.actions.report_breakdown, true);
    assert.equal(byCode.body.actions.edit, false);
  });
});
