#!/usr/bin/env python3
"""Generate the Cement & Aggregates Inventory Monitoring workbooks.

    python3 build_workbook.py [output_dir]

Writes two workbooks (default: the folder this script is in):

* ``Cement and Aggregates Inventory.xlsx`` - blank template, ready for real data.
* ``Cement and Aggregates Inventory - Sample Data.xlsx`` - the same workbook filled
  with illustrative October 2026 data so the dashboard can be seen working.

Every total, status, date and forecast in the workbooks is a live Excel formula.
openpyxl does not calculate formulas: Excel recalculates on opening, or run the
files through LibreOffice to store calculated values.
"""
import datetime as dt
import math
import os
import random
import sys

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.chart.axis import ChartLines
from openpyxl.chart.data_source import StrRef
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import SeriesLabel
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.drawing.line import LineProperties
from openpyxl.formatting.rule import CellIsRule, DataBarRule, FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter as colL
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.pagebreak import Break

# ---------------------------------------------------------------------------
# Master data (defaults - all editable in the workbook)
# ---------------------------------------------------------------------------
MATERIALS = [
    # code, short name, description, unit, lead time (working days), safety stock (working days), colour
    ("CEM", "Cement", "Portland Cement Type 1 (40 kg bag)", "bags", 3, 2, "2A78D6"),
    ("SAND", "Sand", "Fine Aggregate - Washed Sand", "m3", 2, 2, "EB6834"),
    ("G34", 'Gravel 3/4"', 'Coarse Aggregate - 3/4" Crushed Gravel', "m3", 2, 2, "1BAF7A"),
    ("G38", 'Gravel 3/8"', 'Coarse Aggregate - 3/8" Crushed Gravel', "m3", 2, 2, "EDA100"),
    ("ADM", "Admixture", "Concrete Admixture - Superplasticizer / Water Reducer", "L", 5, 3, "E87BA4"),
]
CEM_IDX, AGG_IDX, ADM_IDX = 0, [1, 2, 3], 4      # positions in MATERIALS used by the dashboard visuals
NMAT = len(MATERIALS)

# Same site names as Housing Database.xlsx (Project Overview)
SITES = [
    "Batulao Parkhomes", "Calauan (Alora+Amani)", "Gentri", "Naic",
    "The Cove Lipa", "Sights Bay", "Tayabas", "Batulao Impression",
]

MIXES = [
    # code, description, class, cement bags, sand m3, gravel 3/4 m3, gravel 3/8 m3, admixture L, allowance
    ("MD-01", "Precast Wall Panel", "Class AA (1 : 1.5 : 3)", 12.0, 0.50, 0.00, 1.00, 4.0, 0.03),
    ("MD-02", "Precast Slab / Beam", "Class AA (1 : 1.5 : 3)", 12.0, 0.50, 1.00, 0.00, 4.0, 0.03),
    ("MD-03", "Footing / Ground Slab", "Class A (1 : 2 : 4)", 9.0, 0.50, 1.00, 0.00, 2.5, 0.05),
    ("MD-04", "Lean Concrete / Blinding", "Class C (1 : 3 : 6)", 6.0, 0.50, 1.00, 0.00, 0.0, 0.05),
]
MIX_NOTE = ("Typical volumetric proportion per m3 using 40 kg bags (Philippine practice); admixture = typical "
            "superplasticizer / water-reducer dosage. Replace with your approved, lab-tested mix design and the "
            "supplier's recommended dosage.")

# ---------------------------------------------------------------------------
# Layout (rows) - change here and every formula follows
# ---------------------------------------------------------------------------
CI0, CI1 = 6, 105          # Current Inventory / Stock Monitor data rows
CON0, CON1 = 6, 2005       # Consumption Log rows
DEL0, DEL1 = 6, 1005       # Deliveries rows
PP0, PP1 = 6, 85           # Production Plan rows
MIX0, MIX1 = 5, 24         # Mix Design rows
MAT0 = 11                  # Settings: first material row
SITE_ALL = 18              # Settings: "All Sites" row
SITE0, SITE1 = 19, 38      # Settings: site list rows
HOL0, HOL1 = 42, 61        # Settings: holiday list rows
FCA0, FCA1 = 13, 32        # Forecast section A rows (one per Settings site)
FCB_OFF = 32               # Forecast section B row = inventory row + 32
FCB0, FCB1 = CI0 + FCB_OFF, CI1 + FCB_OFF
NPER = 6                   # forecast periods
# column positions that depend on the number of materials
MIX_Q0 = 4                              # Mix Design: first quantity column (D)
MIX_ALLOW = MIX_Q0 + NMAT               # allowance %
MIX_NOTE_COL = MIX_ALLOW + 1            # notes / source
MIX_EFF0 = MIX_NOTE_COL + 1             # first "incl. allowance" column
CON_USE0 = 6                            # Consumption Log: first material-used column (F)
CON_REM = CON_USE0 + NMAT               # element / remarks
CON_CHK = CON_REM + 1                   # check
PP_D0 = 7                               # Production Plan: first daily-need column (G)
PP_M0 = PP_D0 + NMAT                    # first monthly-need column
PP_REM = PP_M0 + NMAT                   # remarks
PP_CHK = PP_REM + 1                     # check

SHEET_ORDER = ["Instructions", "Dashboard", "Current Inventory", "Consumption Log", "Deliveries",
               "Stock Monitor", "Production Plan", "Forecast", "Mix Design", "Settings"]
CIq, SMq, PPq = "'Current Inventory'", "'Stock Monitor'", "'Production Plan'"

# ---------------------------------------------------------------------------
# Styles (match Housing Database.xlsx: Arial, navy headers, yellow inputs, grey formulas)
# ---------------------------------------------------------------------------
FONT = "Arial"
NAVY, MUTED, INK = "1C2530", "77807A", "1A1A1A"
INPUT_FILL, CALC_FILL, BAND_FILL, GRID = "FFF6D6", "F2F0EA", "DDE3EA", "D5D8DC"
EXAMPLE_FILL, EXAMPLE_INK = "F7F7F5", "8A9096"

QTY = '#,##0.0;[Red]-#,##0.0;0.0'
DATE = 'dd-mmm-yyyy'
PCT = '0%'
DAYS = '0.0'
QTY_DASH = '#,##0.0;[Red]-#,##0.0;"–"'
INT_DASH = '#,##0;[Red]-#,##0;"–"'
NA_NUM = '[>=1000000000]"–";0'
RATE = '0.00'

STATUS_STYLES = [  # text, fill, font colour
    ("OUT OF STOCK", "D03B3B", "FFFFFF"),
    ("CRITICAL", "F6CFCF", "9E1F1F"),
    ("REORDER", "FFEDB8", "7A5200"),
    ("OK", "D9F0D9", "0B5E0B"),
    ("NO USAGE", "ECECEA", "55554F"),
    ("NO DATA", "ECECEA", "55554F"),
    ("NOT SET UP", "ECECEA", "55554F"),
]


def F(size=10, bold=False, color=INK, italic=False):
    return Font(name=FONT, size=size, bold=bold, italic=italic, color=color)


def fill(hex_):
    return PatternFill("solid", start_color=hex_, end_color=hex_)


SIDE = Side(style="thin", color=GRID)
BOX = Border(left=SIDE, right=SIDE, top=SIDE, bottom=SIDE)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
MID = Alignment(vertical="center")
WRAP = Alignment(horizontal="left", vertical="center", wrap_text=True)


def T(tpl, **kw):
    """Fill {placeholders} in a formula template (formulas never contain braces)."""
    for k, v in kw.items():
        tpl = tpl.replace("{" + k + "}", str(v))
    return tpl


def style(c, kind, fmt=None, align=None, bold=False):
    if kind == "in":
        c.fill, c.font = fill(INPUT_FILL), F(bold=bold)
    elif kind == "calc":
        c.fill, c.font = fill(CALC_FILL), F(bold=bold)
    elif kind == "example":
        c.fill, c.font = fill(EXAMPLE_FILL), F(italic=True, color=EXAMPLE_INK)
    c.border = BOX
    if fmt:
        c.number_format = fmt
    c.alignment = align or MID
    return c


def title(ws, text, subtitle):
    ws["A1"].value, ws["A1"].font = text, F(14, True, NAVY)
    ws["A2"].value, ws["A2"].font = subtitle, F(10, color=MUTED)
    ws.row_dimensions[1].height = 22


def header_row(ws, row, labels, start_col=1, height=34):
    for i, lab in enumerate(labels):
        c = ws.cell(row, start_col + i, lab)
        c.font, c.fill, c.alignment, c.border = F(10, True, "FFFFFF"), fill(NAVY), CENTER, BOX
    ws.row_dimensions[row].height = height


def band(ws, row, c1, c2, text, color=BAND_FILL, ink=NAVY):
    if c2 > c1:
        ws.merge_cells(start_row=row, start_column=c1, end_row=row, end_column=c2)
    c = ws.cell(row, c1, text)
    c.font, c.fill, c.alignment = F(10, True, ink), fill(color), Alignment(horizontal="left", vertical="center")
    ws.row_dimensions[row].height = 18


def column_formula(ws, col, r0, r1, tpl, fmt=None, align=None, kind="calc", **kw):
    for r in range(r0, r1 + 1):
        style(ws.cell(r, col, T(tpl, r=r, **kw)), kind, fmt, align)


def input_column(ws, col, r0, r1, fmt=None, align=None):
    for r in range(r0, r1 + 1):
        style(ws.cell(r, col), "in", fmt, align)


def widths(ws, spec):
    for letter, w in spec.items():
        ws.column_dimensions[letter].width = w


def add_name(wb, name, ref):
    wb.defined_names[name] = DefinedName(name, attr_text=ref)


def dv_list(ws, source, rng, msg="Pick a value from the drop-down list."):
    dv = DataValidation(type="list", formula1=source, allow_blank=True, showErrorMessage=True,
                        errorTitle="Not in list", error=msg)
    dv.add(rng)
    ws.add_data_validation(dv)


def dv_date(ws, rng):
    dv = DataValidation(type="date", operator="greaterThan", formula1="DATE(2020,1,1)", allow_blank=True,
                        showErrorMessage=True, errorTitle="Date", error="Enter a valid date, e.g. 15-Oct-2026.")
    dv.add(rng)
    ws.add_data_validation(dv)


def dv_number(ws, rng, minimum=0):
    dv = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1=str(minimum), allow_blank=True,
                        showErrorMessage=True, errorTitle="Number", error=f"Enter a number >= {minimum}.")
    dv.add(rng)
    ws.add_data_validation(dv)


def status_cf(ws, rng):
    for text, bg, fg in STATUS_STYLES:
        ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=[f'"{text}"'], fill=fill(bg),
                                                      font=Font(color=fg, bold=True)))


def check_cf(ws, rng, first_cell):
    ws.conditional_formatting.add(rng, FormulaRule(formula=[f'LEFT({first_cell},1)="⚠"'], fill=fill("FFEDB8"),
                                                   font=Font(color="7A5200", bold=True)))


def pct_bars(ws, rng):
    ws.conditional_formatting.add(rng, DataBarRule(start_type="num", start_value=0, end_type="num", end_value=1,
                                                   color="86B6EF", showValue=True))


def example_row(ws, row, values, ncols):
    for ci in range(1, ncols + 1):
        v = values.get(ci, "")
        fmt = DATE if isinstance(v, dt.date) else None
        style(ws.cell(row, ci, v if v != "" else None), "example", fmt)


def mat_lookup(field, code_ref):
    return f'IFERROR(INDEX({field},MATCH({code_ref},Mat_Code,0)),"")'


# ---------------------------------------------------------------------------
# Named ranges
# ---------------------------------------------------------------------------
def define_names(wb):
    m1 = MAT0 + NMAT - 1
    names = {
        "AsOfDate": "Settings!$B$5",
        "WorkDaysWeek": "Settings!$B$6",
        "WorkDaysMonth": "Settings!$B$7",
        "WeekendMask": "Settings!$B$8",
        "Holidays": f"Settings!$B${HOL0}:$B${HOL1}",
        "Mat_Code": f"Settings!$B${MAT0}:$B${m1}",
        "Mat_Short": f"Settings!$C${MAT0}:$C${m1}",
        "Mat_Desc": f"Settings!$D${MAT0}:$D${m1}",
        "Mat_Unit": f"Settings!$E${MAT0}:$E${m1}",
        "Mat_Lead": f"Settings!$F${MAT0}:$F${m1}",
        "Mat_Safety": f"Settings!$G${MAT0}:$G${m1}",
        "SiteChoice": f"Settings!$B${SITE_ALL}:$B${SITE1}",
        "SiteList": f"Settings!$B${SITE0}:$B${SITE1}",
        "Mix_Code": f"'Mix Design'!$A${MIX0}:$A${MIX1}",
        "Mix_Desc": f"'Mix Design'!$B${MIX0}:$B${MIX1}",
        "Mix_Eff": f"'Mix Design'!${colL(MIX_EFF0)}${MIX0}:${colL(MIX_EFF0 + NMAT - 1)}${MIX1}",
        "CI_Site": f"{CIq}!$A${CI0}:$A${CI1}",
        "CI_Mat": f"{CIq}!$B${CI0}:$B${CI1}",
        "CI_Count": f"{CIq}!$E${CI0}:$E${CI1}",
        "Con_Date": f"'Consumption Log'!$A${CON0}:$A${CON1}",
        "Con_Site": f"'Consumption Log'!$B${CON0}:$B${CON1}",
        "Con_Vol": f"'Consumption Log'!$D${CON0}:$D${CON1}",
        "Con_Use": f"'Consumption Log'!${colL(CON_USE0)}${CON0}:${colL(CON_USE0 + NMAT - 1)}${CON1}",
        "Del_Date": f"Deliveries!$A${DEL0}:$A${DEL1}",
        "Del_Site": f"Deliveries!$B${DEL0}:$B${DEL1}",
        "Del_Mat": f"Deliveries!$C${DEL0}:$C${DEL1}",
        "Del_Qty": f"Deliveries!$E${DEL0}:$E${DEL1}",
        "Del_Status": f"Deliveries!$G${DEL0}:$G${DEL1}",
        "PP_Site": f"{PPq}!$A${PP0}:$A${PP1}",
        "PP_Vol": f"{PPq}!$D${PP0}:$D${PP1}",
        "PP_Daily": f"{PPq}!${colL(PP_D0)}${PP0}:${colL(PP_D0 + NMAT - 1)}${PP1}",
        "SM_Site": f"{SMq}!$A${CI0}:$A${CI1}",
        "SM_Mat": f"{SMq}!$B${CI0}:$B${CI1}",
        "SM_Stock": f"{SMq}!$E${CI0}:$E${CI1}",
        "SM_Cap": f"{SMq}!$F${CI0}:$F${CI1}",
        "SM_Rate": f"{SMq}!$J${CI0}:$J${CI1}",
        "SM_OnOrder": f"{SMq}!$N${CI0}:$N${CI1}",
        "SM_Status": f"{SMq}!$U${CI0}:$U${CI1}",
        "SM_Order": f"{SMq}!$X${CI0}:$X${CI1}",
        "SM_RBn": f"{SMq}!$Z${CI0}:$Z${CI1}",
        "SM_CRn": f"{SMq}!$AA${CI0}:$AA${CI1}",
        "SM_SOn": f"{SMq}!$AB${CI0}:$AB${CI1}",
        "FCA_Site": f"Forecast!$A${FCA0}:$A${FCA1}",
        "FCA_Per": f"Forecast!$E${FCA0}:$J${FCA1}",
        "FC_Site": f"Forecast!$A${FCB0}:$A${FCB1}",
        "FC_Mat": f"Forecast!$B${FCB0}:$B${FCB1}",
        "FC_Use": f"Forecast!$J${FCB0}:$O${FCB1}",
        "FC_In": f"Forecast!$P${FCB0}:$U${FCB1}",
        "FC_Order": f"Forecast!$V${FCB0}:$AA${FCB1}",
        "FC_Close": f"Forecast!$AB${FCB0}:$AG${FCB1}",
        "SelCrit": "Dashboard!$R$4",
    }
    for n, ref in names.items():
        add_name(wb, n, ref)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
