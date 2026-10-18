'use strict';
const path = require('path');
const express = require('express');
const auth = require('./auth');
const { AppError } = require('./errors');
const core = require('./routes/core');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.CMMS_TRUST_PROXY) app.set('trust proxy', process.env.CMMS_TRUST_PROXY);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  api.use(core.publicRouter);
  api.use((req, res, next) => {
    // session from httpOnly cookie (browser) or Bearer token (API clients)
    if (!req.headers.authorization) {
      const c = parseCookies(req.headers.cookie)[core.COOKIE];
      if (c) req.headers.authorization = `Bearer ${c}`;
    }
    auth.middleware(req, res, next);
  });
  api.use(core.router);
  api.use(require('./routes/maintenance'));
  api.use(require('./routes/operations'));
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  app.use('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err && /SQLITE_CONSTRAINT/.test(err.code || '')) {
      return res.status(409).json({ error: /UNIQUE/.test(err.message) ? 'Duplicate record: a record with the same unique value already exists' : 'The change violates a data integrity rule and was not saved' });
    }
    console.error(new Date().toISOString(), req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Unexpected server error. The change was not saved.' });
  });
  return app;
}
module.exports = { createApp };
