// App shell: session, navigation (permission-based) and hash router.
import { h, mount, api, state, can, canAny, $, errorBox, toast } from './ui.js';
import * as auth from './views/auth.js';
import * as dashboard from './views/dashboard.js';
import * as assets from './views/assets.js';
import * as wo from './views/workorders.js';
import * as pms from './views/pms.js';
import * as ops from './views/operations.js';
import * as inv from './views/inventory.js';
import * as rep from './views/reports.js';
import * as admin from './views/admin.js';

const NAV = [
  ['Overview', [['#/dashboard', 'Dashboard', () => can('kpi.view')], ['#/availability', 'Availability board', () => can('downtime.view')], ['#/notifications', 'Notifications', () => true]]],
  ['Maintenance', [
    ['#/report', 'Report breakdown', () => can('breakdown.report')],
    ['#/wo', 'Work orders', () => canAny('wo.view', 'wo.view_assigned')],
    ['#/my', 'My jobs', () => can('wo.execute')],
    ['#/pms/calendar', 'PMS calendar', () => can('pms.view')],
    ['#/pms', 'PMS plans', () => can('pms.view')],
    ['#/breakdowns', 'Breakdown register', () => can('wo.view')],
    ['#/investigations', 'Failure investigations', () => can('wo.view')],
    ['#/team', 'Technician workload', () => canAny('team.view', 'wo.assign')],
  ]],
  ['Assets', [['#/assets', 'Equipment registry', () => can('asset.view')], ['#/scan', 'Scan QR code', () => can('asset.view')]]],
  ['Stores & costs', [['#/inventory', 'Spare parts', () => can('inventory.view')], ['#/prs', 'Purchase requests', () => canAny('inventory.view', 'pr.create')], ['#/costs', 'Maintenance costs', () => can('cost.view')]]],
  ['Analysis', [['#/reports', 'Reports & exports', () => can('report.view')]]],
  ['Administration', [
    ['#/admin/users', 'Users & passwords', () => can('admin.users')], ['#/admin/roles', 'Roles & permissions', () => can('admin.users')],
    ['#/admin/master', 'Sites & master data', () => can('admin.master')], ['#/admin/checklists', 'Checklists', () => canAny('pms.plan', 'admin.master')],
    ['#/admin/settings', 'Settings & rules', () => can('admin.settings')], ['#/admin/workflow', 'Workflow', () => can('admin.settings')],
    ['#/import', 'Import from Excel', () => can('import.run')], ['#/admin/audit', 'Audit log', () => can('audit.view')],
  ]],
  ['Account', [['#/profile', 'My profile & password', () => true]]],
];

const ROUTES = [
  [/^\/login$/, auth.login, true],
  [/^\/profile$/, auth.profile],
  [/^\/dashboard$/, dashboard.view],
  [/^\/availability$/, ops.availability],
  [/^\/notifications$/, ops.notifications],
  [/^\/report$/, wo.reportBreakdown],
  [/^\/wo$/, wo.list],
  [/^\/my$/, wo.myJobs],
  [/^\/wo\/new$/, wo.create],
  [/^\/wo\/(\d+)$/, wo.detail],
  [/^\/breakdowns$/, wo.breakdowns],
  [/^\/investigations$/, wo.investigations],
  [/^\/investigations\/(\d+)$/, wo.investigation],
  [/^\/pms$/, pms.plans],
  [/^\/pms\/plans\/(new|\d+)$/, pms.plan],
  [/^\/pms\/calendar$/, pms.calendar],
  [/^\/team$/, ops.team],
  [/^\/assets$/, assets.list],
  [/^\/assets\/new$/, assets.edit],
  [/^\/assets\/(\d+)\/edit$/, assets.edit],
  [/^\/assets\/(\d+)$/, assets.detail],
  [/^\/a\/(.+)$/, assets.byCode],
  [/^\/scan$/, assets.scan],
  [/^\/inventory$/, inv.parts],
  [/^\/inventory\/parts\/(\d+)$/, inv.part],
  [/^\/prs$/, inv.prs],
  [/^\/costs$/, inv.costs],
  [/^\/reports$/, rep.list],
  [/^\/reports\/(\w+)$/, rep.report],
  [/^\/import$/, admin.importer],
  [/^\/admin\/users$/, admin.users],
  [/^\/admin\/roles$/, admin.roles],
  [/^\/admin\/master$/, admin.master],
  [/^\/admin\/checklists$/, admin.checklists],
  [/^\/admin\/settings$/, admin.settings],
  [/^\/admin\/workflow$/, admin.workflow],
  [/^\/admin\/audit$/, admin.audit],
];