def build_settings(ws):
    title(ws, "Settings — Report Date, Materials & Sites",
          "Fill in the yellow cells. Material codes (grey) are fixed: Mix Design and log columns follow this order.")
    band(ws, 4, 1, 3, "GENERAL")
    general = [
        (5, "As-of Date (report date)", "=TODAY()", DATE,
         "Stock is counted up to and including this date. Keep =TODAY() for live monitoring, or type a date to review a past day."),
        (6, "Working days per week", 6, "0", "Converts working days into calendar dates (6 = Monday to Saturday)."),
        (7, "Working days per month", 26, "0", "Used for the generic monthly requirement (daily use × this)."),
    ]
    for r, lab, val, fmt, note in general:
        c = ws.cell(r, 1, lab)
        c.font, c.border = F(bold=True), BOX
        style(ws.cell(r, 2, val), "in", fmt, Alignment(horizontal="center", vertical="center"))
        ws.cell(r, 3, note).font = F(9, color=MUTED)
    c = ws.cell(8, 1, "Non-working weekdays (auto)")
    c.font, c.border = F(bold=True), BOX
    style(ws.cell(8, 2, '=RIGHT("0000000"&REPT("1",7-WorkDaysWeek),7)'), "calc", None,
          Alignment(horizontal="center", vertical="center"))
    ws.cell(8, 3, "Monday→Sunday, 1 = no work. 6 days/week = Sunday off; 5 = Saturday and Sunday off. "
                  "Used to skip non-working days in dates and forecasts.").font = F(9, color=MUTED)
    dv_date(ws, "B5")
    dv = DataValidation(type="whole", operator="between", formula1="1", formula2="7", showErrorMessage=True,
                        error="Enter 1 to 7.")
    dv.add("B6")
    ws.add_data_validation(dv)
    dv = DataValidation(type="whole", operator="between", formula1="1", formula2="31", showErrorMessage=True,
                        error="Enter 1 to 31.")
    dv.add("B7")
    ws.add_data_validation(dv)

    band(ws, 9, 1, 8, "MATERIALS")
    header_row(ws, 10, ["#", "Code (fixed)", "Short Name", "Description", "Unit",
                        "Lead Time\n(working days)", "Safety Stock\n(working days)", "Notes"])
    notes = {
        "CEM": "1 bag = 40 kg. Lead time = order to delivery on site. Lead time and safety stock are assumptions: confirm with supplier.",
        "SAND": "Loose volume as delivered (m3).",
        "G34": "Loose volume as delivered (m3).",
        "G38": "Loose volume as delivered (m3).",
        "ADM": "Liquid, in litres. Delivered in 200 L drums or 1,000 L IBC totes. Lead time and safety stock are "
               "assumptions: confirm with supplier.",
    }
    for i, (code, short, desc, unit, lead, safety, _c) in enumerate(MATERIALS):
        r = MAT0 + i
        style(ws.cell(r, 1, i + 1), "calc", None, Alignment(horizontal="center", vertical="center"))
        style(ws.cell(r, 2, code), "calc", None, Alignment(horizontal="center", vertical="center"), bold=True)
        style(ws.cell(r, 3, short), "in")
        style(ws.cell(r, 4, desc), "in")
        style(ws.cell(r, 5, unit), "in", None, Alignment(horizontal="center", vertical="center"))
        style(ws.cell(r, 6, lead), "in", "0.0", Alignment(horizontal="center", vertical="center"))
        style(ws.cell(r, 7, safety), "in", "0.0", Alignment(horizontal="center", vertical="center"))
        style(ws.cell(r, 8, notes[code]), "in", None, WRAP)
    dv_number(ws, f"F{MAT0}:G{MAT0 + NMAT - 1}")

    band(ws, 16, 1, 3, "SITES / PROJECTS")
    header_row(ws, 17, ["#", "Site / Project", "Notes"])
    style(ws.cell(SITE_ALL, 1), "calc")
    style(ws.cell(SITE_ALL, 2, "All Sites"), "calc", bold=True)
    style(ws.cell(SITE_ALL, 3, "Combined view on the Dashboard — do not change."), "calc")
    for i, r in enumerate(range(SITE0, SITE1 + 1)):
        style(ws.cell(r, 1, i + 1), "calc", None, Alignment(horizontal="center", vertical="center"))
        style(ws.cell(r, 2, SITES[i] if i < len(SITES) else None), "in")
        style(ws.cell(r, 3), "in")
    band(ws, HOL0 - 2, 1, 3, "NON-WORKING HOLIDAYS (optional)")
    header_row(ws, HOL0 - 1, ["#", "Date", "Holiday / Reason"])
    for i, r in enumerate(range(HOL0, HOL1 + 1)):
        style(ws.cell(r, 1, i + 1), "calc", None, Alignment(horizontal="center", vertical="center"))
        style(ws.cell(r, 2), "in", DATE, Alignment(horizontal="center", vertical="center"))
        style(ws.cell(r, 3), "in")
    ws.cell(HOL0, 4, "Days with no production. They are skipped in stock-out / reorder dates and forecast "
                     "working days. Left empty = conservative (assumes work continues).").font = F(9, color=MUTED)
    dv_date(ws, f"B{HOL0}:B{HOL1}")
    widths(ws, {"A": 28, "B": 26, "C": 16, "D": 40, "E": 9, "F": 14, "G": 14, "H": 70})
    for r in range(MAT0, MAT0 + NMAT):
        ws.row_dimensions[r].height = 28


# ---------------------------------------------------------------------------
# Mix Design
# ---------------------------------------------------------------------------
def build_mix(ws):
    title(ws, "Mix Design — Material Quantity per 1 m3 of Concrete",
          "Fill in the yellow cells with your approved mix design (per 1 m3, in each material's unit: cement in bags, "
          "aggregates in m3, admixture in litres). The allowance % covers waste and is added to every m3 produced.")
    C = Alignment(horizontal="center", vertical="center")
    band(ws, 3, MIX_Q0, MIX_ALLOW, "QUANTITY PER 1 m3 OF CONCRETE (input)")
    band(ws, 3, MIX_EFF0, MIX_EFF0 + NMAT - 1, "USED IN CALCULATIONS — incl. allowance (auto)")
    labels = ["Mix Code", "Description / Element", "Class / Proportion"]
    labels += [f'=Settings!$C${MAT0 + k}&CHAR(10)&"("&Settings!$E${MAT0 + k}&" per m3)"' for k in range(NMAT)]
    labels += ["Allowance\n(waste) %", "Notes / Source"]
    labels += [f'=Settings!$C${MAT0 + k}&CHAR(10)&"incl. allowance"' for k in range(NMAT)]
    header_row(ws, 4, labels, height=40)
    allow = colL(MIX_ALLOW)
    for r in range(MIX0, MIX1 + 1):
        i = r - MIX0
        mix = MIXES[i] if i < len(MIXES) else None
        style(ws.cell(r, 1, mix[0] if mix else None), "in", None, C, bold=True)
        style(ws.cell(r, 2, mix[1] if mix else None), "in")
        style(ws.cell(r, 3, mix[2] if mix else None), "in")
        for k in range(NMAT):
            style(ws.cell(r, MIX_Q0 + k, mix[3 + k] if mix else None), "in", RATE, C)
        style(ws.cell(r, MIX_ALLOW, mix[3 + NMAT] if mix else None), "in", PCT, C)
        style(ws.cell(r, MIX_NOTE_COL, MIX_NOTE if mix else None), "in", None, WRAP)
        for k in range(NMAT):
            src = colL(MIX_Q0 + k)
            style(ws.cell(r, MIX_EFF0 + k, f'=IF($A{r}="","",N({src}{r})*(1+N(${allow}{r})))'), "calc", "0.000", C)
        if mix:
            ws.row_dimensions[r].height = 42
    dv_number(ws, f"{colL(MIX_Q0)}{MIX0}:{allow}{MIX1}")
    widths(ws, {"A": 11, "B": 26, "C": 22, **{colL(MIX_Q0 + k): 13 for k in range(NMAT)}, allow: 11,
                colL(MIX_NOTE_COL): 50, **{colL(MIX_EFF0 + k): 13 for k in range(NMAT)}})
    ws.freeze_panes = "B5"


# ---------------------------------------------------------------------------
# 1 - Current Inventory
# ---------------------------------------------------------------------------
def build_ci(ws):
    title(ws, "1 · Current Inventory — Stock on Hand per Site",
          "One row per site and material: physical count (beginning balance), count date and storage capacity. "
          "Deliveries and consumption from the count date up to the As-of Date are applied automatically.")
    ws["A3"] = '="Stock as of "&TEXT(AsOfDate,"dd mmm yyyy")&"   (As-of Date is set in Settings)"'
    ws["A3"].font = F(10, True, NAVY)
    header_row(ws, 4, ["Site / Project", "Material Code", "Material", "Unit", "Count Date",
                       "Beginning Balance\n(physical count)", "Max Storage\nCapacity", "Deliveries\nReceived (+)",
                       "Consumption\n(−)", "Current Stock", "% of\nCapacity", "Check", "Remarks"], height=40)
    example_row(ws, 5, {1: "Example Site", 2: "CEM", 3: "Cement", 4: "bags", 5: dt.date(2026, 10, 1), 6: 1500,
                        7: 3000, 8: "(auto)", 9: "(auto)", 10: "(auto)", 11: "(auto)",
                        13: "Example row — shows the format, not counted"}, 13)
    a, b = CI0, CI1
    for col in (1, 2, 13):
        input_column(ws, col, a, b)
    input_column(ws, 5, a, b, DATE)
    input_column(ws, 6, a, b, QTY)
    input_column(ws, 7, a, b, QTY)
    column_formula(ws, 3, a, b, '=IF($B{r}="","",IFERROR(INDEX(Mat_Short,MATCH($B{r},Mat_Code,0)),"⚠ Unknown code"))')
    column_formula(ws, 4, a, b, '=IF($B{r}="","",' + mat_lookup("Mat_Unit", "$B{r}") + ')',
                   align=Alignment(horizontal="center", vertical="center"))
    column_formula(ws, 8, a, b, '=IF(OR($A{r}="",$B{r}=""),"",SUMIFS(Del_Qty,Del_Site,$A{r},Del_Mat,$B{r},'
                                'Del_Status,"Received",Del_Date,">="&N($E{r}),Del_Date,"<="&AsOfDate))', QTY)
    column_formula(ws, 9, a, b, '=IF(OR($A{r}="",$B{r}=""),"",IFERROR(SUMIFS(INDEX(Con_Use,0,MATCH($B{r},Mat_Code,0)),'
                                'Con_Site,$A{r},Con_Date,">="&N($E{r}),Con_Date,"<="&AsOfDate),0))', QTY)
    column_formula(ws, 10, a, b, '=IF(OR($A{r}="",$B{r}="",$F{r}=""),"",$F{r}+$H{r}-$I{r})', QTY)
    for r in range(a, b + 1):
        ws.cell(r, 10).font = F(bold=True)
    column_formula(ws, 11, a, b, '=IF(OR($J{r}="",N($G{r})<=0),"",MAX(0,$J{r})/$G{r})', PCT)
    column_formula(ws, 12, a, b,
                   '=IF(OR($A{r}="",$B{r}=""),"",IF(COUNTIFS(CI_Site,$A{r},CI_Mat,$B{r})>1,"⚠ Duplicate site + material row",'
                   'IF(ISNA(MATCH($B{r},Mat_Code,0)),"⚠ Unknown material code",IF($E{r}="","⚠ Enter count date",'
                   'IF($F{r}="","⚠ Enter beginning balance",IF(N($G{r})<=0,"⚠ Enter storage capacity",'
                   'IF($E{r}>AsOfDate,"⚠ Count date is after the As-of Date",'
                   'IF($J{r}<0,"⚠ Negative stock – check logs or recount","OK"))))))))')
    dv_list(ws, "SiteList", f"A{a}:A{b}", "Pick a site from the list (the list is kept in Settings).")
    dv_list(ws, "Mat_Code", f"B{a}:B{b}", "Pick a material code (CEM, SAND, G34, G38).")
    dv_date(ws, f"E{a}:E{b}")
    dv_number(ws, f"F{a}:G{b}")
    pct_bars(ws, f"K{a}:K{b}")
    check_cf(ws, f"L{a}:L{b}", f"$L{a}")
    widths(ws, {"A": 24, "B": 10, "C": 13, "D": 7, "E": 13, "F": 15, "G": 13, "H": 13, "I": 13, "J": 14,
                "K": 10, "L": 36, "M": 34})
    ws.freeze_panes = "C6"


