-- CMMS schema (SQLite). All timestamps are ISO-8601 UTC strings ("...Z").
-- Calendar dates (due dates, work dates) are 'YYYY-MM-DD' in Asia/Manila local time.
-- Money is stored as REAL in Philippine Peso (PHP).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,            -- JSON encoded
  description TEXT,
  updated_by  INTEGER,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,               -- e.g. 'CM-2026'
  value INTEGER NOT NULL
);

-- ---------------------------------------------------------------- access control
CREATE TABLE IF NOT EXISTS roles (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code  TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_code, permission)
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role_code     TEXT NOT NULL REFERENCES roles(code),
  all_sites     INTEGER NOT NULL DEFAULT 0,
  position      TEXT,
  department    TEXT,
  skills        TEXT,                   -- comma separated skills / specialisations
  hourly_rate   REAL,                   -- internal labor rate (PHP/hour); null = default setting
  is_active     INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------- sites & locations
CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  site_type   TEXT NOT NULL DEFAULT 'PROJECT' CHECK (site_type IN ('PROJECT','FACTORY','WAREHOUSE','OFFICE')),
  address     TEXT,
  -- operating schedule used for availability (Asia/Manila local time)
  op_days     TEXT NOT NULL DEFAULT '1,2,3,4,5,6',   -- ISO weekdays 1=Mon..7=Sun
  op_start    TEXT NOT NULL DEFAULT '07:00',
  op_end      TEXT NOT NULL DEFAULT '19:00',         -- '24:00' allowed; op_start=00:00 & op_end=24:00 = round the clock
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER NOT NULL REFERENCES sites(id),
  name       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, name)
);

-- ---------------------------------------------------------------- master data
CREATE TABLE IF NOT EXISTS equipment_categories (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  meter_type  TEXT NOT NULL DEFAULT 'NONE' CHECK (meter_type IN ('NONE','HOURS','KM')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failure_codes (
  id        INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('ROOT_CAUSE','FAILURE_MODE','BREAKDOWN_CATEGORY')),
  code      TEXT NOT NULL,
  label     TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, code)
);

