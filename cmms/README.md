# Precast CMMS

This is a Computerized Maintenance Management System for **Precast Construction Solutions by Megawide**. It covers the central precast factory and the housing project sites (Calauan, Naic, Gentri, Batulao, Tayabas – The Cove, The Cove Lipa, Sights Bay, Taytay and future sites).

It is one system of record for:

- equipment and its status
- preventive maintenance (PMS)
- breakdowns and corrective work
- work orders
- spare parts
- downtime and availability
- maintenance costs
- KPIs and reports
- **site progress reports with photos taken on the phone** (see below)

All of it is stored in a real database and enforced by the server.

- Design, data model, workflows and KPI definitions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Pilot test scenarios and results: [`docs/TESTING.md`](docs/TESTING.md)

## Quick start

Requires Node.js 20 or later.

```bash
cd cmms
npm install

# Option A: an empty production database (master data plus one administrator)
CMMS_ADMIN_PASSWORD='ChangeMe123' npm run init-db
npm start                         # http://localhost:3000

# Option B: a demo database with about 90 days of simulated activity
CMMS_ADMIN_PASSWORD='ChangeMe123' CMMS_DB=data/demo.db npm run seed:demo
CMMS_DB=data/demo.db npm start
```

You sign in as `admin` with the password from `CMMS_ADMIN_PASSWORD`. The system makes you choose a new password the first time you sign in.

The demo creates these role accounts, all with the password `Demo1234`:

| Username | Role |
|---|---|
| `manager` | Maintenance Manager (all sites) |
| `sup.factory` | Maintenance Supervisor – factory |
| `sup.projects` | Maintenance Supervisor – project sites |
| `tech.jun`, `tech.mark`, `tech.ana`, `tech.joel`, `tech.rico` | Maintenance Technicians |
| `store.cpf` | Storekeeper |
| `custodian.cal` | Project Supervisor / Equipment Custodian (Calauan) |
| `prod.cpf` | Production / Logistics user |
| `viewer` | Management Viewer |
| `eng.cal`, `eng.south` | Site Engineer / Progress Reporter (Calauan; Naic & Gentri) |

The demo data is produced by running the real workflows day by day. Every dashboard figure comes from the recorded transactions; nothing is typed in by hand. Never load demo data into a production database. The `demo` command refuses to run if the database already contains equipment.

## Site progress reports (phone + photos)

Site engineers and project supervisors send a daily progress report from their phone. It goes straight into the database.

1. Open the app on the phone and tap **📷** in the top bar (or **Site progress → New progress report**).
2. Pick the site and date, then tap **Take photo** (opens the camera) or **Choose from gallery**. Add a caption if useful.
3. Write the work accomplished, any issues, the plan for the next day, and today's quantities: FTB produced/installed, m³ produced/installed, manpower, manhours, COCA. Optionally tap **📍 Add my location**.
4. Tap **Submit progress report**.

What happens on submit:

- **Photos are resized on the phone** (max 1920 px JPEG, about 300 KB instead of 4–10 MB). By default the site, area, date/time and reporter's name are **stamped** on each photo.
- **The report and its photos are saved on the phone first, then uploaded.** With no signal, they stay on the phone and **upload automatically** when the connection is back: on reconnect, when the app is reopened, and every 30 seconds. The **⏳** counter in the top bar shows what is still waiting; **Site progress → Upload queue** lists it.
- **No duplicates from retries.** The report and every photo carry an idempotency key, so a retry after a lost connection never stores them twice.
- **Second report for the same site and day:** the app warns first (the quantities would be counted twice). If the report was saved offline, the warning appears in the upload queue with **Submit anyway** / **Correct and resend** / **Discard**.
- The app itself must be opened while online. Once it is open, losing the signal does not lose the report.

After submission:

- **Progress reports** (`#/progress`) lists reports with photo thumbnails, filters and a "last 7 days" coverage panel showing which sites have not reported.
- A report (`#/progress/:id`) shows the photo gallery and quantities; **Print / PDF** gives a printable report with photos.
- The author can **correct** or **void** (with a reason) within `progress_edit_days` (default 7); users with `progress.manage` can do so at any time. Corrections are audited with old and new values. Reports are never deleted.
- **Monthly progress summary** (`#/progress/monthly`) totals the reports per site and month. Units, m³, manhours and COCA are summed; manpower is the **average daily headcount**. **Export for Monthly History (.xlsx)** produces rows in the exact column order and site names of the *Monthly History* sheet of `Housing Database.xlsx`, ready to paste. The targets stay blank.

Access:

| Permission | Who has it by default |
|---|---|
| `progress.submit` – submit reports, see your own | Site Engineer / Progress Reporter (new role), Project Supervisor / Custodian, Production / Logistics, Manager |
| `progress.view` – all reports and monthly summary in your sites | Site Engineer, Custodian, Maintenance Supervisor, Manager, Management Viewer |
| `progress.manage` – correct or void any report | Manager, Administrator |

Existing databases receive these default grants once, on the next start. Later changes under Roles & permissions are kept.

## Users and passwords