# ---------------------------------------------------------------------------
# 2 - Consumption Log
# ---------------------------------------------------------------------------
def build_consumption(ws):
    title(ws, "2 · Consumption Log — Concrete Produced (m3) by Mix Design",
          "Declare the m3 of concrete produced per day (or per pour/shift). Material used = m3 × mix design "
          "quantity × (1 + allowance), and is deducted from stock automatically.")
    labels = ["Date", "Site / Project", "Mix Code", "Concrete\nProduced (m3)", "Mix Description"]
    labels += [f'=Settings!$C${MAT0 + k}&" used"&CHAR(10)&"("&Settings!$E${MAT0 + k}&")"' for k in range(NMAT)]
    labels += ["Element / Remarks", "Check"]
    header_row(ws, 4, labels, height=40)
    example_row(ws, 5, {1: dt.date(2026, 10, 1), 2: "Example Site", 3: "MD-01", 4: 18.5, 5: "Precast Wall Panel",
                        **{CON_USE0 + k: "(auto)" for k in range(NMAT)},
                        CON_REM: "Example row — wall panels, casting beds 1-3"}, CON_CHK)
    a, b = CON0, CON1
    input_column(ws, 1, a, b, DATE)
    input_column(ws, 2, a, b)
    input_column(ws, 3, a, b, None, Alignment(horizontal="center", vertical="center"))
    input_column(ws, 4, a, b, QTY)
    input_column(ws, CON_REM, a, b)
    column_formula(ws, 5, a, b, '=IF($C{r}="","",IFERROR(INDEX(Mix_Desc,MATCH($C{r},Mix_Code,0)),"⚠ Unknown mix code"))')
    for k in range(NMAT):
        column_formula(ws, CON_USE0 + k, a, b, T('=IF(OR($C{r}="",$D{r}=""),"",IFERROR($D{r}*INDEX(Mix_Eff,'
                                                 'MATCH($C{r},Mix_Code,0),{k}),""))', k=k + 1), QTY)
    column_formula(ws, CON_CHK, a, b,
                   '=IF(AND($A{r}="",$B{r}="",$C{r}="",$D{r}=""),"",IF($A{r}="","⚠ Date missing",'
                   'IF($B{r}="","⚠ Site missing",IF(ISNA(MATCH($C{r},Mix_Code,0)),"⚠ Unknown mix code",'
                   'IF($D{r}="","⚠ Enter m3 produced",IF(COUNTIF(CI_Site,$B{r})=0,"⚠ Site not set up in Current Inventory",'
                   'IF($A{r}>AsOfDate,"Future date – not yet deducted","OK")))))))')
    dv_date(ws, f"A{a}:A{b}")
    dv_list(ws, "SiteList", f"B{a}:B{b}", "Pick a site from the list (the list is kept in Settings).")
    dv_list(ws, "Mix_Code", f"C{a}:C{b}", "Pick a mix code from the Mix Design sheet.")
    dv_number(ws, f"D{a}:D{b}")
    chk = colL(CON_CHK)
    check_cf(ws, f"{chk}{a}:{chk}{b}", f"${chk}{a}")
    widths(ws, {"A": 13, "B": 24, "C": 10, "D": 13, "E": 24, **{colL(CON_USE0 + k): 13 for k in range(NMAT)},
                colL(CON_REM): 34, chk: 36})
    ws.freeze_panes = "B6"


# ---------------------------------------------------------------------------
# 3 - Deliveries
# ---------------------------------------------------------------------------
def build_deliveries(ws):
    title(ws, "3 · Deliveries — New Stock Added to Current Inventory",
          "One row per delivery receipt. 'Received' is added to stock on its date. 'Scheduled' (ordered, not yet "
          "arrived) is not added to stock but is used by the Forecast — change it to Received when it arrives.")
    header_row(ws, 4, ["Date", "Site / Project", "Material Code", "Material", "Quantity", "Unit", "Status",
                       "Supplier", "DR / Reference No.", "Remarks", "Check"], height=40)
    example_row(ws, 5, {1: dt.date(2026, 10, 5), 2: "Example Site", 3: "CEM", 4: "Cement", 5: 500, 6: "bags",
                        7: "Received", 8: "Cement Supplier A", 9: "DR-000123",
                        10: "Example row — 1 truck (20 t)"}, 11)
    a, b = DEL0, DEL1
    input_column(ws, 1, a, b, DATE)
    input_column(ws, 2, a, b)
    input_column(ws, 3, a, b, None, Alignment(horizontal="center", vertical="center"))
    input_column(ws, 5, a, b, QTY)
    input_column(ws, 7, a, b, None, Alignment(horizontal="center", vertical="center"))
    for col in (8, 9, 10):
        input_column(ws, col, a, b)
    column_formula(ws, 4, a, b, '=IF($C{r}="","",IFERROR(INDEX(Mat_Short,MATCH($C{r},Mat_Code,0)),"⚠ Unknown code"))')
    column_formula(ws, 6, a, b, '=IF($C{r}="","",' + mat_lookup("Mat_Unit", "$C{r}") + ')',
                   align=Alignment(horizontal="center", vertical="center"))
    column_formula(ws, 11, a, b,
                   '=IF(AND($A{r}="",$B{r}="",$C{r}="",$E{r}=""),"",IF($A{r}="","⚠ Date missing",'
                   'IF(OR($B{r}="",$C{r}=""),"⚠ Site / material missing",'
                   'IF(COUNTIFS(CI_Site,$B{r},CI_Mat,$C{r})=0,"⚠ No Current Inventory row for this site + material",'
                   'IF($G{r}="","⚠ Status missing",'
                   'IF(AND($G{r}="Scheduled",$A{r}<=AsOfDate),"⚠ Scheduled date reached – mark Received or re-date",'
                   'IF(AND($G{r}="Received",$A{r}>AsOfDate),"Future-dated – added on its date",'
                   'IF(AND($G{r}="Received",$A{r}<SUMIFS(CI_Count,CI_Site,$B{r},CI_Mat,$C{r})),'
                   '"Before count date – already in the count","OK"))))))))')
    dv_date(ws, f"A{a}:A{b}")
    dv_list(ws, "SiteList", f"B{a}:B{b}", "Pick a site from the list (the list is kept in Settings).")
    dv_list(ws, "Mat_Code", f"C{a}:C{b}", "Pick a material code (CEM, SAND, G34, G38).")
    dv_list(ws, '"Received,Scheduled"', f"G{a}:G{b}", "Choose Received or Scheduled.")
    check_cf(ws, f"K{a}:K{b}", f"$K{a}")
    ws.conditional_formatting.add(f"G{a}:G{b}", CellIsRule(operator="equal", formula=['"Scheduled"'],
                                                           font=Font(color="256ABF", bold=True)))
    widths(ws, {"A": 13, "B": 24, "C": 10, "D": 13, "E": 12, "F": 7, "G": 12, "H": 24, "I": 17, "J": 28,
                "K": 44})
    ws.freeze_panes = "B6"


# ---------------------------------------------------------------------------
# 4 - Stock Monitor
# ---------------------------------------------------------------------------
def build_monitor(ws):
    title(ws, "4 · Stock Monitor — Days Remaining & Critical Alerts",
          "Automatic — do not type here. Daily usage = declared m3/day (Production Plan) × mix design; if no plan is "
          "declared, the actual average of the last 7 days. Days are working days (Settings).")
    ws["A3"] = ("OK = enough cover   ·   REORDER = cover ≤ lead time + safety stock → order now   ·   "
                "CRITICAL = cover ≤ supplier lead time → stock-out before a normal delivery, expedite   ·   "
                "OUT OF STOCK = zero stock.   Cover counts scheduled deliveries only if they arrive before the stock-out.")
    ws["A3"].font = F(9, True, NAVY)
    for c1, c2, text in [(1, 4, "ITEM"), (5, 7, "STOCK"), (8, 11, "USAGE RATE (per working day)"),
                         (12, 13, "ON HAND ONLY"), (14, 17, "SCHEDULED DELIVERIES"), (18, 20, "LEVELS"),
                         (21, 25, "STATUS & ACTION")]:
        band(ws, 4, c1, c2, text)
    band(ws, 4, 26, 28, "FOR DASHBOARD (auto)", "ECECEA", MUTED)
    header_row(ws, 5, ["Site / Project", "Code", "Material", "Unit", "Current Stock", "Max Capacity",
                       "% of Capacity", "Planned Use\n/ Day", "Actual Avg Use\n/ Day (7 days)", "Daily Rate\nUsed",
                       "Basis", "Days\nRemaining", "Stock-out On\n(no delivery)", "On Order\n(qty)",
                       "Next\nDelivery", "Due Before\nStock-out (qty)", "Planning\nCover (days)",
                       "Lead Time\n(days)", "Safety Stock\n(days)", "Reorder Point\n(qty)", "Status",
                       "Reorder By", "Critical On", "Suggested\nOrder Qty", "Alert / Action",
                       "Reorder By\n(number)", "Critical On\n(number)", "Stock-out\n(number)"], height=42)
    a, b = CI0, CI1
    C = Alignment(horizontal="center", vertical="center")
    wd = "WeekendMask,Holidays"
    match = "MATCH($B{r},Mat_Code,0)"
    column_formula(ws, 1, a, b, f'=IF(ISNUMBER({CIq}!$J{{r}}),{CIq}!$A{{r}},"")')
    column_formula(ws, 2, a, b, f'=IF($A{{r}}="","",{CIq}!$B{{r}})', align=C)
    column_formula(ws, 3, a, b, f'=IF($A{{r}}="","",{CIq}!$C{{r}})')
    column_formula(ws, 4, a, b, f'=IF($A{{r}}="","",{CIq}!$D{{r}})', align=C)
    column_formula(ws, 5, a, b, f'=IF($A{{r}}="","",{CIq}!$J{{r}})', QTY)
    column_formula(ws, 6, a, b, f'=IF($A{{r}}="","",N({CIq}!$G{{r}}))', QTY)
    column_formula(ws, 7, a, b, f'=IF($A{{r}}="","",{CIq}!$K{{r}})', PCT)
    # usage
    column_formula(ws, 8, a, b, f'=IF($A{{r}}="","",IFERROR(SUMIFS(INDEX(PP_Daily,0,{match}),PP_Site,$A{{r}}),0))', QTY)
    column_formula(ws, 9, a, b, f'=IF($A{{r}}="","",IFERROR(SUMIFS(INDEX(Con_Use,0,{match}),Con_Site,$A{{r}},'
                                f'Con_Date,">"&(AsOfDate-7),Con_Date,"<="&AsOfDate)'
                                f'/MAX(1,NETWORKDAYS.INTL(AsOfDate-6,AsOfDate,{wd})),0))', QTY)
    column_formula(ws, 10, a, b, '=IF($A{r}="","",IF($H{r}>0,$H{r},$I{r}))', QTY)
    column_formula(ws, 11, a, b, '=IF($A{r}="","",IF($H{r}>0,"Plan",IF($I{r}>0,"Actual 7-day avg","No usage")))',
                   align=C)
    # on hand
    column_formula(ws, 12, a, b, '=IF($A{r}="","",IF($J{r}>0,MAX(0,$E{r})/$J{r},""))', DAYS, C)
    column_formula(ws, 13, a, b, f'=IF(OR($A{{r}}="",$L{{r}}=""),"",IF($E{{r}}<=0,"OUT",'
                                 f'WORKDAY.INTL(AsOfDate,ROUNDUP($L{{r}},0),{wd})))', DATE, C)
    # scheduled deliveries
    column_formula(ws, 14, a, b, '=IF($A{r}="","",SUMIFS(Del_Qty,Del_Site,$A{r},Del_Mat,$B{r},Del_Date,">"&AsOfDate))',
                   QTY_DASH)
    cond = "(Del_Site=$A{r})*(Del_Mat=$B{r})*(Del_Date>AsOfDate)"
    column_formula(ws, 15, a, b, f'=IF(OR($A{{r}}="",N($N{{r}})<=0),"",SUMPRODUCT(MIN({cond}*Del_Date+(1-{cond})*1E9)))',
                   DATE, C)
    column_formula(ws, 16, a, b, '=IF($A{r}="","",IF(ISNUMBER($M{r}),SUMIFS(Del_Qty,Del_Site,$A{r},Del_Mat,$B{r},'
                                 'Del_Date,">"&AsOfDate,Del_Date,"<="&$M{r}),0))', QTY_DASH)
    column_formula(ws, 17, a, b, '=IF(OR($A{r}="",$J{r}<=0),"",IF($P{r}>0,(MAX(0,$E{r})+$N{r})/$J{r},$L{r}))', DAYS, C)
    # levels
    column_formula(ws, 18, a, b, '=IF($A{r}="","",IFERROR(INDEX(Mat_Lead,MATCH($B{r},Mat_Code,0)),0))', DAYS, C)
    column_formula(ws, 19, a, b, '=IF($A{r}="","",IFERROR(INDEX(Mat_Safety,MATCH($B{r},Mat_Code,0)),0))', DAYS, C)
    column_formula(ws, 20, a, b, '=IF($A{r}="","",$J{r}*($R{r}+$S{r}))', QTY)
    # status & action
    column_formula(ws, 21, a, b, '=IF($A{r}="","",IF($E{r}<=0,"OUT OF STOCK",IF($J{r}<=0,"NO USAGE",'
                                 'IF($Q{r}<=$R{r},"CRITICAL",IF($Q{r}<=$R{r}+$S{r},"REORDER","OK")))))', None, C)
    column_formula(ws, 22, a, b, f'=IF(OR($A{{r}}="",$U{{r}}="NO USAGE"),"",IF(OR($U{{r}}="OUT OF STOCK",'
                                 f'$Q{{r}}<=$R{{r}}+$S{{r}}),"NOW",WORKDAY.INTL(AsOfDate,INT($Q{{r}}-$R{{r}}-$S{{r}}),{wd})))',
                   DATE, C)
    column_formula(ws, 23, a, b, f'=IF(OR($A{{r}}="",$U{{r}}="NO USAGE"),"",IF(OR($U{{r}}="OUT OF STOCK",'
                                 f'$Q{{r}}<=$R{{r}}),"NOW",WORKDAY.INTL(AsOfDate,ROUNDUP($Q{{r}}-$R{{r}},0),{wd})))', DATE, C)
    column_formula(ws, 24, a, b, '=IF($A{r}="","",IF(OR($U{r}="CRITICAL",$U{r}="REORDER",$U{r}="OUT OF STOCK"),'
                                 'IF($F{r}>0,ROUNDUP(MAX(0,$F{r}-MAX(0,MAX(0,$E{r})+$N{r}-$J{r}*$R{r})),0),'
                                 '"Set capacity"),0))', INT_DASH)
    column_formula(ws, 25, a, b,
                   '=IF($A{r}="","",IF($U{r}="OUT OF STOCK","Out of stock – production at risk."&IF($N{r}>0," Next '
                   'delivery "&TEXT($O{r},"ddd dd-mmm")&": expedite it."," Order and expedite now."),'
                   'IF($U{r}="CRITICAL",IF(AND($N{r}>0,$P{r}<=0),"URGENT – runs out about "&TEXT($M{r},"ddd dd-mmm")'
                   '&", before the next delivery ("&TEXT($O{r},"ddd dd-mmm")&"). Expedite it.",'
                   '"URGENT – runs out about "&TEXT($M{r},"ddd dd-mmm")&"; a normal order takes "&$R{r}&" days. '
                   'Order and expedite now."),'
                   'IF($U{r}="REORDER","Order now (about "&TEXT($X{r},"#,##0")&" "&$D{r}&") – becomes critical "'
                   '&TEXT($W{r},"ddd dd-mmm")&".",IF($U{r}="NO USAGE","No planned or recent usage.",'
                   '"OK – next order by "&TEXT($V{r},"ddd dd-mmm")&IF($N{r}>0,"; "&TEXT($N{r},"#,##0")&" "&$D{r}&'
                   '" on order (next "&TEXT($O{r},"dd-mmm")&")","")&".")))))')
    # numeric helpers for the dashboard (1E9 = not applicable)
    for ci, src, now in [(26, "V", '"NOW"'), (27, "W", '"NOW"'), (28, "M", '"OUT"')]:
        column_formula(ws, ci, a, b, f'=IF(OR($A{{r}}="",${src}{{r}}=""),1E9,IF(${src}{{r}}={now},AsOfDate,${src}{{r}}))',
                       NA_NUM, C)
        for r in range(a, b + 1):
            ws.cell(r, ci).font = F(8, color=MUTED)
    for r in range(a, b + 1):
        ws.cell(r, 12).font = F(bold=True)
        ws.cell(r, 21).font = F(bold=True)
    status_cf(ws, f"U{a}:U{b}")
    pct_bars(ws, f"G{a}:G{b}")
    ws.conditional_formatting.add(f"V{a}:W{b}", CellIsRule(operator="equal", formula=['"NOW"'],
                                                           font=Font(color="9E1F1F", bold=True)))
    widths(ws, {"A": 24, "B": 8, "C": 12, "D": 7, "E": 12, "F": 12, "G": 10, "H": 12, "I": 14, "J": 11,
                "K": 15, "L": 10, "M": 14, "N": 11, "O": 12, "P": 13, "Q": 11, "R": 10, "S": 11, "T": 13,
                "U": 15, "V": 13, "W": 13, "X": 12, "Y": 80, "Z": 11, "AA": 11, "AB": 11})
    ws.freeze_panes = "D6"


