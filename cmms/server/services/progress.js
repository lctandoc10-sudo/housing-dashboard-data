'use strict';
// Site progress reports: a daily record of work done at a project site or the factory,
// submitted from a phone with photos. Quantities use the measures of the FTB Supply &
// Production workbook, so monthly totals can be exported straight into its Monthly History.
const db = require('../db');
const rbac = require('../rbac');
const audit = require('../audit');
const settings = require('../settings');
const numbering = require('../numbering');
const files = require('./files');
const { nowIso, today, isDate, toIso, addDays, daysBetween, manilaDate } = require('../time');
const { bad, notFound, forbidden, conflict } = require('../errors');

// key, label, integer?, Monthly History column, how a month is rolled up
const FIELDS = [
  ['ftb_produced', 'FTB produced (client supply)', true, 'FTB Produced', 'SUM'],
  ['ftb_installed', 'FTB installed', true, 'Installed', 'SUM'],
  ['volume_produced_m3', 'Volume produced, panels (m³)', false, 'Volume Produced m3 (Panels)', 'SUM'],
  ['volume_installed_m3', 'Volume installed (m³)', false, 'Volume Installed m3', 'SUM'],
  ['manpower_production', 'Manpower – production (headcount)', true, 'Manpower (Production)', 'AVG_DAILY'],
  ['manpower_installation', 'Manpower – installation (headcount)', true, 'Manpower (Installation)', 'AVG_DAILY'],
  ['manhours_production', 'Manhours – production', false, 'Manhours (Production)', 'SUM'],
  ['manhours_installation', 'Manhours – installation', false, 'Manhours (Installation)', 'SUM'],
  ['coca', 'COCA (units accepted)', true, 'COCA', 'SUM'],
].map(([key, label, int, column, rollup]) => ({ key, label, int, column, rollup }));
const QTY = FIELDS.map(f => f.key);
const TEXT = { area: 120, work_done: 4000, issues: 4000, next_plan: 4000 };
const WEATHER = ['SUNNY', 'CLOUDY', 'RAINY', 'STORMY'];
const MAX_QTY = 1e6;

// Site names as written in the "Housing Database" workbook, where they differ from the CMMS name.
const WORKBOOK_SITE_NAMES = { CAL: 'Calauan (Alora+Amani)', GEN: 'Gentri', TAY: 'Tayabas' };
// Monthly History column order (targets are planning figures and are left blank).
const MONTHLY_HISTORY_COLUMNS = ['Site', 'Month', 'FTB Produced', 'Installed', 'Volume Produced m3 (Panels)', 'Volume Installed m3',
  'Manpower (Production)', 'Manpower (Installation)', 'Manhours (Production)', 'Manhours (Installation)', 'Target Installation', 'COCA', 'Target FTB Produced'];

const clean = v => (v == null ? null : String(v).trim() || null);

