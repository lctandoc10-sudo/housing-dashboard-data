# Housing Dashboard Data & Precast CMMS

This repository holds the following for **Precast Construction Solutions by Megawide**:

| Item | What it is |
|---|---|
| [`cmms/`](cmms/) | **Maintenance management system (CMMS)** for the central precast factory and the housing project sites. It covers equipment, PMS, breakdowns, work orders, spare parts, downtime, costs and KPIs. |
| `Housing Database.xlsx` | Data workbook for the FTB Supply & Production dashboard (project overview and monthly history per site). |
| [`materials-inventory/`](materials-inventory/) | **Cement & aggregates inventory monitoring (Excel)** per housing site: current stock, consumption from m3 produced × mix design, deliveries, critical-stock alerts (days remaining, stock-out date), 6-month consumption forecast and a dashboard. |

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