# ---------------------------------------------------------------------------
# 5 - Production Plan
# ---------------------------------------------------------------------------
def build_plan(ws):
    title(ws, "5 · Production Plan — Declared m3 per Day (forecast basis)",
          "One row per site and mix design. Enter the planned concrete volume per working day; weekly and monthly "
          "volumes and material requirements are calculated.")
    band(ws, 3, 4, 6, "DECLARED PRODUCTION")
    band(ws, 3, PP_D0, PP_M0 - 1, "DAILY MATERIAL NEED (incl. allowance)")
    band(ws, 3, PP_M0, PP_REM - 1, "MONTHLY MATERIAL NEED")
    labels = ["Site / Project", "Mix Code", "Mix Description", "Planned\nm3 / Day", "m3 / Week", "m3 / Month"]
    labels += [f'=Settings!$C${MAT0 + k}&" / day"&CHAR(10)&"("&Settings!$E${MAT0 + k}&")"' for k in range(NMAT)]
    labels += [f'=Settings!$C${MAT0 + k}&" / month"&CHAR(10)&"("&Settings!$E${MAT0 + k}&")"' for k in range(NMAT)]
    labels += ["Remarks", "Check"]
    header_row(ws, 4, labels, height=40)
    example_row(ws, 5, {1: "Example Site", 2: "MD-01", 3: "Precast Wall Panel", 4: 20, 5: "(auto)", 6: "(auto)",
                        **{PP_D0 + k: "(auto)" for k in range(2 * NMAT)},
                        PP_REM: "Example row — panels, 2 casting beds"}, PP_CHK)
    a, b = PP0, PP1
    input_column(ws, 1, a, b)
    input_column(ws, 2, a, b, None, Alignment(horizontal="center", vertical="center"))
    input_column(ws, 4, a, b, QTY)
    input_column(ws, PP_REM, a, b)
    column_formula(ws, 3, a, b, '=IF($B{r}="","",IFERROR(INDEX(Mix_Desc,MATCH($B{r},Mix_Code,0)),"⚠ Unknown mix code"))')
    column_formula(ws, 5, a, b, '=IF($D{r}="","",$D{r}*WorkDaysWeek)', QTY)
    column_formula(ws, 6, a, b, '=IF($D{r}="","",$D{r}*WorkDaysMonth)', QTY)
    for k in range(NMAT):
        column_formula(ws, PP_D0 + k, a, b, T('=IF(OR($B{r}="",$D{r}=""),"",IFERROR($D{r}*INDEX(Mix_Eff,'
                                              'MATCH($B{r},Mix_Code,0),{k}),""))', k=k + 1), QTY)
        d = colL(PP_D0 + k)
        column_formula(ws, PP_M0 + k, a, b, T('=IF({d}{r}="","",{d}{r}*WorkDaysMonth)', d=d), QTY)
    column_formula(ws, PP_CHK, a, b,
                   '=IF(AND($A{r}="",$B{r}="",$D{r}=""),"",IF(OR($A{r}="",$B{r}=""),"⚠ Site and mix code required",'
                   'IF(ISNA(MATCH($B{r},Mix_Code,0)),"⚠ Unknown mix code",'
                   'IF(COUNTIF(CI_Site,$A{r})=0,"⚠ Site not set up in Current Inventory","OK"))))')
    dv_list(ws, "SiteList", f"A{a}:A{b}", "Pick a site from the list (the list is kept in Settings).")
    dv_list(ws, "Mix_Code", f"B{a}:B{b}", "Pick a mix code from the Mix Design sheet.")
    dv_number(ws, f"D{a}:D{b}")
    chk = colL(PP_CHK)
    check_cf(ws, f"{chk}{a}:{chk}{b}", f"${chk}{a}")
    widths(ws, {"A": 24, "B": 10, "C": 24, "D": 11, "E": 11, "F": 11,
                **{colL(PP_D0 + k): 13 for k in range(NMAT)}, **{colL(PP_M0 + k): 14 for k in range(NMAT)},
                colL(PP_REM): 30, chk: 34})
    ws.freeze_panes = "B6"


# ---------------------------------------------------------------------------
# 5 - Forecast
# ---------------------------------------------------------------------------
def build_forecast(ws):
    title(ws, "5 · Forecast — Consumption (Daily → Weekly → Monthly) & 6-Month Stock Projection",
          "Automatic. Usage = declared m3/day (Production Plan) × mix design × working days. Period 1 runs from the "
          "day after the As-of Date to month-end; projected stock adds the deliveries dated in each period.")
    C = Alignment(horizontal="center", vertical="center")
    band(ws, 4, 1, 1 + NPER, "FORECAST PERIODS")
    for lab, r in [("Period", 5), ("Start date", 6), ("End date", 7), ("Working days", 8), ("Label", 9)]:
        c = ws.cell(r, 1, lab)
        c.font, c.border = F(bold=True), BOX
    for p in range(NPER):
        cl, prev = colL(2 + p), colL(1 + p)
        style(ws.cell(5, 2 + p, f"P{p + 1}"), "calc", None, C, bold=True)
        style(ws.cell(6, 2 + p, "=AsOfDate+1" if p == 0 else f"={prev}7+1"), "calc", DATE, C)
        style(ws.cell(7, 2 + p, f"=EOMONTH({cl}6,0)"), "calc", DATE, C)
        style(ws.cell(8, 2 + p, f"=NETWORKDAYS.INTL({cl}6,{cl}7,WeekendMask,Holidays)"), "calc", "0", C)
        style(ws.cell(9, 2 + p, f'=TEXT({cl}6,"mmm yyyy")&IF(DAY({cl}6)=1,""," ("&DAY({cl}6)&"–"&DAY({cl}7)&")")'),
              "calc", None, C, bold=True)
    ws.cell(8, 2 + NPER, "← actual working days in each period (non-working weekdays and holidays from Settings "
                         "are skipped)").font = F(9, color=MUTED)

    # Section A - concrete
    band(ws, 11, 1, 11, "A. CONCRETE PRODUCTION FORECAST (m3) — from the declared m3/day in the Production Plan")
    header_row(ws, 12, ["Site / Project", "Planned\nm3 / Day", "m3 / Week", "m3 / Month\n(full month)"]
               + [f"={colL(2 + p)}$9" for p in range(NPER)] + ["Total next\n6 periods"], height=40)
    for r in range(FCA0, FCA1 + 1):
        s = SITE0 + (r - FCA0)
        style(ws.cell(r, 1, f'=IF(Settings!$B{s}="","",Settings!$B{s})'), "calc")
        style(ws.cell(r, 2, f'=IF($A{r}="","",SUMIFS(PP_Vol,PP_Site,$A{r}))'), "calc", QTY)
        style(ws.cell(r, 3, f'=IF($A{r}="","",$B{r}*WorkDaysWeek)'), "calc", QTY)
        style(ws.cell(r, 4, f'=IF($A{r}="","",$B{r}*WorkDaysMonth)'), "calc", QTY)
        for p in range(NPER):
            style(ws.cell(r, 5 + p, f'=IF($A{r}="","",$B{r}*{colL(2 + p)}$8)'), "calc", QTY)
        style(ws.cell(r, 11, f'=IF($A{r}="","",SUM(E{r}:J{r}))'), "calc", QTY, bold=True)
    tr = FCA1 + 1
    style(ws.cell(tr, 1, "TOTAL — ALL SITES"), "calc", bold=True)
    for ci in range(2, 12):
        L_ = colL(ci)
        style(ws.cell(tr, ci, f"=SUM({L_}{FCA0}:{L_}{FCA1})"), "calc", QTY, bold=True)

    # Section B - materials
    hb = FCB0 - 1
    band(ws, hb - 2, 1, 36, "B. MATERIAL FORECAST & PROCUREMENT PLAN (per site and material)")
    groups = [(1, 4, "ITEM"), (5, 9, "USAGE RATE, STOCK & TARGET"), (10, 15, "FORECAST CONSUMPTION per period"),
              (16, 21, "SCHEDULED DELIVERIES per period"),
              (22, 27, "STILL TO ORDER per period (keeps stock at the reorder level)"),
              (28, 33, "PROJECTED CLOSING STOCK (with those orders)"), (34, 36, "OUTLOOK")]
    for c1, c2, text in groups:
        band(ws, hb - 1, c1, c2, text)
    per = [f"={colL(2 + p)}$9" for p in range(NPER)]
    header_row(ws, hb, ["Site / Project", "Code", "Material", "Unit", "Use / Day", "Use / Week",
                        "Use / Month\n(generic)", "Current Stock", "Target Stock\n(reorder level)"]
               + per * 4 + ["Runs Out\n(no new orders)", "6-Period\nRequirement", "Total Still\nto Order"], height=40)
    for r in range(FCB0, FCB1 + 1):
        s_ = r - FCB_OFF
        style(ws.cell(r, 1, f'=IF({SMq}!$A{s_}="","",{SMq}!$A{s_})'), "calc")
        style(ws.cell(r, 2, f'=IF($A{r}="","",{SMq}!$B{s_})'), "calc", None, C)
        style(ws.cell(r, 3, f'=IF($A{r}="","",{SMq}!$C{s_})'), "calc")
        style(ws.cell(r, 4, f'=IF($A{r}="","",{SMq}!$D{s_})'), "calc", None, C)
        style(ws.cell(r, 5, f'=IF($A{r}="","",{SMq}!$J{s_})'), "calc", QTY)
        style(ws.cell(r, 6, f'=IF($A{r}="","",$E{r}*WorkDaysWeek)'), "calc", QTY)
        style(ws.cell(r, 7, f'=IF($A{r}="","",$E{r}*WorkDaysMonth)'), "calc", QTY)
        style(ws.cell(r, 8, f'=IF($A{r}="","",{SMq}!$E{s_})'), "calc", QTY, bold=True)
        style(ws.cell(r, 9, f'=IF($A{r}="","",{SMq}!$T{s_})'), "calc", QTY)
        cum = []
        for p in range(NPER):
            pc = colL(2 + p)
            cons, sched, order, close = colL(10 + p), colL(16 + p), colL(22 + p), colL(28 + p)
            opening = f"MAX(0,$H{r})" if p == 0 else f"{colL(27 + p)}{r}"
            style(ws.cell(r, 10 + p, f'=IF($A{r}="","",$E{r}*{pc}$8)'), "calc", QTY)
            style(ws.cell(r, 16 + p, f'=IF($A{r}="","",SUMIFS(Del_Qty,Del_Site,$A{r},Del_Mat,$B{r},'
                                     f'Del_Date,">="&{pc}$6,Del_Date,"<="&{pc}$7))'), "calc", QTY_DASH)
            style(ws.cell(r, 22 + p, f'=IF($A{r}="","",MAX(0,{cons}{r}+$I{r}-{opening}-{sched}{r}))'), "calc",
                  QTY_DASH, bold=True)
            style(ws.cell(r, 28 + p, f'=IF($A{r}="","",MAX($I{r},{opening}+{sched}{r}-{cons}{r}))'), "calc", QTY)
            cum.append(f"MAX(0,$H{r})+SUM($P{r}:{sched}{r})-SUM($J{r}:{cons}{r})<=0")
        nested = '"Beyond 6 periods"'
        for p in reversed(range(NPER)):
            nested = f"IF({cum[p]},${colL(2 + p)}$9,{nested})"
        style(ws.cell(r, 34, f'=IF($A{r}="","",IF($H{r}<=0,"Already out",IF($E{r}<=0,"No usage",{nested})))'),
              "calc", None, C, bold=True)
        style(ws.cell(r, 35, f'=IF($A{r}="","",SUM(J{r}:O{r}))'), "calc", QTY)
        style(ws.cell(r, 36, f'=IF($A{r}="","",SUM(V{r}:AA{r}))'), "calc", QTY, bold=True)
    ws.conditional_formatting.add(f"V{FCB0}:AA{FCB1}", CellIsRule(operator="greaterThan", formula=["0"],
                                                                  font=Font(color="1C5CAB", bold=True)))
    widths(ws, {"A": 24, **{colL(c): 12 for c in range(2, 37)}, "AH": 15})
    ws.freeze_panes = "B1"


