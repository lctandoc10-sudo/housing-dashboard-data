'use strict';
// Master data required for a working system (no demo transactions).
const db = require('./db');
const settings = require('./settings');
const rbac = require('./rbac');
const auth = require('./auth');
const { nowIso } = require('./time');

const WO_STATUSES = [
  // code, label, category, asset effect, description
  ['REPORTED', 'Reported', 'OPEN', null, 'Breakdown or defect reported, awaiting assessment'],
  ['SCHEDULED', 'Scheduled / Planned', 'OPEN', null, 'Planned work generated or created, not yet assigned'],
  ['UNDER_ASSESSMENT', 'Under Assessment', 'OPEN', null, 'Supervisor assessing scope, priority and resources'],
  ['ASSIGNED', 'Approved / Assigned', 'OPEN', null, 'Approved and assigned to technician(s)'],
  ['IN_PROGRESS', 'In Progress', 'OPEN', 'MAINT', 'Work being performed; equipment under maintenance'],
  ['WAITING_PARTS', 'Waiting for Parts', 'HOLD', 'WAITING_PARTS', 'Work stopped pending spare parts'],
  ['WAITING_EXTERNAL', 'Waiting for External Service', 'HOLD', 'WAITING_EXTERNAL', 'Waiting for supplier or third-party service'],
  ['FOR_TESTING', 'For Testing', 'OPEN', 'FOR_TESTING', 'Repair done; functional testing in progress'],
  ['FOR_VERIFICATION', 'For Verification', 'OPEN', 'FOR_TESTING', 'Submitted; awaiting supervisor verification and return-to-service approval'],
  ['CLOSED', 'Closed', 'DONE', null, 'Verified and closed; equipment returned to service'],
  ['CANCELLED', 'Cancelled', 'CANCELLED', null, 'Cancelled with recorded reason'],
  ['MISSED', 'Missed', 'MISSED', null, 'PMS not performed within its window (non-compliant)'],
];

const T = (types, from, to, perm) => types.map(t => [t, from, to, perm]);
const ALL_T = ['PMS', 'CM', 'INSPECTION', 'OTHER'];
const PLANNED_T = ['PMS', 'INSPECTION', 'OTHER'];
const WO_TRANSITIONS = [
  ...T(['CM'], 'REPORTED', 'UNDER_ASSESSMENT', 'wo.assess'),
  ...T(['CM'], 'REPORTED', 'ASSIGNED', 'wo.assign'),
  ...T(['CM'], 'UNDER_ASSESSMENT', 'ASSIGNED', 'wo.assign'),
  ...T(PLANNED_T, 'SCHEDULED', 'ASSIGNED', 'wo.assign'),
  ...T(ALL_T, 'ASSIGNED', 'IN_PROGRESS', 'wo.execute'),
  ...T(ALL_T, 'IN_PROGRESS', 'WAITING_PARTS', 'wo.execute'),
  ...T(ALL_T, 'IN_PROGRESS', 'WAITING_EXTERNAL', 'wo.execute'),
  ...T(ALL_T, 'WAITING_PARTS', 'IN_PROGRESS', 'wo.execute'),
  ...T(ALL_T, 'WAITING_EXTERNAL', 'IN_PROGRESS', 'wo.execute'),
  ...T(ALL_T, 'WAITING_PARTS', 'WAITING_EXTERNAL', 'wo.execute'),
  ...T(ALL_T, 'WAITING_EXTERNAL', 'WAITING_PARTS', 'wo.execute'),
  ...T(ALL_T, 'IN_PROGRESS', 'FOR_TESTING', 'wo.execute'),
  ...T(ALL_T, 'FOR_TESTING', 'IN_PROGRESS', 'wo.execute'),
  ...T(ALL_T, 'FOR_TESTING', 'FOR_VERIFICATION', 'wo.execute'),
  ...T(PLANNED_T, 'IN_PROGRESS', 'FOR_VERIFICATION', 'wo.execute'),
  ...T(ALL_T, 'FOR_VERIFICATION', 'IN_PROGRESS', 'wo.verify'),
  ...T(ALL_T, 'FOR_VERIFICATION', 'CLOSED', 'wo.close'),
  ...T(['CM'], 'REPORTED', 'CANCELLED', 'wo.cancel'),
  ...T(['CM'], 'UNDER_ASSESSMENT', 'CANCELLED', 'wo.cancel'),
  ...T(PLANNED_T, 'SCHEDULED', 'CANCELLED', 'wo.cancel'),
  ...T(ALL_T, 'ASSIGNED', 'CANCELLED', 'wo.cancel'),
  ...T(ALL_T, 'WAITING_PARTS', 'CANCELLED', 'wo.cancel'),
  ...T(ALL_T, 'WAITING_EXTERNAL', 'CANCELLED', 'wo.cancel'),
  ...T(['PMS'], 'SCHEDULED', 'MISSED', 'pms.mark_missed'),
  ...T(['PMS'], 'ASSIGNED', 'MISSED', 'pms.mark_missed'),
];

