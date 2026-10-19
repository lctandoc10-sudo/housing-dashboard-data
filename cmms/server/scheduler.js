'use strict';
const settings = require('./settings');
const pms = require('./services/pms');
const notify = require('./services/notify');

let timer = null;
function runOnce() {
  try {
    const created = pms.generate({ user: null });
    const n = notify.runChecks();
    if (created.length || n.notifications) console.log(new Date().toISOString(), `scheduler: ${created.length} PMS WO generated, ${n.notifications} notifications`);
  } catch (e) { console.error('scheduler error', e); }
}
function start() {
  runOnce();
  const minutes = Math.max(5, settings.get('scheduler_interval_minutes'));
  timer = setInterval(runOnce, minutes * 60000);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { start, stop, runOnce };
