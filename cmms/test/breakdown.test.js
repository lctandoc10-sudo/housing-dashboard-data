'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, asset, completeWo } = require('./helpers');
const time = require('../server/time');

const at = (d, hhmm) => time.setClock(time.manilaToUtc(d, hhmm));

test('breakdown and corrective maintenance workflow', async t => {
  const T = await setup();
  t.after(() => T.close());
  at('2026-05-04', '09:00');
  const bp = await asset(T, 'BP-CBP100', 'BP');
  const fl = await asset(T, 'FL-01', 'FL');
  let woId;

  await t.test('production user reports a breakdown; equipment goes down and downtime starts (AC4, AC7)', async () => {
    const r = await T.as('prod').post('/breakdowns', { asset_id: bp, category_code: 'MECH', description: 'Mixer arm broken during batching', severity: 'CRITICAL', impact: 'STOPPED', occurred_at: '2026-05-04T08:30', client_request_id: 'abc-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    woId = r.body.id;
    assert.match(r.body.report_no, /^BR-2026-/); assert.match(r.body.wo_number, /^CM-2026-/);
    const a = (await T.as('sup').get(`/assets/${bp}`)).body;
    assert.equal(a.status, 'BREAKDOWN');
    assert.equal(a.downtime_open.category, 'UNPLANNED');
    assert.equal(a.downtime_open.start_at, time.toIso('2026-05-04T08:30'), 'downtime starts when the failure occurred');
    const n = (await T.as('sup').get('/notifications')).body.rows;
    assert.ok(n.some(x => x.type === 'CRITICAL_BREAKDOWN' && x.entity_id === woId));
  });

  await t.test('double submission and duplicate reports are handled safely (AC15)', async () => {
    const again = await T.as('prod').post('/breakdowns', { asset_id: bp, category_code: 'MECH', description: 'Mixer arm broken during batching', severity: 'CRITICAL', impact: 'STOPPED', client_request_id: 'abc-1' });
    assert.equal(again.body.id, woId); assert.equal(again.body.duplicate_submission, true);
    const dup = await T.as('prod').post('/breakdowns', { asset_id: bp, category_code: 'MECH', description: 'Mixer not working', severity: 'HIGH', impact: 'STOPPED' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.details.duplicates[0].id, woId);
    const count = T.d.prepare('SELECT COUNT(*) n FROM breakdowns').get().n;
    assert.equal(count, 1);
    assert.equal((await T.as('prod').post('/breakdowns', { asset_id: bp, description: 'x' })).status, 400, 'validation');
    assert.equal((await T.as('prod').post('/breakdowns', { asset_id: bp, category_code: 'MECH', description: 'Future', severity: 'LOW', impact: 'NONE', occurred_at: '2026-05-05T10:00', confirm_duplicate: true })).status, 400, 'future time rejected');
  });

  await t.test('workflow: assess → assign → in progress → waiting for parts → testing → verification', async () => {
    at('2026-05-04', '09:30');
    assert.equal((await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'UNDER_ASSESSMENT' })).status, 403);
    assert.equal((await T.as('sup').post(`/work-orders/${woId}/transition`, { to: 'UNDER_ASSESSMENT' })).status, 200);
    assert.equal((await T.as('sup').post(`/work-orders/${woId}/transition`, { to: 'ASSIGNED' })).status, 400, 'needs technician');
    await T.as('sup').post(`/work-orders/${woId}/assign`, { user_ids: [T.ids.tech] });
    assert.equal((await T.as('sup').get(`/work-orders/${woId}`)).body.status, 'ASSIGNED');
    at('2026-05-04', '10:00');
    await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'IN_PROGRESS' });
    assert.equal((await T.as('sup').get(`/assets/${bp}`)).body.status, 'UNDER_CM');
    at('2026-05-04', '11:00');
    await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'WAITING_PARTS', remarks: 'Need mixer arm' });
    const a = (await T.as('sup').get(`/assets/${bp}`)).body;
    assert.equal(a.status, 'WAITING_PARTS'); assert.equal(a.downtime_open.category, 'WAITING_PARTS');
    at('2026-05-05', '08:00');
    await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'IN_PROGRESS', remarks: 'Parts arrived' });
    const noData = await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'FOR_TESTING' });
    assert.equal(noData.status, 400);
    await T.as('tech').post(`/work-orders/${woId}/labor`, { hours: 6, work_date: '2026-05-05' });
    assert.equal((await T.as('tech').post(`/work-orders/${woId}/labor`, { hours: 20, work_date: '2026-05-05' })).status, 400, 'more than 24 h in a day');
    assert.equal((await T.as('tech').post(`/work-orders/${woId}/labor`, { hours: 2, work_date: '2026-05-09' })).status, 400, 'future date');
    await T.as('tech').put(`/work-orders/${woId}`, { work_performed: 'Replaced mixer arm and blade' });
    at('2026-05-05', '12:00');
    assert.equal((await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'FOR_TESTING' })).status, 200);
    const sub = await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'FOR_VERIFICATION' });
    assert.equal(sub.status, 400, 'a technician update alone does not resolve the breakdown');
    for (const m of ['root cause', 'failure mode', 'failed component', 'repair action', 'testing results', 'passed functional test']) assert.ok(sub.body.details.missing.includes(m), m);
    await T.as('tech').put(`/work-orders/${woId}`, { root_cause_code: 'WEAR', failure_mode_code: 'BROKEN', failed_component: 'Mixer arm', repair_action: 'Replaced arm, set clearance', test_results: 'Test batch OK', test_passed: true });
    at('2026-05-05', '13:00');
    assert.equal((await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'FOR_VERIFICATION' })).status, 200);
    assert.equal((await T.as('sup').get(`/assets/${bp}`)).body.status, 'FOR_TESTING', 'not released before verification');
  });

  await t.test('no self-approval; verifier closes and returns equipment to service (AC5)', async () => {
    assert.equal((await T.as('tech').post(`/work-orders/${woId}/transition`, { to: 'CLOSED' })).status, 403, 'technician lacks close permission');
    const w = (await T.as('sup').get(`/work-orders/${woId}`)).body;
    assert.equal((await T.as('sup').post(`/work-orders/${woId}/transition`, { to: 'CLOSED', version: w.version - 1 })).status, 409, 'stale version');
    at('2026-05-05', '14:00');
    const bad = await T.as('sup').post(`/work-orders/${woId}/transition`, { to: 'CLOSED', returned_to_service_at: '2026-05-05T11:30' });
    assert.equal(bad.status, 400, 'return to service before completion rejected');
    const ok = await T.as('sup').post(`/work-orders/${woId}/transition`, { to: 'CLOSED', remarks: 'Verified', returned_to_service_at: '2026-05-05T13:30' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const a = (await T.as('sup').get(`/assets/${bp}`)).body;
    assert.equal(a.status, 'AVAILABLE');
    assert.equal(a.downtime_open, null);
    const d = (await T.as('sup').get(`/work-orders/${woId}`)).body;
    assert.equal(d.verified_by, T.ids.sup); assert.equal(d.submitted_by, T.ids.tech);
    assert.ok(d.approvals.some(x => x.action === 'VERIFY_CLOSE' && x.decision === 'APPROVED'));
    // downtime: 08:30 (4 May) → 13:30 (5 May) = 29 h, split unplanned / waiting parts
    const total = d.downtime.reduce((s, e) => s + (Date.parse(e.end_at) - Date.parse(e.start_at)) / 36e5, 0);
    assert.equal(total, 29);
    const wp = d.downtime.filter(e => e.category === 'WAITING_PARTS').reduce((s, e) => s + (Date.parse(e.end_at) - Date.parse(e.start_at)) / 36e5, 0);
    assert.equal(wp, 21, '11:00 → 08:00 next day');
    assert.equal(T.d.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE entity_type = 'work_order' AND entity_id = ?`).get(String(woId)).n > 5, true, 'audit trail (AC14)');
  });

  await t.test('independent verification also blocks a supervisor who worked on the job', async () => {
    at('2026-05-06', '09:00');
    const r = await T.as('sup').post('/breakdowns', { asset_id: fl, category_code: 'TIRE', description: 'Front tire damaged', severity: 'MEDIUM', impact: 'STOPPED' });
    await T.as('sup').post(`/work-orders/${r.body.id}/assign`, { user_ids: [T.ids.sup] });
    await assert.rejects(completeWo(T, r.body.id, { tech: 'sup', verifier: 'sup', cm: true }), /Independent verification/);
    const ok = await T.as('sup2').post(`/work-orders/${r.body.id}/transition`, { to: 'CLOSED', remarks: 'Verified by second supervisor' });
    assert.equal(ok.status, 200);
  });

  await t.test('defect found during PMS creates a linked corrective WO; PMS stays preventive', async () => {
    const w = await T.as('sup').post('/work-orders', { wo_type: 'PMS', asset_id: fl, title: 'One-off PMS', due_date: '2026-05-10' });
    assert.equal(w.status, 200);
    const cm = await T.as('sup').post(`/work-orders/${w.body.id}/linked-cm`, { title: 'Hydraulic leak found at mast cylinder' });
    assert.equal(cm.status, 200);
    const parent = (await T.as('sup').get(`/work-orders/${w.body.id}`)).body;
    assert.equal(parent.wo_type, 'PMS');
    assert.ok(parent.linked.some(l => l.id === cm.body.id && l.wo_type === 'CM'));
  });

  await t.test('invalid report cancelled: not counted as failure, downtime voided', async () => {
    const r = await T.as('prod').post('/breakdowns', { asset_id: bp, category_code: 'ELEC', description: 'Panel alarm', severity: 'LOW', impact: 'STOPPED' });
    at('2026-05-06', '10:00');
    const c = await T.as('sup').post(`/work-orders/${r.body.id}/transition`, { to: 'CANCELLED', remarks: 'False alarm – sensor dirty', invalid_report: true });
    assert.equal(c.status, 200);
    assert.equal((await T.as('sup').get(`/assets/${bp}`)).body.status, 'AVAILABLE');
    assert.equal(T.d.prepare('SELECT is_failure FROM breakdowns WHERE work_order_id = ?').get(r.body.id).is_failure, 0);
    assert.equal(T.d.prepare('SELECT COUNT(*) n FROM downtime_events WHERE work_order_id = ? AND is_void = 0').get(r.body.id).n, 0);
  });

  await t.test('repeat breakdowns are flagged and can be linked to an investigation', async () => {
    const r = await T.as('prod').post('/breakdowns', { asset_id: bp, category_code: 'MECH', description: 'Mixer arm broken again', severity: 'HIGH', impact: 'STOPPED' });
    assert.ok(r.body.repeat_count >= 2);
    assert.equal(T.d.prepare('SELECT is_recurrence FROM work_orders WHERE id = ?').get(r.body.id).is_recurrence, 1);
    const inv = await T.as('sup').post('/investigations', { asset_id: bp, title: 'Recurring mixer arm failure', work_order_ids: [woId, r.body.id] });
    assert.equal(inv.status, 200);
    const fu = await T.as('sup').post(`/investigations/${inv.body.id}/follow-up`, {});
    assert.equal(fu.status, 200);
    assert.equal(T.d.prepare('SELECT investigation_id FROM work_orders WHERE id = ?').get(fu.body.id).investigation_id, inv.body.id);
  });

  await t.test('MTTR distinguishes repair time, labor hours and downtime', async () => {
    at('2026-05-31', '18:00');
    const m = (await T.as('manager').get('/kpi/reliability?from=2026-05-01&to=2026-05-31')).body.mttr;
    assert.equal(m.denominator, 2);
    const first = T.d.prepare('SELECT actual_start, actual_end FROM work_orders WHERE id = ?').get(woId);
    assert.equal((Date.parse(first.actual_end) - Date.parse(first.actual_start)) / 36e5, 26, '10:00 → 12:00 next day (repair done, before testing)');
    assert.ok(m.mean_labor_h > 0 && m.mean_downtime_h > 0);
    const mb = (await T.as('manager').get('/kpi/reliability?from=2026-05-01&to=2026-05-31')).body.mtbf;
    assert.equal(mb.denominator, 3, 'invalid report not counted as failure');
  });
});