const FAILURE_CODES = {
  ROOT_CAUSE: [
    ['MECH', 'Mechanical failure'], ['ELEC', 'Electrical failure'], ['HYD', 'Hydraulic failure'],
    ['OPER', 'Operator-related issue'], ['NOPM', 'Lack of preventive maintenance'], ['LUBE', 'Lubrication failure'],
    ['CONT', 'Contamination'], ['WEAR', 'Wear and tear'], ['STRUCT', 'Structural damage'],
    ['EXT', 'External service or supplier issue'], ['OTHER', 'Other (remarks required)'],
  ],
  FAILURE_MODE: [
    ['NOSTART', 'Fails to start'], ['STOP', 'Stops during operation'], ['LEAK', 'Leakage (oil/hydraulic/air/water)'],
    ['OVERHEAT', 'Overheating'], ['NOISE', 'Abnormal noise / vibration'], ['LOWPERF', 'Reduced performance / capacity'],
    ['ELECFAULT', 'Electrical fault / trip'], ['BROKEN', 'Broken / cracked component'], ['CTRL', 'Control system fault'],
    ['BRAKE', 'Brake failure'], ['TIRE', 'Tire / wheel failure'], ['OTHER', 'Other'],
  ],
  BREAKDOWN_CATEGORY: [
    ['MECH', 'Mechanical'], ['ELEC', 'Electrical'], ['HYD', 'Hydraulic'], ['ENGINE', 'Engine / powertrain'],
    ['STRUCT', 'Structural'], ['SAFETY', 'Safety device'], ['CTRL', 'Controls / instrumentation'],
    ['PNEU', 'Pneumatic / air'], ['TIRE', 'Tires / undercarriage'], ['OTHER', 'Other'],
  ],
};

const CATEGORIES = [
  ['TL', 'Travel Lift', 'HOURS'], ['MC', 'Mobile Crane', 'HOURS'], ['GC', 'Gantry Crane', 'HOURS'],
  ['OC', 'Overhead Crane', 'HOURS'], ['BP', 'Batching Plant', 'HOURS'], ['GS', 'Generator / Genset', 'HOURS'],
  ['FL', 'Forklift', 'HOURS'], ['IL', 'Inloader Truck', 'KM'], ['AC', 'Air Compressor', 'HOURS'],
  ['WP', 'Water Pump', 'HOURS'], ['TR', 'Truck / Trailer / Transport', 'KM'], ['MO', 'Mould / Form / Battery Mould', 'NONE'],
  ['RK', 'Rack / Panel Holder / Handling Equipment', 'NONE'], ['FE', 'Other Factory Equipment / Tools', 'NONE'],
];

// Sites taken from the Housing Database workbook plus the sites named in the CMMS brief.
const SITES = [
  ['CPF', 'Central Precast Factory', 'FACTORY', '1,2,3,4,5,6', '06:00', '22:00'],
  ['CAL', 'Calauan (Alora + Amani)', 'PROJECT'], ['NAIC', 'Naic', 'PROJECT'], ['GEN', 'Gentri (General Trias)', 'PROJECT'],
  ['BAT-P', 'Batulao Parkhomes', 'PROJECT'], ['BAT-I', 'Batulao Impression', 'PROJECT'], ['TAY', 'Tayabas – The Cove', 'PROJECT'],
  ['LIPA', 'The Cove Lipa', 'PROJECT'], ['SB', 'Sights Bay', 'PROJECT'], ['TTY', 'Taytay', 'PROJECT'],
];

