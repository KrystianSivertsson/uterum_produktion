# quadra2-ldt — ECW → CAMplus-program för Emmegi Quadra2

Gör om eluCad/NC-X-arbetsfiler (`.ECW`, som ase60-generatorn skriver) till CAMplus-program (`.ldt`),
ett per fysisk bit. Programmen öppnas och simuleras i CAMplus på kontorsdatorn (kräver ingen dongel).
Därifrån går de vidare till JOB/Drill på maskindatorn, som kräver dongel.

```
python ecw2ldt.py <fil.ECW> [--out MAPP] [--pos 270] [--mirror 0] [--flip-ops] [--cuts 101,103] [--tools F3L,F5,F8L,P5L] [--name kindrot]
```

**Profilläge 270 (stående, som i eluCads klämvy) sedan 2026-10-23.** Quadra2-sågen gör 45° åt ett håll
(Krystian), så profilerna står som i eluCads profilvy med de gula klämmorna. Den vyn är DXF:en vriden 90° medurs, alltså
CAMplus läge 270. Det är verifierat på bågens osymmetriska form. Det gamla läge 0 byggde på CAMplus XH-vy och
stämmer inte med maskinens såg.
- **Karm 487850A:** `--pos 270 --flip-ops`. eluCad visar tröskelns snedställda dränering V T1/T2 på den motsatta fasen
  mot mappning B, ovanifrån snett från höger, och den synliga dräneringen på undersidan. Karmsnittet är symmetriskt inom
  0,02 mm, så bearbetningarna speglas och profilen behåller läge 270 utan spegelflagga. `--flip-ops` vägrar
  osymmetriska profiler.
- **Båge 517340A:** `--pos 270` utan `--flip-ops`. Dess S1-dränering hamnar i godset bara med mappning B. Läget ska
  jämföras med eluCad innan bågen körs.
- **DPROFILE-förskjutning:** CAMplus håller den vridna profilens bbox-hörn kvar vid DXF:ens, med förskjutning =
  DXF-min − vriden min. Daniels RAMPROFI (270 1 3.8589 −3.8589) räknas exakt så av `quadra.keep_min`, och huvudets
  bbox skrivs som (0, 0, B, H). Utan förskjutning låg alla bearbetningar 46 mm bredvid karmen. Värdena är
  `487850A=270 0 -46 46` och `517340A=270 0 11 -11` i `C:\Quadra2\CAM\DPROFILE.INI`. CAMplus vrider om bearbetningarna
  efter den globala filen när en LDT öppnas.
- **Gering:** CAMplus har två vinkelpar: "1 - Angle generated on the vertical face" (Sx/Dx) och "2 - … horizontal
  face" (Sx2/Dx2). Liggande profil ger par 1, stående (90/270) ger par 2 (ldtwriter väljer). LDA:n har bara ett par,
  vid 0x110.
- **Kör alltid CAMplus-simuleringen efter ett lägesbyte.** Dess krockkontroll hittade krockar i fel läge som platt läge
  inte hade.

**CAMplus:s verktygstabell** `C:\Quadra2\CAM\TOOLS.TXT` är maskinens riktiga tabell, återskapad ur Drills
`OUTPUT.DEB`. Där har även **P5L** lagts in (2026-10-14): en lång Ø5-borr, DIN 338 (52 mm spånlängd) med 40 mm
utstick. **Maskinens verktygstabell behöver samma post** innan programmen körs.

**Verktygssats (4 motorer, varje motor når alla sidor): F3L, F5, F8L, P5L.** Den är vald med `tool_plan2.py` över
alla ASE60- och ASS32-bearbetningar (839 st), med krockkontrollen nedan:
- P5L (borr) tar alla Ø5-hål, även bågens lim- och spikhål underifrån genom bottenkanalen. Ett hål med exakt
  diameter tas med borr före fräs (Krystian 2026-10-22).
- F5 tar 5 mm-spåren (ASS32), glaslistens urtag och andra fräsningar för smala verktyg.
- F3L tar Ø3–4,5.
- F8L tar allt större.

Profilerna är klena med stort överhäng från clampsen, så F9 och större verktyg valdes bort.

**Krockkontroll (`collide.py`):**
- Kontrollen gäller verktygets steg (skär, större diameter, skaft) och hållaren i slutdjup, i profilsnittet. Varje del sveper sin diameter plus figurens sidorörelse, och får inte nå gods utanför den kolumn bearbetningen själv tar bort.
- Verktygsvalet tar aldrig ett verktyg som krockar. Går inget verktyg, hoppas bearbetningen över med "KROCK" i rapporten.
- CAMplus egen simulering ser inte de här krockarna, trots `ENABLE_COLLISION_DETECTION=1`: F3L:s Ø12-steg gick rakt in i bågens krok.
- Bilder per bearbetning: `tools_dev/collision.py <ecw> --png MAPP`.
- Hållare och motor (Krystian 2026-10-23):
  - tångmutter med tabellens diameter, 30 mm från nosen (`NUT_LEN`)
  - sedan Ø35 (`BODY_D`) fram till tabellens hållarlängd (F8L 39,7 ≈ 30 + 10)
  - motorns främre del är också Ø35, 11 mm lång (`MOTOR_NOSE_LEN`)
  - därefter den breda motorn, räknad som Ø113 × 150 (`MOTOR_D`, `MOTOR_LEN`). Ø113 är det största måttet i
    CAMplus modell `Parts\Quadra386.stp` och är inte uppmätt.
  - Det kritiska stället är karmens dräneringsspår på −45°-planet (34×8, 40 djupa): F8L behöver där minst
    33,5 mm utstick (i dag 40).
