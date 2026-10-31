# Cement & Aggregates Inventory Monitoring

Excel workbook that tracks cement, sand, gravel (3/4" and 3/8") and concrete admixture for each housing site: stock on hand, consumption calculated from the m3 of concrete produced, deliveries, critical-stock alerts, a daily-to-monthly forecast and a dashboard.

| File | Use it for |
|---|---|
| `Cement and Aggregates Inventory.xlsx` | **Real data.** Blank template. The 8 housing sites and 4 materials are already listed. |
| `Cement and Aggregates Inventory - Sample Data.xlsx` | **Demo.** The same workbook filled with illustrative October 2026 data, so every status and chart has something to show. The figures are made up. |
| `build_workbook.py` | Generator for both files (`python3 build_workbook.py`). |

## Sheets

| # | Sheet | What you do there |
|---|---|---|
| 1 | **Current Inventory** | One row per site and material: count date, beginning balance (physical count), max storage capacity. Current stock = count + deliveries received − consumption. |
| 2 | **Consumption Log** | Every day: date, site, mix code, m3 of concrete produced. Cement, sand, gravel and admixture used = m3 × mix design × (1 + allowance). |
| 3 | **Deliveries** | Every delivery receipt (`Received` is added to stock). Purchase orders not delivered yet go in as `Scheduled`. |
| 4 | **Stock Monitor** | Automatic. Shows days remaining, stock-out date, on order, status (OK / REORDER / CRITICAL / OUT OF STOCK), reorder-by and critical-on dates, suggested order quantity and an action message. |
| 5 | **Production Plan** | Declare planned m3 per working day per site and mix. Weekly and monthly volumes and material needs are calculated. |
| 5 | **Forecast** | Automatic. Material use per day → week → month, then a 6-month projection: consumption, scheduled deliveries and quantity still to order each month. |
| 6 | **Dashboard** | Pick a site (or All Sites). Shows day-count tiles, a **cement silo, aggregate bins and admixture tank drawing** that fills to each material's % of capacity (with critical and reorder level markers and a status badge), days remaining vs reorder and critical levels, an all-sites colour-coded table, the 6-month forecast and actual vs planned production for the last 14 days. |
| | **Mix Design** | Quantity of each material per 1 m3 of concrete (cement in bags, aggregates in m3, admixture in litres), plus the allowance %. |
| | **Settings** | As-of date (`=TODAY()`), working days, materials (unit, lead time, safety stock), site list, holidays. |

Yellow cells are inputs. Grey cells are formulas. The grey italic row under each header is an example and is not counted.

## Status logic

- **Days remaining** = stock on hand ÷ daily usage, in working days. Daily usage = declared m3/day × mix design. If no plan is declared, the last 7 days' actual average is used.
- **Planning cover** = days remaining, plus deliveries already on order that arrive before the stock-out.
- **REORDER** = planning cover ≤ lead time + safety stock.
- **CRITICAL** = planning cover ≤ supplier lead time, meaning the stock runs out before a normal delivery can arrive.
- **OUT OF STOCK** = stock ≤ 0.

Defaults are assumptions that you change in Settings and Mix Design:
- Lead time: cement 3 working days, aggregates 2, admixture 5.
- Safety stock: 2 days (admixture 3).
- Admixture dosage: 4.0 L/m3 for precast mixes, 2.5 L/m3 for footings (typical superplasticizer / water-reducer range).
- Working week: 6 days (Sunday off).
- Mix design: typical Philippine volumetric proportions with 40 kg bags.

The workbook uses only functions available in Excel 2010 and later, plus LibreOffice. The files are stored with calculated values, and Excel recalculates them when they are opened.