const CHECKLISTS = {
  'General PMS – Lifting Equipment': ['TL', [
    ['Lubrication', 'Grease all lubrication points (sheaves, pins, bearings)', 'DONE'],
    ['Engine / Power', 'Check engine oil level and condition; replace oil and filter if due', 'PASS_FAIL'],
    ['Hydraulics', 'Inspect hydraulic hoses, fittings and cylinders for leaks', 'PASS_FAIL'],
    ['Hydraulics', 'Hydraulic oil level (%)', 'VALUE'],
    ['Electrical', 'Check battery, wiring, limit switches and lights', 'PASS_FAIL'],
    ['Brakes', 'Test service and parking brakes', 'PASS_FAIL'],
    ['Structure', 'Inspect frame, welds and lifting beam for cracks or deformation', 'PASS_FAIL'],
    ['Wire rope', 'Inspect wire ropes / slings / hooks for wear, kinks and broken wires', 'PASS_FAIL'],
    ['Safety', 'Test emergency stop, horn, overload limiter and anti-collision devices', 'PASS_FAIL'],
    ['Function test', 'Perform no-load and rated-load functional test', 'PASS_FAIL'],
  ]],
  'General PMS – Batching Plant': ['BP', [
    ['Lubrication', 'Lubricate mixer shaft seals, conveyor bearings and gearboxes', 'DONE'],
    ['Mixer', 'Inspect mixer arms, liners and blades for wear', 'PASS_FAIL'],
    ['Weighing', 'Verify calibration of cement, aggregate, water and admixture scales', 'PASS_FAIL'],
    ['Pneumatics', 'Drain air receivers; check valves and cylinders', 'PASS_FAIL'],
    ['Conveyor', 'Check belt tension, alignment and scrapers', 'PASS_FAIL'],
    ['Electrical', 'Inspect control panel, motors and sensors', 'PASS_FAIL'],
    ['Cleaning', 'Remove concrete build-up from mixer and discharge gate', 'DONE'],
    ['Function test', 'Run test batch and confirm discharge', 'PASS_FAIL'],
  ]],
  'General PMS – Genset': ['GS', [
    ['Engine', 'Change engine oil and oil filter (if due)', 'DONE'],
    ['Engine', 'Check coolant level and radiator condition', 'PASS_FAIL'],
    ['Fuel', 'Replace fuel filter / drain water separator', 'DONE'],
    ['Air', 'Clean or replace air filter', 'DONE'],
    ['Electrical', 'Check battery voltage and charger', 'VALUE'],
    ['Electrical', 'Inspect AVR, breaker and output terminals', 'PASS_FAIL'],
    ['Function test', 'Run on load; record voltage and frequency', 'VALUE'],
  ]],
  'General PMS – Forklift / Mobile Equipment': ['FL', [
    ['Engine', 'Check engine oil, coolant and fuel system', 'PASS_FAIL'],
    ['Hydraulics', 'Inspect mast, chains, hoses and cylinders', 'PASS_FAIL'],
    ['Brakes', 'Test service and parking brakes', 'PASS_FAIL'],
    ['Tires', 'Inspect tires and wheel nuts', 'PASS_FAIL'],
    ['Lubrication', 'Grease chassis, mast and steering points', 'DONE'],
    ['Safety', 'Test horn, lights, reverse alarm and seat belt', 'PASS_FAIL'],
    ['Function test', 'Operational test (lift, tilt, travel)', 'PASS_FAIL'],
  ]],
  'General PMS – Moulds and Forms': ['MO', [
    ['Structure', 'Inspect mould faces, edges and welds for damage', 'PASS_FAIL'],
    ['Cleaning', 'Clean and apply release agent', 'DONE'],
    ['Mechanisms', 'Check hinges, locks, bolts and magnets', 'PASS_FAIL'],
    ['Dimensions', 'Verify critical dimensions within tolerance', 'PASS_FAIL'],
  ]],
};