# ---------------------------------------------------------------------------
# 6 - Dashboard
# ---------------------------------------------------------------------------
D_SEL, TILE0, KPI_H, KPI0 = 4, 6, 13, 14
KPI_LAST = KPI0 + NMAT - 1
NBANDS = 20                                                  # silo/bin/tank height = 20 bands of 5 %
STORE_BAND = KPI_LAST + 2                                    # silo, bins & tank drawing
V_LABEL = STORE_BAND + 2
V_TOP, V_BOT = V_LABEL + 1, V_LABEL + NBANDS
V_CONE, V_OUT, V_LEG = V_BOT + 1, V_BOT + 2, V_BOT + 3
V_NAME, V_PCT, V_QTY, V_DAYS, V_STATUS = (V_LEG + i for i in range(1, 6))
V_NOTE = V_STATUS + 1
MAT_BAND = V_NOTE + 2                                        # all-sites table
MAT_H, MAT0R = MAT_BAND + 1, MAT_BAND + 2
ACT_BAND = MAT0R + (SITE1 - SITE0 + 1) + 1                   # days-remaining + production charts
CH5_ROW = ACT_BAND + 2
FC_BAND = CH5_ROW + 17                                       # 6-month forecast tables
FC_USE_H, FC_CONC, FC_USE0 = FC_BAND + 1, FC_BAND + 2, FC_BAND + 3
FC_IN_H = FC_USE0 + NMAT + 1
FC_IN0 = FC_IN_H + 1
FC_END_H = FC_IN0 + NMAT + 1
FC_END0 = FC_END_H + 1
CH3_BAND = FC_END0 + NMAT + 2                                # forecast charts (2 rows of 2)
CH3_ROW = CH3_BAND + 2
CH6_ROW = CH3_ROW + 17
NACT = 14
# drawing: (left col, right col, kind) per material, in MATERIALS order
VESSELS = [(3, 4, "silo"), (6, 7, "bin"), (8, 9, "bin"), (10, 11, "bin"), (13, 14, "tank")]
VESSEL_TINT = ["9EC5F4", "F6B08F", "8ED9BC", "F7D27A", "F2B8CF"]   # light tints of the material colours


def _line_series(s, color, width=28575, dash=None, marker=True):
    s.graphicalProperties.line.solidFill = color
    s.graphicalProperties.line.width = width
    if dash:
        s.graphicalProperties.line.dashStyle = dash
    s.smooth = False
    if marker:
        s.marker.symbol = "circle"
        s.marker.size = 7
        s.marker.graphicalProperties.solidFill = color
        s.marker.graphicalProperties.line.solidFill = "FFFFFF"
    else:
        s.marker.symbol = "none"


def _labels(s, fmt=None, pos=None):
    s.dLbls = DataLabelList()
    s.dLbls.showVal = True
    for attr in ("showLegendKey", "showCatName", "showSerName", "showPercent", "showBubbleSize"):
        setattr(s.dLbls, attr, False)
    if fmt:
        s.dLbls.numFmt = fmt
    if pos:
        s.dLbls.position = pos


def _axes(ch, y_fmt=None, y_title=None, x_title=None):
    ch.x_axis.delete = False
    ch.y_axis.delete = False
    if y_fmt:
        ch.y_axis.number_format = y_fmt
    if y_title:
        ch.y_axis.title = y_title
    if x_title:
        ch.x_axis.title = x_title
    ch.y_axis.majorGridlines = ChartLines(spPr=GraphicalProperties(ln=LineProperties(solidFill="E3E3E3")))


