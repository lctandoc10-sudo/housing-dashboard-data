# Housing Dashboard Data & Precast CMMS

This repository holds two things for **Precast Construction Solutions by Megawide**:

| Item | What it is |
|---|---|
| [`cmms/`](cmms/) | **Maintenance management system (CMMS)** for the central precast factory and the housing project sites. It covers equipment, PMS, breakdowns, work orders, spare parts, downtime, costs and KPIs. |
| `Housing Database.xlsx` | Data workbook for the FTB Supply & Production dashboard (project overview and monthly history per site). |
| [`tools/travel-lift-cycle.html`](tools/travel-lift-cycle.html) | **Travel lift cycle calculator** (time and motion): standard cycle time and panels per hour/shift for moving an FTB panel from demould to a storage rack, for any casting bed × rack pair. |

## CMMS at a glance

- **Equipment registry:** QR labels, status, transfers between sites, full history
- **Preventive maintenance (PMS):** by calendar, operating hours or km, with automatic work orders, checklists and compliance tracking
- **Breakdowns:** mobile reporting and a corrective workflow; a job is closed only after independent verification
- **Spare parts:** inventory, purchase requests, maintenance costs in PHP
- **Dashboard:** availability, MTTR, MTBF and backlog; every figure traceable to its records
- **Access:** user roles, site-based access, password management, audit log

| To find | Read |
|---|---|
| How to install and run | [`cmms/README.md`](cmms/README.md) |
| Design, data model, workflows, KPI formulas | [`cmms/docs/ARCHITECTURE.md`](cmms/docs/ARCHITECTURE.md) |
| Test results against the acceptance criteria | [`cmms/docs/TESTING.md`](cmms/docs/TESTING.md) |

Quick start (requires Node.js 20+):

```bash
cd cmms
npm install
CMMS_ADMIN_PASSWORD='ChangeMe123' CMMS_DB=data/demo.db npm run seed:demo   # sample data
CMMS_DB=data/demo.db npm start                                            # http://localhost:3000
```

## Travel lift cycle calculator

`tools/travel-lift-cycle.html` is a single self-contained page. Open it in any browser; no install or server needed.

- Enter the fixed work elements (stopwatch averages, seconds), the loaded and empty travel speeds, PF&D allowance, shift hours and utilisation.
- Enter the casting beds and storage racks as chainages (m) along the travel lift runway.
- It shows the standard cycle, panels/hour and panels/shift for the selected pair, a step-by-step breakdown, an animated runway side view and a bed × rack cycle matrix.
- Formulas: loaded travel = distance ÷ loaded speed + accel/decel; empty return likewise (optional); standard cycle = (fixed + travel) × (1 + PF&D %); panels/hour = 3600 ÷ standard × utilisation.
- Inputs are saved in that browser only. The sample values are examples; replace them with measured data.
