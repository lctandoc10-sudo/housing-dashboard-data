'use strict';
const db = require('./db');
const { forbidden } = require('./errors');

// Every permission enforced by the backend. Roles map to permission sets stored in
// role_permissions, so administrators can adjust them without code changes.
const PERMISSIONS = {
  'admin.users': 'Manage users and role permissions',
  'admin.master': 'Manage sites, locations, categories, failure codes, suppliers, checklists, stores',
  'admin.settings': 'Change system settings and escalation rules',
  'audit.view': 'View audit logs',
  'import.run': 'Import equipment and history from Excel',
  'asset.view': 'View equipment registry',
  'asset.create': 'Register equipment',
  'asset.edit': 'Edit equipment master data',
  'asset.transfer': 'Transfer equipment between sites',
  'asset.status': 'Set operational status (Available/Operational/Standby/Restricted/Decommissioned)',
  'asset.meter': 'Record meter readings',
  'pms.view': 'View PMS plans and schedules',
  'pms.plan': 'Create and edit PMS plans and checklists',
  'pms.reschedule': 'Authorise PMS rescheduling',
  'pms.mark_missed': 'Mark a PMS work order as missed',
  'breakdown.report': 'Report breakdowns and defects',
  'wo.view': 'View all work orders in permitted sites',
  'wo.view_assigned': 'View work orders assigned to me (and those I requested)',
  'wo.create': 'Create work orders',
  'wo.assess': 'Assess reported breakdowns',
  'wo.assign': 'Approve and assign work orders',
  'wo.execute': 'Execute assigned work orders (progress, labor, findings, submit)',
  'wo.verify': 'Verify completed work',
  'wo.close': 'Approve closure / return equipment to service',
  'wo.cancel': 'Cancel work orders',
  'investigation.manage': 'Manage failure investigations',
  'downtime.view': 'View availability board and downtime',
  'downtime.manage': 'Record manual (other authorised) downtime',
  'inventory.view': 'View spare parts and stock',
  'inventory.manage_parts': 'Maintain parts catalog and stock levels',
  'inventory.reserve': 'Reserve parts for work orders',
  'inventory.receive': 'Receive stock',
  'inventory.issue': 'Issue and accept returns of stock',
  'inventory.transfer': 'Transfer stock between stores',
  'inventory.adjust': 'Request stock adjustments',
  'inventory.approve': 'Approve stock adjustments',
  'pr.create': 'Create purchase requests',
  'pr.approve': 'Approve purchase requests',
  'cost.view': 'View maintenance costs',
  'cost.manage': 'Record cost entries',
  'cost.approve': 'Approve cost entries',
  'cost.export': 'Export approved cost data for finance',
  'kpi.view': 'View dashboards and KPIs',
  'report.view': 'View reports',
  'report.export': 'Export reports',
  'team.view': 'View technician workload',
};

const ALL = Object.keys(PERMISSIONS);
const except = (...xs) => ALL.filter(p => !xs.includes(p));

const ROLES = {
  ADMIN: ['System Administrator', 'Manages users, roles, permissions, sites, settings and master data', ALL],
  MANAGER: ['Maintenance Manager', 'Approves plans and work orders, monitors KPIs, costs and compliance',
    except('admin.users', 'admin.settings', 'import.run')],
  SUPERVISOR: ['Maintenance Supervisor', 'Plans PMS, assigns technicians, verifies completion', [
    'asset.view', 'asset.create', 'asset.edit', 'asset.status', 'asset.meter', 'asset.transfer',
    'pms.view', 'pms.plan', 'pms.reschedule', 'pms.mark_missed', 'breakdown.report',
    'wo.view', 'wo.create', 'wo.assess', 'wo.assign', 'wo.execute', 'wo.verify', 'wo.close', 'wo.cancel', 'investigation.manage',
    'downtime.view', 'downtime.manage', 'inventory.view', 'inventory.reserve', 'inventory.issue', 'inventory.adjust', 'pr.create',
    'cost.view', 'cost.manage', 'kpi.view', 'report.view', 'report.export', 'team.view', 'audit.view']],
  TECHNICIAN: ['Maintenance Technician', 'Executes assigned PMS and corrective work', [
    'asset.view', 'asset.meter', 'pms.view', 'breakdown.report', 'wo.view_assigned', 'wo.execute', 'downtime.view', 'inventory.view', 'pr.create']],
  STOREKEEPER: ['Storekeeper / Inventory Controller', 'Receives, issues and transfers spare parts', [
    'asset.view', 'wo.view', 'inventory.view', 'inventory.manage_parts', 'inventory.receive', 'inventory.issue', 'inventory.transfer',
    'inventory.adjust', 'inventory.reserve', 'pr.create', 'report.view', 'report.export', 'downtime.view']],
  CUSTODIAN: ['Project Supervisor / Equipment Custodian', 'Reports breakdowns, confirms operational impact and availability', [
    'asset.view', 'asset.status', 'asset.meter', 'breakdown.report', 'wo.view', 'downtime.view', 'pms.view', 'kpi.view', 'report.view']],
  OPERATIONS: ['Production / Logistics User', 'Views equipment availability and reports defects', [
    'asset.view', 'breakdown.report', 'wo.view_assigned', 'downtime.view']],
  VIEWER: ['Management Viewer', 'Read-only access to dashboards, KPIs, reports and approved records', [
    'asset.view', 'pms.view', 'wo.view', 'downtime.view', 'inventory.view', 'cost.view', 'kpi.view', 'report.view', 'report.export', 'team.view']],
};

function initRoles() {
  const d = db.get();
  const insRole = d.prepare('INSERT OR IGNORE INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 1)');
  const insPerm = d.prepare('INSERT OR IGNORE INTO role_permissions (role_code, permission) VALUES (?, ?)');
  for (const [code, [name, desc, perms]] of Object.entries(ROLES)) {
    const existed = d.prepare('SELECT 1 FROM roles WHERE code = ?').get(code);
    insRole.run(code, name, desc);
    if (!existed) for (const p of perms) insPerm.run(code, p);
  }
  // administrators always hold every permission, including ones added in later versions
  for (const p of ALL) insPerm.run('ADMIN', p);
}

function permissionsFor(roleCode) {
  return new Set(db.get().prepare('SELECT permission FROM role_permissions WHERE role_code = ?').all(roleCode).map(r => r.permission));
}

/** Site ids the user may access, or null meaning all sites. */
function siteScope(user) {
  if (user.all_sites) return null;
  return db.get().prepare('SELECT site_id FROM user_sites WHERE user_id = ?').all(user.id).map(r => r.site_id);
}

function can(user, perm) { return user.perms.has(perm); }
function require_(user, ...perms) {
  if (!perms.some(p => user.perms.has(p))) throw forbidden(`Requires permission: ${perms.join(' or ')}`);
}
function canSite(user, siteId) { return user.sites === null || user.sites.includes(Number(siteId)); }
function requireSite(user, siteId) { if (!canSite(user, siteId)) throw forbidden('You do not have access to this project/site'); }

/** SQL fragment restricting a site column to the user's scope. */
function siteFilter(user, column, params) {
  if (user.sites === null) return '1=1';
  if (!user.sites.length) return '0=1';
  const keys = user.sites.map((id, i) => { params[`__s${i}`] = id; return `@__s${i}`; });
  return `${column} IN (${keys.join(',')})`;
}

module.exports = { PERMISSIONS, ROLES, initRoles, permissionsFor, siteScope, can, require: require_, canSite, requireSite, siteFilter };