def build_dashboard(ws, sample):
    C = Alignment(horizontal="center", vertical="center", wrap_text=True)
    LASTC = 15  # column O
    ws.sheet_view.showGridLines = False
    ws["B1"].value, ws["B1"].font = "6 · Inventory Dashboard — Cement, Aggregates & Admixture", F(16, True, NAVY)
    ws["B2"] = ('="As of "&TEXT(AsOfDate,"dddd, dd mmmm yyyy")&"   ·   Days are working days ("&WorkDaysWeek&'
                '" per week)   ·   Pick a site in the yellow cell"')
    ws["B2"].font = F(10, color=MUTED)
    if sample:
        ws["J1"].value = "SAMPLE DATA — illustrative figures only"
        ws["J1"].font = F(10, True, "9E1F1F")

    # selector + headline counts
    ws["B4"].value, ws["B4"].font = "Site / Project:", F(11, True, NAVY)
    ws["B4"].alignment = Alignment(horizontal="right", vertical="center")
    ws.merge_cells("C4:E4")
    style(ws["C4"], "in", None, Alignment(horizontal="center", vertical="center"), bold=True)
    ws["C4"].value = "All Sites"
    ws["C4"].font = F(11, True, NAVY)
    dv_list(ws, "SiteChoice", "C4", "Pick a site from the list, or All Sites.")
    for ref, text in [("G4", "Worst item status:"), ("J4", "Critical / out:"), ("L4", "To reorder:")]:
        ws[ref].value, ws[ref].font = text, F(10, True, NAVY)
        ws[ref].alignment = Alignment(horizontal="right", vertical="center")
    ws.merge_cells("H4:I4")
    ws["H4"] = ('=IF(COUNTIFS(SM_Site,SelCrit,SM_Status,"OUT OF STOCK")>0,"OUT OF STOCK",'
                'IF(COUNTIFS(SM_Site,SelCrit,SM_Status,"CRITICAL")>0,"CRITICAL",'
                'IF(COUNTIFS(SM_Site,SelCrit,SM_Status,"REORDER")>0,"REORDER",'
                'IF(COUNTIFS(SM_Site,SelCrit,SM_Status,"OK")>0,"OK","NO DATA"))))')
    style(ws["H4"], "calc", None, C, bold=True)
    ws["K4"] = '=COUNTIFS(SM_Site,SelCrit,SM_Status,"CRITICAL")+COUNTIFS(SM_Site,SelCrit,SM_Status,"OUT OF STOCK")'
    style(ws["K4"], "calc", '[=1]0" item";0" items"', C, bold=True)
    ws["M4"] = '=COUNTIFS(SM_Site,SelCrit,SM_Status,"REORDER")'
    style(ws["M4"], "calc", '[=1]0" item";0" items"', C, bold=True)
    status_cf(ws, "H4")
    ws.conditional_formatting.add("K4", CellIsRule(operator="greaterThan", formula=["0"], fill=fill("F6CFCF"),
                                                   font=Font(color="9E1F1F", bold=True)))
    ws.conditional_formatting.add("M4", CellIsRule(operator="greaterThan", formula=["0"], fill=fill("FFEDB8"),
                                                   font=Font(color="7A5200", bold=True)))
    ws.row_dimensions[4].height = 24

    # helper block (columns Q..Z)
    band(ws, 3, 17, 29, "CHART DATA & HELPERS (automatic — do not edit)", "ECECEA", MUTED)
    ws["Q4"].value, ws["Q4"].font = "Site criteria", F(9, color=MUTED)
    ws["R4"] = '=IF(OR($C$4="",$C$4="All Sites"),"*",$C$4)'
    style(ws["R4"], "calc")
    header_row(ws, KPI_H, ["Code", "Lead (days)", "Safety (days)", "Reorder level\n(lead + safety)",
                           "Critical level\n(lead time)", "Days remaining\n(on hand)", "% of capacity",
                           "Earliest reorder", "Earliest critical", "Earliest stock-out", "Silo/bin fill\n(of 20 bands)",
                           "Critical mark\n(band)", "Reorder mark\n(band)"], start_col=17, height=34)

    # KPI table (B..O)
    header_row(ws, KPI_H, ["Material", "Unit", "Current\nStock", "Max\nCapacity", "% of\nCapacity", "Use / Day",
                           "Days\nRemaining", "On Order", "Reorder By", "Critical On", "Stock-out On", "Status",
                           "Sites Critical\n/ Out", "Suggested\nOrder Qty"], start_col=2, height=34)
    site_mask = '((($C$4=SM_Site)+($R$4="*"))>0)'
    for k in range(NMAT):
        r = KPI0 + k
        crit = f"SM_Site,SelCrit,SM_Mat,$Q{r}"
        f = {
            2: f"=INDEX(Mat_Short,{k + 1})",
            3: f"=INDEX(Mat_Unit,{k + 1})",
            4: f"=SUMIFS(SM_Stock,{crit})",
            5: f"=SUMIFS(SM_Cap,{crit})",
            6: f'=IF(E{r}>0,MAX(0,D{r})/E{r},"")',
            7: f"=SUMIFS(SM_Rate,{crit})",
            8: f'=IF(G{r}>0,MAX(0,D{r})/G{r},"")',
            9: f"=SUMIFS(SM_OnOrder,{crit})",
            10: f'=IF($X{r}>=1E9,"",IF($X{r}<=AsOfDate,"NOW",$X{r}))',
            11: f'=IF($Y{r}>=1E9,"",IF($Y{r}<=AsOfDate,"NOW",$Y{r}))',
            12: f'=IF($Z{r}>=1E9,"",IF($Z{r}<=AsOfDate,"OUT",$Z{r}))',
            13: (f'=IF(COUNTIFS({crit})=0,"NO DATA",IF(COUNTIFS({crit},SM_Status,"OUT OF STOCK")>0,"OUT OF STOCK",'
                 f'IF(COUNTIFS({crit},SM_Status,"CRITICAL")>0,"CRITICAL",IF(COUNTIFS({crit},SM_Status,"REORDER")>0,'
                 f'"REORDER",IF(COUNTIFS({crit},SM_Status,"OK")>0,"OK","NO USAGE")))))'),
            14: f'=COUNTIFS({crit},SM_Status,"CRITICAL")+COUNTIFS({crit},SM_Status,"OUT OF STOCK")',
            15: f"=SUMIFS(SM_Order,{crit})",
        }
        fmts = {4: QTY, 5: QTY, 6: PCT, 7: QTY, 8: DAYS, 9: QTY_DASH, 10: DATE, 11: DATE, 12: DATE, 14: "0",
                15: INT_DASH}
        for ci, formula in f.items():
            style(ws.cell(r, ci, formula), "calc", fmts.get(ci), MID if ci == 2 else C, bold=ci in (2, 8, 13))
        mask = f"{site_mask}*(SM_Mat=$Q{r})"
        helpers = {17: f"=INDEX(Mat_Code,{k + 1})", 18: f"=INDEX(Mat_Lead,{k + 1})",
                   19: f"=INDEX(Mat_Safety,{k + 1})", 20: f"=R{r}+S{r}", 21: f"=R{r}",
                   22: f"=IF(ISNUMBER(H{r}),H{r},0)", 23: f"=IF(ISNUMBER(F{r}),F{r},0)"}
        for ci, rng in [(24, "SM_RBn"), (25, "SM_CRn"), (26, "SM_SOn")]:
            helpers[ci] = f"=SUMPRODUCT(MIN({mask}*{rng}+(1-{mask})*1E9))"
        helpers[27] = f"=IF(AND(E{r}>0,D{r}>0),MIN({NBANDS},MAX(1,ROUND(D{r}/E{r}*{NBANDS},0))),0)"
        helpers[28] = f"=IF(AND(E{r}>0,G{r}>0,R{r}>0),MIN({NBANDS},MAX(1,ROUND(G{r}*R{r}/E{r}*{NBANDS},0))),0)"
        helpers[29] = f"=IF(AND(E{r}>0,G{r}>0,T{r}>0),MIN({NBANDS},MAX(1,ROUND(G{r}*T{r}/E{r}*{NBANDS},0))),0)"
        hf = {18: DAYS, 19: DAYS, 20: DAYS, 21: DAYS, 22: DAYS, 23: PCT, 24: NA_NUM, 25: NA_NUM, 26: NA_NUM,
              27: "0", 28: "0", 29: "0"}
        for ci, formula in helpers.items():
            style(ws.cell(r, ci, formula), "calc", hf.get(ci), C)
        ws.row_dimensions[r].height = 20
    kl = KPI0 + NMAT - 1
    status_cf(ws, f"M{KPI0}:M{kl}")
    pct_bars(ws, f"F{KPI0}:F{kl}")
    ws.conditional_formatting.add(f"J{KPI0}:L{kl}", CellIsRule(operator="equal", formula=['"NOW"'],
                                                              font=Font(color="9E1F1F", bold=True)))
    ws.conditional_formatting.add(f"J{KPI0}:L{kl}", CellIsRule(operator="equal", formula=['"OUT"'],
                                                              font=Font(color="9E1F1F", bold=True)))
    ws.cell(kl + 1, 2, "Days Remaining = stock on hand ÷ use per day (working days). Status, Reorder By and Critical On "
                       "also count scheduled deliveries that arrive before the stock-out. All Sites: totals, the "
                       "earliest date and the worst status across sites.").font = F(9, color=MUTED)

    # tiles
    spans = [(2, 2), (3, 4), (5, 6), (7, 8), (9, 10)]
    for k, (c1, c2) in enumerate(spans[:NMAT]):
        r = KPI0 + k
        _tile(ws, c1, c2,
              head=f'=B{r}&"  ("&C{r}&")"',
              big=f'=IF(ISNUMBER(H{r}),H{r},"–")', big_fmt='0.0" days"',
              line1=(f'=IF(ISNUMBER(L{r}),IF($R$4="*","Earliest out ≈ ","Stock-out ≈ ")&TEXT(L{r},"ddd dd-mmm"),'
                     f'IF(L{r}="OUT","OUT OF STOCK now",IF(M{r}="NO DATA","Not set up yet","No usage declared")))'),
              line2=f'=TEXT(D{r},"#,##0")&" "&C{r}&IF(ISNUMBER(F{r}),"  ·  "&TEXT(F{r},"0%")&" full","")',
              foot=f"=M{r}")
    _tile(ws, 11, 15, head="Planned Production (concrete)",
          big="=SUMIFS(PP_Vol,PP_Site,SelCrit)", big_fmt='#,##0.0" m3/day"',
          line1='="≈ "&TEXT(K7*WorkDaysMonth,"#,##0")&" m3 per month ("&WorkDaysMonth&" working days)"',
          line2=('="Actual, last 7 days: "&TEXT(SUMIFS(Con_Vol,Con_Site,SelCrit,Con_Date,">"&(AsOfDate-7),'
                 'Con_Date,"<="&AsOfDate)/MAX(1,NETWORKDAYS.INTL(AsOfDate-6,AsOfDate,WeekendMask,Holidays)),'
                 '"#,##0.0")&" m3/day"'),
          foot='=IF(K7>0,"PLAN DECLARED","NO DATA")')
    status_cf(ws, f"B{TILE0 + 5}:O{TILE0 + 5}")

    _storage_visual(ws)

    # all-sites matrix
    band(ws, MAT_BAND, 2, LASTC, "ALL SITES — DAYS REMAINING (working days, colour = status) AND % OF CAPACITY")
    D0, P0 = 3, 3 + NMAT                    # first "days left" column, first "% full" column
    W_, LO_, SO_ = 3 + 2 * NMAT, 4 + 2 * NMAT, 5 + 2 * NMAT
    labels = ["Site / Project"]
    labels += [f'=INDEX(Mat_Short,{k + 1})&CHAR(10)&"days left"' for k in range(NMAT)]
    labels += [f'=INDEX(Mat_Short,{k + 1})&CHAR(10)&"% full"' for k in range(NMAT)]
    labels += ["Worst Status", "Lowest\nDays Left", "Stock-out ≈"]
    header_row(ws, MAT_H, labels, start_col=2, height=34)
    nsites = SITE1 - SITE0 + 1
    m_last = MAT0R + nsites - 1
    dl, dr = colL(D0), colL(D0 + NMAT - 1)
    for i, r in enumerate(range(MAT0R, m_last + 1)):
        s_row = SITE0 + i
        style(ws.cell(r, 2, f'=IF(Settings!$B{s_row}="","",Settings!$B{s_row})'), "calc", bold=True)
        for k in range(NMAT):
            code = f"Settings!$B${MAT0 + k}"
            stock = f"SUMIFS(SM_Stock,SM_Site,$B{r},SM_Mat,{code})"
            rate = f"SUMIFS(SM_Rate,SM_Site,$B{r},SM_Mat,{code})"
            cap = f"SUMIFS(SM_Cap,SM_Site,$B{r},SM_Mat,{code})"
            style(ws.cell(r, D0 + k, f'=IF($B{r}="","",IF(COUNTIFS(SM_Site,$B{r},SM_Mat,{code})=0,"",'
                                     f'IF({rate}>0,MAX(0,{stock})/{rate},"no use")))'), "calc", DAYS, C)
            style(ws.cell(r, P0 + k, f'=IF($B{r}="","",IF({cap}>0,MAX(0,{stock})/{cap},""))'), "calc", PCT, C)
        worst = (f'=IF($B{r}="","",IF(COUNTIF(SM_Site,$B{r})=0,"NOT SET UP",'
                 f'IF(COUNTIFS(SM_Site,$B{r},SM_Status,"OUT OF STOCK")>0,"OUT OF STOCK",'
                 f'IF(COUNTIFS(SM_Site,$B{r},SM_Status,"CRITICAL")>0,"CRITICAL",'
                 f'IF(COUNTIFS(SM_Site,$B{r},SM_Status,"REORDER")>0,"REORDER",'
                 f'IF(COUNTIFS(SM_Site,$B{r},SM_Status,"OK")>0,"OK","NO USAGE"))))))')
        style(ws.cell(r, W_, worst), "calc", None, C, bold=True)
        lo = colL(LO_)
        style(ws.cell(r, LO_, f'=IF(COUNT({dl}{r}:{dr}{r})=0,"",MIN({dl}{r}:{dr}{r}))'), "calc", DAYS, C, bold=True)
        style(ws.cell(r, SO_, f'=IF({lo}{r}="","",IF({lo}{r}<=0,"OUT",'
                              f'WORKDAY.INTL(AsOfDate,ROUNDUP({lo}{r},0),WeekendMask,Holidays)))'), "calc", DATE, C)
    for k in range(NMAT):
        L_ = colL(D0 + k)
        rng = f"{L_}{MAT0R}:{L_}{m_last}"
        code = f"Settings!$B${MAT0 + k}"
        has = f"COUNTIFS(SM_Site,$B{MAT0R},SM_Mat,{code},SM_Status,"
        for statuses, bg, fg in [(('"OUT OF STOCK"', '"CRITICAL"'), "F6CFCF", "9E1F1F"),
                                 (('"REORDER"',), "FFEDB8", "7A5200"), (('"OK"',), "D9F0D9", "0B5E0B")]:
            formula = "+".join(f"{has}{st})" for st in statuses) + ">0"
            ws.conditional_formatting.add(rng, FormulaRule(formula=[formula], fill=fill(bg),
                                                           font=Font(color=fg, bold=True), stopIfTrue=True))
    pct_bars(ws, f"{colL(P0)}{MAT0R}:{colL(P0 + NMAT - 1)}{m_last}")
    status_cf(ws, f"{colL(W_)}{MAT0R}:{colL(W_)}{m_last}")
    ws.conditional_formatting.add(f"{colL(SO_)}{MAT0R}:{colL(SO_)}{m_last}", CellIsRule(
        operator="equal", formula=['"OUT"'], font=Font(color="9E1F1F", bold=True)))

    # 6-month outlook tables
    band(ws, FC_BAND, 2, LASTC, "6-MONTH FORECAST — selected site (declared m3/day × mix design × working days per month)")
    per = [f"=Forecast!{colL(2 + p)}$9" for p in range(NPER)]
    per_wd = [f'=Forecast!{colL(2 + p)}$9&CHAR(10)&Forecast!{colL(2 + p)}$8&" working days"' for p in range(NPER)]
    header_row(ws, FC_USE_H, ["Forecast consumption", "Unit"] + per_wd + ["6-Period\nTotal"], start_col=2, height=46)
    header_row(ws, FC_IN_H, ["Scheduled deliveries", "Unit"] + per + ["6-Period\nTotal"], start_col=2)
    header_row(ws, FC_END_H, ["Still to order (keeps the reorder level)", "Unit"] + per + ["6-Period\nTotal"],
               start_col=2)
    style(ws.cell(FC_CONC, 2, "Concrete (m3)"), "calc", bold=True)
    style(ws.cell(FC_CONC, 3, "m3"), "calc", None, C)
    for p in range(NPER):
        style(ws.cell(FC_CONC, 4 + p, f"=SUMIFS(INDEX(FCA_Per,0,{p + 1}),FCA_Site,SelCrit)"), "calc", QTY, C)
    style(ws.cell(FC_CONC, 10, f"=SUM(D{FC_CONC}:I{FC_CONC})"), "calc", QTY, C, bold=True)
    for k in range(NMAT):
        code = f"$Q${KPI0 + k}"
        for base, rng_name in [(FC_USE0, "FC_Use"), (FC_IN0, "FC_In"), (FC_END0, "FC_Order")]:
            r = base + k
            style(ws.cell(r, 2, f"=INDEX(Mat_Short,{k + 1})"), "calc", bold=True)
            style(ws.cell(r, 3, f"=INDEX(Mat_Unit,{k + 1})"), "calc", None, C)
            for p in range(NPER):
                style(ws.cell(r, 4 + p, f"=SUMIFS(INDEX({rng_name},0,{p + 1}),FC_Site,SelCrit,FC_Mat,{code})"),
                      "calc", QTY, C)
            style(ws.cell(r, 10, f"=SUM(D{r}:I{r})"), "calc", QTY, C, bold=True)
    ws.conditional_formatting.add(f"D{FC_END0}:J{FC_END0 + NMAT - 1}", CellIsRule(
        operator="greaterThan", formula=["0"], font=Font(color="1C5CAB", bold=True)))
    ws.cell(FC_END0 + NMAT, 2, "Still to order = forecast use − scheduled deliveries − stock above the reorder level, "
                               "per period, so that each period closes at the reorder level (lead time + safety stock "
                               "of usage). Details per site: Forecast sheet.").font = F(9, color=MUTED)
    ws.cell(FC_USE0 - 1, 18, "Chart series names").font = F(9, color=MUTED)
    style(ws.cell(FC_CONC, 18, "Concrete (m3)"), "calc")
    for k in range(NMAT):
        r = FC_USE0 + k
        style(ws.cell(r, 18, f'=B{r}&" use ("&C{r}&")"'), "calc")
        r = FC_END0 + k
        style(ws.cell(r, 18, f'="Still to order ("&C{r}&")"'), "calc")

    # forecast charts: cement | aggregates, admixture | concrete
    band(ws, CH3_BAND, 2, LASTC, "FORECAST VISUALS — selected site")
    cats = Reference(ws, min_col=4, max_col=9, min_row=FC_IN_H)

    def use_vs_order(k, anchor, width):
        ch = BarChart()
        ch.type, ch.grouping, ch.gapWidth, ch.overlap = "col", "clustered", 60, -5
        ch.title = f"{MATERIALS[k][1]} — Monthly Use vs Still to Order"
        for row, color in [(FC_USE0 + k, "86B6EF"), (FC_END0 + k, "1C5CAB")]:
            ch.add_data(Reference(ws, min_col=4, max_col=9, min_row=row), from_rows=True, titles_from_data=False)
            ser = ch.series[-1]
            ser.tx = SeriesLabel(strRef=StrRef(f"'Dashboard'!$R${row}"))
            ser.graphicalProperties.solidFill = color
            ser.graphicalProperties.line.noFill = True
        _labels(ch.series[0], "#,##0", "outEnd")
        ch.set_categories(cats)
        _axes(ch, "#,##0")
        ch.y_axis.scaling.min = 0
        ch.legend.position = "b"
        ch.width, ch.height = width, 7.6
        ws.add_chart(ch, anchor)

    use_vs_order(CEM_IDX, f"B{CH3_ROW}", 16.4)
    agg = BarChart()
    agg.type, agg.grouping, agg.gapWidth, agg.overlap = "col", "clustered", 60, -5
    agg.title = "Aggregates — Monthly Forecast Use"
    for k in AGG_IDX:
        r = FC_USE0 + k
        agg.add_data(Reference(ws, min_col=4, max_col=9, min_row=r), from_rows=True, titles_from_data=False)
        ser = agg.series[-1]
        ser.tx = SeriesLabel(strRef=StrRef(f"'Dashboard'!$R${r}"))
        ser.graphicalProperties.solidFill = MATERIALS[k][6]
        ser.graphicalProperties.line.noFill = True
    agg.set_categories(cats)
    _axes(agg, "#,##0")
    agg.y_axis.scaling.min = 0
    agg.legend.position = "b"
    agg.width, agg.height = 19.0, 7.6
    ws.add_chart(agg, f"H{CH3_ROW}")

    use_vs_order(ADM_IDX, f"B{CH6_ROW}", 16.4)
    conc = BarChart()
    conc.type, conc.grouping, conc.gapWidth = "col", "clustered", 60
    conc.title = "Concrete Production Forecast (m3 per month)"
    conc.add_data(Reference(ws, min_col=4, max_col=9, min_row=FC_CONC), from_rows=True, titles_from_data=False)
    conc.series[0].tx = SeriesLabel(strRef=StrRef(f"'Dashboard'!$R${FC_CONC}"))
    conc.series[0].graphicalProperties.solidFill = "3A4654"
    conc.series[0].graphicalProperties.line.noFill = True
    _labels(conc.series[0], "#,##0", "outEnd")
    conc.set_categories(cats)
    _axes(conc, "#,##0", "m3")
    conc.y_axis.scaling.min = 0
    conc.legend = None
    conc.width, conc.height = 19.0, 7.6
    ws.add_chart(conc, f"H{CH6_ROW}")

    # last 14 days actual production
    band(ws, ACT_BAND, 2, LASTC, "DAYS REMAINING vs REORDER & CRITICAL LEVELS   ·   ACTUAL CONCRETE PRODUCTION, "
                                 "LAST 14 DAYS (selected site)")
    ch = BarChart()
    ch.type, ch.grouping, ch.gapWidth, ch.overlap = "col", "clustered", 60, -5
    ch.title = "Days Remaining vs Reorder & Critical Levels"
    for col_idx, color in [(22, "3A4654"), (20, "FAB219"), (21, "D03B3B")]:
        ch.add_data(Reference(ws, min_col=col_idx, min_row=KPI_H, max_row=KPI0 + NMAT - 1), titles_from_data=True)
        ser = ch.series[-1]
        ser.graphicalProperties.solidFill = color
        ser.graphicalProperties.line.noFill = True
    _labels(ch.series[0], "0.0", "outEnd")
    ch.set_categories(Reference(ws, min_col=2, min_row=KPI0, max_row=KPI0 + NMAT - 1))
    _axes(ch, "0", "Working days")
    ch.y_axis.scaling.min = 0
    ch.legend.position = "b"
    ch.width, ch.height = 16.4, 7.6
    ws.add_chart(ch, f"B{CH5_ROW}")
    header_row(ws, CH5_ROW - 1, ["Date", "Actual m3", "Planned m3/day", "Label"], start_col=17, height=18)
    for i in range(NACT):
        r = CH5_ROW + i
        style(ws.cell(r, 17, "=AsOfDate-13" if i == 0 else f"=Q{r - 1}+1"), "calc", DATE, C)
        style(ws.cell(r, 18, f"=SUMIFS(Con_Vol,Con_Site,SelCrit,Con_Date,Q{r})"), "calc", QTY, C)
        style(ws.cell(r, 19, "=SUMIFS(PP_Vol,PP_Site,SelCrit)"), "calc", QTY, C)
        style(ws.cell(r, 20, f'=TEXT(Q{r},"ddd dd")'), "calc", None, C)
    a5 = BarChart()
    a5.type, a5.grouping, a5.gapWidth = "col", "clustered", 50
    a5.title = "Concrete Produced per Day (m3) — Actual vs Plan"
    a5.add_data(Reference(ws, min_col=18, min_row=CH5_ROW - 1, max_row=CH5_ROW + NACT - 1), titles_from_data=True)
    a5.series[0].graphicalProperties.solidFill = "3A4654"
    a5.series[0].graphicalProperties.line.noFill = True
    _labels(a5.series[0], "0.0", "outEnd")
    dates = Reference(ws, min_col=20, min_row=CH5_ROW, max_row=CH5_ROW + NACT - 1)
    a5.set_categories(dates)
    pl = LineChart()
    pl.add_data(Reference(ws, min_col=19, min_row=CH5_ROW - 1, max_row=CH5_ROW + NACT - 1), titles_from_data=True)
    _line_series(pl.series[0], "77807A", 22225, "dash", marker=False)
    pl.set_categories(dates)
    _axes(a5, "0", "m3")
    a5 += pl
    a5.legend.position = "b"
    a5.width, a5.height = 19.0, 7.6
    ws.add_chart(a5, f"H{CH5_ROW}")

    widths(ws, {"A": 2, "B": 24, **{colL(c): 12.5 for c in range(3, 16)}, "M": 15, "P": 3, "Q": 13,
                "R": 26, **{colL(c): 13 for c in range(19, 30)}})
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_area = f"A1:O{CH6_ROW + 16}"
    for brk in (STORE_BAND - 1, MAT_BAND - 1, FC_BAND - 1, CH3_BAND - 1):
        ws.row_breaks.append(Break(id=brk))