const ESCALATIONS = [
  ['Critical breakdown unassigned > 1 h', 'CRITICAL_UNASSIGNED', 'CRITICAL', 1, 'MANAGER'],
  ['Critical work order past target > 4 h', 'WO_OVERDUE', 'CRITICAL', 4, 'MANAGER'],
  ['High priority work order past target > 24 h', 'WO_OVERDUE', 'HIGH', 24, 'MANAGER'],
  ['Equipment unavailable > 72 h', 'ASSET_UNAVAILABLE', null, 72, 'MANAGER'],
  ['PMS overdue > 7 days', 'PMS_OVERDUE', null, 168, 'MANAGER'],
  ['Waiting for parts > 48 h', 'WAITING_PARTS', null, 48, 'STOREKEEPER'],
];

function initMasterData({ adminPassword } = {}) {
  const d = db.get();
  const ts = nowIso();
  db.tx(() => {
    settings.init();
    rbac.initRoles();
    const insS = d.prepare('INSERT OR IGNORE INTO wo_statuses (code, label, category, asset_effect, sort_order, description, is_system) VALUES (?, ?, ?, ?, ?, ?, 1)');
    WO_STATUSES.forEach((s, i) => insS.run(s[0], s[1], s[2], s[3], (i + 1) * 10, s[4]));
    const insT = d.prepare('INSERT OR IGNORE INTO wo_transitions (wo_type, from_status, to_status, permission) VALUES (?, ?, ?, ?)');
    for (const t of WO_TRANSITIONS) insT.run(...t);
    const insF = d.prepare('INSERT OR IGNORE INTO failure_codes (kind, code, label) VALUES (?, ?, ?)');
    for (const [kind, list] of Object.entries(FAILURE_CODES)) for (const [c, l] of list) insF.run(kind, c, l);

    if (!d.prepare('SELECT 1 FROM equipment_categories LIMIT 1').get()) {
      const ins = d.prepare('INSERT INTO equipment_categories (code, name, meter_type, created_at) VALUES (?, ?, ?, ?)');
      for (const c of CATEGORIES) ins.run(c[0], c[1], c[2], ts);
    }
    if (!d.prepare('SELECT 1 FROM sites LIMIT 1').get()) {
      const ins = d.prepare('INSERT INTO sites (code, name, site_type, op_days, op_start, op_end, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insStore = d.prepare('INSERT INTO stores (site_id, code, name) VALUES (?, ?, ?)');
      SITES.forEach((s, i) => {
        const r = ins.run(s[0], s[1], s[2], s[3] || '1,2,3,4,5,6', s[4] || '07:00', s[5] || '19:00', i, ts, ts);
        insStore.run(r.lastInsertRowid, `WH-${s[0]}`, `${s[1]} Warehouse`);
      });
    }
    if (!d.prepare('SELECT 1 FROM checklist_templates LIMIT 1').get()) {
      const insTpl = d.prepare('INSERT INTO checklist_templates (name, category_id, created_at) VALUES (?, (SELECT id FROM equipment_categories WHERE code = ?), ?)');
      const insItem = d.prepare('INSERT INTO checklist_items (template_id, seq, section, description, response_type) VALUES (?, ?, ?, ?, ?)');
      for (const [name, [cat, items]] of Object.entries(CHECKLISTS)) {
        const id = insTpl.run(name, cat, ts).lastInsertRowid;
        items.forEach((it, i) => insItem.run(id, i + 1, it[0], it[1], it[2]));
      }
    }
    if (!d.prepare('SELECT 1 FROM escalation_rules LIMIT 1').get()) {
      const ins = d.prepare('INSERT INTO escalation_rules (name, event_type, priority, threshold_hours, notify_role, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const e of ESCALATIONS) ins.run(...e, ts);
    }
    if (!d.prepare('SELECT 1 FROM users LIMIT 1').get()) {
      const pw = adminPassword || process.env.CMMS_ADMIN_PASSWORD;
      if (!pw) throw new Error('Set CMMS_ADMIN_PASSWORD (min 8 chars, letters and numbers) to create the initial administrator');
      auth.validatePassword(pw);
      d.prepare(`INSERT INTO users (username, full_name, password_hash, role_code, all_sites, must_change_password, created_at, updated_at)
        VALUES ('admin', 'System Administrator', ?, 'ADMIN', 1, 1, ?, ?)`).run(auth.hashPassword(pw), ts, ts);
    }
  });
}

module.exports = { initMasterData, WO_STATUSES, WO_TRANSITIONS };