/** Normalise and validate report fields. `partial` validates only the keys present (edits). */
function normalise(b, partial) {
  const out = {};
  const has = k => !partial || k in b;
  for (const f of FIELDS) {
    if (!has(f.key)) continue;
    const v = b[f.key];
    if (v == null || v === '') { out[f.key] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw bad(`${f.label} must be zero or a positive number`);
    if (n > MAX_QTY) throw bad(`${f.label} is implausibly large`);
    if (f.int && !Number.isInteger(n)) throw bad(`${f.label} must be a whole number`);
    out[f.key] = f.int ? n : Math.round(n * 1000) / 1000;
  }
  for (const [k, max] of Object.entries(TEXT)) {
    if (!has(k)) continue;
    const v = clean(b[k]);
    if (v && v.length > max) throw bad(`${k.replace('_', ' ')} is too long (max ${max} characters)`);
    out[k] = v;
  }
  if (has('work_done') && !out.work_done) throw bad('Describe the work accomplished');
  if (has('weather')) {
    const w = clean(b.weather);
    if (w && !WEATHER.includes(w)) throw bad('Unknown weather value');
    out.weather = w;
  }
  if (has('report_date')) {
    if (!isDate(b.report_date)) throw bad('Report date must be a valid date (YYYY-MM-DD)');
    if (b.report_date > today()) throw bad('Report date cannot be in the future');
    out.report_date = b.report_date;
  }
  if (has('latitude') || has('longitude')) {
    const lat = b.latitude == null || b.latitude === '' ? null : Number(b.latitude);
    const lng = b.longitude == null || b.longitude === '' ? null : Number(b.longitude);
    if ((lat == null) !== (lng == null)) throw bad('Location needs both latitude and longitude');
    if (lat != null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw bad('Invalid GPS location');
    const acc = b.location_accuracy_m == null || b.location_accuracy_m === '' ? null : Number(b.location_accuracy_m);
    out.latitude = lat; out.longitude = lng; out.location_accuracy_m = lat == null || !Number.isFinite(acc) ? null : Math.round(acc);
  }
  return out;
}

/** Cross-field checks on the full (merged) record. */
function checkConsistency(r) {
  for (const k of ['production', 'installation']) {
    const mp = r[`manpower_${k}`], mh = r[`manhours_${k}`];
    if (mp === 0 && mh > 0) throw bad(`Manhours – ${k} are recorded but manpower is 0`);
    if (mp != null && mh != null && mh > mp * 24) throw bad(`Manhours – ${k} (${mh}) cannot exceed manpower × 24 h (${mp * 24})`);
  }
}

function load(id) {
  const r = db.get().prepare(`SELECT p.*, s.name site_name, s.code site_code, u.full_name created_by_name, ub.full_name updated_by_name, uv.full_name voided_by_name
    FROM progress_reports p JOIN sites s ON s.id = p.site_id JOIN users u ON u.id = p.created_by
    LEFT JOIN users ub ON ub.id = p.updated_by LEFT JOIN users uv ON uv.id = p.voided_by WHERE p.id = ?`).get(id);
  if (!r) throw notFound('Progress report');
  return r;
}

/** Load a report the user may see: their own, or any in their sites with progress.view. */
function loadVisible(user, id) {
  const r = load(Number(id));
  rbac.requireSite(user, r.site_id);
  if (!rbac.can(user, 'progress.view') && !(rbac.can(user, 'progress.submit') && r.created_by === user.id)) throw forbidden('You can only see your own progress reports');
  return r;
}

/** Edit rights: progress.manage always; the author (with progress.submit) within the edit window. */
function editRights(user, r) {
  if (r.status === 'VOID') return { edit: false, reason: 'The report is void' };
  if (rbac.can(user, 'progress.manage')) return { edit: true };
  if (r.created_by !== user.id || !rbac.can(user, 'progress.submit')) return { edit: false, reason: 'Only the author or a progress manager can change this report' };
  const days = settings.get('progress_edit_days');
  if (daysBetween(manilaDate(r.created_at), today()) > days) return { edit: false, reason: `Reports can be corrected by their author for ${days} days; ask a progress manager` };
  return { edit: true };
}

/** Access check used by the attachment download/delete routes. */
function checkAccess(user, id, write) {
  const r = loadVisible(user, id);
  if (write) { const e = editRights(user, r); if (!e.edit) throw forbidden(e.reason); }
  return r;
}

function duplicates(user, siteId, date, exceptId) {
  return db.get().prepare(`SELECT p.id, p.report_no, p.area, p.created_at, u.full_name created_by_name FROM progress_reports p JOIN users u ON u.id = p.created_by
    WHERE p.site_id = ? AND p.report_date = ? AND p.status = 'SUBMITTED' AND p.id <> ? ORDER BY p.id`).all(siteId, date, exceptId || 0);
}

function create(ctx, b) {
  const user = ctx.user;
  rbac.require(user, 'progress.submit');
  const requestId = clean(b.client_request_id);
  if (requestId && requestId.length > 100) throw bad('client_request_id is too long');
  return db.tx(() => {
    const d = db.get();
    if (requestId) {
      // a retried upload returns the report that was already stored
      const prior = d.prepare('SELECT id, created_by FROM progress_reports WHERE client_request_id = ?').get(requestId);
      if (prior) {
        if (prior.created_by !== user.id) throw conflict('This upload key belongs to another user');
        return { ...detail(user, prior.id), already_saved: true };
      }
    }
    const siteId = Number(b.site_id);
    if (!siteId) throw bad('Select the project / site');
    const site = d.prepare('SELECT id, is_active FROM sites WHERE id = ?').get(siteId);
    if (!site) throw notFound('Site');
    rbac.requireSite(user, siteId);
    if (!site.is_active) throw bad('This site is inactive');
    const f = normalise({ ...b, report_date: b.report_date || today() }, false);
    checkConsistency(f);
    const dups = duplicates(user, siteId, f.report_date);
    if (dups.length && !b.confirm_duplicate) {
      throw conflict(`A progress report for this site and date already exists (${dups.map(x => x.report_no).join(', ')}). Submit again only if it covers different work, otherwise the quantities are counted twice.`, { duplicates: dups });
    }
    const ts = nowIso();
    const row = { ...f, site_id: siteId, report_no: numbering.next('PROGRESS'), client_request_id: requestId, created_by: user.id, created_at: ts, updated_at: ts };
    const cols = Object.keys(row);
    const id = Number(d.prepare(`INSERT INTO progress_reports (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`).run(row).lastInsertRowid);
    audit.log(ctx, 'CREATE', 'progress_report', id, `${row.report_no} ${f.report_date}${dups.length ? ' (confirmed duplicate)' : ''}`);
    return detail(user, id);
  });
}

function update(ctx, id, b) {
  const user = ctx.user;
  return db.tx(() => {
    const before = loadVisible(user, id);
    const e = editRights(user, before);
    if (!e.edit) throw forbidden(e.reason);
    if (b.version != null && Number(b.version) !== before.version) throw conflict('Someone else changed this report. Reload it and apply your change again.');
    const f = normalise(b, true);
    const merged = { ...before, ...f };
    checkConsistency(merged);
    const fields = { ...f, updated_by: user.id, updated_at: nowIso(), version: before.version + 1 };
    db.updateRow('progress_reports', before.id, fields, [...QTY, ...Object.keys(TEXT), 'weather', 'report_date', 'latitude', 'longitude', 'location_accuracy_m', 'updated_by', 'updated_at', 'version']);
    const df = audit.diff(before, { ...before, ...f });
    if (df) audit.log(ctx, 'UPDATE', 'progress_report', before.id, before.report_no, df[0], df[1]);
    return detail(user, before.id);
  });
}

function voidReport(ctx, id, reason) {
  const user = ctx.user;
  return db.tx(() => {
    const r = loadVisible(user, id);
    const e = editRights(user, r);
    if (!e.edit) throw forbidden(e.reason);
    const why = clean(reason);
    if (!why) throw bad('A reason is required to void a report');
    const ts = nowIso();
    db.get().prepare(`UPDATE progress_reports SET status = 'VOID', void_reason = ?, voided_by = ?, voided_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(why.slice(0, 1000), user.id, ts, user.id, ts, r.id);
    audit.log(ctx, 'VOID', 'progress_report', r.id, `${r.report_no}: ${why}`);
    return detail(user, r.id);
  });
}

function photos(reportId) {
  return db.get().prepare(`SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.caption, a.uploaded_at, a.uploaded_by, p.taken_at, p.client_photo_id
    FROM progress_photos p JOIN attachments a ON a.id = p.attachment_id WHERE p.report_id = ? AND a.is_deleted = 0 ORDER BY COALESCE(p.taken_at, a.uploaded_at), a.id`).all(reportId);
}

function addPhoto(ctx, id, file, { caption, client_photo_id, taken_at } = {}) {
  const user = ctx.user;
  return db.tx(() => {
    const d = db.get();
    const r = checkAccess(user, id, true);
    const cid = clean(client_photo_id);
    if (cid && cid.length > 100) throw bad('client_photo_id is too long');
    if (cid) {
      const prior = d.prepare('SELECT attachment_id FROM progress_photos WHERE report_id = ? AND client_photo_id = ?').get(r.id, cid);
      if (prior) return { id: prior.attachment_id, already_saved: true };
    }
    const max = settings.get('progress_max_photos');
    const n = d.prepare(`SELECT COUNT(*) n FROM progress_photos p JOIN attachments a ON a.id = p.attachment_id WHERE p.report_id = ? AND a.is_deleted = 0`).get(r.id).n;
    if (n >= max) throw bad(`A progress report can hold at most ${max} photos`);
    let taken = taken_at ? toIso(taken_at) : null;
    if (taken && Date.parse(taken) > Date.now() + 10 * 60e3) taken = null; // phone clock in the future: ignore
    const attId = files.store(ctx, 'progress_report', r.id, file, caption, { imagesOnly: true });
    d.prepare('INSERT INTO progress_photos (report_id, attachment_id, client_photo_id, taken_at, created_at) VALUES (?, ?, ?, ?, ?)').run(r.id, attId, cid, taken, nowIso());
    return { id: attId };
  });
}

function detail(user, id) {
  const r = loadVisible(user, id);
  const e = editRights(user, r);
  delete r.client_request_id;
  return { ...r, photos: photos(r.id), can: { edit: e.edit, void: e.edit, add_photos: e.edit }, edit_blocked_reason: e.edit ? null : e.reason };
}

function list(user, q) {
  const p = {};
  const where = [rbac.siteFilter(user, 'p.site_id', p)];
  if (!rbac.can(user, 'progress.view')) { where.push('p.created_by = @me'); p.me = user.id; }
  if (q.mine === '1') { where.push('p.created_by = @me2'); p.me2 = user.id; }
  if (q.site_id) { rbac.requireSite(user, q.site_id); where.push('p.site_id = @site'); p.site = Number(q.site_id); }
  if (q.from) { if (!isDate(q.from)) throw bad('Invalid from date'); where.push('p.report_date >= @from'); p.from = q.from; }
  if (q.to) { if (!isDate(q.to)) throw bad('Invalid to date'); where.push('p.report_date <= @to'); p.to = q.to; }
  if (q.status === 'VOID') where.push(`p.status = 'VOID'`);
  else if (q.status !== 'ALL') where.push(`p.status = 'SUBMITTED'`);
  if (q.q) { where.push('(p.report_no LIKE @q OR p.area LIKE @q OR p.work_done LIKE @q OR p.issues LIKE @q)'); p.q = `%${String(q.q).slice(0, 100)}%`; }
  return { where: where.join(' AND '), params: p };
}

/**
 * Monthly roll-up per site, in the shape of the workbook's Monthly History sheet.
 * Units, volumes, manhours and COCA are summed. Manpower is a headcount, so the month shows the
 * average daily headcount: each day's reports are added together, then averaged over the days that
 * recorded it. Void reports are excluded.
 */
function monthly(user, q) {
  const fromM = q.from || today().slice(0, 7);
  const toM = q.to || fromM;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromM) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(toM)) throw bad('Months must be in the format YYYY-MM');
  if (fromM > toM) throw bad('The start month is after the end month');
  const p = { from: `${fromM}-01`, to: `${toM}-31` };
  const where = [`p.status = 'SUBMITTED'`, 'p.report_date BETWEEN @from AND @to', rbac.siteFilter(user, 'p.site_id', p)];
  if (q.site_id) { rbac.requireSite(user, q.site_id); where.push('p.site_id = @site'); p.site = Number(q.site_id); }
  const d = db.get();
  const daily = d.prepare(`SELECT p.site_id, p.report_date, COUNT(*) reports,
      ${FIELDS.map(f => `SUM(p.${f.key}) ${f.key}, COUNT(p.${f.key}) n_${f.key}`).join(', ')},
      (SELECT COUNT(*) FROM progress_photos ph JOIN attachments a ON a.id = ph.attachment_id JOIN progress_reports p2 ON p2.id = ph.report_id
        WHERE a.is_deleted = 0 AND p2.status = 'SUBMITTED' AND p2.site_id = p.site_id AND p2.report_date = p.report_date) photos
    FROM progress_reports p WHERE ${where.join(' AND ')} GROUP BY p.site_id, p.report_date ORDER BY p.report_date`).all(p);
  const sites = new Map(d.prepare('SELECT id, code, name, sort_order FROM sites').all().map(s => [s.id, s]));
  const groups = new Map();
  for (const r of daily) {
    const key = `${r.site_id}|${r.report_date.slice(0, 7)}`;
    if (!groups.has(key)) groups.set(key, { site_id: r.site_id, month: r.report_date.slice(0, 7), reports: 0, days_reported: 0, photos: 0, acc: {} });
    const g = groups.get(key);
    g.reports += r.reports; g.days_reported += 1; g.photos += r.photos;
    for (const f of FIELDS) {
      if (!r[`n_${f.key}`]) continue;
      const a = g.acc[f.key] || (g.acc[f.key] = { sum: 0, days: 0 });
      a.sum += r[f.key]; a.days += 1;
    }
  }
  const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
  const rows = [...groups.values()].map(g => {
    const s = sites.get(g.site_id);
    const out = { site_id: g.site_id, site_code: s.code, site_name: s.name, workbook_site: WORKBOOK_SITE_NAMES[s.code] || s.name, month: g.month,
      reports: g.reports, days_reported: g.days_reported, photos: g.photos, sort: s.sort_order };
    for (const f of FIELDS) {
      const a = g.acc[f.key];
      out[f.key] = !a ? null : f.rollup === 'AVG_DAILY' ? round(a.sum / a.days, 1) : round(a.sum, 3);
    }
    out.production_efficiency = out.volume_produced_m3 != null && out.manhours_production ? round(out.volume_produced_m3 / out.manhours_production, 4) : null;
    out.installation_efficiency = out.volume_installed_m3 != null && out.manhours_installation ? round(out.volume_installed_m3 / out.manhours_installation, 4) : null;
    return out;
  }).sort((a, b) => a.sort - b.sort || a.site_name.localeCompare(b.site_name) || a.month.localeCompare(b.month));
  for (const r of rows) delete r.sort;
  return { from: fromM, to: toM, fields: FIELDS, rows,
    notes: ['Void reports are excluded.', 'Units, volumes, manhours and COCA are monthly sums of the daily reports.',
      'Manpower is the average daily headcount over the days that recorded it.', 'Efficiency = volume ÷ manhours (m³ per manhour).'] };
}

/** XLSX in the column layout of the workbook's Monthly History sheet, ready to paste. */
async function monthlyWorkbook(user, q) {
  const ExcelJS = require('exceljs');
  const m = monthly(user, q);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Precast CMMS';
  const ws = wb.addWorksheet('Monthly History');
  ws.addRow(MONTHLY_HISTORY_COLUMNS).font = { bold: true };
  const byCol = Object.fromEntries(FIELDS.map(f => [f.column, f.key]));
  for (const r of m.rows) ws.addRow(MONTHLY_HISTORY_COLUMNS.map(c => (c === 'Site' ? r.workbook_site : c === 'Month' ? r.month : byCol[c] ? r[byCol[c]] : null)));
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 26 : 16; });
  const det = wb.addWorksheet('Report basis');
  det.addRow(['Site (CMMS)', 'Month', 'Reports', 'Days reported', 'Photos', 'Production efficiency (m³/manhour)', 'Installation efficiency (m³/manhour)']).font = { bold: true };
  for (const r of m.rows) det.addRow([r.site_name, r.month, r.reports, r.days_reported, r.photos, r.production_efficiency, r.installation_efficiency]);
  det.addRow([]);
  for (const n of m.notes) det.addRow([n]);
  det.addRow(['Target Installation and Target FTB Produced are planning figures and are not part of progress reports; fill them in the workbook.']);
  det.columns.forEach(c => { c.width = 22; });
  return wb.xlsx.writeBuffer();
}

/** Activity summary for a site over recent days (used on the progress home screen). */
function recent(user, days = 7) {
  const p = { from: addDays(today(), -(days - 1)) };
  const where = [`p.status = 'SUBMITTED'`, 'p.report_date >= @from', rbac.siteFilter(user, 'p.site_id', p)];
  if (!rbac.can(user, 'progress.view')) { where.push('p.created_by = @me'); p.me = user.id; }
  return db.get().prepare(`SELECT s.id site_id, s.name site_name, COUNT(*) reports, MAX(p.report_date) last_date, SUM(p.ftb_installed) ftb_installed, SUM(p.volume_produced_m3) volume_produced_m3
    FROM progress_reports p JOIN sites s ON s.id = p.site_id WHERE ${where.join(' AND ')} GROUP BY s.id ORDER BY s.sort_order, s.name`).all(p);
}

module.exports = { FIELDS, WEATHER, MONTHLY_HISTORY_COLUMNS, WORKBOOK_SITE_NAMES, create, update, voidReport, addPhoto, detail, list, monthly, monthlyWorkbook, recent, duplicates, checkAccess, loadVisible };