def _storage_visual(ws):
    """Cement silo, 3-compartment aggregate bin and admixture tank drawn with cells: each vessel fills (5 % bands)
    to its % of storage capacity; dashed markers show the critical (lead time) and reorder levels."""
    C = Alignment(horizontal="center", vertical="center")
    wall = Side(style="medium", color="3A4654")
    thin = Side(style="thin", color="3A4654")
    ground = Side(style="thin", color="9AA0A6")
    band(ws, STORE_BAND, 2, 15, '="STORAGE LEVELS — CEMENT SILO, AGGREGATE BINS & ADMIXTURE TANK ("&IF($R$4="*",'
                                '"all sites combined",$C$4)&")   ·   fill = stock on hand ÷ max storage capacity"')
    bins = [v for v in VESSELS if v[2] == "bin"]
    if bins:   # title over the bin battery
        ws.merge_cells(start_row=V_LABEL, start_column=bins[0][0], end_row=V_LABEL, end_column=bins[-1][1])
        c = ws.cell(V_LABEL, bins[0][0], "AGGREGATE BINS")
        c.font, c.alignment = F(9, True, MUTED), Alignment(horizontal="center", vertical="bottom")

    # vessel bodies: one merged cell per 5 % band, filled by conditional formatting
    bexpr = f"({V_BOT + 1}-ROW())"
    for k, (cl, cr, kind) in enumerate(VESSELS):
        hr = KPI0 + k
        for i, r in enumerate(range(V_TOP, V_BOT + 1)):
            b = NBANDS - i
            ws.merge_cells(start_row=r, start_column=cl, end_row=r, end_column=cr)
            c = ws.cell(r, cl, f'=IF({b}=$AB${hr},"– – critical level – –",IF({b}=$AC${hr},"– – reorder level – –",'
                               f'IF({b}=$AA${hr},TEXT($W${hr},"0%"),"")))')
            top = wall if (kind == "tank" and r == V_TOP) else None       # flat tank roof
            bottom = wall if (kind == "tank" and r == V_BOT) else None    # flat tank floor
            c.font, c.alignment, c.fill = F(8, True, NAVY), C, fill("FFFFFF")
            c.border = Border(left=wall, top=top, bottom=bottom)
            ws.cell(r, cr).fill, ws.cell(r, cr).border = fill("FFFFFF"), Border(right=wall, top=top, bottom=bottom)
        lvl, crit, reo, tint = f"$AA${hr}", f"$AB${hr}", f"$AC${hr}", fill(VESSEL_TINT[k])
        rng = f"{colL(cl)}{V_TOP}:{colL(cr)}{V_BOT}"
        for formula, bg, fg in [(f"AND({lvl}>={bexpr},{crit}={bexpr})", tint, "9E1F1F"),
                                (f"AND({lvl}>={bexpr},{reo}={bexpr})", tint, "7A5200"),
                                (f"{lvl}>={bexpr}", tint, NAVY),
                                (f"{crit}={bexpr}", None, "9E1F1F"),
                                (f"{reo}={bexpr}", None, "7A5200")]:
            ws.conditional_formatting.add(rng, FormulaRule(formula=[formula], fill=bg, font=Font(color=fg, bold=True),
                                                           stopIfTrue=True))

    # roofs, hoppers / floors, outlets, legs and the ground line
    for ci in range(2, 16):
        ws.cell(V_LEG, ci).border = Border(bottom=ground)
    prev_right = None
    for k, (cl, cr, kind) in enumerate(VESSELS):
        outer = None if prev_right == cl - 1 else wall          # adjoining bins share one wall
        prev_right = cr
        if kind == "silo":       # conical roof /\
            ws.cell(V_LABEL, cl).border = Border(diagonal=wall, diagonalUp=True)
            ws.cell(V_LABEL, cr).border = Border(diagonal=wall, diagonalDown=True)
        if kind == "tank":       # vent pipe on the flat roof
            ws.cell(V_LABEL, cl).border = Border(right=thin)
        if kind in ("silo", "bin"):   # hopper \/
            ws.cell(V_CONE, cl).border = Border(left=outer, diagonal=wall, diagonalDown=True)
            ws.cell(V_CONE, cr).border = Border(right=wall, diagonal=wall, diagonalUp=True)
        else:                    # flat-bottom tank on a stand with a bottom valve
            ws.cell(V_CONE, cl).border = Border(left=outer, right=thin)
            ws.cell(V_CONE, cr).border = Border(right=wall)
        ws.cell(V_OUT, cl).border = Border(left=outer, right=thin)
        ws.cell(V_OUT, cr).border = Border(right=wall)
        ws.cell(V_LEG, cl).border = Border(left=outer, bottom=ground)
        ws.cell(V_LEG, cr).border = Border(right=wall, bottom=ground)

    # labels under each vessel
    suffix = {"silo": " SILO", "bin": " BIN", "tank": " TANK"}
    for k, (cl, cr, kind) in enumerate(VESSELS):
        hr = KPI0 + k
        rows = [(V_NAME, f'=UPPER(INDEX(Mat_Short,{k + 1}))&"{suffix[kind]}"', F(9, True, NAVY)),
                (V_PCT, f'=IF(ISNUMBER(F{hr}),TEXT(F{hr},"0%")&" full",IF(M{hr}="NO DATA","not set up","no capacity set"))',
                 F(12, True, NAVY)),
                (V_QTY, f'=TEXT(D{hr},"#,##0")&" / "&TEXT(E{hr},"#,##0")&" "&C{hr}', F(8, color=MUTED)),
                (V_DAYS, f'=IF(ISNUMBER(H{hr}),TEXT(H{hr},"0.0")&" days left",IF(M{hr}="NO DATA","–","no usage"))',
                 F(9, True, "3A4654")),
                (V_STATUS, f"=M{hr}", F(9, True, NAVY))]
        for r, formula, font_ in rows:
            ws.merge_cells(start_row=r, start_column=cl, end_row=r, end_column=cr)
            c = ws.cell(r, cl, formula)
            c.font, c.alignment = font_, C
        ws.cell(V_STATUS, cl).fill = fill("ECECEA")
        status_cf(ws, f"{colL(cl)}{V_STATUS}:{colL(cr)}{V_STATUS}")

    # level scale and how-to-read line
    for b, text in {20: "100% —", 15: "75% —", 10: "50% —", 5: "25% —"}.items():
        c = ws.cell(V_TOP + NBANDS - b, 2, text)
        c.font, c.alignment = F(8, color=MUTED), Alignment(horizontal="right", vertical="top")
    c = ws.cell(V_BOT, 2, "0% —")
    c.font, c.alignment = F(8, color=MUTED), Alignment(horizontal="right", vertical="bottom")
    ws.merge_cells(start_row=V_NOTE, start_column=2, end_row=V_NOTE, end_column=15)
    c = ws.cell(V_NOTE, 2, "How to read: coloured fill = stock on hand ÷ max storage capacity (5 % bands)   ·   "
                           "– – critical level – – = usage during the supplier lead time   ·   – – reorder level – – = "
                           "lead time + safety stock   ·   badge = status (counts scheduled deliveries)   ·   All Sites = "
                           "combined stock and capacity")
    c.font, c.alignment = F(8, color="3A4654"), Alignment(horizontal="center", vertical="center")

    ws.row_dimensions[V_LABEL].height = 26
    for r in range(V_TOP, V_BOT + 1):
        ws.row_dimensions[r].height = 13
    ws.row_dimensions[V_CONE].height = 30
    ws.row_dimensions[V_OUT].height = 10
    ws.row_dimensions[V_LEG].height = 12
    ws.row_dimensions[V_PCT].height = 18
    ws.row_dimensions[V_NOTE].height = 20


def _tile(ws, c1, c2, head, big, big_fmt, line1, line2, foot):
    r0 = TILE0
    C = Alignment(horizontal="center", vertical="center", wrap_text=True)
    rows = [(r0, head, F(10, True, "FFFFFF"), NAVY, None),
            (r0 + 1, big, F(22, True, NAVY), "FFFFFF", big_fmt),
            (r0 + 3, line1, F(8.5, color="3A4654"), "FFFFFF", None),
            (r0 + 4, line2, F(8.5, color="3A4654"), "FFFFFF", None),
            (r0 + 5, foot, F(10, True, NAVY), "ECECEA", None)]
    for r, value, font_, bg, fmt in rows:
        if c2 > c1 or r == r0 + 1:
            ws.merge_cells(start_row=r, start_column=c1, end_row=r + (1 if r == r0 + 1 else 0), end_column=c2)
        c = ws.cell(r, c1, value)
        c.font, c.fill, c.alignment = font_, fill(bg), C
        if fmt:
            c.number_format = fmt
        for rr in range(r, r + (2 if r == r0 + 1 else 1)):
            for cc in range(c1, c2 + 1):
                cell = ws.cell(rr, cc)
                cell.border = Border(left=SIDE if cc == c1 else None, right=SIDE if cc == c2 else None,
                                     top=SIDE if rr == r0 else None, bottom=SIDE if rr == r0 + 5 else None)
                if cell.coordinate != c.coordinate:
                    cell.fill = fill(bg)
    ws.row_dimensions[r0].height = 20
    ws.row_dimensions[r0 + 1].height = 22
    ws.row_dimensions[r0 + 2].height = 22
    ws.row_dimensions[r0 + 5].height = 20


# ---------------------------------------------------------------------------
# Instructions
# ---------------------------------------------------------------------------
def build_instructions(ws, sample):
    ws.sheet_view.showGridLines = False
    lines = [
        ("t", "Cement & Aggregates Inventory Monitoring — Housing Projects"),
        ("p", "Tracks cement, sand, gravel (3/4\" and 3/8\") and concrete admixture per housing site: current stock, "
              "consumption from the m3 of concrete produced (via mix design), new deliveries, critical-stock alerts, a "
              "daily-to-monthly consumption forecast and a visual dashboard with % of capacity and days remaining."),
    ]
    if sample:
        lines += [("warn", "SAMPLE DATA: this copy is filled with illustrative figures for 8 sites (count date "
                           "1-Oct-2026, daily logs to 31-Oct-2026) so you can see how it works. The quantities are made "
                           "up. Use the blank 'Cement and Aggregates Inventory.xlsx' for real data.")]
    lines += [
        ("b", ""),
        ("h", "HOW TO USE"),
        ("p", "1. Settings — check the As-of Date (=TODAY() by default), working days per week/month, the materials "
              "(unit, supplier lead time, safety stock), the site list and (optional) non-working holidays."),
        ("p", "2. Mix Design — enter your approved mix design: quantity of each material per 1 m3 of concrete (cement "
              "in bags, aggregates in m3, admixture in litres), plus the allowance (waste) %."),
        ("p", "3. Current Inventory (1) — one row per site and material: count date, beginning balance (physical "
              "count) and maximum storage capacity."),
        ("p", "4. Consumption Log (2) — every day, record the concrete produced: date, site, mix code and m3. The "
              "cement, sand, gravel and admixture used are calculated from the mix design and deducted from stock."),
        ("p", "5. Deliveries (3) — record every delivery receipt as 'Received' (added to stock on its date). Also "
              "record purchase orders not yet delivered as 'Scheduled' with the expected date: they are not added to "
              "stock, but the monitor and the forecast count them as on order."),
        ("p", "6. Production Plan (5) — declare the planned m3 per working day for each site and mix. This drives the "
              "daily usage, days remaining, critical dates and the monthly forecast."),
        ("p", "7. Stock Monitor (4), Forecast (5) and Dashboard (6) are automatic. On the Dashboard, pick a site (or "
              "All Sites) in the yellow cell."),
        ("p", "Dashboard silo, bins & tank: the cement silo, the 3 aggregate bins and the admixture tank fill up to "
              "their % of max storage capacity (bands of 5 %). '– – critical level – –' marks the stock needed for the supplier lead time and "
              "'– – reorder level – –' the stock for lead time + safety stock; the badge under each vessel is its status."),
        ("b", ""),
        ("h", "COLOUR LEGEND"),
        ("in", "Yellow cells = type your data here"),
        ("calc", "Grey cells = calculated automatically — do not type over these"),
        ("ex", "Light grey / italic row under each header = example showing the format — it is not counted"),
        ("p", "Check columns show ⚠ when something needs attention (missing date, unknown code, duplicate row, "
              "scheduled delivery date already passed, ...)."),
        ("b", ""),
        ("h", "HOW CURRENT STOCK IS CALCULATED"),
        ("p", "Current Stock = Beginning Balance (physical count) + Deliveries Received − Consumption, counting "
              "transactions dated from the Count Date up to and including the As-of Date."),
        ("p", "Consumption = m3 produced × mix design quantity per m3 × (1 + allowance %)."),
        ("p", "The physical count is taken at the START of the count date (before that day's deliveries and "
              "production)."),
        ("p", "Recount regularly (weekly or monthly): type the new count date and balance in Current Inventory. Older "
              "log rows then stop affecting the balance — there is no need to delete them."),
        ("b", ""),
        ("h", "CRITICAL-STOCK MONITORING (Stock Monitor and Dashboard)"),
        ("p", "Daily usage = declared m3/day (Production Plan) × mix design. If no plan is declared for a site, the "
              "actual average of the last 7 days (per working day) is used."),
        ("p", "Days Remaining = stock on hand ÷ daily usage, in working days. Stock-out On = the working day the stock "
              "on hand runs out if nothing more arrives (non-working weekdays and holidays in Settings are skipped)."),
        ("p", "Planning Cover = days of usage covered by stock on hand plus deliveries already on order (Scheduled, or "
              "Received with a future date) — counted only when a delivery arrives on or before the stock-out day."),
        ("p", "OK — planning cover is above lead time + safety stock."),
        ("p", "REORDER — planning cover ≤ lead time + safety stock: place an order now."),
        ("p", "CRITICAL — planning cover ≤ supplier lead time: stock will run out before a normal delivery can arrive "
              "(or the next delivery is due after the stock-out). Expedite."),
        ("p", "OUT OF STOCK — stock on hand is zero or negative (negative also means a delivery or a recount is missing)."),
        ("p", "Reorder By = last working day to place the order before the planning cover falls to lead time + safety "
              "stock. Critical On = the working day the cover falls to the lead time. 'NOW' = already reached."),
        ("p", "Suggested Order Qty = quantity that refills storage to its maximum capacity when the order arrives "
              "(after the usage during the lead time and counting what is already on order)."),
        ("p", "Dashboard 'All Sites' view: stock, capacity and usage are totals; dates are the earliest site; the status "
              "is the worst site. The All-Sites table shows each site and material separately."),
        ("b", ""),
        ("h", "FORECAST (Production Plan → Forecast)"),
        ("p", "Daily usage × working days per week = weekly; × working days per month = generic monthly requirement."),
        ("p", "6 forecast periods: period 1 runs from the day after the As-of Date to month-end, then 5 calendar months. "
              "Each period uses its actual number of working days."),
        ("p", "Still to Order = what must be delivered in each period, beyond the scheduled deliveries, so the period "
              "closes at the reorder level (lead time + safety stock of usage). It is the monthly procurement forecast."),
        ("p", "Runs Out (no new orders) = first period in which stock on hand plus scheduled deliveries is used up."),
        ("b", ""),
        ("h", "ASSUMPTIONS (change them in Settings / Mix Design)"),
        ("p", "Mix design defaults are typical Philippine volumetric proportions per m3 with 40 kg cement bags, "
              "0.50 m3 sand and 1.00 m3 gravel: Class AA (1:1.5:3) = 12 bags, Class A (1:2:4) = 9 bags, Class C (1:3:6) "
              "= 6 bags (as tabulated in common estimating references, e.g. M. Fajardo, Simplified Construction "
              "Estimate). Replace them with your approved, lab-tested mix design."),
        ("p", "Admixture default dosage: 4.0 L/m3 for the precast mixes and 2.5 L/m3 for footings (typical "
              "superplasticizer / water-reducer range); none for lean concrete. Use the supplier's recommended dosage "
              "from your trial mixes."),
        ("p", "Allowance 3% (precast) / 5% (cast in place), lead time 3 working days for cement, 2 for aggregates and 5 "
              "for admixture, safety stock 2 working days (3 for admixture), 6 working days per week (Sunday off) and "
              "26 per month are starting assumptions. No holidays are entered by default, which is the conservative "
              "choice."),
        ("b", ""),
        ("h", "CAPACITY"),
        ("p", f"Room for {CI1 - CI0 + 1} site/material rows, {CON1 - CON0 + 1:,} consumption rows, "
              f"{DEL1 - DEL0 + 1:,} deliveries, {PP1 - PP0 + 1} plan rows, {MIX1 - MIX0 + 1} mix designs and "
              f"{SITE1 - SITE0 + 1} sites. To extend a log, insert rows ABOVE its last row (the named ranges then grow) "
              "and copy the grey formula cells down."),
    ]
    r = 2
    for kind, text in lines:
        c = ws.cell(r, 2, text)
        c.alignment = Alignment(wrap_text=True, vertical="top")
        if kind == "t":
            c.font = F(15, True, NAVY)
        elif kind == "h":
            c.font = F(11, True, NAVY)
        elif kind == "warn":
            c.font, c.fill = F(10, True, "9E1F1F"), fill("FFEDB8")
        elif kind == "in":
            c.font, c.fill, c.border = F(), fill(INPUT_FILL), BOX
        elif kind == "calc":
            c.font, c.fill, c.border = F(), fill(CALC_FILL), BOX
        elif kind == "ex":
            c.font, c.fill, c.border = F(italic=True, color=EXAMPLE_INK), fill(EXAMPLE_FILL), BOX
        else:
            c.font = F()
        if kind in ("p", "warn") and len(text) > 120:
            ws.row_dimensions[r].height = 15 * math.ceil(len(text) / 120)
        r += 1
    widths(ws, {"A": 3, "B": 125})