- Hållaren får gå in i profilens öppna utrymmen (env-regeln gäller inte med krockkontroll). Bara F8L gör det:
  17,7 mm in i bågens bottenkanal vid DLO-fickan.

Programmet skriver `<order>_<CNo>_<profil>.ldt` och `rapport.txt`. En bit som ase60 har delat i två pass,
`[A: standardläge]` + `[B: 180 flipp]` (CRotation 2), blir ETT program `<order>_<CNoA>-<CNoB>_<profil>.ldt`:
SBZ151 når inte undersidan och måste vända biten, men Quadra2 vrider spindeln runt stången.
`--no-merge` ger ett program per :CUT. Rapporten listar varje bearbetning med
plan B, X, W, H, djup, mått och verktyg, plus varningar.

**Profiler i Quadra2:** bara karm 487850A och båge 517340A. Glaslisten 460640F (ytterlock) och täcklocket 490240H
(innerlock) körs inte där (Krystian 2026-10-23). `ecw2ldt.py` hoppar över dem (`NOT_QUADRA`); `--all-profiles`
tvingar fram dem.

**Vidare till maskinen:** LDT → CAMplus "Create/Add JLT" (en JOB-lista per profil, `<kund>_<profil>`) → JOB
Optimize → Export to Quadra2 → `<kund>_<profil>.LDA`. Detaljer och automations-ID:n finns i minnesfilen
emmegi-job-lda-flode.

## Kedjan
1. `ecw.py` läser ECW och plattar ut makroanrop: absolut X = anropets WX1 + makroverkets WX1 (samma regel som ase60).
2. `quadra.py` räknar om varje bearbetning till CAMplus-geometri:
   - **Sidor:** profil-DXF:en har samma koordinater som eluCads `Profiles.epd`. I eluCads profilvy sitter
     NC-X-nollpunkten i profilens övre HÖGRA hörn och Y pekar åt vänster (kontrollerat i eluCad 2026-10-14).
     DXF x = BW − EV och y = BH + EW, där EV/EW är ase60:s SBZ-ram (EV 0 fram → BW bak, EW 0 topp → −BH).
     Den första versionen hade x = EV och gav spegelvända program.

     | WSide | punkt (DXF) | normalvinkel θ |
     |---|---|---|
     | 1 ovansida | (BW − WY1, BH + WHeight) | 90 |
     | 2 framsida | (BW + WHeight, BH + WY1) | 0 |
     | 3 baksida | (−WHeight, BH − WY1) | 180 |
     | 6 undersida | (BW + WY1, −WHeight) | 270 |
     | 7+n fritt plan n | EV/EW = (WPTransY, WPTransZ) + rotera (WY1, WHeight) med A = −WPAngleX | 90 − A |

   - **Vridning och spegling per bit:** eluCad ritar profilen i den fastspänning biten har, och bearbetningarna
     gäller den ritningen. Generatorn räknar tillbaka till profilens eget läge. Båda fallen syns i eluCads profilvy.
     - CRotation 2 (180°, bågarnas B-pass): (BW − x, BH − y, θ + 180). Ändvinklarna blir 180 − vinkeln (135 → 45).
     - CMirror 1: (BW − x, y, 180 − θ).
     - Glaslisten 460640F har båda, vilket blir en spegling i höjdled.
     - CRotation 1/3 (90/270°) är inte verifierat, så de bearbetningarna hoppas över med varning.

   - **Profilläge:** CAMplus lagrar W/H och θ i det *placerade* läget. DXF:en vrids moturs med lägesvinkeln
     runt mitten av dess omslutande rektangel (DPROFILE.INI). Därefter kommer spegling och förskjutning.
     W/H räknas från den vridna rektangelns minsta hörn, så att profilen står på bordet vid H = 0 och mot
     anslaget vid W = 0. Huvudet lagrar den vridna rektangeln.
     CAMplus nekar punkter under H = 0 med "Complete cuts programming not allowed!".
   - **Verktyg:** uppsättningen anges med `--tools`, som standard F3L, F5, F8L, P5L. Djupen räknas ur DXF-konturen:
     godsdjup från första kontakt och djup under ytterkonturen. Ett verktyg duger om dess smala del räcker för
     godsdjupet och utsticket (totallängd − hållarlängd) räcker för djupet under ytterkonturen. Hål med exakt
     diameter borras rakt ner, i övrigt väljs det största verktyg som passar.
   - **CAMplus-B** = θ − 90. B = 0 betyder uppifrån, −90 från W-max-sidan och 180 underifrån.
   - **Djup:** Z start = +3 och Z slut = −(djupaste nivån i WDepthTab), båda relativt referenspunkten (WHeight ingår).
   - **Typer:** C/D blir HOLE (D = WW1). L blir SLOT (L = WW1, bredd = WW2, vinkel = WAngle).
     R blir RECTANGLE (L = WW1, H = WW2, r = WW3, vinkel = WAngle, WBroach = 1 ger urfräsning).
     Om kortsidan är 2 × r (till exempel 8×20 r4) sätts r till kortsidan/2 − 0,1. CAMplus 3D-kärna (TKG3d.dll)
     kraschar annars när filen öppnas (testat på 460640F 2026-10-14). Generatorn väljer då ett mindre verktyg,
     och hörnen skiljer 0,1 mm.
   - **Verktyg:** se verktygssatsen ovan. Verktyget väljs bland dem som räcker och inte krockar: exakt hål → rak borrning
     med kortaste verktyget, annars största diametern.
     S (såg) hoppas över, eftersom maskinen kapar själv efter längd och ändvinklar. Andra typer och sidor varnas.
