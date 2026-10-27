// Jämför en egen efterbehandlare mot NC-X-facit (par/*/in.ncw → facit.auf).
//
//   npx tsx jamfor.mjs <modul> [--filter <text>] [--max <n>] [--visa <n>]
//
// <modul> exporterar ncwTillAuf(ncwText) → aufText (latin1-strängar). Varje AUF
// delas i program (rader som börjar med "%") och jämförs rad för rad efter att
// de flyktiga raderna maskats (program-ID, DATE, PP-RUN, Label Date/Time —
// de enda raderna som skiljer två NC-X-körningar på samma NCW).
// Utdata: andel identiska program/par + vanligaste FÖRSTA skillnaden, och
// rapport.json med varje programs första avvikelse.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HAR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flagga = (n, std = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : std; };
const modulFil = args.find((a, i) => !a.startsWith('--') && !['--filter', '--max', '--visa'].includes(args[i - 1]));
if (!modulFil) { console.error('ange modulen: npx tsx jamfor.mjs <modul.ts>'); process.exit(2); }
const filter = flagga('--filter'), max = Number(flagga('--max', '0')) || Infinity, visa = Number(flagga('--visa', '15'));

const { ncwTillAuf } = await import(pathToFileURL(path.resolve(modulFil)).href);
const index = JSON.parse(fs.readFileSync(path.join(HAR, 'index.json'), 'utf8'));

export function maskera(rad) {
  return rad
    .replace(/(\(ID .*_)\d{10,}\)/, '$1#)')
    .replace(/^\((DATE|PP-RUN)(\s*:\s*)[^;]*;[^)]*/, '($1$2#')
    .replace(/^\((#Label\w*?(?:Date|Time)\s*:\s*)[^)\s]*/, '($1#');
}
export function program(text) {
  const rader = text.split(/\r?\n/).map(maskera);
  const ut = [];
  for (const r of rader) {
    if (r.startsWith('%') || !ut.length) ut.push({ id: r, rader: [] });
    ut[ut.length - 1].rader.push(r);
  }
  return ut;
}
const typ = (r) => (r ?? '<slut>').replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 70);

const rapport = [];
let par = 0, parOk = 0, prog = 0, progOk = 0, rader = 0, raderOk = 0, kastade = 0;
const forsta = new Map();
for (const r of index) {
  if (filter && !new RegExp(filter, 'i').test(r.namn)) continue;
  if (par >= max) break;
  par++;
  const dir = path.join(HAR, r.dir);
  const ncw = fs.readFileSync(path.join(dir, 'in.ncw'), 'latin1');
  const facit = program(fs.readFileSync(path.join(dir, 'facit.auf'), 'latin1'));
  let egen;
  try { egen = program(String(await ncwTillAuf(ncw, { dir, namn: r.namn }))); }
  catch (e) { kastade++; rapport.push({ nr: r.nr, namn: r.namn, fel: String(e?.stack || e).split('\n').slice(0, 3).join(' | ') }); prog += facit.length; continue; }
  let alla = true;
  const progRapport = [];
  facit.forEach((f, i) => {
    prog++;
    const e = egen[i]?.rader ?? [];
    let d = -1;
    for (let k = 0; k < Math.max(f.rader.length, e.length); k++) if (f.rader[k] !== e[k]) { d = k; break; }
    rader += f.rader.length;
    raderOk += d < 0 ? f.rader.length : d;
    if (d < 0) { progOk++; return; }
    alla = false;
    const t = typ(f.rader[d]);
    forsta.set(t, (forsta.get(t) || 0) + 1);
    progRapport.push({ program: i + 1, rad: d + 1, facit: f.rader[d] ?? '<slut>', egen: e[d] ?? '<slut>', fore: f.rader.slice(Math.max(0, d - 3), d) });
  });
  if (egen.length !== facit.length) alla = false;
  if (alla) parOk++;
  rapport.push({ nr: r.nr, namn: r.namn, program: facit.length, egnaProgram: egen.length, avvikelser: progRapport });
}
fs.writeFileSync(path.join(HAR, 'rapport.json'), JSON.stringify(rapport, null, 1));
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '0') + ' %';
console.log(`par ${parOk}/${par} identiska (${pct(parOk, par)}), program ${progOk}/${prog} (${pct(progOk, prog)}), rader före första fel ${pct(raderOk, rader)}${kastade ? `, ${kastade} kastade fel` : ''}`);
console.log('vanligaste första skillnaden (facit-raden):');
for (const [t, n] of [...forsta].sort((a, b) => b[1] - a[1]).slice(0, visa)) console.log(String(n).padStart(6), ' ', t);