function renderNav() {
  const nav = $('#sidenav');
  mount(nav, ...NAV.map(([group, items]) => {
    const vis = items.filter(i => i[2]());
    if (!vis.length) return null;
    return [h('div', { class: 'group' }, group), ...vis.map(([href, text]) => h('a', { href }, text))];
  }));
  $('#userChip').textContent = state.me.full_name;
  $('#quickReport').hidden = !can('breakdown.report');
}
function highlightNav() {
  const cur = location.hash.split('?')[0];
  for (const a of document.querySelectorAll('#sidenav a')) a.classList.toggle('active', cur === a.getAttribute('href') || (cur.startsWith(a.getAttribute('href') + '/') && a.getAttribute('href') !== '#/pms'));
}
export async function refreshBell() {
  if (!state.me) return;
  try { const { unread } = await api('/notifications/count'); const b = $('#bellCount'); b.textContent = unread > 99 ? '99+' : unread; b.hidden = !unread; } catch { /* ignore */ }
}

async function loadSession() {
  try {
    state.me = await api('/auth/me');
    state.meta = await api('/meta');
    return true;
  } catch { state.me = null; return false; }
}
export async function afterLogin() {
  await loadSession();
  renderNav();
  showChrome(true);
  refreshBell();
}
function showChrome(on) {
  $('#topbar').hidden = !on; $('#sidenav').hidden = !on;
  document.body.classList.toggle('public', !on);
}
function defaultRoute() {
  if (can('kpi.view')) return '#/dashboard';
  if (can('wo.execute')) return '#/my';
  if (can('downtime.view')) return '#/availability';
  return '#/assets';
}

async function route() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const query = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  const view = $('#view');
  closeNav();
  if (!state.me && path !== '/login') { sessionStorage.setItem('cmms_after_login', location.hash); location.hash = '#/login'; return; }
  if (state.me && state.me.must_change_password && path !== '/profile' && path !== '/login') { location.hash = '#/profile'; return; }
  if (path === '/' || path === '') { location.hash = defaultRoute(); return; }
  for (const [re, fn, pub] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    showChrome(!pub);
    highlightNav();
    mount(view, h('div', { class: 'loading' }, 'Loading…'));
    try { await fn(view, ...m.slice(1).map(decodeURIComponent), query); }
    catch (e) { if (e.status !== 401) mount(view, errorBox(e)); }
    window.scrollTo(0, 0);
    return;
  }
  mount(view, h('div', { class: 'panel' }, 'Page not found. ', h('a', { href: defaultRoute() }, 'Go to start')));
}

function closeNav() { $('#sidenav').classList.remove('open'); $('#navBackdrop').hidden = true; }
$('#menuBtn').addEventListener('click', () => { $('#sidenav').classList.toggle('open'); $('#navBackdrop').hidden = !$('#sidenav').classList.contains('open'); });
$('#navBackdrop').addEventListener('click', closeNav);
window.addEventListener('hashchange', route);
window.addEventListener('unhandledrejection', e => {
  // errors from background loads inside views: show them instead of failing silently
  if (e.reason && e.reason.status !== 401) toast(e.reason.message || String(e.reason), 'err');
  e.preventDefault();
});
export const app = { afterLogin, defaultRoute, refreshBell, route };
window.__cmms = app;

(async () => {
  if (await loadSession()) { renderNav(); showChrome(true); refreshBell(); }
  route();
  setInterval(refreshBell, 60000);
})();
