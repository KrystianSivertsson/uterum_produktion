// Svenska helger: lördag/söndag, röda dagar och de aftnar som i praktiken är
// lediga (midsommar-, jul- och nyårsafton). CommonJS så att både servern
// (require) och Expo-appen (Metro) kan dela exakt samma regler.
// Datum hanteras som 'ÅÅÅÅ-MM-DD'-strängar via UTC, oberoende av tidszon.

function pad2(n) { return String(n).padStart(2, '0'); }
function isoDatum(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function franIso(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function plusDagar(d, n) { return new Date(d.getTime() + n * 86400000); }

// Påskdagen (gregoriansk, Meeus/Jones/Butcher).
function paskdagen(ar) {
  const a = ar % 19, b = Math.floor(ar / 100), c = ar % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const manad = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ar, manad - 1, dag));
}

// Första lördagen från och med ett datum.
function lordagFran(ar, manad, dag) {
  for (let d = new Date(Date.UTC(ar, manad - 1, dag)); ; d = plusDagar(d, 1)) if (d.getUTCDay() === 6) return d;
}

// Map 'ÅÅÅÅ-MM-DD' → namn för ett år.
function svenskaHelgdagar(ar) {
  const p = paskdagen(ar);
  const midsommardagen = lordagFran(ar, 6, 20);     // lördag 20–26 juni
  const allaHelgonsDag = lordagFran(ar, 10, 31);    // lördag 31 okt–6 nov
  return new Map([
    [`${ar}-01-01`, 'Nyårsdagen'],
    [`${ar}-01-06`, 'Trettondedag jul'],
    [isoDatum(plusDagar(p, -2)), 'Långfredagen'],
    [isoDatum(p), 'Påskdagen'],
    [isoDatum(plusDagar(p, 1)), 'Annandag påsk'],
    [`${ar}-05-01`, 'Första maj'],
    [isoDatum(plusDagar(p, 39)), 'Kristi himmelsfärdsdag'],
    [isoDatum(plusDagar(p, 49)), 'Pingstdagen'],
    [`${ar}-06-06`, 'Nationaldagen'],
    [isoDatum(plusDagar(midsommardagen, -1)), 'Midsommarafton'],
    [isoDatum(midsommardagen), 'Midsommardagen'],
    [isoDatum(allaHelgonsDag), 'Alla helgons dag'],
    [`${ar}-12-24`, 'Julafton'],
    [`${ar}-12-25`, 'Juldagen'],
    [`${ar}-12-26`, 'Annandag jul'],
    [`${ar}-12-31`, 'Nyårsafton'],
  ]);
}

const cache = new Map();
function helgdagsnamn(iso) {
  const ar = Number(String(iso).slice(0, 4));
  if (!cache.has(ar)) cache.set(ar, svenskaHelgdagar(ar));
  return cache.get(ar).get(iso) || null;
}

const VECKODAGAR = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];
function veckodagIndex(iso) { return franIso(iso).getUTCDay(); }   // 0 = söndag
function veckodagKort(iso) { return VECKODAGAR[veckodagIndex(iso)]; }
function arVeckoslut(iso) { const v = veckodagIndex(iso); return v === 0 || v === 6; }
// Helg = lördag, söndag, röd dag eller ledig afton.
function arHelg(iso) { return arVeckoslut(iso) || !!helgdagsnamn(iso); }

// Alla datum från och med fran till och med till (inklusive), i ordning.
function dagarMellan(fran, till) {
  const ut = [];
  for (let d = franIso(fran), slut = franIso(till); d <= slut; d = plusDagar(d, 1)) ut.push(isoDatum(d));
  return ut;
}

module.exports = { svenskaHelgdagar, helgdagsnamn, veckodagKort, veckodagIndex, arVeckoslut, arHelg, dagarMellan, paskdagen, isoDatum };
