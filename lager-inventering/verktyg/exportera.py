# Beställningslistans xlsx → CSV (svensk Excel) + Schüco-importfiler per färg.
import openpyxl, csv, json, math, sys
sys.stdout.reconfigure(encoding='utf-8')
d = json.load(open('behov-miljo.json', encoding='utf-8'))
A = d['ANTAL']; DIR = 'K:/Claude Projekt-Krystian Sivertsson/lager-inventering/'
src = DIR + f"Beställningslista lager {A['ase60']} miljöer per färg.xlsx"
wb = openpyxl.load_workbook(src, data_only=True)
def tal(v):
    if isinstance(v, float): return (f'{v:.1f}'.rstrip('0').rstrip('.')).replace('.', ',')
    return '' if v is None else str(v)
for blad, namn, start in [('Beställningslista', f"Beställningslista lager {A['ase60']} miljöer per färg.csv", 5), ('Hela behovet', f"Hela behovet lager {A['ase60']} miljöer per färg.csv", 1)]:
    ws = wb[blad]; n = 0
    with open(DIR + namn, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f, delimiter=';')
        for r in ws.iter_rows(min_row=start, values_only=True):
            if all(v is None for v in r): continue
            if start == 5 and r[0] is not None and all(v is None for v in r[1:]): continue
            w.writerow([tal(v) for v in r]); n += 1
    print(namn, n - 1, 'rader')
# Schüco-import: ASCII, CRLF, "Item number;Quantity;Order Unit". Lackerade profiler per färg.
# Inga ofärgade profiler — bara Vit, Svart och RAL 7016 (Krystian 2026-10-26). Alla aluminium-
# profiler som räknats som tillbehör delas lika på färgerna. Plast/isolering (Interlock PVC,
# Slider, Insert, Guide — Schüco 'Miscellaneous') och beslag är utan färg.
LACKAS_TILLB = {'184020', '184040', '224634', '359700', '178490', '308130', '513000', '220787', '203198', '542000'}
FARG = {'Vit': 'Vit NCS S 0502-Y', 'Svart': 'Svart RAL 9005', 'Antracit': 'Antracit RAL 7016'}
per = {f: {} for f in FARG}; utan = {}
for r in d['rader']:
    if not r['saknas'] > 0 or r['art'] == 'GLAS': continue
    if r['grupp'] == 'Profil': per[r['farg']][r['art']] = per[r['farg']].get(r['art'], 0) + r['saknas']; continue
    if r['art'] in LACKAS_TILLB:
        for f in per: per[f][r['art']] = per[f].get(r['art'], 0) + r['saknas'] / 3
        continue
    x = utan.setdefault(r['art'], [0, r['enhet']]); x[0] += r['saknas']
def skriv(namn, rader):
    with open(DIR + 'Schueco import/' + namn, 'w', encoding='ascii', newline='') as f: f.write('\r\n'.join(['Item number;Quantity;Order Unit'] + rader))
    print(namn, len(rader), 'rader')
skriv('Schueco import 1 - utan farg.csv', [f"{a};{math.ceil(x[0] - 1e-9)};{'M' if x[1] == 'm' else 'PCE'}" for a, x in sorted(utan.items())])
for i, (f, m) in enumerate(per.items(), start=2):
    skriv(f'Schueco import {i} - {FARG[f]}.csv', [f"{a};{math.ceil(n - 1e-9)};PCE" for a, n in sorted(m.items()) if n > 0])
    print('  ', f, ' '.join(f"{a}:{math.ceil(n - 1e-9)}" for a, n in sorted(m.items()) if n > 0))
