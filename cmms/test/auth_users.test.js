'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, PW } = require('./helpers');

test('users and passwords', async t => {
  const T = await setup();
  t.after(() => T.close());

  await t.test('rejects wrong password and unknown user with the same message', async () => {
    const a = await T.login('tech', 'wrong-password1');
    const b = await T.login('nobody', 'wrong-password1');
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
  });

  await t.test('locks the account after 5 failed attempts; admin can unlock', async () => {
    for (let i = 0; i < 5; i++) await T.login('tech2', 'bad-password' + i);
    const locked = await T.login('tech2', PW);
    assert.equal(locked.status, 423);
    const users = (await T.as('admin').get('/admin/users')).body;
    assert.ok(users.find(u => u.username === 'tech2').locked_until);
    assert.equal((await T.as('admin').put(`/admin/users/${T.ids.tech2}`, { unlock: true })).status, 200);
    assert.equal((await T.login('tech2', PW)).status, 200);
  });

  await t.test('new user must change the temporary password; weak passwords rejected', async () => {
    const weak = await T.as('admin').post('/admin/users', { username: 'newtech', full_name: 'New Tech', role_code: 'TECHNICIAN', password: 'short', site_ids: [T.meta.site('CPF')] });
    assert.equal(weak.status, 400);
    const r = await T.as('admin').post('/admin/users', { username: 'newtech', full_name: 'New Tech', role_code: 'TECHNICIAN', password: 'Temp12345', site_ids: [T.meta.site('CPF')] });
    assert.equal(r.status, 200);
    const dup = await T.as('admin').post('/admin/users', { username: 'NEWTECH', full_name: 'Dup', role_code: 'TECHNICIAN', password: 'Temp12345' });
    assert.equal(dup.status, 409, 'usernames are unique case-insensitively');
    await T.login('newtech', 'Temp12345');
    const me = (await T.as('newtech').get('/auth/me')).body;
    assert.equal(me.must_change_password, 1);
    assert.equal((await T.as('newtech').post('/auth/change-password', { current_password: 'wrong', new_password: 'Better12345' })).status, 400);
    assert.equal((await T.as('newtech').post('/auth/change-password', { current_password: 'Temp12345', new_password: 'abcdefgh' })).status, 400, 'needs digits');
    assert.equal((await T.as('newtech').post('/auth/change-password', { current_password: 'Temp12345', new_password: 'Better12345' })).status, 200);
    assert.equal((await T.as('newtech').get('/auth/me')).body.must_change_password, 0);
    assert.equal((await T.login('newtech', 'Temp12345')).status, 401);
    assert.equal((await T.login('newtech', 'Better12345')).status, 200);
  });

  await t.test('admin password reset forces a change and signs out existing sessions', async () => {
    await T.login('prod');
    assert.equal((await T.as('prod').get('/auth/me')).status, 200);
    assert.equal((await T.as('admin').put(`/admin/users/${T.ids.prod}`, { password: 'Reset12345' })).status, 200);
    assert.equal((await T.as('prod').get('/auth/me')).status, 401, 'old session revoked');
    await T.login('prod', 'Reset12345');
    assert.equal((await T.as('prod').get('/auth/me')).body.must_change_password, 1);
  });

  await t.test('deactivated users cannot sign in; admins cannot deactivate themselves', async () => {
    assert.equal((await T.as('admin').put(`/admin/users/${T.ids.viewer}`, { is_active: false })).status, 200);
    assert.equal((await T.as('viewer').get('/auth/me')).status, 401);
    assert.equal((await T.login('viewer')).status, 401);
    assert.equal((await T.as('admin').put('/admin/users/1', { is_active: false })).status, 403);
  });

  await t.test('only administrators manage users; passwords never returned', async () => {
    assert.equal((await T.as('manager').get('/admin/users')).status, 403);
    const list = (await T.as('admin').get('/admin/users')).body;
    assert.ok(list.every(u => !('password_hash' in u)));
  });

  await t.test('logout ends the session; user actions are audited', async () => {
    await T.login('store');
    assert.equal((await T.as('store').post('/auth/logout')).status, 200);
    assert.equal((await T.as('store').get('/auth/me')).status, 401);
    const audit = (await T.as('admin').get('/admin/audit?entity_type=user')).body.rows;
    assert.ok(audit.some(a => a.action === 'CHANGE_PASSWORD'));
    assert.ok(audit.some(a => /password reset/.test(a.summary || '')));
    assert.ok(audit.some(a => /unlocked/.test(a.summary || '')));
  });
});
