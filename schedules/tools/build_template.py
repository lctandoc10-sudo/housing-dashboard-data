"""PCS Gantt schedule template. Usage: python build_template.py OUT.xlsx [LOGO.png]"""
import datetime as dt
import os
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter as CL
from openpyxl.chart import LineChart, Reference
from openpyxl.drawing.image import Image as XLImage

OUT = sys.argv[1]
LOGO = sys.argv[2] if len(sys.argv) > 2 and os.path.exists(sys.argv[2]) else None
FONT = "Arial"
NAVY = "1F3864"
INPUT = "FFF2CC"
GREY = "F2F2F2"
BLUE = "0000FF"
COMPANY = "PRECAST & CONSTRUCTION SOLUTIONS · MEGAWIDE GROUP"
thin = Side(style="thin", color="BFBFBF")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
dash = Side(style="dashed", color="A6A6A6")


def f(bold=False, color="000000", size=10, italic=False):
    return Font(name=FONT, bold=bold, color=color, size=size, italic=italic)


def fill(c):
    return PatternFill("solid", start_color=c, end_color=c)


def cf(ws, rng, formula, bg=None, fg=None, bold=False):
    r = FormulaRule(formula=[formula], stopIfTrue=True)
    r.dxf = DifferentialStyle(fill=fill(bg) if bg else None, font=Font(color=fg, bold=bold) if fg else None)
    ws.conditional_formatting.add(rng, r)


def letterhead(ws, title, logo_cols=2, height_rows=3):
    """Logo (or placeholder) at top-left, company name and sheet title beside it."""
    for r in range(1, height_rows + 1):
        ws.row_dimensions[r].height = 20
    if LOGO:
        img = XLImage(LOGO)
        h = 58
        img.width = int(img.width * h / img.height)
        img.height = h
        ws.add_image(img, "A1")
    else:
        ws.merge_cells(start_row=1, start_column=1, end_row=height_rows, end_column=logo_cols)
        c = ws.cell(1, 1, "PCS LOGO\n(insert picture here)")
        c.font = f(True, "A6A6A6", 9)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        for r in range(1, height_rows + 1):
            for col in range(1, logo_cols + 1):
                ws.cell(r, col).border = Border(
                    left=dash if col == 1 else None, right=dash if col == logo_cols else None,
                    top=dash if r == 1 else None, bottom=dash if r == height_rows else None)
    tc = logo_cols + 1
    ws.cell(1, tc, COMPANY).font = f(True, NAVY, 11)
    ws.cell(2, tc, title).font = f(True, NAVY, 15)
    return tc


wb = Workbook()
ws = wb.active
ws.title = "Schedule"
ws.sheet_view.showGridLines = False

NROWS = 40
H = 13          # header row of the activity table
FIRST = H + 1
LAST = FIRST + NROWS - 1
TL0 = 11        # timeline starts at column K
NDAYS = 112     # 16 weeks
rng = lambda col: f"${col}${FIRST}:${col}${LAST}"
DAYS, ST, FIN, PCT = rng("F"), rng("G"), rng("H"), rng("I")

tc = letterhead(ws, "GANTT CHART SCHEDULE")
ws.cell(3, tc, '=IF(C5="","",C5&IF(C6="",""," — "&C6))').font = f(False, "404040", 10, True)

inputs = [(5, "Project", "Project name"), (6, "Scope / Location", "e.g. Demob & transfer, Site A → Site B"),
          (7, "Start date", dt.date(2027, 1, 4)), (8, "Status date", "=TODAY()")]
for r, lab, val in inputs:
    ws.cell(r, 2, lab).font = f(True)
    ws.cell(r, 2).alignment = Alignment(horizontal="right")
    ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=4)
    c = ws.cell(r, 3, val)
    c.font = f(True, BLUE); c.fill = fill(INPUT); c.border = BORDER
    ws.cell(r, 4).fill = fill(INPUT); ws.cell(r, 4).border = BORDER
    c.alignment = Alignment(horizontal="left")
    if r >= 7: c.number_format = "dd-mmm-yyyy"


