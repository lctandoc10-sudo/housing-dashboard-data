'use strict';
class AppError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const bad = (msg, details) => new AppError(400, msg, details);
const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, msg);
const notFound = (what = 'Record') => new AppError(404, `${what} not found`);
const conflict = (msg, details) => new AppError(409, msg, details);
module.exports = { AppError, bad, forbidden, notFound, conflict };