# ---------------------------------------------------------------------------
# Sample data (illustrative only)
# ---------------------------------------------------------------------------
SAMPLE_PLAN = {
    "Batulao Parkhomes": [("MD-01", 16.0), ("MD-02", 3.0)],
    "Calauan (Alora+Amani)": [("MD-01", 22.0), ("MD-03", 4.0)],
    "Gentri": [("MD-01", 10.0)],
    "Naic": [("MD-01", 30.0), ("MD-02", 6.0)],
    "The Cove Lipa": [("MD-01", 22.0), ("MD-04", 2.0)],
    "Sights Bay": [("MD-01", 12.0)],
    "Tayabas": [("MD-01", 3.0)],
    "Batulao Impression": [("MD-01", 8.0), ("MD-03", 3.0)],
}
ELEMENT = {"MD-01": "Wall panels", "MD-02": "Slabs / beams", "MD-03": "Footings", "MD-04": "Lean concrete"}
TRUCK = {"CEM": 250, "SAND": 16, "G34": 16, "G38": 16, "ADM": 200}   # bags (10 t) / m3 per truckload / L per drum
# Disruptions that create REORDER / CRITICAL / OUT OF STOCK examples:
#   ("delay", from date, extra working days) - supplier delivers late
#   ("stop", from date)                      - no new order placed yet
DISRUPT = {
    ("Naic", "CEM"): ("delay", dt.date(2026, 10, 24), 7),
    ("Gentri", "SAND"): ("stop", dt.date(2026, 10, 27)),
    ("Tayabas", "SAND"): ("delay", dt.date(2026, 10, 15), 14),
    ("The Cove Lipa", "G38"): ("stop", dt.date(2026, 10, 24)),
    ("Sights Bay", "CEM"): ("stop", dt.date(2026, 10, 26)),
    ("The Cove Lipa", "ADM"): ("stop", dt.date(2026, 10, 19)),
    ("Batulao Impression", "CEM"): ("stop", dt.date(2026, 10, 24)),
    ("Batulao Parkhomes", "ADM"): ("stop", dt.date(2026, 10, 27)),
    ("Naic", "ADM"): ("delay", dt.date(2026, 10, 26), 3),
    ("Calauan (Alora+Amani)", "CEM"): ("stop", dt.date(2026, 10, 29)),
    ("Batulao Impression", "SAND"): ("delay", dt.date(2026, 10, 27), 2),
}
RECOUNT = {("Tayabas", "SAND"): (dt.date(2026, 10, 31), 0, "Recount 31-Oct: stockpile empty (remnant unusable)")}


def simulate_sample(seed=20261031):
    start, end = dt.date(2026, 10, 1), dt.date(2026, 10, 31)
    days = [start + dt.timedelta(n) for n in range((end - start).days + 1)]
    work = [d for d in days if d.weekday() != 6]
    mixes = {m[0]: m for m in MIXES}
    eff = {code: [m[3 + k] * (1 + m[3 + NMAT]) for k in range(NMAT)] for code, m in mixes.items()}
    codes = [m[0] for m in MATERIALS]
    lead = {m[0]: m[4] for m in MATERIALS}
    safety = {m[0]: m[5] for m in MATERIALS}

    def add_workdays(d, n):
        while n > 0:
            d += dt.timedelta(1)
            if d.weekday() != 6:
                n -= 1
        return d

    inventory, logs, deliveries, plan_rows = [], [], [], []
    dr = 41200
    for site, plan in SAMPLE_PLAN.items():
        rnd = random.Random(f"{seed}|{site}")          # one stream per site: adding materials keeps the sample stable
        rate = {c: sum(v * eff[mx][k] for mx, v in plan) for k, c in enumerate(codes)}
        used = [c for c in codes if rate[c] > 0]
        cap, stock, orders = {}, {}, []
        for c in used:
            rc = random.Random(f"{seed}|{site}|{c}")
            raw = rate[c] * rc.uniform(10, 13)
            step = 100 if c in ("CEM", "ADM") else 10
            cap[c] = max(TRUCK[c] * 3, math.ceil(raw / step) * step)
            unit = 10 if c in ("CEM", "ADM") else 1
            stock[c] = round(cap[c] * rc.uniform(0.45, 0.8) / unit) * unit
            inventory.append((site, c, start, stock[c], cap[c]))
        for mx, v in plan:
            plan_rows.append((site, mx, v))
        for d in work:
            for c in used:
                if (site, c) in RECOUNT and RECOUNT[(site, c)][0] == d:
                    stock[c] = RECOUNT[(site, c)][1]
            for o in [o for o in orders if o[0] == d]:
                stock[o[1]] += o[2]
                deliveries.append((d, site, o[1], o[2], "Received", o[3]))
            orders = [o for o in orders if o[0] != d]
            factor = 0.0 if rnd.random() < 0.05 else rnd.uniform(0.82, 1.12)
            vols = [(mx, round(v * factor, 1)) for mx, v in plan]
            need = {c: sum(vol * eff[mx][codes.index(c)] for mx, vol in vols) for c in used}
            scale = min([1.0] + [stock[c] / need[c] for c in used if need[c] > 0])
            if scale < 0.25:      # not enough material for a meaningful pour - no production
                vols = [(mx, 0.0) for mx, _ in vols]
            elif scale < 1:
                vols = [(mx, math.floor(vol * scale * 10) / 10) for mx, vol in vols]
            for mx, vol in vols:
                if vol <= 0:
                    continue
                logs.append((d, site, mx, vol, ELEMENT[mx] + (" – reduced, material shortage" if scale < 1 else "")))
                for c in used:
                    stock[c] -= vol * eff[mx][codes.index(c)]
            for c in used:
                on_order = sum(o[2] for o in orders if o[1] == c)
                dis = DISRUPT.get((site, c))
                if dis and dis[0] == "stop" and d >= dis[1]:
                    continue
                if stock[c] + on_order <= rate[c] * (lead[c] + safety[c] + 1.5):
                    qty = math.floor((cap[c] - stock[c] - on_order) / TRUCK[c]) * TRUCK[c]
                    if qty <= 0:
                        continue
                    arrive = add_workdays(d, int(lead[c]))
                    note = f"{qty // TRUCK[c]} drum(s) x 200 L" if c == "ADM" else f"{qty // TRUCK[c]} truckload(s)"
                    if dis and dis[0] == "delay" and d >= dis[1]:
                        arrive = add_workdays(arrive, dis[2])
                        note += " – supplier delay"
                    orders.append((arrive, c, qty, note))
        for o in orders:
            deliveries.append((o[0], site, o[1], o[2], "Scheduled", o[3]))
    deliveries.sort(key=lambda x: (x[0], x[1], codes.index(x[2])))
    out = []
    for d, site, c, qty, status, note in deliveries:
        dr += 1
        supplier = {"CEM": "Cement Supplier A", "SAND": "Sand Supplier B", "ADM": "Admixture Supplier D"}.get(
            c, "Aggregates Supplier C")
        out.append((d, site, c, qty, status, supplier, f"DR-{dr:06d}" if status == "Received" else "PO pending", note))
    logs.sort(key=lambda x: (x[0], SITES.index(x[1])))
    return inventory, logs, out, plan_rows


def write_sample(wb):
    inventory, logs, deliveries, plan_rows = simulate_sample()
    ci = wb["Current Inventory"]
    for i, (site, c, count_date, bal, cap) in enumerate(inventory):
        r = CI0 + i
        note = "Opening count (sample)"
        if (site, c) in RECOUNT:
            count_date, bal, note = RECOUNT[(site, c)]
        ci.cell(r, 1, site); ci.cell(r, 2, c); ci.cell(r, 5, count_date); ci.cell(r, 6, bal); ci.cell(r, 7, cap)
        ci.cell(r, 13, note)
    con = wb["Consumption Log"]
    for i, (d, site, mx, vol, note) in enumerate(logs):
        r = CON0 + i
        con.cell(r, 1, d); con.cell(r, 2, site); con.cell(r, 3, mx); con.cell(r, 4, vol); con.cell(r, CON_REM, note)
    de = wb["Deliveries"]
    for i, (d, site, c, qty, status, supplier, ref, note) in enumerate(deliveries):
        r = DEL0 + i
        for ci_, v in zip((1, 2, 3, 5, 7, 8, 9, 10), (d, site, c, qty, status, supplier, ref, note)):
            de.cell(r, ci_, v)
    pp = wb["Production Plan"]
    for i, (site, mx, v) in enumerate(plan_rows):
        r = PP0 + i
        pp.cell(r, 1, site); pp.cell(r, 2, mx); pp.cell(r, 4, v); pp.cell(r, PP_REM, "Sample plan")
    return len(inventory), len(logs), len(deliveries), len(plan_rows)


def write_template_rows(wb):
    """Blank template: pre-list every site x material pair so only quantities need typing."""
    ci = wb["Current Inventory"]
    r = CI0
    for site in SITES:
        for m in MATERIALS:
            ci.cell(r, 1, site)
            ci.cell(r, 2, m[0])
            r += 1


# ---------------------------------------------------------------------------
def build(path, sample):
    wb = Workbook()
    wb.active.title = SHEET_ORDER[0]
    for name in SHEET_ORDER[1:]:
        wb.create_sheet(name)
    define_names(wb)
    build_instructions(wb["Instructions"], sample)
    build_settings(wb["Settings"])
    build_mix(wb["Mix Design"])
    build_ci(wb["Current Inventory"])
    build_consumption(wb["Consumption Log"])
    build_deliveries(wb["Deliveries"])
    build_monitor(wb["Stock Monitor"])
    build_plan(wb["Production Plan"])
    build_forecast(wb["Forecast"])
    build_dashboard(wb["Dashboard"], sample)
    tabs = {"Instructions": MUTED, "Dashboard": NAVY, "Stock Monitor": "9AA0A6", "Forecast": "9AA0A6"}
    for ws in wb.worksheets:
        ws.sheet_properties.tabColor = tabs.get(ws.title, "E8B931")
        if ws.title not in ("Dashboard", "Instructions"):
            ws.page_setup.orientation = "landscape"
            ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
            ws.sheet_properties.pageSetUpPr.fitToPage = True
    stats = write_sample(wb) if sample else write_template_rows(wb)
    wb.active = wb.sheetnames.index("Dashboard" if sample else "Instructions")
    wb.calculation.fullCalcOnLoad = True
    wb.save(path)
    return stats


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(out_dir, exist_ok=True)
    build(os.path.join(out_dir, "Cement and Aggregates Inventory.xlsx"), sample=False)
    stats = build(os.path.join(out_dir, "Cement and Aggregates Inventory - Sample Data.xlsx"), sample=True)
    print("sample rows (inventory, consumption, deliveries, plan):", stats)


if __name__ == "__main__":
    main()