def planned_at(d, sheet=""):
    s = sheet
    return (f"IFERROR(SUMPRODUCT(({d}>={s}{FIN})*{s}{DAYS}+({d}>={s}{ST})*({d}<{s}{FIN})*({d}-{s}{ST}+1))"
            f"/SUM({s}{DAYS}),0)")


kpi = [(5, "Finish", f'=IF(COUNT({DAYS})=0,"",MAX({FIN}))', "dd-mmm-yy"),
       (6, "Planned progress", "=" + planned_at("$C$8"), "0%"),
       (7, "Actual progress", f"=IFERROR(SUMPRODUCT({DAYS},{PCT})/SUM({DAYS}),0)", "0%"),
       (8, "Variance", "=J7-J6", "+0%;-0%;0%")]
for r, lab, fml, fm in kpi:
    ws.merge_cells(start_row=r, start_column=7, end_row=r, end_column=9)
    ws.cell(r, 7, lab).font = f(True)
    ws.cell(r, 7).alignment = Alignment(horizontal="right")
    c = ws.cell(r, 10, fml)
    c.number_format = fm; c.font = f(True, NAVY, 11); c.fill = fill(GREY)
    c.alignment = Alignment(horizontal="center")

# document control block (above the timeline)
doc = [(5, "Prepared by"), (6, "Checked by"), (7, "Approved by"), (8, "Rev. No. / Date")]
for r, lab in doc:
    ws.merge_cells(start_row=r, start_column=TL0 + 1, end_row=r, end_column=TL0 + 5)
    ws.merge_cells(start_row=r, start_column=TL0 + 6, end_row=r, end_column=TL0 + 16)
    ws.cell(r, TL0 + 1, lab).font = f(True, "000000", 9)
    ws.cell(r, TL0 + 1).alignment = Alignment(horizontal="right")
    for col in range(TL0 + 6, TL0 + 17):
        ws.cell(r, col).fill = fill(INPUT); ws.cell(r, col).border = BORDER
    ws.cell(r, TL0 + 6).font = f(False, BLUE, 9)

heads = ["No.", "Activity", "Stage", "Responsible", "After No.", "Days", "Start", "Finish", "% Done", "Status"]
for i, h in enumerate(heads, 1):
    c = ws.cell(H, i, h)
    c.font = f(True, "FFFFFF", 9); c.fill = fill(NAVY)
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.cell(H - 1, i).fill = fill(NAVY)
ws.row_dimensions[H].height = 30
for k in range(NDAYS):
    col = TL0 + k
    c = ws.cell(H, col, "=$C$7-WEEKDAY($C$7,3)" if k == 0 else f"={CL(col-1)}{H}+1")
    c.number_format = "d"; c.font = f(False, "FFFFFF", 8); c.fill = fill("2F5597")
    c.alignment = Alignment(horizontal="center", vertical="center")
    ws.column_dimensions[CL(col)].width = 3.0
    if k % 7 == 0:
        ws.merge_cells(start_row=H - 1, start_column=col, end_row=H - 1, end_column=col + 6)
        c = ws.cell(H - 1, col, f'="Week of "&TEXT({CL(col)}{H},"dd mmm")')
        c.font = f(True, "FFFFFF", 8); c.fill = fill(NAVY); c.alignment = Alignment(horizontal="center")
        for rr in range(H - 1, LAST + 1):
            ws.cell(rr, col).border = Border(left=Side(style="thin", color="8EA9DB"))

