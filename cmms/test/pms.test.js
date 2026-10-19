'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, asset, completeWo } = require('./helpers');
const time = require('../server/time');
const pms = require('../server/services/pms');

const day = (d, hhmm = '08:00') => time.setClock(time.manilaToUtc(d, hhmm));

test('preventive maintenance scheduling', async t => {
  const T = await setup();
  t.after(() => T.close());
  day('2026-03-01');
  const tl1 = await asset(T, 'TL-1', 'TL'), tl2 = await asset(T, 'TL-2', 'TL');
  const gs = await asset(T, 'GS-1', 'GS', 'CPF', { meter_reading: 100 });

  let planId;
  await t.test('supervisor creates a category plan; every asset of the type gets a schedule (AC2)', async () => {
    assert.equal((await T.as('tech').post('/pms/plans', {})).status, 403);
    const r = await T.as('sup').post('/pms/plans', { code: 'PM-TL-M', name: 'Monthly TL', category_id: T.meta.cat('TL'), frequency: 'MONTHLY', interval_value: 1, lead_days: 5, checklist_template_id: T.meta.tpl(), est_labor_hours: 4, start_date: '2026-03-10' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    planId = r.body.id;
    const p = (await T.as('sup').get(`/pms/plans/${planId}`)).body;
    assert.equal(p.schedules.length, 2);
    assert.ok(p.schedules.every(s => s.next_due_date === '2026-03-10'));
  });

  await t.test('work orders are generated only inside the lead window, once per schedule', async () => {
    assert.equal(pms.generate().length, 0, 'March 1: due 10th, lead 5 days → nothing yet');
    day('2026-03-05');
    const g = pms.generate();
    assert.equal(g.length, 2);
    assert.equal(pms.generate().length, 0, 'no duplicates while open');
    const wo = (await T.as('sup').get(`/work-orders/${g[0].id}`)).body;
    assert.equal(wo.wo_type, 'PMS'); assert.equal(wo.status, 'SCHEDULED'); assert.equal(wo.due_date, '2026-03-10');
    assert.ok(wo.checklist.length > 0, 'checklist copied to work order');
    assert.match(wo.wo_number, /^PM-2026-\d{5}$/);
  });

  await t.test('new asset of the category is picked up automatically', async () => {
    const tl3 = await asset(T, 'TL-3', 'TL');
    const p = (await T.as('sup').get(`/pms/plans/${planId}`)).body;
    assert.ok(p.schedules.some(s => s.asset_id === tl3));
  });

  await t.test('upcoming and overdue PMS are flagged and notified (AC3)', async () => {
    const notify = require('../server/services/notify');
    notify.runChecks();
    const n1 = (await T.as('sup').get('/notifications')).body.rows;
    assert.ok(n1.some(n => n.type === 'PMS_UPCOMING'));
    day('2026-03-12');
    notify.runChecks(); notify.runChecks();
    const n2 = (await T.as('sup').get('/notifications')).body.rows.filter(n => n.type === 'PMS_OVERDUE');
    assert.equal(n2.length, 2, 'one overdue alert per WO, not repeated on re-check');
    const overdue = (await T.as('sup').get('/work-orders?wo_type=PMS&overdue=1')).body;
    assert.equal(overdue.total, 2);
    const k = (await T.as('manager').get('/kpi/dashboard')).body.kpis.find(x => x.key === 'overdue_pms');
    assert.equal(k.value, 2);
  });

  await t.test('PMS cannot be closed without completion records and independent approval', async () => {
    const wos = (await T.as('sup').get('/work-orders?wo_type=PMS&open=1')).body.rows;
    const id = wos.find(w => w.asset_code === 'TL-1').id;
    await T.as('sup').post(`/work-orders/${id}/assign`, { user_ids: [T.ids.tech] });
    assert.equal((await T.as('tech2').post(`/work-orders/${id}/transition`, { to: 'IN_PROGRESS' })).status, 403, 'unassigned technician cannot start');
    await T.as('tech').post(`/work-orders/${id}/transition`, { to: 'IN_PROGRESS' });
    assert.equal((await T.as('sup').get(`/assets/${tl1}`)).body.status, 'UNDER_PM');
    const sub = await T.as('tech').post(`/work-orders/${id}/transition`, { to: 'FOR_VERIFICATION' });
    assert.equal(sub.status, 400);
    assert.ok(sub.body.details.missing.includes('work performed'));
    assert.ok(sub.body.details.missing.some(m => /checklist/.test(m)));
    assert.equal((await T.as('tech').post(`/work-orders/${id}/transition`, { to: 'CLOSED' })).status, 409, 'cannot skip verification');
  });

  await t.test('completing PMS advances the schedule and returns equipment to service', async () => {
    const wos = (await T.as('sup').get('/work-orders?wo_type=PMS&open=1')).body.rows;
    const id = wos.find(w => w.asset_code === 'TL-1').id;
    // supervisor who logged labor on the job cannot self-verify
    const w = await completeWo(T, id, { tech: 'tech', verifier: 'sup' });
    assert.equal(w.status, 'CLOSED');
    const a = (await T.as('sup').get(`/assets/${tl1}`)).body;
    assert.equal(a.status, 'AVAILABLE');
    assert.equal(a.last_pms_date, '2026-03-12');
    const sched = (await T.as('sup').get(`/pms/plans/${planId}`)).body.schedules.find(s => s.asset_id === tl1);
    assert.equal(sched.next_due_date, '2026-04-10', 'fixed schedule: next cycle from previous due date');
    assert.equal(sched.last_done_date, '2026-03-12');
  });

  await t.test('rescheduling records reason and authoriser; missed PMS tracked separately', async () => {
    const wos = (await T.as('sup').get('/work-orders?wo_type=PMS&open=1')).body.rows;
    const id2 = wos.find(w => w.asset_code === 'TL-2').id;
    assert.equal((await T.as('tech').post(`/work-orders/${id2}/reschedule`, { new_due_date: '2026-03-20', reason: 'Production priority' })).status, 403);
    assert.equal((await T.as('sup').post(`/work-orders/${id2}/reschedule`, { new_due_date: '2026-03-20' })).status, 400, 'reason required');
    const r = await T.as('sup').post(`/work-orders/${id2}/reschedule`, { new_due_date: '2026-03-20', reason: 'Travel lift needed for urgent panel dispatch' });
    assert.equal(r.status, 200);
    const w = (await T.as('sup').get(`/work-orders/${id2}`)).body;
    assert.equal(w.due_date, '2026-03-20'); assert.equal(w.original_due_date, '2026-03-10');
    assert.equal(w.reschedules[0].authorized_by, T.ids.sup);
    assert.equal(w.wo_type, 'PMS');
    const id3 = wos.find(w2 => w2.asset_code === 'TL-3');
    if (id3) {
      const m = await T.as('sup').post(`/work-orders/${id3.id}/transition`, { to: 'MISSED', remarks: 'Equipment in continuous use' });
      assert.equal(m.status, 200);
    }
  });

  await t.test('PMS compliance uses the documented definition', async () => {
    day('2026-03-31', '18:00');
    const c = (await T.as('manager').get('/kpi/reliability?from=2026-03-01&to=2026-03-31')).body.pms_compliance;
    // TL-1 completed 12th (due 10th, within 3-day tolerance) = on time; TL-2 rescheduled to 20th, still open → overdue
    assert.equal(c.buckets.on_time, 1);
    assert.equal(c.buckets.overdue, 1);
    assert.equal(c.rescheduled, 1);
    assert.equal(c.denominator, c.buckets.on_time + c.buckets.late + c.buckets.early + c.buckets.missed + c.buckets.overdue);
    assert.equal(Math.round(c.value * 10) / 10, Math.round(c.numerator / c.denominator * 1000) / 10);
    const empty = (await T.as('manager').get('/kpi/reliability?from=2025-01-01&to=2025-01-31')).body.pms_compliance;
    assert.equal(empty.value, null, 'no misleading percentage without data');
  });

  await t.test('meter-based PMS generates at the hour threshold', async () => {
    const r = await T.as('sup').post('/pms/plans', { code: 'PM-GS-250', name: '250h genset', category_id: T.meta.cat('GS'), frequency: 'HOURS', interval_value: 250, lead_days: 2, lead_meter: 20 });
    assert.equal(r.status, 200);
    assert.ok(!pms.generate().some(g => g.asset_code === 'GS-1'), 'next due at 350 h');
    await T.as('sup').post(`/assets/${gs}/meter`, { reading: 335 });
    const g = pms.generate().filter(x => x.asset_code === 'GS-1');
    assert.equal(g.length, 1);
    const sub = await (async () => { try { await completeWo(T, g[0].id, { tech: 'tech', verifier: 'sup2' }); return 'ok'; } catch (e) { return e.message; } })();
    assert.equal(sub, 'ok');
    const sched = (await T.as('sup').get(`/pms/plans/${r.body.id}`)).body.schedules[0];
    assert.equal(sched.next_due_meter, 600, 'fixed: 350 + 250');
  });

  await t.test('PMS calendar shows work orders and forecast occurrences', async () => {
    const c = (await T.as('sup').get('/pms/calendar?from=2026-04-01&to=2026-06-30')).body;
    assert.ok(c.forecast.some(f => f.due_date === '2026-05-10'));
  });
});