3. `ldtwriter.py` skriver LDT-filen, se formatet nedan.

## LDT-formatet (CAMplus 4.0/2, inre version 0x68)
- Filen är ett zip-arkiv med `QUADRA2.MACHINE`, `<SERIE>.SERIE`, `<namn>.ldt` (binär), `<kod>.dxf`, `tools.txt`,
  `dprofile.ini`, `encumbrance.txt` (X-intervall med bearbetning, som styr klämmorna) och `LDT.ini`.
- Den binära delen är ett huvud på 512 B, följt av nObj × 34 B referensobjekt och sedan n × 3858 B
  bearbetningsposter. Det finns ingen avslutande del.

### Huvud
| offset | innehåll |
|---|---|
| 0x0A | beskrivning, 40 B |
| 0x32 | serie, 20 B |
| 0x46 | profilkod, 20 B |
| 0x5A | nObj (uint32) |
| 0x5E | antal bearbetningar (uint16). CAMplus läser bara så många poster. |
| 0x14C | längd (double) |
| 0x158 / 0x160 / 0x168 / 0x170 | placerad omslutande rektangel: min W, min H, max W, max H |
| 0x184 / 0x18C / 0x194 | lägesvinkel / förskjutning W / förskjutning H |
| 0x19C | spegling (int16) |
| 0x19E | 4 × int16 ändvinklar i hundradels grader (Sx, Dx, Sx2, Dx2) |

### Post
Offset räknas från figurnamnet, som ligger 20 B in i posten. Posten börjar med `id u32, figurtyp u16, 1 u16`.
Figurtyperna är HOLE = 1, RECTANGLE = 2, SLOT = 3 och KEY HOLE = 4.

| offset | innehåll |
|---|---|
| +80 | θ |
| +94 | X |
| +340 / +348 / +554 / +562 | cos θ, −sin θ, sin θ, cos θ |
| +522 / +678 / +730 | Z start / Z slut / frigång |
| +738 | banläge (byte): 0 profilfräsning, 1 urfräsning |
| +844 | figurvinkel ALPHALAV (double) |
| +854 / +862 / +870 | figurparametrar |
| +1074 | figurfil (F01.LAV …) |
| +1152 / +1204 | id för referensobjekt till W / H |
| +1156 / +1208 | W / H |
| +2028 | antal verktyg |
| +2030 | verktygsnamn |
| +2110 | verktygets totala längd |
| +2118 | verktygets diameter |

## Verifiering
- Bit 103 (karmtröskel, 21 bearbetningar av alla typer) är kontrollerad. Den öppnas utan fel, med rätt plan och
  verktyg på alla 21 bearbetningar. Simuleringen ger "Simulation completed!" utan kollision. Compile LDA ger en
  LDA i samma format som Daniels produktionsfiler, med 1 rektangel, 10 spår och 10 hål.
- När CAMplus sparar om en genererad fil blir alla meningsfulla fält identiska. Det som skiljer är skräp i
  oinitierade buffertar, att CAMplus skapar egna referensobjekt och att den slår ihop klämzoner.
- Klämzoner i `encumbrance.txt` slås ihop när mellanrummet är under 20 mm. Det är säkrare än CAMplus egen
  sammanslagning, som slår ihop 16 mm-luckor.
- `templates/` innehåller poster som CAMplus själv har sparat; generatorn patchar dem.
- **Kindrot (2026-10-14):** karm 487850A (8 bitar), båge 517340A (16 bitar, A/B hopslagna) och glaslist 460640F
  (4 bitar) är genererade i `C:\Quadra2_ecw_test\Kindrot_exempel`. Alla öppnas, simuleras och kompileras till LDA
  i CAMplus. Täcklocket 490240H körs inte i Quadra2.
- **Varje nytt program ska simuleras i CAMplus (Piece → Simulate) innan det körs i maskinen.**
