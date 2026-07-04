# StommarBTL

Fristående generator för **Hundegger BVX-** och **BTL V10.5-maskinfiler** –
ett eget alternativ till hsbCAD:s maskinexport. Importera **STEP-filer**
och konvertera 3D-solider till timber-delar (motsvarigheten till hsbCAD:s
"solid till balk"), eller beskriv delarna direkt i en JSON-fil.

Byggd med samma stack som `ase60-generator`: TypeScript + tsx + vitest + Express.

## Webbgränssnitt

```bash
npm run web        # startar http://localhost:5175
```

Dra in en STEP-fil (eller ett sparat jobb-JSON) i webbläsaren → granska
delar och varningar → justera jobbet vid behov i JSON-redigeraren →
ladda ner BVX/BTL/JSON.

## Kommandoraden

```bash
npm install            # första gången
npm run generate -- data/exempel-jobb.json           # skriver data/exempel-jobb.bvx
npm run generate -- jobb.json --btl                  # ... plus .btl
npm run generate -- jobb.json -o "P123 Villa Ek.bvx" # valfri utfil
npm run import-step -- stomme.step                   # STEP → jobb-JSON (granskningsbar)
npm run import-step -- stomme.step --bvx --btl       # ... och direkt till maskinfiler
npm run inspect  -- fil.bvx                          # sammanfattar en befintlig BVX-fil
npm test
```

## STEP-import (solid → timber)

`import-step` läser STEP Part 21 (AP203/AP214), hittar alla solider och gör
per solid:

1. Lokalt koordinatsystem ur de dominerande planytenormalerna (fungerar
   även när delen ligger roterad i modellen).
2. Längd/höjd/bredd ur geometrins utbredning (höjd = minsta tvärmåttet).
3. Ändytor → `SawCut` — vinklade ändytor ger Angle/Bevel ≠ 90.
4. Rektangulära fullbreddsurtag (t.ex. hak för takstolar, ändhalvningar)
   → `Lap` med läge, längd och djup.
5. Cylinderytor vinkelräta mot balkaxeln → `Drilling` (genomgående eller
   med djup).

Delnamn hämtas från produktstrukturen i filen. Det som inte känns igen
(delbreddsfickor, snedborrningar, friformsytor) **konverteras inte utan
rapporteras som varningar** — granska alltid jobb-JSON:en innan du
genererar maskinfil.

## BTL-export

`--btl` skriver BTL V10.5 enligt den officiella specen
([design2machine](https://www.design2machine.com/btl/)), samma stil som
hsbCAD:s export (SCALEUNIT 2 = 1/100 mm och 1/100 grader). Mappning:

| Vår operation | BTL-process | Nyckel |
|---|---|---|
| SawCut | Cut (010) | `1-010-S` vid balkstart, `2-010-S` vid balkslut |
| Drilling | Drilling (040) | `3-040-S`, P11 = diameter, P12 utelämnad = genomgående |
| Lap | Lap Joint (030) | `3-030-S`, P01 = start, P03 = djup, P12 = längd |

Övriga operationstyper (Tenon, Mortise, laxstjärtar) exporteras ännu inte
till BTL — de rapporteras som varningar. BVX-exporten täcker allt.

## Jobbformat

Se [data/exempel-jobb.json](data/exempel-jobb.json). Alla mått i mm, vinklar i
grader. Fält med rimliga standardvärden (t.ex. `angle: 90` för kap) kan
utelämnas – `shared/schema.ts` är facit för alla fält och standardvärden.

Operationstyper som stöds typade: `SawCut`, `Drilling`, `Lap`, `Mortise`,
`Tenon`, `DovetailMortise`, `DovetailTenon`. Övriga operationer kan anges som
`{ "type": "Generic", "tag": "...", "attrs": { ... } }` och skrivs ut ordagrant.

## Struktur

- `shared/schema.ts` – datamodell + zod-validering av jobb-JSON
- `server/bvx/spec.ts` – attributordning/typning per operation (facit mot hsbCAD:s export)
- `server/bvx/writer.ts` / `parser.ts` – JSON ⇄ BVX
- `test/fixtures/hsbCAD2017Template.bvx` – riktig hsbCAD-export som regressionsfacit

## Viktigt innan skarp körning

Formatet är verifierat mot hsbCAD:s egen exportfil (rundtursläsning utan
avvikelser), men **provkör alltid en genererad fil i Cambium/maskinsimulering
innan den skickas till maskinen**. Koordinatkonventionerna (ReferenceSide,
LengthMeas från nollpunkt, CrossMeas mot referenskant) måste stämma med hur er
maskin är uppställd.