- **Sign-in** uses a username and password. The session is kept in an httpOnly, SameSite=Strict cookie. API clients can send a Bearer token instead.
- **Lockout:** an account locks for 15 minutes after 5 failed attempts. Unknown usernames and wrong passwords get the same error message.
- **Password storage:** passwords are salted scrypt hashes and can never be displayed. A password needs at least 8 characters, including letters and numbers.
- **My profile → Change password:** asks for the current password. After a change, all your other sessions are signed out.
- **Administration → Users & passwords** (administrators only) lets you:
  - create a user with a generated temporary password, a role and permitted sites
  - edit a user
  - deactivate a user (they are signed out immediately)
  - **reset** a password (the user is signed out, the lockout is cleared, and they must change it at the next sign-in)
  - **unlock** a locked account
- **Forgotten passwords:** the administrator resets them. No e-mail reset is built in because no mail server is configured.
- **Audit:** every sign-in, password change, reset, unlock and role or permission change is written to the audit log.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `CMMS_DB` | `./data/cmms.db` | SQLite database file |
| `CMMS_ADMIN_PASSWORD` | — | Password for the first administrator; used only when the database has no users |
| `CMMS_UPLOAD_DIR` | `./data/uploads` | Where photos and documents are stored |
| `CMMS_BACKUP_DIR` | `./data/backups` | Destination for online backups |
| `CMMS_PUBLIC_URL` | request host | Base URL encoded in equipment QR labels |
| `CMMS_TRUST_PROXY` | — | Set this when running behind a reverse proxy (e.g. `1`) |
| `CMMS_SECURE_COOKIE` | — | Set to `1` to force Secure cookies (use with HTTPS) |
| `CMMS_SMTP_URL` | — | E-mail channel; see "Notifications" below |
| `CMMS_DISABLE_SCHEDULER` | — | Set to `1` to turn off the hourly PMS generator and alert checks |

Business rules are changed in the app under **Administration → Settings & rules**, not in code. They include:

- PMS tolerance window
- whether planned downtime counts against availability
- independent verification
- labor rate
- repeat-failure window
- unavailability alert threshold
- negative stock policy
- escalation rules

## Deployment notes

- **Hosting:** run the app behind HTTPS (nginx, Caddy or IIS ARR) and set `CMMS_TRUST_PROXY=1` and `CMMS_SECURE_COOKIE=1`. No secrets are sent to the browser.
- **Database:** SQLite in WAL mode, accessed through a thin data layer (`server/db.js`). It is suitable for a single-server pilot with dozens of concurrent users. If the system grows to many sites with heavy concurrency, move to PostgreSQL; the schema is portable.
- **Backups:**
  - **Administration → Settings → Create database backup** takes a consistent online copy into `CMMS_BACKUP_DIR`.
  - Schedule an off-server copy of `CMMS_BACKUP_DIR` and `CMMS_UPLOAD_DIR`, for example nightly.
  - To restore: stop the app, replace `CMMS_DB` with a backup file, then start the app.
- **Data retention:**
  - Work orders, assets and inventory transactions cannot be deleted (enforced by database triggers). They are cancelled or archived instead.
  - The audit log is append-only.
- **Timezone and currency:** operational dates use Asia/Manila. Money is in PHP (₱).

## Notifications

- **In-app notifications** are always on: the bell icon and the Notifications page.
- **E-mail** is optional and **not sent by default**:
  - With the `email_enabled` setting on, messages are queued in the `notification_outbox` table.
  - Without `CMMS_SMTP_URL`, they are stored with the status `CHANNEL_NOT_CONFIGURED`. The app never reports them as sent.
  - Plugging in an SMTP sender is listed in the backlog.

## Offline use

Offline operation is implemented **only for progress reports** (see above): they are kept on the phone and uploaded automatically. Everything else needs a network connection. Failed saves show an error ("the change was NOT saved"). Breakdown reports, stock issues and work order creation carry an idempotency key, so retrying after a network error never creates duplicates.

## Tests

```bash
npm test     # 70 functional tests, Node's built-in test runner, in-memory database
```

The tests cover:

- users and passwords
- role and site access control
- the equipment registry
- PMS scheduling and compliance
- the complete breakdown workflow
- independent verification
- inventory reconciliation
- cost traceability
- availability calculations, including overlapping downtime and operating windows
- report and dashboard reconciliation
- Excel import
- secure uploads
- site progress reports: idempotent phone uploads, site scope, validation, duplicates, photos, corrections, voids, monthly roll-up and export

## Project layout

```
cmms/
  server/
    schema.sql          relational schema (constraints, indexes, append-only triggers)
    db.js  auth.js  rbac.js  settings.js  numbering.js  audit.js  time.js
    seed.js             master data (statuses, transitions, failure codes, sites, checklists)
    cli.js              init / demo data
    services/           business logic: workorders, pms, assetStatus (status + downtime), inventory,
                        costs, analytics (KPIs, availability), reports, notify, importer
    routes/             HTTP API (core/admin, maintenance, operations)
  public/               mobile-first single-page app (no build step)
  test/                 functional tests
  docs/                 architecture and testing documentation
```