-- ---------------------------------------------------------------- assets
CREATE TABLE IF NOT EXISTS assets (
  id                 INTEGER PRIMARY KEY,
  asset_code         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name               TEXT NOT NULL,
  description        TEXT,
  category_id        INTEGER NOT NULL REFERENCES equipment_categories(id),
  manufacturer       TEXT,
  model              TEXT,
  serial_no          TEXT,
  plate_no           TEXT,
  site_id            INTEGER NOT NULL REFERENCES sites(id),
  location_id        INTEGER REFERENCES locations(id),
  date_acquired      TEXT,
  commissioning_date TEXT,
  purchase_value     REAL,
  supplier_id        INTEGER REFERENCES suppliers(id),
  warranty_expiry    TEXT,
  warranty_details   TEXT,
  custodian          TEXT,
  department         TEXT,
  criticality        TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (criticality IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status             TEXT NOT NULL DEFAULT 'AVAILABLE',
  status_reason      TEXT,
  status_since       TEXT,
  status_responsible TEXT,
  status_source      TEXT NOT NULL DEFAULT 'MANUAL' CHECK (status_source IN ('MANUAL','WO')),
  status_wo_id       INTEGER REFERENCES work_orders(id),
  est_recovery_at    TEXT,
  meter_type         TEXT NOT NULL DEFAULT 'NONE' CHECK (meter_type IN ('NONE','HOURS','KM')),
  meter_reading      REAL,
  meter_read_at      TEXT,
  last_pms_date      TEXT,
  is_archived        INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assets_site ON assets(site_id);
CREATE INDEX IF NOT EXISTS ix_assets_category ON assets(category_id);
CREATE INDEX IF NOT EXISTS ix_assets_status ON assets(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_assets_serial ON assets(manufacturer COLLATE NOCASE, serial_no COLLATE NOCASE)
  WHERE serial_no IS NOT NULL AND serial_no <> '';

CREATE TABLE IF NOT EXISTS asset_status_history (
  id            INTEGER PRIMARY KEY,
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  work_order_id INTEGER REFERENCES work_orders(id),
  changed_by    INTEGER REFERENCES users(id),
  changed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ash_asset ON asset_status_history(asset_id, changed_at);

CREATE TABLE IF NOT EXISTS meter_readings (
  id          INTEGER PRIMARY KEY,
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  reading     REAL NOT NULL,
  reading_at  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'MANUAL',
  work_order_id INTEGER REFERENCES work_orders(id),
  recorded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_meter_asset ON meter_readings(asset_id, reading_at);

CREATE TABLE IF NOT EXISTS asset_transfers (
  id               INTEGER PRIMARY KEY,
  asset_id         INTEGER NOT NULL REFERENCES assets(id),
  from_site_id     INTEGER NOT NULL REFERENCES sites(id),
  to_site_id       INTEGER NOT NULL REFERENCES sites(id),
  from_location_id INTEGER REFERENCES locations(id),
  to_location_id   INTEGER REFERENCES locations(id),
  reason           TEXT NOT NULL,
  transferred_by   INTEGER NOT NULL REFERENCES users(id),
  transferred_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_transfer_asset ON asset_transfers(asset_id);

-- ---------------------------------------------------------------- checklists & PMS
CREATE TABLE IF NOT EXISTS checklist_templates (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES equipment_categories(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id            INTEGER PRIMARY KEY,
  template_id   INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  section       TEXT,
  description   TEXT NOT NULL,
  response_type TEXT NOT NULL DEFAULT 'PASS_FAIL' CHECK (response_type IN ('PASS_FAIL','VALUE','TEXT','DONE')),
  is_required   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pms_plans (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                  TEXT NOT NULL,
  category_id           INTEGER REFERENCES equipment_categories(id),  -- plan for an equipment type ...
  asset_id              INTEGER REFERENCES assets(id),                -- ... or for an individual asset
  frequency             TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL','CUSTOM_DAYS','HOURS','KM')),
  interval_value        REAL NOT NULL DEFAULT 1,   -- multiplier for calendar freqs, days for CUSTOM_DAYS, hours/km for meter freqs
  schedule_basis        TEXT NOT NULL DEFAULT 'FIXED' CHECK (schedule_basis IN ('FIXED','FLOATING')),
  lead_days             INTEGER NOT NULL DEFAULT 7,   -- generate WO this many days before due
  lead_meter            REAL NOT NULL DEFAULT 0,      -- generate WO this many hours/km before due
  checklist_template_id INTEGER REFERENCES checklist_templates(id),
  est_labor_hours       REAL,
  requires_shutdown     INTEGER NOT NULL DEFAULT 1,
  default_priority      TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (default_priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  instructions          TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_by            INTEGER REFERENCES users(id),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK ((category_id IS NULL) <> (asset_id IS NULL))
);

CREATE TABLE IF NOT EXISTS pms_plan_parts (
  id      INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES pms_plans(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES parts(id),
  qty     REAL NOT NULL CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS pms_schedules (
  id              INTEGER PRIMARY KEY,
  plan_id         INTEGER NOT NULL REFERENCES pms_plans(id),
  asset_id        INTEGER NOT NULL REFERENCES assets(id),
  start_date      TEXT NOT NULL,
  last_done_date  TEXT,
  last_done_meter REAL,
  next_due_date   TEXT,
  next_due_meter  REAL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (plan_id, asset_id)
);
CREATE INDEX IF NOT EXISTS ix_sched_due ON pms_schedules(next_due_date);

-- ---------------------------------------------------------------- work orders
CREATE TABLE IF NOT EXISTS wo_statuses (
  code          TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('OPEN','HOLD','DONE','CANCELLED','MISSED')),
  asset_effect  TEXT,          -- asset status while WO is in this state (MAINT = Under PM/CM by type); null = no change
  sort_order    INTEGER NOT NULL,
  description   TEXT,
  is_system     INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS wo_transitions (
  id          INTEGER PRIMARY KEY,
  wo_type     TEXT NOT NULL,           -- PMS / CM / INSPECTION / OTHER / * (any)
  from_status TEXT NOT NULL REFERENCES wo_statuses(code),
  to_status   TEXT NOT NULL REFERENCES wo_statuses(code),
  permission  TEXT NOT NULL,           -- permission required to perform the transition
  UNIQUE (wo_type, from_status, to_status)
);

CREATE TABLE IF NOT EXISTS work_orders (
  id                 INTEGER PRIMARY KEY,
  wo_number          TEXT NOT NULL UNIQUE,
  wo_type            TEXT NOT NULL CHECK (wo_type IN ('PMS','CM','INSPECTION','OTHER')),
  source             TEXT NOT NULL DEFAULT 'MANUAL',  -- MANUAL / PMS_SCHEDULE / BREAKDOWN / PMS_FINDING / INVESTIGATION / IMPORT
  asset_id           INTEGER NOT NULL REFERENCES assets(id),
  site_id            INTEGER NOT NULL REFERENCES sites(id),   -- site at time of the work
  schedule_id        INTEGER REFERENCES pms_schedules(id),
  parent_wo_id       INTEGER REFERENCES work_orders(id),
  investigation_id   INTEGER REFERENCES failure_investigations(id),
  title              TEXT NOT NULL,
  description        TEXT,
  priority           TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status             TEXT NOT NULL REFERENCES wo_statuses(code),
  requires_shutdown  INTEGER NOT NULL DEFAULT 1,
  requested_by       INTEGER REFERENCES users(id),
  supervisor_id      INTEGER REFERENCES users(id),
  due_date           TEXT,             -- PMS: compliance due date (after approved rescheduling)
  original_due_date  TEXT,
  due_meter          REAL,
  planned_start      TEXT,
  planned_end        TEXT,             -- target completion / target recovery
  actual_start       TEXT,
  actual_end         TEXT,
  returned_to_service_at TEXT,
  est_labor_hours    REAL,
  est_cost           REAL,
  checklist_template_id INTEGER REFERENCES checklist_templates(id),
  work_performed     TEXT,
  findings           TEXT,
  defects_found      TEXT,
  recommendations    TEXT,
  condition_after    TEXT,
  test_results       TEXT,
  test_passed        INTEGER,
  completion_remarks TEXT,
  meter_at_completion REAL,
  -- corrective / failure analysis
  root_cause_code    TEXT,
  root_cause_remarks TEXT,
  failure_mode_code  TEXT,
  failed_component   TEXT,
  repair_action      TEXT,
  is_recurrence      INTEGER NOT NULL DEFAULT 0,
  -- approvals
  submitted_by       INTEGER REFERENCES users(id),
  submitted_at       TEXT,
  verified_by        INTEGER REFERENCES users(id),
  verified_at        TEXT,
  closed_by          INTEGER REFERENCES users(id),
  closed_at          TEXT,
  cancelled_by       INTEGER REFERENCES users(id),
  cancelled_at       TEXT,
  cancel_reason      TEXT,
  reschedule_count   INTEGER NOT NULL DEFAULT 0,
  client_request_id  TEXT UNIQUE,
  version            INTEGER NOT NULL DEFAULT 1,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wo_asset ON work_orders(asset_id);
CREATE INDEX IF NOT EXISTS ix_wo_site ON work_orders(site_id);
CREATE INDEX IF NOT EXISTS ix_wo_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS ix_wo_type_due ON work_orders(wo_type, due_date);
CREATE INDEX IF NOT EXISTS ix_wo_schedule ON work_orders(schedule_id);
CREATE INDEX IF NOT EXISTS ix_wo_created ON work_orders(created_at);

CREATE TABLE IF NOT EXISTS wo_assignees (
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  assigned_by   INTEGER REFERENCES users(id),
  assigned_at   TEXT NOT NULL,
  PRIMARY KEY (work_order_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_assignee_user ON wo_assignees(user_id);

CREATE TABLE IF NOT EXISTS wo_status_history (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  remarks       TEXT,
  changed_by    INTEGER REFERENCES users(id),
  changed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wosh_wo ON wo_status_history(work_order_id);

CREATE TABLE IF NOT EXISTS wo_checklist_results (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  section       TEXT,
  description   TEXT NOT NULL,
  response_type TEXT NOT NULL,
  is_required   INTEGER NOT NULL DEFAULT 1,
  result        TEXT,          -- PASS / FAIL / NA / DONE / free value
  remarks       TEXT,
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_wocl_wo ON wo_checklist_results(work_order_id);

CREATE TABLE IF NOT EXISTS wo_reschedules (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  old_due_date  TEXT,
  new_due_date  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  authorized_by INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labor_entries (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  work_date     TEXT NOT NULL,
  hours         REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  rate          REAL NOT NULL,
  cost          REAL NOT NULL,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  is_void       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_labor_wo ON labor_entries(work_order_id);

CREATE TABLE IF NOT EXISTS wo_progress_notes (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  note          TEXT NOT NULL,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------- breakdowns & investigations
CREATE TABLE IF NOT EXISTS breakdowns (
  id                  INTEGER PRIMARY KEY,
  report_no           TEXT NOT NULL UNIQUE,
  asset_id            INTEGER NOT NULL REFERENCES assets(id),
  site_id             INTEGER NOT NULL REFERENCES sites(id),
  work_order_id       INTEGER NOT NULL UNIQUE REFERENCES work_orders(id),
  reported_by         INTEGER NOT NULL REFERENCES users(id),
  reported_at         TEXT NOT NULL,
  occurred_at         TEXT,
  category_code       TEXT NOT NULL,
  description         TEXT NOT NULL,
  operating_condition TEXT,
  impact              TEXT NOT NULL CHECK (impact IN ('STOPPED','RESTRICTED','NONE')),
  safety_impact       TEXT,
  production_impact   TEXT,
  severity            TEXT NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  temporary_action    TEXT,
  is_failure          INTEGER NOT NULL DEFAULT 1   -- counts toward MTBF / breakdown frequency (0 if cancelled as invalid)
);
CREATE INDEX IF NOT EXISTS ix_bd_asset ON breakdowns(asset_id, reported_at);

CREATE TABLE IF NOT EXISTS failure_investigations (
  id                INTEGER PRIMARY KEY,
  inv_no            TEXT NOT NULL UNIQUE,
  asset_id          INTEGER NOT NULL REFERENCES assets(id),
  title             TEXT NOT NULL,
  problem_statement TEXT,
  root_cause        TEXT,
  preventive_actions TEXT,
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  closed_by         INTEGER REFERENCES users(id),
  closed_at         TEXT
);

-- ---------------------------------------------------------------- downtime
CREATE TABLE IF NOT EXISTS downtime_events (
  id            INTEGER PRIMARY KEY,
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  site_id       INTEGER NOT NULL REFERENCES sites(id),
  work_order_id INTEGER REFERENCES work_orders(id),
  category      TEXT NOT NULL CHECK (category IN ('PLANNED','UNPLANNED','WAITING_PARTS','EXTERNAL','OTHER')),
  asset_status  TEXT,
  reason        TEXT,
  start_at      TEXT NOT NULL,
  end_at        TEXT,
  source        TEXT NOT NULL DEFAULT 'AUTO',   -- AUTO (from status changes) / MANUAL
  is_void       INTEGER NOT NULL DEFAULT 0,     -- voided when a breakdown report is cancelled as invalid
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  CHECK (end_at IS NULL OR end_at >= start_at)
);
CREATE INDEX IF NOT EXISTS ix_dt_asset ON downtime_events(asset_id, start_at);
CREATE INDEX IF NOT EXISTS ix_dt_open ON downtime_events(asset_id) WHERE end_at IS NULL;

-- ---------------------------------------------------------------- inventory
CREATE TABLE IF NOT EXISTS stores (
  id        INTEGER PRIMARY KEY,
  site_id   INTEGER NOT NULL REFERENCES sites(id),
  code      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name      TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS parts (
  id            INTEGER PRIMARY KEY,
  part_no       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  uom           TEXT NOT NULL DEFAULT 'pc',
  compatibility TEXT,                  -- compatible equipment categories / models
  supplier_id   INTEGER REFERENCES suppliers(id),
  unit_cost     REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),  -- moving average cost
  min_qty       REAL NOT NULL DEFAULT 0,
  max_qty       REAL,
  reorder_point REAL NOT NULL DEFAULT 0,
  is_critical   INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_balances (
  part_id      INTEGER NOT NULL REFERENCES parts(id),
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  qty_on_hand  REAL NOT NULL DEFAULT 0,
  qty_reserved REAL NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  bin_location TEXT,
  PRIMARY KEY (part_id, store_id)
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id             INTEGER PRIMARY KEY,
  txn_no         TEXT NOT NULL UNIQUE,
  txn_type       TEXT NOT NULL CHECK (txn_type IN ('RECEIPT','ISSUE','RETURN','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT')),
  status         TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','PENDING_APPROVAL','REJECTED')),
  part_id        INTEGER NOT NULL REFERENCES parts(id),
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  qty            REAL NOT NULL,          -- signed: + into store, - out of store
  unit_cost      REAL NOT NULL,
  total_cost     REAL NOT NULL,
  balance_after  REAL,
  work_order_id  INTEGER REFERENCES work_orders(id),
  asset_id       INTEGER REFERENCES assets(id),
  site_id        INTEGER REFERENCES sites(id),
  recipient      TEXT,
  reference      TEXT,                   -- PO / DR / invoice number
  reason         TEXT,
  related_txn_id INTEGER REFERENCES inventory_transactions(id),
  purchase_request_id INTEGER REFERENCES purchase_requests(id),
  client_request_id TEXT UNIQUE,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_inv_part ON inventory_transactions(part_id, store_id);
CREATE INDEX IF NOT EXISTS ix_inv_wo ON inventory_transactions(work_order_id);
CREATE INDEX IF NOT EXISTS ix_inv_created ON inventory_transactions(created_at);

CREATE TABLE IF NOT EXISTS part_reservations (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
  part_id       INTEGER NOT NULL REFERENCES parts(id),
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  qty_reserved  REAL NOT NULL CHECK (qty_reserved > 0),
  qty_issued    REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FULFILLED','RELEASED')),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_res_wo ON part_reservations(work_order_id);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id            INTEGER PRIMARY KEY,
  pr_no         TEXT NOT NULL UNIQUE,
  part_id       INTEGER NOT NULL REFERENCES parts(id),
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  qty           REAL NOT NULL CHECK (qty > 0),
  qty_received  REAL NOT NULL DEFAULT 0,
  est_unit_cost REAL,
  supplier_id   INTEGER REFERENCES suppliers(id),
  work_order_id INTEGER REFERENCES work_orders(id),
  status        TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','ORDERED','PARTIAL','RECEIVED','REJECTED','CANCELLED')),
  needed_by     TEXT,
  remarks       TEXT,
  po_reference  TEXT,
  requested_by  INTEGER NOT NULL REFERENCES users(id),
  requested_at  TEXT NOT NULL,
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------- costs
CREATE TABLE IF NOT EXISTS cost_entries (
  id            INTEGER PRIMARY KEY,
  work_order_id INTEGER REFERENCES work_orders(id),
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  site_id       INTEGER NOT NULL REFERENCES sites(id),
  category      TEXT NOT NULL CHECK (category IN ('PARTS','INTERNAL_LABOR','EXTERNAL_LABOR','THIRD_PARTY_SERVICE','RENTAL','OTHER')),
  kind          TEXT NOT NULL DEFAULT 'ACTUAL' CHECK (kind IN ('ESTIMATE','ACTUAL')),
  amount        REAL NOT NULL,
  entry_date    TEXT NOT NULL,         -- Manila calendar date
  description   TEXT,
  vendor        TEXT,
  reference     TEXT,
  source_type   TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source_type IN ('MANUAL','INV_TXN','LABOR','IMPORT')),
  source_id     INTEGER,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','VOID')),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_source ON cost_entries(source_type, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_cost_asset ON cost_entries(asset_id, entry_date);
CREATE INDEX IF NOT EXISTS ix_cost_wo ON cost_entries(work_order_id);

-- ---------------------------------------------------------------- attachments, notifications, approvals, audit
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  caption     TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_att_entity ON attachments(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'INFO',
  title       TEXT NOT NULL,
  body        TEXT,
  entity_type TEXT,
  entity_id   INTEGER,
  dedupe_key  TEXT NOT NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, is_read, created_at);

-- tracks conditions already alerted, so unchanged conditions are not re-notified
CREATE TABLE IF NOT EXISTS alert_conditions (
  key       TEXT PRIMARY KEY,
  raised_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT,
  status     TEXT NOT NULL CHECK (status IN ('QUEUED','SENT','FAILED','CHANNEL_NOT_CONFIGURED')),
  error      TEXT,
  created_at TEXT NOT NULL,
  sent_at    TEXT
);

CREATE TABLE IF NOT EXISTS escalation_rules (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN ('WO_OVERDUE','CRITICAL_UNASSIGNED','ASSET_UNAVAILABLE','PMS_OVERDUE','WAITING_PARTS')),
  priority        TEXT,           -- null = any
  site_id         INTEGER REFERENCES sites(id),  -- null = all sites
  threshold_hours REAL NOT NULL,
  notify_role     TEXT NOT NULL REFERENCES roles(code),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  action      TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  remarks     TEXT,
  decided_by  INTEGER NOT NULL REFERENCES users(id),
  decided_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_approvals_entity ON approvals(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  summary     TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at);

-- audit log and history tables are append-only
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_invtxn_no_delete BEFORE DELETE ON inventory_transactions
BEGIN SELECT RAISE(ABORT, 'inventory transactions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_wo_no_delete BEFORE DELETE ON work_orders
BEGIN SELECT RAISE(ABORT, 'work orders cannot be deleted; cancel instead'); END;
CREATE TRIGGER IF NOT EXISTS trg_asset_no_delete BEFORE DELETE ON assets
BEGIN SELECT RAISE(ABORT, 'assets cannot be deleted; archive instead'); END;