for i in range(NROWS):
    r = FIRST + i
    vals = [i + 1, None, None, None, None, None,
            f'=IF(OR(B{r}="",E{r}=""),$C$7,INDEX({FIN},MATCH(E{r},{rng("A")},0))+IF(F{r}=0,0,1))',
            f"=IF(N(F{r})=0,G{r},G{r}+F{r}-1)", None,
            f'=IF(B{r}="","",IF(N(I{r})>=1,"Done",IF($C$8>H{r},"Late",IF($C$8>=G{r},"In Progress","Not Started"))))']
    for j, v in enumerate(vals, 1):
        c = ws.cell(r, j, v)
        c.border = BORDER
        c.font = f(False, "000000", 9)
        c.alignment = Alignment(horizontal="left" if j in (2, 4) else "center", vertical="center")
    for j in (2, 3, 4, 5, 6, 9):
        ws.cell(r, j).fill = fill(INPUT); ws.cell(r, j).font = f(False, BLUE, 9)
    ws.cell(r, 7).number_format = "dd-mmm"
    ws.cell(r, 8).number_format = "dd-mmm"
    ws.cell(r, 9).number_format = "0%"
    for k in range(NDAYS):
        col = TL0 + k
        c = ws.cell(r, col, f'=IF(AND($B{r}<>"",N($F{r})=0,{CL(col)}${H}=$G{r}),"◆","")')
        c.font = Font(name=FONT, bold=True, color="C00000", size=11)
        c.alignment = Alignment(horizontal="center")
    ws.row_dimensions[r].height = 18

# hide dates of empty rows
cf(ws, f"G{FIRST}:H{LAST}", f'$B{FIRST}=""', None, "FFFFFF")
# milestone rows in red bold
cf(ws, f"B{FIRST}:B{LAST}", f'AND($B{FIRST}<>"",N($F{FIRST})=0,$F{FIRST}<>"")', None, "C00000", True)
TL = f"{CL(TL0)}{FIRST}:{CL(TL0 + NDAYS - 1)}{LAST}"
k0 = CL(TL0)
on = f'$B{FIRST}<>"",N($F{FIRST})>0,{k0}${H}>=$G{FIRST}'
cf(ws, TL, f"AND({on},{k0}${H}<$G{FIRST}+ROUND($F{FIRST}*N($I{FIRST}),0))", "00B050")
cf(ws, TL, f"AND({on},{k0}${H}<=$H{FIRST},$H{FIRST}<$C$8,N($I{FIRST})<1)", "FF7C80")
cf(ws, TL, f"AND({on},{k0}${H}<=$H{FIRST})", "5B9BD5")
cf(ws, TL, f"{k0}${H}=$C$8", "FFE699")
cf(ws, TL, f"WEEKDAY({k0}${H})=1", "EDEDED")
cf(ws, f"{k0}{H}:{CL(TL0 + NDAYS - 1)}{H}", f"{k0}${H}=$C$8", "FF0000", "FFFFFF", True)
for s, bg, fg in (("Done", "C6EFCE", "006100"), ("Late", "FFC7CE", "9C0006"), ("In Progress", "DDEBF7", "1F4E78")):
    cf(ws, f"J{FIRST}:J{LAST}", f'$J{FIRST}="{s}"', bg, fg, True)

dv = DataValidation(type="decimal", operator="between", formula1="0", formula2="1", allow_blank=True)
dvn = DataValidation(type="whole", operator="between", formula1="1", formula2=str(NROWS), allow_blank=True,
                     error="Enter the No. of an activity above", errorTitle="After No.")
ws.add_data_validation(dv); dv.add(f"I{FIRST}:I{LAST}")
ws.add_data_validation(dvn); dvn.add(f"E{FIRST}:E{LAST}")

lg = LAST + 2
legend = [("5B9BD5", "Planned"), ("00B050", "Done (% Done)"), ("FF7C80", "Late"), ("FFE699", "Status date"),
          (None, "◆ Milestone (Days = 0)"), (INPUT, "Yellow = you type here")]
ws.cell(lg, 2, "Legend:").font = f(True, NAVY, 9)
for i, (col, txt) in enumerate(legend):
    r = lg + 1 + i
    c = ws.cell(r, 1)
    if col: c.fill = fill(col)
    c.border = BORDER
    ws.cell(r, 2, txt).font = f(False, "404040", 9)
