'use strict';
const path = require('path');
const db = require('./db');
const seed = require('./seed');
const scheduler = require('./scheduler');
const { createApp } = require('./app');

const file = process.env.CMMS_DB || path.join(process.cwd(), 'data', 'cmms.db');
db.open(file);
seed.initMasterData();
const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => {
  console.log(`CMMS listening on http://localhost:${port} (database ${file})`);
  if (process.env.CMMS_DISABLE_SCHEDULER !== '1') scheduler.start();
});
