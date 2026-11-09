'use strict';
// Site progress reports: phone submission with photos, register, detail, monthly summary/export.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const rbac = require('../rbac');
const progress = require('../services/progress');
const { h, need, paging, sortBy } = require('./util');
const { bad } = require('../errors');

const router = express.Router();
// photos are resized on the phone before upload; the limit is for originals sent as a fallback
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const ANY = need('progress.view', 'progress.submit');

router.get('/progress-reports', ANY, h(req => {
  const { page, size, offset } = paging(req.query);
  const { where, params } = progress.list(req.user, req.query);
  const order = sortBy(req.query, { report_date: 'p.report_date', report_no: 'p.report_no', site: 's.name', ftb_installed: 'p.ftb_installed' }, 'p.report_date DESC, p.id DESC');
  const from = `FROM progress_reports p JOIN sites s ON s.id = p.site_id JOIN users u ON u.id = p.created_by WHERE ${where}`;
  const photoCount = `(SELECT COUNT(*) FROM progress_photos ph JOIN attachments a ON a.id = ph.attachment_id WHERE ph.report_id = p.id AND a.is_deleted = 0)`;
  const cover = `(SELECT a.id FROM progress_photos ph JOIN attachments a ON a.id = ph.attachment_id WHERE ph.report_id = p.id AND a.is_deleted = 0 ORDER BY a.id LIMIT 1)`;
  const rows = db.get().prepare(`SELECT p.id, p.report_no, p.report_date, p.site_id, s.name site_name, p.area, p.weather, p.status, p.work_done, p.issues,
      ${progress.FIELDS.map(f => 'p.' + f.key).join(', ')}, p.created_by, u.full_name created_by_name, p.created_at,
      ${photoCount} photo_count, ${cover} cover_photo_id
    ${from} ORDER BY ${order} LIMIT @size OFFSET @offset`).all({ ...params, size, offset });
  return { rows, total: db.get().prepare(`SELECT COUNT(*) n ${from}`).get(params).n, page, page_size: size };
}));
router.get('/progress-reports/check-duplicates', need('progress.submit'), h(req => {
  if (!req.query.site_id || !req.query.report_date) throw bad('site_id and report_date are required');
  rbac.requireSite(req.user, req.query.site_id);
  return progress.duplicates(req.user, Number(req.query.site_id), String(req.query.report_date));
}));
router.get('/progress-reports/recent', ANY, h(req => progress.recent(req.user, 7)));
router.get('/progress-reports/monthly', need('progress.view'), h(req => progress.monthly(req.user, req.query)));
router.get('/progress-reports/monthly.xlsx', need('progress.view'), h(async (req, res) => {
  const m = progress.monthly(req.user, req.query); // validates the query before building the file
  const buf = await progress.monthlyWorkbook(req.user, req.query);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="progress-monthly-history-${m.from}${m.to !== m.from ? '-to-' + m.to : ''}.xlsx"`);
  res.send(Buffer.from(buf));
}));
router.post('/progress-reports', need('progress.submit'), h(req => progress.create(req.ctx, req.body || {})));
router.get('/progress-reports/:id(\\d+)', ANY, h(req => progress.detail(req.user, req.params.id)));
router.put('/progress-reports/:id(\\d+)', ANY, h(req => progress.update(req.ctx, req.params.id, req.body || {})));
router.post('/progress-reports/:id(\\d+)/void', ANY, h(req => progress.voidReport(req.ctx, req.params.id, (req.body || {}).reason)));
router.post('/progress-reports/:id(\\d+)/photos', ANY, photoUpload.single('file'), h(req => {
  if (!req.file) throw bad('No photo uploaded');
  return progress.addPhoto(req.ctx, req.params.id, req.file, req.body || {});
}));

module.exports = router;
