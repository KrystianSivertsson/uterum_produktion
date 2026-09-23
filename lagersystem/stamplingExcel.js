// Excel-arbetsbok för stämplingsexporten i UterumLager. Ren funktion utan
// React så att den kan köras och testas i Node. Krystian 2026-09-23: alla
// kalenderdagar i perioden, helger rödmarkerade, varje dag för sig och en
// sammanfattning sist på varje persons blad; Sjukdag/VAB/Semester är
// frånvarotyper (07–16 med 1 h lunch = 8 h) och får gul bakgrund.
// xlsx-js-style = SheetJS 0.18 med cellstilar (vanliga xlsx ignorerar `s`).
const { utils } = require('xlsx-js-style');
const { helgdagsnamn, veckodagKort, veckodagIndex, dagarMellan } = require('./helgdagar');

const FRANVARO_TYPER = ['Sjukdag', 'VAB', 'Semester'];

const STIL = {
  rubrik: { font: { bold: true } },
  helg: { fill: { patternType: 'solid', fgColor: { rgb: 'FFC7CE' } }, font: { color: { rgb: '9C0006' } } },
  franvaro: { fill: { patternType: 'solid', fgColor: { rgb: 'FFF2CC' } } },
  summa: { font: { bold: true } },
};
const KOLUMNER = ['Datum', 'Veckodag', 'Första in', 'Sista ut', 'Brutto', 'Lunch', 'Timmar', 'Typ', 'Område', 'Kund'];

// Excel-bladnamn: max 31 tecken, inga [ ] : * ? / \ och unikt i arbetsboken.
function excelBladNamn(namn, upptagna) {
  const bas = String(namn || 'Blad').replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Blad';
  let kandidat = bas; let n = 2;
  while (upptagna.has(kandidat)) kandidat = `${bas} ${n++}`;
  upptagna.add(kandidat);
  return kandidat;
}

// Sätter stil på `antal` celler i en rad; tomma celler skapas så att hela
// raden färgas, inte bara cellerna med innehåll.
function stilaRad(ws, rad, antal, stil) {
  for (let k = 0; k < antal; k++) {
    const adr = utils.encode_cell({ r: rad, c: k });
    if (!ws[adr]) ws[adr] = { t: 's', v: '' };
    ws[adr].s = stil;
  }
}

function lokaltIdag() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// personer: [{ id, namn }], summering: resultatet av sammanstallStampling
// (dagar med datum/ms/forstaIn/sistaUt/omraden/kunder/typ/lunchMs/nettoMs).
// fran/till: 'ÅÅÅÅ-MM-DD' eller '' (tomt = första stämplingsdag / idag).
function byggStamplingArbetsbok({ personer, summering, fran, till, idag }) {
  const idagIso = idag || lokaltIdag();
  const allaDagar = summering.flatMap(t => t.dagar.map(d => d.datum));
  const forsta = allaDagar.length ? allaDagar.reduce((a, b) => (a < b ? a : b)) : null;
  const franEff = fran || forsta || idagIso;
  const tillEff = (till || idagIso) < franEff ? franEff : (till || idagIso);
  const period = `${franEff} – ${tillEff}`;
  const klocka = iso => new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const h2 = ms => Math.round(ms / 36000) / 100;
  const r2 = h => Math.round(h * 100) / 100;

  const wb = utils.book_new();
  const upptagna = new Set();

  const wsS = utils.json_to_sheet(personer.map(p => {
    const t = summering.find(x => x.userId === p.id);
    return {
      'Person': p.namn, 'Period': period,
      'Arbetsdagar': t ? t.arbetsdagar : 0, 'Sjukdagar': t ? t.sjukdagar : 0, 'VAB': t ? t.vabdagar : 0, 'Semester': t ? t.semesterdagar : 0,
      'Brutto': t ? r2(t.brutto) : 0, 'Lunch': t ? r2(t.lunch) : 0, 'Timmar': t ? r2(t.timmar) : 0,
    };
  }));
  wsS['!cols'] = [{ wch: 22 }, { wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 6 }, { wch: 9 }, { wch: 8 }, { wch: 8 }, { wch: 8 }];
  stilaRad(wsS, 0, 9, STIL.rubrik);
  utils.book_append_sheet(wb, wsS, excelBladNamn('Summering', upptagna));

  for (const p of personer) {
    const t = summering.find(x => x.userId === p.id);
    const perDatum = new Map((t ? t.dagar : []).map(d => [d.datum, d]));
    const rader = [
      ['Person', p.namn], ['Period', period],
      ['Lunch', '1 h dras per dag (sjuk/VAB/semester räknas som 07–16 = 8 h)'], [],
      KOLUMNER,
    ];
    const rubrikRad = rader.length - 1;
    const stilar = [];
    for (const datum of dagarMellan(franEff, tillEff)) {
      const d = perDatum.get(datum);
      const helgNamn = helgdagsnamn(datum);
      const v = veckodagIndex(datum);
      const helg = v === 0 || v === 6 || !!helgNamn;
      const typ = d ? (d.typ || 'Arbete') : (helgNamn || (helg ? 'Helg' : ''));
      rader.push([
        datum, veckodagKort(datum),
        d ? klocka(d.forstaIn) : '', d ? klocka(d.sistaUt) : '',
        d ? h2(d.ms) : '', d ? h2(d.lunchMs) : '', d ? h2(d.nettoMs) : '',
        d && helgNamn ? `${typ} (${helgNamn})` : typ,
        d && !d.typ ? [...d.omraden].join(', ') : '',
        d && !d.typ ? [...d.kunder].join(', ') : '',
      ]);
      if (helg) stilar.push([rader.length - 1, STIL.helg]);
      else if (d && d.typ) stilar.push([rader.length - 1, STIL.franvaro]);
    }
    rader.push([]);
    const summaRad = rader.length;
    rader.push(['Summa', `${t ? t.arbetsdagar : 0} arbetsdagar`, '', '', t ? r2(t.brutto) : 0, t ? r2(t.lunch) : 0, t ? r2(t.timmar) : 0]);
    rader.push(['Sjukdagar', t ? t.sjukdagar : 0]);
    rader.push(['VAB', t ? t.vabdagar : 0]);
    rader.push(['Semester', t ? t.semesterdagar : 0]);
    const ws = utils.aoa_to_sheet(rader);
    ws['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 26 }, { wch: 16 }, { wch: 28 }];
    stilaRad(ws, rubrikRad, KOLUMNER.length, STIL.rubrik);
    for (const [r, s] of stilar) stilaRad(ws, r, KOLUMNER.length, s);
    stilaRad(ws, summaRad, 7, STIL.summa);
    utils.book_append_sheet(wb, ws, excelBladNamn(p.namn, upptagna));
  }
  return { wb, period, franEff, tillEff };
}

module.exports = { byggStamplingArbetsbok, excelBladNamn, FRANVARO_TYPER, STIL, KOLUMNER };
