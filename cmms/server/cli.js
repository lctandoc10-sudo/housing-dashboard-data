'use strict';
// Command line: `node server/cli.js init` creates master data and the admin user.
// `node server/cli.js demo` additionally creates demo users, precast equipment and
// ~90 days of simulated maintenance activity by driving the real services, so every
// dashboard figure comes from recorded transactions.
const path = require('path');
const db = require('./db');
const seed = require('./seed');
const auth = require('./auth');
const rbac = require('./rbac');
const time = require('./time');
const pms = require('./services/pms');
const wos = require('./services/workorders');
const inventory = require('./services/inventory');
const costs = require('./services/costs');
const assetStatus = require('./services/assetStatus');
const notify = require('./services/notify');

function ctxFor(username) {
  const u = db.get().prepare('SELECT * FROM users WHERE username = ?').get(username);
  return { user: { ...u, perms: rbac.permissionsFor(u.role_code), sites: rbac.siteScope(u) }, ip: 'seed' };
}
function rng(seedVal) { let a = seedVal; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function demo({ days = 90, password = 'Demo1234' } = {}) {
  const d = db.get();
  if (d.prepare('SELECT COUNT(*) n FROM assets').get().n) throw new Error('Database already has equipment; demo data is only loaded into an empty database');
  const rand = rng(20261018);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const site = code => d.prepare('SELECT * FROM sites WHERE code = ?').get(code);
  const cat = code => d.prepare('SELECT * FROM equipment_categories WHERE code = ?').get(code);
  const store = code => d.prepare('SELECT * FROM stores WHERE code = ?').get(code);
  const realNow = time.now();
  const startDay = time.addDays(time.manilaDate(realNow), -days);
  const at = (day, hhmm) => time.setClock(time.manilaToUtc(day, hhmm));
  at(startDay, '07:00');
  const ts = time.nowIso();

  // ------------------------------------------------ users
  const users = [
    ['manager', 'Ramon Dela Cruz', 'MANAGER', 1, [], 'Maintenance Manager', null],
    ['sup.factory', 'Engr. Liza Manalo', 'SUPERVISOR', 0, ['CPF'], 'Maintenance Supervisor – Factory', 450],
    ['sup.projects', 'Engr. Paolo Reyes', 'SUPERVISOR', 0, ['CAL', 'NAIC', 'GEN', 'BAT-P', 'BAT-I', 'TAY', 'LIPA', 'SB', 'TTY'], 'Maintenance Supervisor – Projects', 450],
    ['tech.jun', 'Jun Santos', 'TECHNICIAN', 0, ['CPF'], 'Heavy Equipment Mechanic', 230, 'Hydraulics, cranes, travel lifts'],
    ['tech.mark', 'Mark Villanueva', 'TECHNICIAN', 0, ['CPF', 'CAL'], 'Industrial Electrician', 240, 'Electrical, batching plant controls, gensets'],
    ['tech.ana', 'Ana Bautista', 'TECHNICIAN', 0, ['CPF'], 'Welder / Fabricator', 220, 'Moulds, structural repair, racks'],
    ['tech.joel', 'Joel Garcia', 'TECHNICIAN', 0, ['CAL', 'NAIC', 'GEN', 'BAT-P', 'BAT-I', 'TAY', 'LIPA', 'SB', 'TTY'], 'Field Mechanic', 230, 'Mobile cranes, forklifts, trucks, gensets'],
    ['tech.rico', 'Rico Mendoza', 'TECHNICIAN', 0, ['CAL', 'NAIC', 'GEN', 'BAT-P', 'TAY'], 'Field Mechanic', 220, 'Engines, pumps, compressors'],
    ['store.cpf', 'Grace Lim', 'STOREKEEPER', 0, ['CPF', 'CAL', 'NAIC', 'GEN'], 'Storekeeper', null],
    ['custodian.cal', 'Arnel Tolentino', 'CUSTODIAN', 0, ['CAL'], 'Project Supervisor – Calauan', null],
    ['prod.cpf', 'Maricel Navarro', 'OPERATIONS', 0, ['CPF'], 'Production Supervisor', null],
    ['viewer', 'Executive Viewer', 'VIEWER', 1, [], 'Operations Director', null],
  ];
  const insU = d.prepare(`INSERT INTO users (username, full_name, password_hash, role_code, all_sites, position, hourly_rate, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const hash = auth.hashPassword(password);
  for (const [u, n, r, all, sites, pos, rate, skills] of users) {
    const id = insU.run(u, n, hash, r, all, pos, rate, skills || null, ts, ts).lastInsertRowid;
    for (const s of sites) d.prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)').run(id, site(s).id);
  }
  const C = Object.fromEntries(users.map(u => [u[0], ctxFor(u[0])]));
  const admin = ctxFor('admin');

  // ------------------------------------------------ locations & suppliers
  const loc = {};
  for (const [s, names] of Object.entries({ CPF: ['Casting Bay 1', 'Casting Bay 2', 'Batching Area', 'Stockyard', 'Maintenance Shop', 'Power House'], CAL: ['Laydown Area', 'Site Batching'], NAIC: ['Laydown Area', 'Site Batching'], GEN: ['Laydown Area'], 'BAT-P': ['Laydown Area'], TAY: ['Laydown Area'], LIPA: ['Laydown Area'] })) {
    for (const n of names) loc[`${s}:${n}`] = d.prepare('INSERT INTO locations (site_id, name, created_at) VALUES (?, ?, ?)').run(site(s).id, n, ts).lastInsertRowid;
  }
  const sup = {};
  for (const n of ['Hydraulic Power Systems Inc.', 'Monark Equipment', 'Prime Electrical Supply', 'Industrial Bearings PH', 'Precast Crane Services Co.']) sup[n] = d.prepare('INSERT INTO suppliers (name, created_at) VALUES (?, ?)').run(n, ts).lastInsertRowid;

  // ------------------------------------------------ equipment
  const A = [
    ['TL-CPF-01', 'Travel Lift 50T', 'TL', 'CPF', 'Stockyard', 'Hydraulic Power Systems', 'TL-50', 'HP50-2201', null, 'CRITICAL', 18500000, 3200],
    ['TL-CPF-02', 'Travel Lift 35T', 'TL', 'CPF', 'Casting Bay 2', 'Hydraulic Power Systems', 'TL-35', 'HP35-2318', null, 'CRITICAL', 14200000, 2100],
    ['TL-CAL-01', 'Travel Lift 35T', 'TL', 'CAL', 'Laydown Area', 'Hydraulic Power Systems', 'TL-35', 'HP35-2410', null, 'HIGH', 14200000, 1450],
    ['GC-CPF-01', 'Gantry Crane 20T', 'GC', 'CPF', 'Casting Bay 1', 'Konecranes', 'GC20', 'KC-GC-7781', null, 'CRITICAL', 9800000, 5100],
    ['OC-CPF-01', 'Overhead Crane 10T – Bay 1', 'OC', 'CPF', 'Casting Bay 1', 'Demag', 'EKKE-10', 'DM-10-4471', null, 'HIGH', 4300000, 6200],
    ['OC-CPF-02', 'Overhead Crane 10T – Bay 2', 'OC', 'CPF', 'Casting Bay 2', 'Demag', 'EKKE-10', 'DM-10-4472', null, 'HIGH', 4300000, 5900],
    ['MC-GEN-01', 'Mobile Crane 25T', 'MC', 'GEN', 'Laydown Area', 'Tadano', 'GR-250N', 'TD-GR250-0912', 'NBC 4521', 'CRITICAL', 21000000, 7800],
    ['BP-CPF-CBP100', 'Batching Plant CBP100', 'BP', 'CPF', 'Batching Area', 'Sany', 'HZS100', 'SY-HZS100-118', null, 'CRITICAL', 32000000, 9100],
    ['BP-NAIC-MBP20', 'Mobile Batching Plant MBP20', 'BP', 'NAIC', 'Site Batching', 'Sany', 'MBP20', 'SY-MBP20-044', null, 'HIGH', 9500000, 3300],
    ['GS-CPF-01', 'Genset 500 kVA', 'GS', 'CPF', 'Power House', 'Cummins', 'C500D5', 'CU-500-88123', null, 'CRITICAL', 6200000, 11500],
    ['GS-CAL-01', 'Genset 250 kVA', 'GS', 'CAL', 'Laydown Area', 'Denyo', 'DCA-250', 'DN-250-5512', null, 'HIGH', 2900000, 6800],
    ['GS-NAIC-01', 'Genset 150 kVA', 'GS', 'NAIC', 'Laydown Area', 'Denyo', 'DCA-150', 'DN-150-3390', null, 'MEDIUM', 1900000, 5400],
    ['GS-TAY-01', 'Genset 100 kVA', 'GS', 'TAY', 'Laydown Area', 'Denyo', 'DCA-100', 'DN-100-2241', null, 'MEDIUM', 1400000, 4100],
    ['FL-CPF-01', 'Forklift 5T', 'FL', 'CPF', 'Stockyard', 'Toyota', '8FD50', 'TY-8FD50-7710', null, 'HIGH', 2600000, 8800],
    ['FL-CPF-02', 'Forklift 3T', 'FL', 'CPF', 'Maintenance Shop', 'Toyota', '8FD30', 'TY-8FD30-6612', null, 'MEDIUM', 1800000, 7400],
    ['FL-CAL-01', 'Forklift 5T', 'FL', 'CAL', 'Laydown Area', 'Komatsu', 'FD50', 'KM-FD50-1209', null, 'MEDIUM', 2500000, 4300],
    ['IL-CPF-01', 'Inloader Truck', 'IL', 'CPF', 'Stockyard', 'Langendorf', 'Inloader 12', 'LD-IL12-0031', 'NCD 8812', 'CRITICAL', 12500000, 48200],
    ['IL-CPF-02', 'Inloader Truck', 'IL', 'CPF', 'Stockyard', 'Faymonville', 'PrefaMAX', 'FM-PM-0207', 'NCD 8813', 'HIGH', 11800000, 39100],
    ['AC-CPF-01', 'Air Compressor 185 cfm', 'AC', 'CPF', 'Batching Area', 'Atlas Copco', 'XAS 185', 'AC-XAS-77120', null, 'MEDIUM', 1200000, 6100],
    ['WP-CPF-01', 'Water Pump 4"', 'WP', 'CPF', 'Batching Area', 'Grundfos', 'NK 80', 'GF-NK80-1180', null, 'MEDIUM', 380000, 9200],
    ['WP-GEN-01', 'Dewatering Pump 3"', 'WP', 'GEN', 'Laydown Area', 'Honda', 'WB30', 'HN-WB30-5531', null, 'LOW', 75000, 2100],
    ['TR-CPF-01', 'Prime Mover Truck', 'TR', 'CPF', 'Stockyard', 'Isuzu', 'Giga', 'IS-GIGA-77011', 'NBD 2231', 'HIGH', 7800000, 156000],
    ['TR-CPF-02', 'Flatbed Trailer 40ft', 'TR', 'CPF', 'Stockyard', 'Local Fabricator', 'FB40', 'FB40-1120', 'NBD 2232', 'MEDIUM', 950000, 0],
    ['MO-CPF-BAT01', 'Battery Mould – Wall Panels A', 'MO', 'CPF', 'Casting Bay 1', 'Ratec', 'BM-12', 'RT-BM12-0091', null, 'HIGH', 5600000, null],
    ['MO-CPF-BAT02', 'Battery Mould – Wall Panels B', 'MO', 'CPF', 'Casting Bay 2', 'Ratec', 'BM-12', 'RT-BM12-0092', null, 'HIGH', 5600000, null],
    ['MO-CPF-SLAB01', 'Tilting Table Form – Slabs', 'MO', 'CPF', 'Casting Bay 2', 'Ratec', 'TT-9', 'RT-TT9-0033', null, 'MEDIUM', 2100000, null],
    ['RK-CPF-01', 'Panel Transport Racks (set of 20)', 'RK', 'CPF', 'Stockyard', 'Local Fabricator', 'PR-A', 'PR-A-SET01', null, 'LOW', 600000, null],
  ];
  const assetId = {};
  for (const a of A) {
    const c = cat(a[2]), s = site(a[3]);
    const commissioned = time.addDays(startDay, -400 - Math.floor(rand() * 900));
    const id = d.prepare(`INSERT INTO assets (asset_code, name, category_id, manufacturer, model, serial_no, plate_no, site_id, location_id, date_acquired, commissioning_date, purchase_value,
        supplier_id, warranty_expiry, custodian, department, criticality, status, status_since, meter_type, meter_reading, meter_read_at, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?, 1, ?, 1, ?)`).run(
      a[0], a[1], c.id, a[5], a[6], a[7], a[8], s.id, loc[`${a[3]}:${a[4]}`] || null, time.addDays(commissioned, -20), commissioned, a[10],
      a[2] === 'TL' ? sup['Hydraulic Power Systems Inc.'] : null, time.addDays(commissioned, 730), a[3] === 'CPF' ? 'Factory Maintenance' : 'Project Equipment Pool',
      a[3] === 'CPF' ? 'Production' : 'Projects', a[9], ts, c.meter_type, c.meter_type === 'NONE' ? null : a[11], c.meter_type === 'NONE' ? null : ts, ts, ts).lastInsertRowid;
    assetId[a[0]] = id;
    d.prepare(`INSERT INTO asset_status_history (asset_id, from_status, to_status, reason, changed_by, changed_at) VALUES (?, NULL, 'AVAILABLE', 'Registered', 1, ?)`).run(id, ts);
    if (c.meter_type !== 'NONE') d.prepare(`INSERT INTO meter_readings (asset_id, reading, reading_at, source, recorded_by, created_at) VALUES (?, ?, ?, 'REGISTRATION', 1, ?)`).run(id, a[11], ts, ts);
  }

  // ------------------------------------------------ parts & opening stock
  const P = [
    ['HYD-FLT-10', 'Hydraulic return filter 10µ', 'Filters', 'pc', 'Travel lift, mobile crane', 1850, 4, 6, 20, 1, 'WH-CPF', 14],
    ['HYD-OIL-46', 'Hydraulic oil ISO VG46 (pail 20 L)', 'Lubricants', 'pail', 'All hydraulic equipment', 4200, 6, 8, 30, 0, 'WH-CPF', 22],
    ['ENG-OIL-15W40', 'Engine oil 15W-40 (pail 18 L)', 'Lubricants', 'pail', 'Gensets, forklifts, trucks', 3900, 6, 10, 40, 0, 'WH-CPF', 26],
    ['OIL-FLT-GS', 'Oil filter – Cummins/Denyo gensets', 'Filters', 'pc', 'Gensets', 950, 4, 6, 24, 0, 'WH-CPF', 15],
    ['FUEL-FLT-GS', 'Fuel filter / water separator – gensets', 'Filters', 'pc', 'Gensets', 1250, 4, 6, 24, 0, 'WH-CPF', 12],
    ['AIR-FLT-FL', 'Air filter element – forklifts', 'Filters', 'pc', 'Forklifts', 1100, 2, 4, 12, 0, 'WH-CPF', 8],
    ['GREASE-EP2', 'EP2 grease (cartridge)', 'Lubricants', 'pc', 'All', 280, 20, 30, 120, 0, 'WH-CPF', 80],
    ['HOSE-HP-12', 'High-pressure hydraulic hose ½" assembly', 'Hydraulics', 'pc', 'Travel lift, gantry crane', 3500, 3, 4, 12, 1, 'WH-CPF', 6],
    ['WIRE-ROPE-16', 'Wire rope 16 mm (per metre)', 'Lifting', 'm', 'Overhead / gantry cranes', 650, 50, 80, 300, 1, 'WH-CPF', 120],
    ['CONT-LC1D', 'Contactor LC1D 32A 220V coil', 'Electrical', 'pc', 'Cranes, batching plant', 2800, 2, 3, 10, 1, 'WH-CPF', 3],
    ['LIMIT-SW-XC', 'Limit switch XCKJ', 'Electrical', 'pc', 'Cranes', 3200, 2, 2, 8, 0, 'WH-CPF', 4],
    ['MIX-LINER', 'Mixer liner plate CBP100', 'Batching plant', 'pc', 'CBP100', 7800, 4, 6, 16, 1, 'WH-CPF', 9],
    ['MIX-ARM', 'Mixer arm & blade CBP100', 'Batching plant', 'pc', 'CBP100', 12500, 2, 2, 6, 1, 'WH-CPF', 2],
    ['BELT-CONV-800', 'Conveyor belt splice kit 800 mm', 'Batching plant', 'kit', 'CBP100, MBP20', 9500, 1, 1, 4, 0, 'WH-CPF', 2],
    ['BRAKE-PAD-TR', 'Brake lining set – prime mover', 'Brakes', 'set', 'Trucks, inloader', 6800, 1, 2, 6, 0, 'WH-CPF', 3],
    ['TIRE-FL-700', 'Forklift tire 7.00-12 solid', 'Tires', 'pc', 'Forklifts', 9800, 2, 2, 8, 0, 'WH-CPF', 4],
    ['BATT-N150', 'Battery N150 12V', 'Electrical', 'pc', 'Gensets, trucks', 8900, 2, 2, 8, 0, 'WH-CPF', 3],
    ['MAG-SHUTTER', 'Shuttering magnet 1350 kg', 'Moulds', 'pc', 'Battery moulds, tilting tables', 3600, 10, 15, 60, 0, 'WH-CPF', 40],
  ];
  const partId = {};
  for (const p of P) {
    partId[p[0]] = d.prepare(`INSERT INTO parts (part_no, name, category, uom, compatibility, unit_cost, min_qty, reorder_point, max_qty, is_critical, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
      .run(p[0], p[1], p[2], p[3], p[4], p[6], p[7], p[8], p[9], ts, ts).lastInsertRowid;
    inventory.receive(C['store.cpf'], { part_id: partId[p[0]], store_id: store(p[10]).id, qty: p[11], unit_cost: p[5], reference: 'OPENING BALANCE' });
  }
  inventory.transfer(C['store.cpf'], { part_id: partId['ENG-OIL-15W40'], from_store_id: store('WH-CPF').id, to_store_id: store('WH-CAL').id, qty: 6, reason: 'Project stock for Calauan gensets/forklift' });
  inventory.transfer(C['store.cpf'], { part_id: partId['OIL-FLT-GS'], from_store_id: store('WH-CPF').id, to_store_id: store('WH-CAL').id, qty: 4, reason: 'Project stock for Calauan genset' });

  // ------------------------------------------------ PMS plans
  const tpl = name => d.prepare('SELECT id FROM checklist_templates WHERE name = ?').get(name).id;
  const plan = (b, start) => pms.createPlan(C['sup.factory'].user.all_sites ? C['sup.factory'] : C.manager, { ...b, start_date: start });
  const s1 = time.addDays(startDay, 3);
  plan({ code: 'PM-TL-M', name: 'Monthly PMS – Travel Lift', category_id: cat('TL').id, frequency: 'MONTHLY', interval_value: 1, lead_days: 5, checklist_template_id: tpl('General PMS – Lifting Equipment'), est_labor_hours: 6, default_priority: 'HIGH', parts: [{ part_id: partId['GREASE-EP2'], qty: 4 }] }, s1);
  plan({ code: 'PM-GC-M', name: 'Monthly PMS – Gantry Crane', category_id: cat('GC').id, frequency: 'MONTHLY', interval_value: 1, lead_days: 5, checklist_template_id: tpl('General PMS – Lifting Equipment'), est_labor_hours: 5, default_priority: 'HIGH' }, time.addDays(startDay, 5));
  plan({ code: 'PM-OC-Q', name: 'Quarterly PMS – Overhead Crane', category_id: cat('OC').id, frequency: 'QUARTERLY', interval_value: 1, lead_days: 7, checklist_template_id: tpl('General PMS – Lifting Equipment'), est_labor_hours: 8 }, time.addDays(startDay, 20));
  plan({ code: 'PM-BP-W', name: 'Weekly PMS – Batching Plant', category_id: cat('BP').id, frequency: 'WEEKLY', interval_value: 1, lead_days: 2, checklist_template_id: tpl('General PMS – Batching Plant'), est_labor_hours: 4, default_priority: 'HIGH' }, time.addDays(startDay, 1));
  plan({ code: 'PM-GS-250', name: '250-hour PMS – Genset', category_id: cat('GS').id, frequency: 'HOURS', interval_value: 250, lead_days: 3, lead_meter: 25, checklist_template_id: tpl('General PMS – Genset'), est_labor_hours: 3,
    parts: [{ part_id: partId['OIL-FLT-GS'], qty: 1 }, { part_id: partId['ENG-OIL-15W40'], qty: 2 }] }, startDay);
  plan({ code: 'PM-FL-M', name: 'Monthly PMS – Forklift', category_id: cat('FL').id, frequency: 'MONTHLY', interval_value: 1, lead_days: 5, checklist_template_id: tpl('General PMS – Forklift / Mobile Equipment'), est_labor_hours: 3 }, time.addDays(startDay, 8));
  plan({ code: 'PM-MC-250', name: '250-hour PMS – Mobile Crane', category_id: cat('MC').id, frequency: 'HOURS', interval_value: 250, lead_days: 3, lead_meter: 25, checklist_template_id: tpl('General PMS – Lifting Equipment'), est_labor_hours: 8, default_priority: 'HIGH' }, startDay);
  plan({ code: 'PM-MO-M', name: 'Monthly mould inspection', category_id: cat('MO').id, frequency: 'MONTHLY', interval_value: 1, lead_days: 5, checklist_template_id: tpl('General PMS – Moulds and Forms'), est_labor_hours: 2, requires_shutdown: true, default_priority: 'MEDIUM' }, time.addDays(startDay, 12));
  plan({ code: 'PM-IL-5000', name: '5,000-km PMS – Inloader', category_id: cat('IL').id, frequency: 'KM', interval_value: 5000, lead_days: 3, lead_meter: 300, checklist_template_id: tpl('General PMS – Forklift / Mobile Equipment'), est_labor_hours: 5, default_priority: 'HIGH' }, startDay);
  plan({ code: 'PM-AC-M', name: 'Monthly PMS – Compressor & Pumps', category_id: cat('AC').id, frequency: 'MONTHLY', interval_value: 1, lead_days: 5, est_labor_hours: 2 }, time.addDays(startDay, 15));

  // ------------------------------------------------ simulation
  const techFor = siteCode => siteCode === 'CPF' ? ['tech.jun', 'tech.mark', 'tech.ana'] : ['tech.joel', 'tech.rico'];
  const supFor = siteCode => siteCode === 'CPF' ? 'sup.factory' : 'sup.projects';
  const siteOf = id => d.prepare('SELECT s.code FROM assets a JOIN sites s ON s.id = a.site_id WHERE a.id = ?').get(id).code;
  const hoursPerDay = { HOURS: [6, 11], KM: [80, 260] };
  const meterAssets = d.prepare(`SELECT id, meter_type FROM assets WHERE meter_type <> 'NONE'`).all();
  const failures = [
    ['HYD', 'Hydraulic hose burst on boom cylinder', 'HYD', 'LEAK', 'Hydraulic hose ½"', 'Replaced hose assembly, topped up hydraulic oil, bled system', 'HOSE-HP-12', 1],
    ['ELEC', 'Hoist does not respond – contactor burnt', 'ELEC', 'ELECFAULT', 'Hoist contactor', 'Replaced contactor and checked control circuit', 'CONT-LC1D', 1],
    ['ENGINE', 'Engine overheating and shut down', 'MECH', 'OVERHEAT', 'Radiator / fan belt', 'Replaced fan belt, flushed radiator, replaced coolant', null, 0],
    ['MECH', 'Mixer arm broken during batching', 'WEAR', 'BROKEN', 'Mixer arm & blade', 'Replaced mixer arm and blade, adjusted clearance', 'MIX-ARM', 1],
    ['ELEC', 'Genset fails to start – battery dead', 'ELEC', 'NOSTART', 'Starter battery', 'Replaced battery, checked charging alternator', 'BATT-N150', 1],
    ['TIRE', 'Front tire damaged', 'OPER', 'TIRE', 'Front tire', 'Replaced tire', 'TIRE-FL-700', 1],
    ['SAFETY', 'Overload limiter malfunction – lifting suspended', 'ELEC', 'CTRL', 'Overload limiter sensor', 'Recalibrated limiter and replaced limit switch', 'LIMIT-SW-XC', 1],
    ['MECH', 'Abnormal noise from travel gearbox', 'LUBE', 'NOISE', 'Travel gearbox bearing', 'Replaced bearing, refilled gear oil', null, 0],
    ['HYD', 'Hydraulic oil leak at pump', 'CONT', 'LEAK', 'Hydraulic pump seal', 'Replaced pump seal kit (external service), changed filter', 'HYD-FLT-10', 1],
    ['STRUCT', 'Mould side panel deformed', 'STRUCT', 'BROKEN', 'Mould side panel', 'Straightened and re-welded panel, re-checked dimensions', null, 0],
  ];
  const openCM = [];
  const issueParts = (ctx, wo, partNo, qty) => {
    try { inventory.issue(ctx, { part_id: partId[partNo], store_id: store('WH-CPF').id, qty, work_order_id: wo.id, recipient: wo.techName }); return true; }
    catch (e) { return false; }
  };

  for (let i = 0; i < days; i++) {
    const day = time.addDays(startDay, i);
    const isLast = i >= days - 6;
    at(day, '07:00');
    pms.generate({ user: null });

    // execute PMS due today (or overdue) – most on time, some late, a few missed
    const due = d.prepare(`SELECT w.* FROM work_orders w WHERE w.wo_type = 'PMS' AND w.status IN ('SCHEDULED','ASSIGNED') AND w.due_date <= ?`).all(day);
    for (const w of due) {
      const sc = siteOf(w.asset_id);
      const r = rand();
      const lateness = time.daysBetween(w.due_date, day);
      if (isLast && r < 0.75) continue; // leave some open at the end
      if (lateness === 0 && r < 0.3) continue; // slips a few days
      if (lateness > 0 && lateness < 9 && r < 0.45) continue;
      const supC = C[supFor(sc)];
      if (lateness >= 9) { if (rand() < 0.6) wos.transition(supC, w.id, 'MISSED', { remarks: 'Not performed – equipment in continuous production use' }); continue; }
      const techU = pick(techFor(sc));
      at(day, '08:00');
      if (w.status === 'SCHEDULED') wos.assign(supC, w.id, [C[techU].user.id]);
      at(day, '08:30');
      wos.transition(C[techU], w.id, 'IN_PROGRESS', {});
      const cl = d.prepare('SELECT * FROM wo_checklist_results WHERE work_order_id = ?').all(w.id);
      const finding = rand() < 0.15;
      wos.saveChecklist(C[techU], w.id, cl.map((c, idx) => ({ id: c.id, result: c.response_type === 'PASS_FAIL' ? (finding && idx === 1 ? 'FAIL' : 'PASS') : c.response_type === 'DONE' ? 'DONE' : c.response_type === 'VALUE' ? String(Math.round(60 + rand() * 40)) : 'OK', remarks: finding && idx === 1 ? 'Wear observed – corrective work recommended' : null })));
      const dur = (w.est_labor_hours || 3) * (0.8 + rand() * 0.6);
      wos.addLabor(C[techU], w.id, { hours: Math.round(dur * 2) / 2, work_date: day });
      const reqParts = w.schedule_id ? d.prepare('SELECT pp.* FROM pms_schedules s JOIN pms_plan_parts pp ON pp.plan_id = s.plan_id WHERE s.id = ?').all(w.schedule_id) : [];
      for (const rp of reqParts) { const pno = Object.keys(partId).find(k => partId[k] === rp.part_id); issueParts(C['store.cpf'].user.sites === null || C['store.cpf'].user.sites.includes(w.site_id) ? C['store.cpf'] : C[supFor(sc)], { ...w, techName: C[techU].user.full_name }, pno, rp.qty); }
      const asset = d.prepare('SELECT * FROM assets WHERE id = ?').get(w.asset_id);
      wos.update(C[techU], w.id, { work_performed: 'PMS performed as per checklist', findings: finding ? 'Wear observed on component – see checklist' : 'No abnormality', condition_after: finding ? 'Serviceable – monitor' : 'Good / serviceable',
        meter_at_completion: asset.meter_type !== 'NONE' ? asset.meter_reading : undefined });
      at(day, `${String(9 + Math.min(7, Math.round(dur))).padStart(2, '0')}:00`);
      wos.transition(C[techU], w.id, 'FOR_VERIFICATION', { remarks: 'Submitted' });
      at(day, '17:00');
      wos.transition(supC, w.id, 'CLOSED', { remarks: 'Verified' });
      if (finding && rand() < 0.6) wos.createLinkedCorrective(supC, w.id, { title: `Corrective repair from PMS finding – ${asset.asset_code}`, priority: 'MEDIUM' });
    }

    // random breakdowns
    const nb = rand() < 0.32 ? 1 : 0;
    for (let k = 0; k < nb; k++) {
      const cands = d.prepare(`SELECT a.* FROM assets a WHERE a.status IN ('AVAILABLE','OPERATIONAL') AND a.category_id NOT IN (SELECT id FROM equipment_categories WHERE code = 'RK')`).all();
      const weights = cands.map(a => (a.asset_code.startsWith('BP-CPF') || a.asset_code.startsWith('TL-CPF-01') || a.asset_code.startsWith('MC-') ? 3 : 1));
      let x = rand() * weights.reduce((t, v) => t + v, 0), a = cands[0];
      for (let j = 0; j < cands.length; j++) { x -= weights[j]; if (x <= 0) { a = cands[j]; break; } }
      const sc = siteOf(a.id);
      const f = a.asset_code.startsWith('BP-') ? pick([failures[3], failures[1], failures[9 - 6]]) : a.asset_code.startsWith('GS-') ? pick([failures[4], failures[2]]) : a.asset_code.startsWith('MO-') ? failures[9] : a.asset_code.startsWith('FL-') ? pick([failures[5], failures[2], failures[0]]) : pick([failures[0], failures[1], failures[6], failures[7], failures[8]]);
      const sev = a.criticality === 'CRITICAL' ? pick(['CRITICAL', 'HIGH', 'HIGH']) : pick(['HIGH', 'MEDIUM', 'MEDIUM', 'LOW']);
      const hh = 7 + Math.floor(rand() * 9);
      at(day, `${String(hh).padStart(2, '0')}:10`);
      const reporter = sc === 'CPF' ? (rand() < 0.5 ? 'prod.cpf' : 'sup.factory') : sc === 'CAL' ? 'custodian.cal' : 'sup.projects';
      let res;
      try {
        res = wos.reportBreakdown(C[reporter], { asset_id: a.id, category_code: f[0], description: f[1], severity: sev, impact: sev === 'LOW' ? 'RESTRICTED' : 'STOPPED',
          occurred_at: time.manilaToUtc(day, `${String(hh).padStart(2, '0')}:00`).toISOString(), production_impact: sev === 'CRITICAL' ? 'Production line stopped' : 'Reduced output', temporary_action: 'Equipment isolated and tagged out', confirm_duplicate: true });
      } catch (e) { continue; }
      openCM.push({ id: res.id, f, sc, start: i, plan: 1 + Math.floor(rand() * (f[7] && rand() < 0.35 ? 5 : 2)) });
    }

    // progress open corrective work (incl. linked CM from PMS findings)
    for (const lc of d.prepare(`SELECT id, asset_id FROM work_orders WHERE wo_type = 'CM' AND source = 'PMS_FINDING' AND status = 'REPORTED'`).all()) {
      if (!openCM.find(o => o.id === lc.id)) openCM.push({ id: lc.id, f: failures[7], sc: siteOf(lc.asset_id), start: i, plan: 2 + Math.floor(rand() * 4) });
    }
    for (const o of [...openCM]) {
      const w = wos.load(o.id);
      if (['CLOSED', 'CANCELLED'].includes(w.status)) { openCM.splice(openCM.indexOf(o), 1); continue; }
      if (isLast && rand() < 0.7) continue;
      const supC = C[supFor(o.sc)];
      const tech = pick(techFor(o.sc));
      const age = i - o.start;
      const hh = w.status === 'REPORTED' ? Math.max(Number(time.nowIso().slice(11, 13)) + 9, 9) : 9;
      at(day, `${String(Math.min(hh, 18)).padStart(2, '0')}:30`);
      if (w.status === 'REPORTED') { wos.assign(supC, w.id, [C[tech].user.id], { remarks: 'Assessed and assigned' }); wos.transition(C[tech], w.id, 'IN_PROGRESS', {}); if (o.f[7] && rand() < 0.4) wos.transition(C[tech], w.id, 'WAITING_PARTS', { remarks: 'Parts requested from stores' }); continue; }
      const assigned = d.prepare('SELECT u.username FROM wo_assignees a JOIN users u ON u.id = a.user_id WHERE a.work_order_id = ?').get(w.id).username;
      const tc = C[assigned];
      if (w.status === 'WAITING_PARTS') { if (age >= o.plan || rand() < 0.4) wos.transition(tc, w.id, 'IN_PROGRESS', { remarks: 'Parts received' }); continue; }
      if (w.status === 'ASSIGNED') { wos.transition(tc, w.id, 'IN_PROGRESS', {}); continue; }
      if (w.status === 'IN_PROGRESS' && (age >= o.plan - 1 || rand() < 0.5)) {
        at(day, '10:00');
        if (o.f[6]) issueParts(o.sc === 'CPF' || ['CAL', 'NAIC', 'GEN'].includes(o.sc) ? C['store.cpf'] : supC, { ...w, techName: tc.user.full_name }, o.f[6], 1);
        wos.addLabor(tc, w.id, { hours: Math.round((2 + rand() * 6) * 2) / 2, work_date: day });
        if (o.f[0] === 'HYD' && rand() < 0.5) costs.createManual(supC, { work_order_id: w.id, category: 'THIRD_PARTY_SERVICE', amount: Math.round(8000 + rand() * 25000), description: 'Hydraulic specialist service call', vendor: 'Hydraulic Power Systems Inc.', reference: `SI-${10000 + Math.floor(rand() * 9000)}` });
        if (w.priority === 'CRITICAL' && rand() < 0.3) costs.createManual(supC, { work_order_id: w.id, category: 'RENTAL', amount: Math.round(15000 + rand() * 30000), description: 'Rental of replacement equipment during breakdown', vendor: 'Precast Crane Services Co.', reference: `RN-${2000 + Math.floor(rand() * 900)}` });
        wos.update(tc, w.id, { work_performed: o.f[5], root_cause_code: o.f[2], failure_mode_code: o.f[3], failed_component: o.f[4], repair_action: o.f[5] });
        at(day, '14:00');
        wos.transition(tc, w.id, 'FOR_TESTING', {});
        wos.update(tc, w.id, { test_results: 'Functional and load test satisfactory', test_passed: true });
        at(day, '15:00');
        wos.transition(tc, w.id, 'FOR_VERIFICATION', { remarks: 'Repair complete, tested OK' });
        if (!isLast || rand() < 0.5) { at(day, '16:30'); wos.transition(supC, w.id, 'CLOSED', { remarks: 'Verified – returned to service' }); }
      }
    }
    at(day, '19:00');
    // meters
    for (const m of meterAssets) {
      const a = d.prepare('SELECT * FROM assets WHERE id = ?').get(m.id);
      if (!['AVAILABLE', 'OPERATIONAL', 'RUNNING_RESTRICTED'].includes(a.status) || time.isoWeekday(day) === 7) continue;
      const [lo, hi] = hoursPerDay[m.meter_type];
      wos.recordMeter(C['sup.factory'].user.sites && siteOf(m.id) !== 'CPF' ? C['sup.projects'] : C['sup.factory'], m.id, Math.round((a.meter_reading + lo + rand() * (hi - lo)) * 10) / 10, time.nowIso());
    }
    // supervisor/manager approve pending manual costs occasionally
    if (i % 7 === 6) for (const c of d.prepare(`SELECT id FROM cost_entries WHERE status = 'PENDING' AND source_type = 'MANUAL'`).all()) costs.decide(C.manager, c.id, true, 'Checked against invoice');
  }

  // a few explicit end-state scenarios for pilot testing
  const last = time.addDays(startDay, days - 1);
  at(last, '10:00');
  const tl = d.prepare('SELECT * FROM assets WHERE asset_code = ?').get('TL-CPF-01');
  if (tl.status === 'AVAILABLE') {
    wos.reportBreakdown(C['prod.cpf'], { asset_id: tl.id, category_code: 'HYD', description: 'Main hoist hydraulic cylinder leaking heavily – panel lifting stopped', severity: 'CRITICAL', impact: 'STOPPED', production_impact: 'Demoulding of wall panels stopped', temporary_action: 'Load lowered and isolated', confirm_duplicate: true });
  }
  // an overdue PMS (mould inspection slipped) and a job waiting for parts
  const moSched = d.prepare(`SELECT s.id FROM pms_schedules s JOIN pms_plans p ON p.id = s.plan_id WHERE p.code = 'PM-MO-M'
    AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.schedule_id = s.id AND w.status NOT IN ('CLOSED','CANCELLED','MISSED')) LIMIT 1`).get();
  if (moSched) { d.prepare('UPDATE pms_schedules SET next_due_date = ? WHERE id = ?').run(time.addDays(last, -6), moSched.id); pms.generate({ user: null }); }
  const ip = d.prepare(`SELECT w.id FROM work_orders w WHERE w.wo_type = 'CM' AND w.status = 'IN_PROGRESS' LIMIT 1`).get();
  if (ip) { const asg = d.prepare('SELECT u.username FROM wo_assignees a JOIN users u ON u.id = a.user_id WHERE a.work_order_id = ?').get(ip.id).username; wos.transition(C[asg], ip.id, 'WAITING_PARTS', { remarks: 'Waiting for seal kit from supplier' }); }
  const pr = inventory.createPR(C['tech.jun'], { part_id: partId['MIX-ARM'], store_id: store('WH-CPF').id, qty: 2, remarks: 'Below reorder point – mixer arms used in recent breakdowns' });
  inventory.requestAdjustment(C['store.cpf'], { part_id: partId['GREASE-EP2'], store_id: store('WH-CPF').id, qty: -3, reason: 'Cycle count variance – 3 cartridges damaged' });
  void pr;
  time.setClock(null);
  notify.runChecks();
  // simulated history: treat notifications older than 3 days as already read
  d.prepare('UPDATE notifications SET is_read = 1 WHERE created_at < ?').run(new Date(Date.now() - 3 * 864e5).toISOString());
  const n = d.prepare('SELECT COUNT(*) n FROM work_orders').get().n;
  return { users: users.length, assets: A.length, parts: P.length, work_orders: n };
}

async function backup(file) {
  const fs = require('fs');
  const dir = process.env.CMMS_BACKUP_DIR || path.join(path.dirname(path.resolve(file)), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `cmms-${time.nowIso().replace(/[:.]/g, '-')}.db`);
  await db.backup(dest);
  // keep the most recent backups only (default 30)
  const keep = Number(process.env.CMMS_BACKUP_KEEP || 30);
  const old = fs.readdirSync(dir).filter(f => /^cmms-.*\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return { dest, removed: old.length };
}

/** Emergency password reset from the server console (e.g. the only administrator is locked out). */
function resetPassword(username, password) {
  const u = db.get().prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!u) throw new Error(`User ${username} not found`);
  auth.validatePassword(password);
  db.get().prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, is_active = 1, updated_at = ? WHERE id = ?')
    .run(auth.hashPassword(password), time.nowIso(), u.id);
  db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  require('./audit').log({ user: null, ip: 'console' }, 'CONSOLE_PASSWORD_RESET', 'user', u.id, `${username} (reset from server console)`);
}

async function main() {
  const cmd = process.argv[2];
  const file = process.env.CMMS_DB || path.join(process.cwd(), 'data', 'cmms.db');
  db.open(file);
  try {
    if (cmd === 'init') {
      seed.initMasterData();
      console.log(`Initialised ${file}. Sign in as "admin" with CMMS_ADMIN_PASSWORD; you will be asked to change it.`);
    } else if (cmd === 'demo') {
      seed.initMasterData();
      const r = demo({ days: Number(process.env.CMMS_DEMO_DAYS || 90) });
      console.log(`Demo data loaded into ${file}:`, r);
      console.log('Demo accounts (password Demo1234): manager, sup.factory, sup.projects, tech.jun, tech.mark, tech.ana, tech.joel, tech.rico, store.cpf, custodian.cal, prod.cpf, viewer');
    } else if (cmd === 'backup') {
      const r = await backup(file);
      console.log(`Backup written to ${r.dest}${r.removed ? ` (${r.removed} old backup(s) removed)` : ''}`);
    } else if (cmd === 'reset-password') {
      const [username, password] = [process.argv[3], process.env.CMMS_NEW_PASSWORD];
      if (!username || !password) throw new Error('Usage: set CMMS_NEW_PASSWORD, then node server/cli.js reset-password <username>');
      resetPassword(username, password);
      console.log(`Password for ${username} reset. The user must change it at next sign-in; lockout cleared.`);
    } else {
      console.log('Usage: node server/cli.js init | demo | backup | reset-password <username>');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main();
module.exports = { demo, ctxFor, backup, resetPassword };