notes = [
    "HOW TO USE: type the Activity, Stage, Responsible and Days. 'After No.' = the No. of the activity it follows "
    "(Start = that Finish + 1 day); leave blank to start on the Start date. Days = 0 makes a milestone (◆).",
    "Example row: No. 4 | Transfer office container van | Transfer | Logistics | After No. 3 | Days 1.",
    "Weekly: set the Status date, type % Done for each activity, then record the Actual progress on the S-Curve sheet.",
    "Timeline shows 16 weeks from the Start date; days are calendar days. Insert rows inside the table to add activities.",
]
for i, t in enumerate(notes):
    ws.cell(lg + 1 + i, 4, t).font = f(False, "404040", 9, True)

for k, v in {"A": 5, "B": 50, "C": 13, "D": 18, "E": 7, "F": 6, "G": 8, "H": 8, "I": 7, "J": 13}.items():
    ws.column_dimensions[k].width = v
ws.freeze_panes = ws.cell(FIRST, 3)
ws.print_title_rows = f"{H-1}:{H}"
ws.page_setup.orientation = "landscape"
ws.page_setup.paperSize = ws.PAPERSIZE_A3
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0
ws.sheet_properties.pageSetUpPr.fitToPage = True
ws.oddFooter.left.text = "&8" + COMPANY
ws.oddFooter.right.text = "&8Page &P of &N"

# ---------------------------------------------------------------- S-CURVE
sc = wb.create_sheet("S-Curve")
sc.sheet_view.showGridLines = False
letterhead(sc, "S-CURVE – PLANNED vs ACTUAL")
sc["C3"] = "=Schedule!C3"
sc["C3"].font = f(False, "404040", 10, True)
sc["A5"] = ("Planned % is automatic (weighted by activity days). Every week, copy the 'Actual progress' from the "
            "Schedule sheet into the yellow cell for that week.")
sc["A5"].font = f(False, "595959", 9, True)
sh = ["Week", "Week Ending", "Planned %", "Actual % (enter)", "Variance"]
for i, h in enumerate(sh, 1):
    c = sc.cell(7, i, h)
    c.font = f(True, "FFFFFF", 9); c.fill = fill(NAVY); c.alignment = Alignment(horizontal="center", wrap_text=True)
NW = 16
for k in range(NW):
    r = 8 + k
    sc.cell(r, 1, f"Wk {k+1}")
    sc.cell(r, 2, f"=Schedule!${CL(TL0)}${H}+{7*(k+1)-1}").number_format = "dd-mmm"
    sc.cell(r, 3, "=" + planned_at(f"B{r}", "Schedule!")).number_format = "0%"
    sc.cell(r, 4).fill = fill(INPUT); sc.cell(r, 4).font = f(True, BLUE); sc.cell(r, 4).number_format = "0%"
    sc.cell(r, 5, f'=IF(D{r}="","",D{r}-C{r})').number_format = "+0%;-0%;0%"
    for j in range(1, 6):
        sc.cell(r, j).border = BORDER
        sc.cell(r, j).alignment = Alignment(horizontal="center")
        if j != 4: sc.cell(r, j).font = f(False, "000000", 10)
lw = 8 + NW - 1
cf(sc, f"E8:E{lw}", 'AND(E8<>"",E8>=0)', "C6EFCE", "006100", True)
cf(sc, f"E8:E{lw}", 'AND(E8<>"",E8<0)', "FFC7CE", "9C0006", True)
dv2 = DataValidation(type="decimal", operator="between", formula1="0", formula2="1", allow_blank=True)
sc.add_data_validation(dv2); dv2.add(f"D8:D{lw}")
sc.merge_cells(start_row=lw + 2, start_column=1, end_row=lw + 2, end_column=5)
sc.row_dimensions[lw + 2].height = 26
c = sc.cell(lw + 2, 1, "Example: if Actual progress shows 36% at the Wk 2 cut-off, type 36% in D9. Leave future weeks blank.")
c.font = f(False, "595959", 9, True); c.alignment = Alignment(wrap_text=True, vertical="top")
for k, v in {"A": 8, "B": 12, "C": 11, "D": 12, "E": 10}.items():
    sc.column_dimensions[k].width = v
