'use strict';
const crypto = require('crypto');
const db = require('./db');
const rbac = require('./rbac');
const settings = require('./settings');
const { nowIso, now, HOUR } = require('./time');
const { AppError } = require('./errors');

const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, SCRYPT);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new AppError(400, 'Password must contain letters and numbers');
}
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function login(username, password, meta = {}) {
  const d = db.get();
  const user = d.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  const fail = () => new AppError(401, 'Invalid username or password');
  if (!user || !user.is_active) { if (!user) verifyPassword('x', hashPassword('y')); throw fail(); }
  if (user.locked_until && user.locked_until > nowIso()) throw new AppError(423, 'Account temporarily locked after repeated failed logins. Try again later.');
  if (!verifyPassword(String(password || ''), user.password_hash)) {
    const n = user.failed_logins + 1;
    const lock = n >= MAX_FAILED ? new Date(now().getTime() + LOCK_MINUTES * 60000).toISOString() : null;
    d.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : n, lock, user.id);
    throw fail();
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(now().getTime() + settings.get('session_hours') * HOUR).toISOString();
  d.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenHash(token), user.id, nowIso(), expires, meta.ip || null, (meta.userAgent || '').slice(0, 200));
  d.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  return { token, expires_at: expires, user_id: user.id };
}

function logout(token) { db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); }

/** Resolve a bearer token to a user context ({id, perms:Set, sites:null|[]}). */
function resolve(token) {
  if (!token) return null;
  const d = db.get();
  const s = d.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash(token));
  if (!s || s.expires_at < nowIso()) return null;
  const u = d.prepare('SELECT id, username, full_name, email, role_code, all_sites, is_active, must_change_password FROM users WHERE id = ?').get(s.user_id);
  if (!u || !u.is_active) return null;
  return { ...u, perms: rbac.permissionsFor(u.role_code), sites: rbac.siteScope(u) };
}

function middleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = resolve(token);
  if (!user) return res.status(401).json({ error: 'Not signed in or session expired' });
  req.user = user;
  req.token = token;
  req.ctx = { user, ip: req.ip };
  next();
}

module.exports = { hashPassword, verifyPassword, validatePassword, login, logout, resolve, middleware };
