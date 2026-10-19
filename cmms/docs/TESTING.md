# Functional test record

Run the suite with `npm test`. It uses Node's built-in test runner with a fresh in-memory database and the real HTTP API. Most scenarios use an injected clock, so time-dependent behaviour such as overdue PMS and downtime hours is deterministic.

**Result: 60 tests, 60 passed.**

## Mapping to the acceptance criteria

| # | Criterion | Covered by |
|---|---|---|
| 1 | Admin registers equipment and assigns it to a project | `access_assets` – registry tests (duplicate ID and serial, date validation) |
| 2 | Supervisor creates a PMS plan and generates a due WO | `pms` – category plan, lead window, no duplicates, new assets picked up |
| 3 | Upcoming and overdue PMS flagged correctly | `pms` – notifications sent once, overdue filter, dashboard KPI |
| 4 | Breakdown reported and processed through the complete workflow | `breakdown` – reported → assessment → assigned → in progress → waiting for parts → testing → verification → closed |
| 5 | Completed repair records cause, action, parts, labor and test results | `breakdown` – submit refused until root cause, failure mode, component, repair action, tests and labor are recorded |
| 6 | PMS and corrective reported separately | `availability_reports` – CM register, PMS vs CM chart; PMS stays PMS when a linked CM is raised |
| 7 | Equipment status follows the approved workflow | `breakdown` – Breakdown → Under CM → Waiting for Parts → For Testing (not released) → Available only after closure |
| 8 | Downtime and availability traceable and validated | `availability_reports` – operating windows in Manila, overlap counted once, night downtime excluded, fleet weighting; `breakdown` – 29 h split into unplanned and waiting for parts |
| 9 | Spare parts transactions reconcile with balances | `inventory_costs` – moving average, issue/return/transfer/adjustment, Σ transactions = balance, no deletion |
| 10 | Costs traceable to assets, WOs and projects | `inventory_costs` – single costing per source, labor rate, estimate vs actual, approval, report = dashboard |
| 11 | No access to unauthorised records or functions | `access_assets`, `auth_users`, `inventory_costs` – site scoping, role permissions, cost data hidden, finance export restricted |
| 12 | Reports and dashboards reconcile with the database | `availability_reports` – KPI vs availability, downtime and breakdown reports; every report runs and exports CSV and XLSX |
| 13 | Works on desktop and mobile | Browser smoke test (Playwright, 1400 px and 390 px viewports, 4 roles, 39 screens): no script errors; pages blocked for a role show a permission message |
| 14 | Important actions audited | `breakdown`, `auth_users` – audit rows for WO actions, password changes, resets, unlocks |
| 15 | Failed saves, duplicates and invalid transactions handled | `breakdown` – idempotent resubmission, duplicate warning, stale version 409, invalid times rejected; `inventory_costs` – negative stock refused, idempotent issue |

Additional coverage:

- **Users and passwords:** lockout and unlock, forced change, password strength, session revocation on reset and change, deactivation.
- **Excel import:** errors leave the database unchanged; a valid import creates equipment, parts with opening stock and history.
- **Secure uploads:** file type allow-list, content checking against the declared type, per-site download control, `nosniff` header.

## Realistic scenario data

`npm run seed:demo` simulates 90 days of operations through the same services. It covers:

- **Equipment:** travel lifts, gantry and overhead cranes, a mobile crane, CBP100 and MBP20 batching plants, gensets, forklifts, inloaders, compressors, pumps, trucks, battery moulds and racks.
- **Activity:** PMS (calendar and hour/km based), breakdowns with parts issues, external services and rentals, PMS findings that raise linked corrective WOs, missed and late PMS, waiting-for-parts jobs, a pending purchase request and a stock adjustment awaiting approval.

After seeding, the integrity check reports no stock mismatches and no overlapping open downtime.
