# Lagerinventering och beställning till lagret

Underlaget för inventeringen 21/10, ombygget av det gemensamma lagret 25–26/10 och beställningen "10 miljöer per färg" (26/10). Allt räknat av Claude åt Krystian. Hela förklaringen av beställningen står i `Beställning lager - förklaring.md`.

## Filer

| Fil | Vad |
|---|---|
| `Inventering 2026-10-21 (färgräkning).xlsx` | Krystians inventering 21/10. Bladet **Färger (sida 2)** har profilerna per färg (Vit/Svart/Antracit) och är källan till lagrets färgrader. |
| `schuecco-inventering-2026-08-06 (aterskapad).xlsx` | Inventeringen 6/8, återskapad ur lagrets ändringslogg. |
| `Beställningslista lager 10 miljöer per färg.xlsx` / `.csv` | **Det som ska beställas.** CSV: semikolon, decimalkomma, UTF-8. |
| `Hela behovet lager 10 miljöer per färg.csv` | Hela behovet, även det som redan räcker. |
| `Schueco import/*.csv` | Importfiler till Schüco-portalens varukorg (`Item number;Quantity;Order Unit`, ASCII, CRLF): en utan färg och en per färg (Coating sätts i portalen). |
| `Beställning lager - förklaring.md` | Hur allt är räknat, antaganden och öppna frågor. |
| `Beställningslista lager 4 miljöer per färg.xlsx` | Äldre variant (4 miljöer). Ersatt av 10 miljöer. |

## verktyg/

Skripten som räknar fram beställningen (körordning i förklaringen, §9):

- `tak-aoc50.mjs`: AOC 50-takets dellista ur konfiguratorns motor → `tak-aoc50.json`
- `behov-miljo.mjs`: åtgång per parti ur ase60-generatorn (`/api/lager-atgang`, `/api/bom`, `/api/ass32/lager-atgang`, `/api/aws70kil/lager-atgang`) + lagret → `behov-miljo.json` (`atg-*.json` = åtgången per system)
- `bestallning.py`: Excel-listan; `exportera.py`: CSV-filerna + Schüco-importen

## verktyg/lagret/

Skripten som ändrade det **gemensamma lagret på servern** (UterumLager, `/api/lager`) 25–26/10. De läser inloggningen ur `lagersystem/tools/sync-u.config.json` (incheckas aldrig).

- `lager-logg-dump.mjs`, `lager-avstamning.mjs`, `lager-bygg-ur-logg.mjs`: lagret byggdes om ur ändringsloggen (saldot **sattes** till det loggade värdet, inga dubbletter) → `lager-startlage-logg.json`
- `lager-farger-in.mjs`: färgraderna ur Inventering.xlsx "Färger (sida 2)" (`inventering-ny2.json` = inventeringen inläst)
- `lager-309320-till-309330.mjs`: saldot på 309320 (91 st) flyttat till glaslisten 309330
- `lager-lock-5000.mjs`: locken 490240/460640 som 5000 mm-stänger
- `lager-nollor.mjs`, `lager-produkt.mjs`, `lager-profiler.mjs`, `lager-status.mjs`: kontroller
- `parti-atgang.mjs`, `parti-lager.mjs`: hur många partier lagret räcker till
