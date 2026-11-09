'use strict';
// Validated file storage shared by every upload endpoint. Files are written to disk under a
// random name; the attachments table holds the metadata and the original (sanitised) name.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const { nowIso } = require('../time');
const { bad } = require('../errors');

const UPLOAD_DIR = () => process.env.CMMS_UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');
const ALLOWED = {
  'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'], 'image/heic': ['.heic'], 'application/pdf': ['.pdf'],
  'video/mp4': ['.mp4'], 'video/quicktime': ['.mov'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAGIC = { '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff], '.png': [0x89, 0x50, 0x4e, 0x47], '.pdf': [0x25, 0x50, 0x44, 0x46], '.xlsx': [0x50, 0x4b], '.docx': [0x50, 0x4b], '.webp': [0x52, 0x49, 0x46, 0x46] };

/** Check type, extension and file signature; returns the extension. */
function validate(f, { imagesOnly = false } = {}) {
  if (!f) throw bad('No file uploaded');
  const ext = path.extname(f.originalname || '').toLowerCase();
  const allowedExt = ALLOWED[f.mimetype];
  if (imagesOnly && !IMAGE_TYPES.includes(f.mimetype)) throw bad('Only photos (JPEG, PNG, WebP, HEIC) can be added here');
  if (!allowedExt || !allowedExt.includes(ext)) throw bad('File type not allowed (photos, videos, PDF, XLSX, DOCX only)');
  const magic = MAGIC[ext];
  if (magic && !magic.every((b, i) => f.buffer[i] === b)) throw bad('File content does not match its type');
  return ext;
}

/** Validate and store an uploaded file as an attachment of an entity; returns the attachment id. */
function store(ctx, entityType, entityId, f, caption, opts) {
  const ext = validate(f, opts);
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  fs.mkdirSync(UPLOAD_DIR(), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR(), stored), f.buffer, { flag: 'wx' });
  const safeName = path.basename(f.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 150);
  const r = db.get().prepare(`INSERT INTO attachments (entity_type, entity_id, filename, stored_name, mime_type, size_bytes, caption, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entityType, entityId, safeName, stored, f.mimetype, f.size, caption ? String(caption).slice(0, 500) : null, ctx.user.id, nowIso());
  audit.log(ctx, 'UPLOAD', entityType, entityId, `${safeName} (${f.size} bytes)`);
  return Number(r.lastInsertRowid);
}

module.exports = { UPLOAD_DIR, ALLOWED, IMAGE_TYPES, MAGIC, validate, store };