ch = LineChart()
ch.add_data(Reference(sc, min_col=3, max_col=4, min_row=7, max_row=lw), titles_from_data=True)
ch.set_categories(Reference(sc, min_col=1, min_row=8, max_row=lw))
pl, ac = ch.series
pl.graphicalProperties.line.solidFill = NAVY; pl.graphicalProperties.line.width = 28000
pl.marker.symbol = "none"; pl.smooth = False
ac.graphicalProperties.line.solidFill = "ED7D31"; ac.graphicalProperties.line.width = 28000
ac.marker.symbol = "circle"; ac.marker.size = 7; ac.smooth = False
ac.marker.graphicalProperties.solidFill = "ED7D31"; ac.marker.graphicalProperties.line.solidFill = "ED7D31"
ch.y_axis.number_format = "0%"; ch.y_axis.scaling.min = 0; ch.y_axis.scaling.max = 1; ch.y_axis.majorUnit = 0.2
ch.y_axis.title = "Cumulative progress"
ch.x_axis.delete = False; ch.y_axis.delete = False
ch.title = "S-Curve"
ch.legend.position = "b"
ch.height = 10; ch.width = 20
sc.add_chart(ch, "G7")
sc.page_setup.orientation = "landscape"
sc.page_setup.fitToWidth = 1
sc.sheet_properties.pageSetUpPr.fitToPage = True
sc.oddFooter.left.text = "&8" + COMPANY

# ---------------------------------------------------------------- CHECKLIST
cl = wb.create_sheet("Checklist")
cl.sheet_view.showGridLines = False
letterhead(cl, "KEY THINGS TO CHECK")
cl["C3"] = "=Schedule!C3"
cl["C3"].font = f(False, "404040", 10, True)
ck = ["No.", "Topic", "What to check / anticipate", "Owner", "Status"]
CH = 6
for i, h in enumerate(ck, 1):
    c = cl.cell(CH, i, h)
    c.font = f(True, "FFFFFF", 9); c.fill = fill(NAVY); c.alignment = Alignment(horizontal="center")
ex = cl.cell(CH - 1, 2, "Example: Permits | LGU / barangay permit and PPH gate passes at both sites | Admin | Open")
ex.font = Font(name=FONT, italic=True, color="808080", size=9)
N_CK = 25
for i in range(N_CK):
    r = CH + 1 + i
    for j in range(1, 6):
        c = cl.cell(r, j, i + 1 if j == 1 else None)
        c.border = BORDER
        c.font = f(False, BLUE if j > 1 else "000000", 9)
        c.alignment = Alignment(horizontal="center" if j in (1, 5) else "left", vertical="center", wrap_text=True)
        if j > 1: c.fill = fill(INPUT)
    cl.row_dimensions[r].height = 22
cll = CH + N_CK
dv3 = DataValidation(type="list", formula1='"Open,In Progress,Done"', allow_blank=True)
cl.add_data_validation(dv3); dv3.add(f"E{CH+1}:E{cll}")
for s, bg, fg in (("Open", "FFC7CE", "9C0006"), ("In Progress", "FFEB9C", "9C5700"), ("Done", "C6EFCE", "006100")):
    cf(cl, f"E{CH+1}:E{cll}", f'$E{CH+1}="{s}"', bg, fg, True)
cl.cell(cll + 2, 2, "Summary").font = f(True)
cl.cell(cll + 2, 3, f'=COUNTIF(E{CH+1}:E{cll},"Open")&" open, "&COUNTIF(E{CH+1}:E{cll},"In Progress")&" in progress, "&COUNTIF(E{CH+1}:E{cll},"Done")&" done"').font = f(True, NAVY)
for k, v in {"A": 5, "B": 26, "C": 90, "D": 18, "E": 12}.items():
    cl.column_dimensions[k].width = v
cl.page_setup.orientation = "landscape"
cl.page_setup.fitToWidth = 1
cl.sheet_properties.pageSetUpPr.fitToPage = True
cl.oddFooter.left.text = "&8" + COMPANY

for w, colr in ((ws, NAVY), (sc, "ED7D31"), (cl, "C00000")):
    w.sheet_properties.tabColor = colr
wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print("logo:", LOGO)
