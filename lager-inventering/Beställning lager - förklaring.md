# Beställning till lagret: 10 miljöer per färg och system + 10 tak per färg

*Underlag 2026-10-26. Hör till filerna i samma mapp:*

| Fil | Innehåll |
|---|---|
| `Beställningslista lager 10 miljöer per färg.xlsx` | Bladet **Beställningslista**: det som ska köpas (78 artiklar + 4 glasrader), med profilerna per färg. Bladet **Hela behovet**: alla 133 rader, även det som redan räcker. |
| `Beställningslista lager 10 miljöer per färg.csv` | Samma lista som CSV för svensk Excel (semikolon, decimalkomma, UTF-8). |
| `Hela behovet lager 10 miljöer per färg.csv` | Hela behovet som CSV. |
| `Schueco import\Schueco import 1 - utan farg.csv` | **Importfil till Schüco-portalens varukorg**: beslag, skruv, tätningar, plast- och isolerdelar (56 rader). |
| `Schueco import\Schueco import 2 - Vit NCS S 0502-Y.csv` | Importfil: allt som lackas **Vit** (15 rader). |
| `Schueco import\Schueco import 3 - Svart RAL 9005.csv` | Importfil: allt som lackas **Svart** (20 rader). |
| `Schueco import\Schueco import 4 - Antracit RAL 7016.csv` | Importfil: allt som lackas **Antracit RAL 7016** (20 rader). |
| `verktyg\` | Skripten som räknar fram allt (se sist). |

---

## 1. Vad målet är

En **miljö** är ett parti. Lagret ska räcka till:

| System | Per färg | Färger | Totalt |
|---|---|---|---|
| ASE60 (skjutparti) | 10 | Vit, Svart, Antracit | 30 partier |
| ASS32 (skjutparti) | 10 | Vit, Svart, Antracit | 30 partier |
| Fasta (AWS 70.HI) | 5 (hälften) | Vit, Svart, Antracit | 15 partier |
| Tak (AOC 50, glas) | 10 | Svart, Vit | 20 tak |

Profiler som lackas behövs per färg. Det finns inga ofärgade profiler, bara Vit, Svart och 7016. Övrigt är gemensamt för alla färger och räknas för allt sammanlagt.

## 2. Vad det är räknat på

- **Partier:** 2500 mm bred × 3400 mm hög.
  - ASE60: 2 bågar, mittmöte, 2 spår, ASE60-350 / DLO-276726.
  - ASS32: 2 bågar, mittmöte, 2 spår, båge 92.
  - Fasta: rakt AWS 70.HI-parti med 2 glasfält (en mittpost 358260).
- **Tak:** 6 m brett × 5 m djupt glastak med konfiguratorns förval. Det blir AOC 50 med 9 takprofiler, 8 fack (cirka 743 c/c), 2 glasrader och 16 glasrutor à 719 × 2632. Bara **täcklocken** (493730 Cover cap 20, 161460 Cover cap) har färg. Add-on-profiler, tryckplattor, tätningar och isolatorer är utan färg.
- **Lock:** 460640 Cover prof. 2/3-tr och 490240 Cover prof. VF 60 är **5000 mm**-stänger. Det är rättat både i generatorn (nästningen räknade 6000) och i lagret.

## 3. Var siffrorna kommer ifrån

**Åtgången** kommer ur samma uträkningar som produktionen använder:

| System | Källa | Ger |
|---|---|---|
| ASE60 | generatorn `/api/lager-atgang` + `/api/bom` | Profiler i **hela stänger** efter nästning (samma som ECW-filen). Tillbehör i styck. |
| ASS32 | generatorn `/api/ass32/lager-atgang`, per färg | Stänger + tillbehör. Färgen styr vita eller mörka täcklock, dränagekåpor och lås. |
| Fasta | generatorn `/api/aws70kil/lager-atgang` | Stänger (358170, 358260) + tillbehör. |
| Tak | konfiguratorns AOC 50-dellista (`aoc50Dellista`, samma som i appen) | Takprofiler och tvärbitar med längd + tillbehör + glasrutor. |

**Lagret** är det gemensamma lagret på servern (UterumLager), som alla ser sedan 25/10, så som det såg ut 26/10.

## 4. Hur lagret fylldes i innan beräkningen

1. **25/10, gemensamt lager.** Alla enheter visade bara nollningen (14/9) plus två tillägg. Påfyllningarna från inventeringen 21/10 fanns bara i ändringsloggen. Lagret byggdes därför om ur loggen: 97 produkter fick saldo, och inget lades in två gånger, eftersom saldot **sattes** till det loggade värdet.
2. **Seal Bk** sattes till 800 st (40 paket à 20 st enligt inventeringen). Loggen visade fel (22 → 22).
3. **26/10, färgerna** från Inventering.xlsx, bladet "Färger (sida 2)", lades in på profilernas färgrader. Totalerna stämmer med arket: Svart 124, Antracit 72, Vit 749. Outer frame 46 och 48/48 hade redan sina totaler (147 och 118) och fördelades bara på färger.
4. **309320 i inventeringen är glaslisten 309330** (Glzg br 50). Saldot (91) flyttades dit.
5. **Antracit** heter "Antracitgrå/RAL7016" i lagret. Det gamla namnet "Grå" hittades inte av kapavdraget när kundkortet säger Antracit.
6. **Locken 490240 och 460640** står som 5000 mm, med färgraderna.

## 5. Hur beställningen är räknad

- **Profiler som lackas, per färg:** behovet i hela stänger minus lagrets färgrad för just den färgen.
  - Glaslisterna 184020/184040, täckprofilerna 224634/220787/203198, droppnäsan 359700, löpskenan 308130, statikprofilen 513000, hörnförbindarprofilen 178490 och 542000 räknas för alla färger och delas lika per färg.
  - Taklocken räknas för Svart och Vit.
- **Utan färg:** beslag, skruv, tätningar och plast- och isolerdelar (Interlock PVC, Slider, Insert, Guide). Summan för allt minus lagret.
  - Bitar med längd är omräknade till hela stänger med lagrets stånglängd.
  - Tätningar som lagret räknar i meter är räknade i meter.
- **Glas** ligger inte i lagret och står för sig:
  - ASE60: 60 rutor 1105 × 3165
  - ASS32: 90 rutor 775 × 3212
  - Fasta: 30 rutor 1168 × 3296
  - Tak: 320 rutor 719 × 2632
- **"Att beställa"** = det som saknas. Ingen extra marginal, ingen avrundning till förpackning.

## 6. Resultat i korthet: lackerade profiler som saknas (hela stänger)

| Färg | Saknas |
|---|---|
| Vit | 490240: 20 · 358170: 10 · 358260: 5 · tak 493730: 90 · tak 161460: 30 |
| Svart | 460640: 20 · 487850: 15 · 490240: 20 · 517340: 38 · 133730: 12 · 309330: 25 · 358170: 10 · 358260: 5 · tak 493730: 90 · tak 161460: 30 |
| Antracit | 460640: 16 · 487850: 10 · 490240: 17 · 517340: 18 · 133720: 9 · 133730: 17 · 309330: 31 · 376150: 16 · 358170: 10 · 358260: 5 |

Dessutom i varje färg: glaslist 184020 60, glaslist 184040 24, 224634 30, 220787 40, 203198 20, droppnäsa 359700 40, löpskena 308130 15, 513000 40, 178490 40 och 542000 20. ASS32 i Vit räcker redan.

Tillbehören står i Excel-filen. De största posterna för taken är skruv 225217 (6705), 205893 (1920), 205894 (1621), brickor 244396 (3462), falsgummi 245572 (1316 m), add-on 536960 (180 stänger) och 536950 (60), tryckplattor 477600 (180) och 477720 (60), isolator 230727 (240 stänger) och glasbärare 268421 (640).

## 7. Att tänka på innan beställning

1. **ASE60:s profiltillbehör står i styck.** Generatorns materiallista ger antal kapade bitar men ingen längd (Track, Interlock, Slider, Cover, Insert, glaslist 22-7, droppnäsa, statikprofil). De måste räknas om till stänger vid beställning. Det står i anmärkningen på raderna.
2. **Räknat men aldrig inlagt.** Spik 218157 (983), Slider 278419 (92), Interlock 220777 (34) och 284084 (77), Cover 220787 (72) och 224634 (127), Insert 203195 (82), lås 9010 234391 (15 pkt). Läggs de in blir beställningen mindre.
3. **358170, 4 st** står som "ofärgade" i inventeringen men ska vara Svart/Vit. De är inte avdragna förrän fördelningen är bekräftad.
4. **Enheter som inte stämmer:** 284351/284839 räknas i st i lagret men behövs i meter. 244058/244669 är tvärtom. 278423 ligger i PAK.
5. **Inre glastätningen ASE60:** materiallistan säger **284834**, lagret har **284835** (omdöpt 21/10). Bestäm vilket nummer som är rätt.
6. **ASE60:s bågprofil** heter 504010 i materiallistan men är profil **517340A**, och det är 517340 som ligger i lagret.
7. **ASE60-karmen:** överkarm (487000) och tröskel (487860) kapas ur stången **487850**.
8. **Taket** är räknat med konfiguratorns förval (takprofilernas c/c, takvinkel, uthäng). Ett riktigt 5 × 6-tak kan ge något annat antal takprofiler.
9. **Ingen förpackningsavrundning.**

## 8. Importera i Schüco-portalen

Importera i **varukorgen** (Shopping Cart → Import articles), inte i Article List (den gav "No lines were imported" med samma fil). Filerna ligger i mappen `Schueco import`. Portalen tar bara `Item number;Quantity;Order Unit` (ASCII, semikolon, CRLF) och har ingen kolumn för färg. Därför finns fyra filer:

1. **`Schueco import 1 - utan farg.csv`** blir "No coating".
2. **`Schueco import 2 - Vit NCS S 0502-Y.csv`**: sätt **Coating** till Vit NCS S 0502-Y på de raderna.
3. **`3 - Svart RAL 9005`** (Coating RAL 9005) och **`4 - Antracit RAL 7016`** (Coating RAL 7016).

Profiler står i stänger (PCE). Tätningar i meter har enheten `M`. Portalens exempel har bara PCE/PK/PR, så tar den inte `M` behöver de bytas till rullar eller PCE. Artiklar som portalen inte känner igen importeras inte (första försöket gav 33 av 50 rader), så jämför antalet rader efter importen.

## 9. Göra om allt

Skripten ligger i `verktyg\`. Kör i den mappen:

```
node tak-aoc50.mjs 6000 5000          ← takets dellista (bredd djup) → tak-aoc50.json
set MILJO=10,10,5                     ← miljöer per färg: ASE60, ASS32, fasta
set TAK=10                            ← tak per färg (Svart, Vit); 0 = inga tak
node behov-miljo.mjs 2500 3400        ← partiets bredd höjd; åtgång + lager → behov-miljo.json
python bestallning.py                 ← Beställningslista-xlsx
python exportera.py                   ← CSV-filerna + Schüco-importfilerna
```
