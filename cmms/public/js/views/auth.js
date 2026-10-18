// Login, profile and password management.
import { h, mount, api, state, toast, act, kv, pageHead, fmt } from '../ui.js';

function passwordInput(name, placeholder, autocomplete) {
  const input = h('input', { type: 'password', name, placeholder, autocomplete, required: true });
  const toggle = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': 'Show password', onclick: () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    toggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
  } }, 'Show');
  const wrap = h('div', { style: { display: 'flex', gap: '6px' } }, input, toggle);
  wrap.input = input;
  return wrap;
}

export function strength(pw) {
  const checks = [
    [pw.length >= 8, 'At least 8 characters'],
    [/[A-Za-z]/.test(pw), 'Contains letters'],
    [/\d/.test(pw), 'Contains numbers'],
    [pw.length >= 12 || /[^A-Za-z0-9]/.test(pw), 'Recommended: 12+ characters or a symbol'],
  ];
  return checks;
}
function strengthList(pw) {
  return h('ul', { class: 'sub', style: { margin: '4px 0 12px', paddingLeft: '18px' } }, ...strength(pw).map(([ok, t]) => h('li', { style: { color: ok ? 'var(--ok)' : 'var(--muted)' } }, (ok ? '✓ ' : '○ ') + t)));
}

export async function login(view) {
  if (state.me) { location.hash = window.__cmms.defaultRoute(); return; }
  const user = h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true });
  const pw = passwordInput('password', '', 'current-password');
  const err = h('div');
  const btn = h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, 'Sign in');
  const f = h('form', { onsubmit: async e => {
    e.preventDefault();
    mount(err);
    btn.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pw.input.value } });
      await window.__cmms.afterLogin();
      const back = sessionStorage.getItem('cmms_after_login');
      sessionStorage.removeItem('cmms_after_login');
      location.hash = state.me.must_change_password ? '#/profile' : (back && back !== '#/login' ? back : window.__cmms.defaultRoute());
    } catch (ex) {
      mount(err, h('div', { class: 'alert err' }, ex.message));
      pw.input.value = ''; pw.input.focus();
    } finally { btn.disabled = false; }
  } },
  h('div', { class: 'field' }, h('label', null, 'Username'), user),
  h('div', { class: 'field' }, h('label', null, 'Password'), pw),
  err, btn,
  h('p', { class: 'sub mt' }, 'Forgot your password? Ask your System Administrator to reset it. After a reset you must choose a new password at your next sign-in. Accounts lock for 15 minutes after 5 failed attempts.'));
  mount(view, h('div', { class: 'panel login-card' }, h('div', { class: 'logo-big' }, '▲'), h('h1', null, 'Precast CMMS'),
    h('p', { class: 'sub' }, 'Maintenance management – Precast Construction Solutions by Megawide'), f));
  user.focus();
}

export async function profile(view) {
  const me = state.me;
  const forced = !!me.must_change_password;
  const cur = passwordInput('current', '', 'current-password');
  const nw = passwordInput('new', '', 'new-password');
  const conf = passwordInput('confirm', '', 'new-password');
  const hints = h('div', null, strengthList(''));
  nw.input.addEventListener('input', () => mount(hints, strengthList(nw.input.value)));
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password');
  const pwForm = h('form', { onsubmit: async e => {
    e.preventDefault();
    if (nw.input.value !== conf.input.value) return toast('New password and confirmation do not match', 'err');
    await act(btn, () => api('/auth/change-password', { method: 'POST', body: { current_password: cur.input.value, new_password: nw.input.value } }), 'Password changed. Other sessions were signed out.');
    cur.input.value = nw.input.value = conf.input.value = '';
    state.me.must_change_password = 0;
    if (forced) location.hash = window.__cmms.defaultRoute();
  } },
  h('div', { class: 'field' }, h('label', null, 'Current password'), cur),
  h('div', { class: 'field' }, h('label', null, 'New password'), nw), hints,
  h('div', { class: 'field' }, h('label', null, 'Confirm new password'), conf), btn);

  const sites = me.sites === null ? 'All sites' : state.meta.sites.map(s => s.name).join(', ') || 'None assigned';
  mount(view,
    pageHead('My profile', 'Account details and password',
      h('button', { class: 'btn', onclick: async e => { await act(e.currentTarget, () => api('/auth/logout', { method: 'POST' })); state.me = null; location.hash = '#/login'; location.reload(); } }, 'Sign out')),
    forced ? h('div', { class: 'alert warn' }, 'You must set a new password before continuing (first sign-in or password reset by the administrator).') : null,
    h('div', { class: 'grid two' },
      h('div', { class: 'panel' }, h('h2', null, 'Account'), kv([
        ['Name', me.full_name], ['Username', me.username], ['Role', me.role_name], ['Position', me.position], ['Department', me.department],
        ['E-mail', me.email], ['Phone', me.phone], ['Sites', sites],
      ]), h('h3', null, 'My permissions'), h('div', { class: 'sub' }, me.permissions.sort().join(', '))),
      h('div', { class: 'panel' }, h('h2', null, 'Change password'), pwForm)));
}
