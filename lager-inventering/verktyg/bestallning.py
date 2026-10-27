import json, datetime, sys
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
sys.stdout.reconfigure(encoding='utf-8')
d = json.load(open('behov-miljo.json', encoding='utf-8'))
F = ['Vit', 'Svart', 'Antracit']
# En rad per system + artikel; profiler med färgkolumner.
rader = {}
for r in d['rader']:
    k = (r['sys'], r['grupp'], r['art'])
    x = rader.setdefault(k, {'sys': r['sys'], 'grupp': r['grupp'], 'art': r['art'], 'ben': r['ben'], 'enhet': r['enhet'], 'f': {}, 'behov': 0, 'lager': 0, 'saknas': 0, 'anm': set()})
    if r['farg']: x['f'][r['farg']] = x['f'].get(r['farg'], 0) + r['saknas']
    x['behov'] += r['behov']; x['lager'] += r['iLager']; x['saknas'] += r['saknas']
    if not r.get('finns', True): x['anm'].add('finns inte i lagerregistret')
    if r.get('anm'): x['anm'].add(r['anm'])
RAKNAD = {'220777': 'räknad 34 st, ej inlagd', '220787': 'räknad 72 st, ej inlagd', '278419': 'räknad 92 st, ej inlagd', '203195': 'räknad 82 st, ej inlagd',
          '218157': 'räknad 983 st, ej inlagd', '224634': 'räknad 127 st, ej inlagd', '284084': 'räknad 77 st, ej inlagd', '234391': 'räknad 15 pkt, ej inlagd'}
BITAR = {'184020', '201316', '203194', '203195', '203196', '203198', '220777', '220787', '278419', '359700', '513000', '542000', '245442'}
PACKNING = {'284321', '284834'}
for x in rader.values():
    if x['art'] in BITAR and x['enhet'] == 'st': x['anm'].add('kapade bitar — materiallistan saknar längd, räkna om till stänger vid beställning')
    if x['art'] in PACKNING and x['enhet'] == 'st': x['anm'].add('bitar — beställs i meter/rulle')
    if x['art'] in RAKNAD: x['anm'].add('inventeringen 21/10: ' + RAKNAD[x['art']])
wb = openpyxl.Workbook()
ws = wb.active; ws.title = 'Beställningslista'
bla = PatternFill('solid', fgColor='1F4E79'); gra = PatternFill('solid', fgColor='D9E1F2'); tunn = Side(style='thin', color='BFBFBF')
ws.append(['Beställningslista — lagermål'])
ws['A1'].font = Font(bold=True, size=14)
A = d['ANTAL']
ws.append([f"ASE60: {A['ase60']} miljöer (partier) per färg · ASS32: {A['ass32']} per färg · Fasta: {A['fasta']} per färg · Färger: Vit, Svart, Antracit · Parti {d['B']} × {d['H']} mm (2 bågar, fasta 2 fält) · " + (f"Tak AOC 50: {d['TAK']['antal']} per färg ({', '.join(d['TAK']['farger'])}), {d['TAK']['B']/1000:g} × {d['TAK']['D']/1000:g} m, täcklocken i färg · " if d.get('TAK') else '') + f"Tillbehör för alla partier · Lagret {datetime.date.today():%Y-%m-%d}"])
ws.append(['Kolumnerna Vit/Svart/Antracit = profilstänger som saknas per färg. "Att beställa" = allt som saknas. Glaset ligger inte i lagret.'])
ws.append([])
rub = ['System', 'Typ', 'Artikelnr', 'Benämning', 'Enhet', 'Vit', 'Svart', 'Antracit', 'Att beställa', 'I lager nu', 'Behov totalt', 'Anmärkning']
ws.append(rub)
hr = ws.max_row
for c in ws[hr]: c.font = Font(bold=True, color='FFFFFF'); c.fill = bla; c.alignment = Alignment(horizontal='center', wrap_text=True)
ordning = {'ASE60': 0, 'ASS32': 1, 'ASE60+Fasta': 2, 'Fasta': 3}
sys_forra = None
for x in sorted([x for x in rader.values() if x['saknas'] > 0], key=lambda x: (ordning.get(x['sys'], 9), x['grupp'] != 'Profil', x['art'])):
    if x['sys'] != sys_forra:
        ws.append([x['sys']]); ws.cell(ws.max_row, 1).font = Font(bold=True, size=12); ws.cell(ws.max_row, 1).fill = gra
        for c in range(2, len(rub) + 1): ws.cell(ws.max_row, c).fill = gra
        sys_forra = x['sys']
    prof = x['grupp'] == 'Profil'
    ws.append([x['sys'], x['grupp'], x['art'], x['ben'], x['enhet'],
               *[(x['f'].get(f) or None) if prof else None for f in F],
               round(x['saknas'], 1), round(x['lager'], 1), round(x['behov'], 1), '; '.join(sorted(x['anm']))])
    ws.cell(ws.max_row, 9).font = Font(bold=True, color='C00000')
ws.append([])
ws.append(['Glas']); ws.cell(ws.max_row, 1).font = Font(bold=True, size=12); ws.cell(ws.max_row, 1).fill = gra
for c in range(2, len(rub) + 1): ws.cell(ws.max_row, c).fill = gra
for g in d['glas']:
    ws.append([g['sys'], 'Glas', 'GLAS', g['ben'], 'st', None, None, None, g['antal'], 0, g['antal'], 'glas beställs separat (ligger inte i lagret)'])
    ws.cell(ws.max_row, 9).font = Font(bold=True, color='C00000')
for col, w in zip('ABCDEFGHIJKL', [11, 10, 10, 36, 16, 7, 7, 9, 12, 10, 11, 46]): ws.column_dimensions[col].width = w
for row in ws.iter_rows(min_row=hr, max_row=ws.max_row):
    for c in row: c.border = Border(top=tunn, bottom=tunn, left=tunn, right=tunn)
ws.freeze_panes = ws.cell(hr + 1, 1)
ws.page_setup.orientation = 'landscape'; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0; ws.sheet_properties.pageSetUpPr.fitToPage = True
# Blad 2: hela behovet mot lagret (även det som räcker)
a = wb.create_sheet('Hela behovet')
a.append(['System', 'Typ', 'Artikelnr', 'Benämning', 'Färg', 'Enhet', 'Behov', 'I lager', 'Saknas', 'Anmärkning'])
for c in a[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = bla
for r in sorted(d['rader'], key=lambda r: (ordning.get(r['sys'], 9), r['grupp'] != 'Profil', r['art'], r['farg'])):
    a.append([r['sys'], r['grupp'], r['art'], r['ben'], r['farg'], r['enhet'], r['behov'], r['iLager'], r['saknas'], '; '.join(x for x in [('finns inte i lagerregistret' if not r.get('finns', True) else ''), r.get('anm', '')] if x)])
for col, w in zip('ABCDEFGHIJ', [11, 10, 10, 36, 9, 16, 9, 9, 9, 34]): a.column_dimensions[col].width = w
a.freeze_panes = 'A2'; a.auto_filter.ref = a.dimensions
ut = rf"K:\Claude Projekt-Krystian Sivertsson\lager-inventering\Beställningslista lager {A['ase60']} miljöer per färg.xlsx"
wb.save(ut)
print('sparad', ut, '—', sum(1 for x in rader.values() if x['saknas'] > 0), 'artiklar +', len(d['glas']), 'glasrader')
