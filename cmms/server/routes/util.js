'use strict';
const rbac = require('../rbac');
const { AppError } = require('../errors');

/** Wrap an async/sync route handler; errors become JSON responses. */
const h = fn => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.then(v => { if (v !== undefined && !res.headersSent) res.json(v); }).catch(next);
    else if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) { next(e); }
};
/** Permission gate middleware. */
const need = (...perms) => (req, res, next) => {
  if (!perms.some(p => req.user.perms.has(p))) return next(new AppError(403, `Requires permission: ${perms.join(' or ')}`));
  next();
};
function paging(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(q.page_size, 10) || 50));
  return { page, size, offset: (page - 1) * size };
}
/** Choose an ORDER BY from a whitelist. */
function sortBy(q, allowed, dflt) {
  const key = String(q.sort || '').replace(/^-/, '');
  if (!allowed[key]) return dflt;
  return `${allowed[key]} ${String(q.sort).startsWith('-') ? 'DESC' : 'ASC'}`;
}
const COST_KEYS = ['purchase_value', 'unit_cost', 'total_cost', 'cost', 'rate', 'est_cost', 'value', 'est_unit_cost', 'amount'];
/** Remove cost fields for users who may not see cost data. */
function stripCost(user, data, keys = COST_KEYS) {
  if (rbac.can(user, 'cost.view')) return data;
  const strip = o => { if (o && typeof o === 'object') for (const k of keys) delete o[k]; return o; };
  return Array.isArray(data) ? data.map(strip) : strip(data);
}
const csvList = v => (v == null || v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));

module.exports = { h, need, paging, sortBy, stripCost, csvList };
