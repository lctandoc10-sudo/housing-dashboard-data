'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, asset } = require('./helpers');
const time = require('../server/time');
const A = require('../server/services/analytics');

test('interval math never double counts', () => {
  assert.deepEqual(A.merge([[5, 10], [1, 3], [2, 6], [12, 13]]), [[1, 10], [12, 13]]);
  assert.deepEqual(A.intersect([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.deepEqual(A.subtract([[0, 10]], [[2, 3], [5, 7]]), [[0, 2], [3, 5], [7, 10]]);
  assert.equal(A.total(A.merge([[0, 4], [2, 6]])), 6);
});

test('operating windows follow the site schedule in Asia/Manila', () => {
  // Mon 2026-06-01 .. Sun 2026-06-07, Mon–Sat 07:00–19:00 → 6 × 12 h
  const site = { op_days: '1,2,3,4,5,6', op_start: '07:00', op_end: '19:00' };
  const w = A.operatingWindows(site, time.manilaToUtc('2026-06-01').getTime(), time.manilaToUtc('2026-06-08').getTime());
  assert.equal(A.total(w) / 36e5, 72);
  assert.equal(new Date(w[0][0]).toISOString(), '2026-05-31T23:00:00.000Z', '07:00 Manila = 23:00 UTC previous day');
  const r = A.operatingWindows({ op_days: '1,2,3,4,5,6,7', op_start: '00:00', op_end: '24:00' }, time.manilaToUtc('2026-06-01').getTime(), time.manilaToUtc('2026-06-03').getTime());
  assert.equal(A.total(r) / 36e5, 48);
});

test('availability, downtime and report reconciliation', async t => {
  const T = await setup();
  t.after(() => T.close());
  const set = (d, hm) => time.setClock(time.manilaToUtc(d, hm));
  set('2026-05-31', '08:00');
  const a1 = await asset(T, 'GC-1', 'GC', 'CPF', { commissioning_date: '2025-01-01' });
  await asset(T, 'OC-1', 'OC', 'CPF', { commissioning_date: '2025-01-01' });
  // CPF default schedule from seed: Mon–Sat 06:00–22:00 (16 h/day)
  // Breakdown Mon 1 Jun 10:00, repaired and closed 12:00 → 2 h downtime inside operating hours
  set('2026-06-01', '10:00');
  const bd = (await T.as('prod').post('/breakdowns', { asset_id: a1, category_code: 'ELEC', description: 'Hoist dead', severity: 'HIGH', impact: 'STOPPED' })).body.id;
  set('2026-06-01', '10:05');
  await T.as('sup').post(`/work-orders/${bd}/assign`, { user_ids: [T.ids.tech] });
  await T.as('tech').post(`/work-orders/${bd}/transition`, { to: 'IN_PROGRESS' });
  await T.as('tech').post(`/work-orders/${bd}/labor`, { hours: 1.5 });
  await T.as('tech').put(`/work-orders/${bd}`, { work_performed: 'Replaced contactor', root_cause_code: 'ELEC', failure_mode_code: 'ELECFAULT', failed_component: 'Contactor', repair_action: 'Replaced', test_results: 'OK', test_passed: true });
  set('2026-06-01', '11:30');
  await T.as('tech').post(`/work-orders/${bd}/transition`, { to: 'FOR_TESTING' });
  await T.as('tech').post(`/work-orders/${bd}/transition`, { to: 'FOR_VERIFICATION' });
  set('2026-06-01', '12:00');
  await T.as('sup').post(`/work-orders/${bd}/transition`, { to: 'CLOSED', remarks: 'ok' });
  // Manual "other" downtime overlapping 11:00–13:00 – overlap with the breakdown must count once
  set('2026-06-02', '08:00');
  const man = await T.as('sup').post('/downtime', { asset_id: a1, category: 'OTHER', start_at: '2026-06-01T11:00', end_at: '2026-06-01T13:00', reason: 'Power interruption in bay' });
  assert.equal(man.status, 200);
  assert.ok(man.body.overlapping_events >= 1);
  // Overnight downtime outside operating hours: 23:00–05:00 should not reduce availability
  await T.as('sup').post('/downtime', { asset_id: a1, category: 'OTHER', start_at: '2026-06-01T23:00', end_at: '2026-06-02T05:00', reason: 'Night shutdown for electrical works' });
  set('2026-06-07', '23:59');

  await t.test('availability counts overlapping downtime once and ignores non-operating time (AC8)', async () => {
    const r = (await T.as('manager').get(`/availability?from=2026-06-01&to=2026-06-06&asset_id=${a1}`)).body;
    const row = r.rows[0];
    assert.equal(row.scheduled_h, 96, '6 days × 16 h');
    assert.equal(row.qualifying_downtime_h, 3, '10:00–13:00 merged, night downtime excluded');
    assert.equal(row.availability_pct, Math.round((96 - 3) / 96 * 1000) / 10);
    assert.match(r.formula, /Scheduled Operating Time/);
    assert.ok(r.assumptions.length >= 3);
  });

  await t.test('planned downtime can be excluded by configuration', async () => {
    await T.as('admin').put('/admin/settings/availability_include_planned', { value: false });
    const cats = A.qualifyingCategories();
    assert.equal(cats.has('PLANNED'), false);
    await T.as('admin').put('/admin/settings/availability_include_planned', { value: true });
    assert.equal((await T.as('admin').put('/admin/settings/pms_tolerance_days', { value: 'x' })).status, 400, 'typed settings');
  });

  await t.test('fleet availability is time-weighted across assets', async () => {
    const r = (await T.as('manager').get('/availability?from=2026-06-01&to=2026-06-06&category_id=' + T.meta.cat('GC'))).body;
    assert.equal(r.scheduled_h, 96);
    const all = (await T.as('manager').get('/availability?from=2026-06-01&to=2026-06-06')).body;
    assert.equal(all.scheduled_h, 192);
    assert.equal(all.availability_pct, Math.round((192 - 3) / 192 * 1000) / 10);
  });

  await t.test('dashboard KPIs reconcile with reports and expose their calculation (AC12)', async () => {
    const q = 'from=2026-06-01&to=2026-06-06';
    const kpis = (await T.as('manager').get(`/kpi/dashboard?${q}`)).body.kpis;
    const k = key => kpis.find(x => x.key === key);
    assert.equal(k('registered').value, 2);
    assert.equal(k('availability').value, (await T.as('manager').get(`/availability?${q}`)).body.availability_pct);
    assert.equal(k('availability').denominator, 192);
    const dt = (await T.as('manager').get(`/reports/downtime?${q}`)).body;
    assert.equal(dt.rows.length, 5, 'breakdown, under CM, for testing segments + 2 manual');
    // elapsed downtime merged per asset: 10:00–13:00 (3 h) + 23:00–05:00 (6 h)
    assert.equal(k('downtime').value, 9);
    const bh = (await T.as('manager').get(`/reports/breakdown_history?${q}`)).body;
    assert.equal(bh.rows.length, 1);
    const freq = (await T.as('manager').get(`/reports/breakdown_frequency?${q}`)).body;
    assert.equal(freq.rows[0].breakdowns, 1);
    const mttr = (await T.as('manager').get(`/kpi/reliability?${q}`)).body.mttr;
    assert.equal(Math.round(mttr.value * 100) / 100, 1.42, 'repair started 10:05, completed 11:30');
  });

  await t.test('PMS and corrective maintenance are reported separately (AC6)', async () => {
    const wo = (await T.as('manager').get('/reports/work_orders?from=2026-06-01&to=2026-06-06')).body;
    assert.ok(wo.rows.every(r => ['PMS', 'CM', 'INSPECTION', 'OTHER'].includes(r.wo_type)));
    const cm = (await T.as('manager').get('/reports/cm_register?from=2026-06-01&to=2026-06-06')).body;
    assert.equal(cm.rows.length, 1);
    const charts = (await T.as('manager').get('/kpi/charts?from=2026-06-01&to=2026-06-06')).body;
    assert.equal(charts.pms_vs_cm.reduce((s, r) => s + r.CM, 0), 1);
    assert.equal(charts.pms_vs_cm.reduce((s, r) => s + r.PMS, 0), 0);
  });

  await t.test('every report runs and exports to CSV and Excel', async () => {
    const list = (await T.as('admin').get('/reports')).body;
    assert.ok(list.length >= 18);
    for (const r of list) {
      const j = await T.as('admin').get(`/reports/${r.id}?from=2026-06-01&to=2026-06-06`);
      assert.equal(j.status, 200, r.id);
      assert.ok(Array.isArray(j.body.rows));
    }
    const csv = await T.as('admin').get('/reports/equipment_master?format=csv');
    assert.equal(csv.status, 200); assert.match(csv.body, /Equipment ID/);
    const x = await fetch(`${T.base}/reports/mtbf?format=xlsx`, { headers: { Authorization: `Bearer ${T.tokens.admin}` } });
    assert.equal(x.status, 200); assert.match(x.headers.get('content-type'), /spreadsheetml/);
    assert.equal((await T.as('prod').get('/reports')).status, 403);
    const viewerList = (await T.as('custodian').get('/reports')).body.map(r => r.id);
    assert.ok(!viewerList.includes('cost_per_equipment'), 'cost reports hidden without cost permission');
  });

  await t.test('no misleading percentages for periods without data', async () => {
    const kpis = (await T.as('manager').get('/kpi/dashboard?from=2020-01-01&to=2020-01-31')).body.kpis;
    assert.equal(kpis.find(k => k.key === 'availability').value, null, 'before commissioning → no scheduled time');
    assert.equal(kpis.find(k => k.key === 'pms_compliance').value, null);
  });
});
