// Samlar facit-par (NCW som NC-X fick + AUF som NC-X skrev) ur AUF-kedjans
// jobbmappar och eluCads egen output-mapp, unika per NCW (SHA-256).
// node bygg-facit.mjs  → par/<nr>_<namn>/{in.ncw, facit.auf, meta.json} + index.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HAR = path.dirname(fileURLToPath(import.meta.url));
const UT = path.join(HAR, 'par');
const KALLOR = [
  path.join(process.env.APPDATA, 'uterum-handerna', 'auf'),
  'C:/elusoft/eluCad 4.0/user/output/SBZ151-2008-7m',
];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const par = [];
// 1) AUF-kedjans jobbmappar: en NCW + en AUF per mapp
const jobb = KALLOR[0];
for (const d of fs.existsSync(jobb) ? fs.readdirSync(jobb) : []) {
  const mapp = path.join(jobb, d);
  if (!fs.statSync(mapp).isDirectory()) continue;
  const filer = fs.readdirSync(mapp);
  const ncw = filer.find((f) => /\.ncw$/i.test(f));
  const auf = filer.find((f) => /\.auf$/i.test(f));
  if (!ncw || !auf || fs.statSync(path.join(mapp, auf)).size < 100) continue;
  let args = null;
  try { args = JSON.parse(fs.readFileSync(path.join(mapp, 'ncx-args.json'), 'utf8')); } catch { /* äldre mapp */ }
  par.push({ kalla: 'kedjan', mapp, ncw: path.join(mapp, ncw), auf: path.join(mapp, auf), args, tid: fs.statSync(path.join(mapp, auf)).mtime.toISOString() });
}
// 2) eluCads egen output (GUI-körningar): <namn>.ncw + <namn>.auf
const elu = KALLOR[1];
for (const f of fs.existsSync(elu) ? fs.readdirSync(elu) : []) {
  if (!/\.ncw$/i.test(f)) continue;
  const auf = path.join(elu, f.replace(/\.ncw$/i, '.auf'));
  if (!fs.existsSync(auf) || fs.statSync(auf).size < 100) continue;
  // GUI-paret räknas bara om AUF:en skrevs efter NCW:n (samma körning)
  const tN = fs.statSync(path.join(elu, f)).mtimeMs, tA = fs.statSync(auf).mtimeMs;
  if (tA < tN || tA - tN > 10 * 60_000) continue;
  par.push({ kalla: 'elucad', mapp: elu, ncw: path.join(elu, f), auf, args: null, tid: new Date(tA).toISOString() });
}

fs.mkdirSync(UT, { recursive: true });
const sedda = new Map();
const index = [];
for (const p of par.sort((a, b) => a.tid.localeCompare(b.tid))) {
  const ncwBuf = fs.readFileSync(p.ncw), aufBuf = fs.readFileSync(p.auf);
  const nSha = sha(ncwBuf), aSha = sha(aufBuf);
  const pp = (p.args || []).find((a) => /^p1?=/.test(a))?.replace(/^p1?=/, '') || null;
  if (sedda.has(nSha)) { sedda.get(nSha).dubbletter.push({ kalla: p.kalla, tid: p.tid, aufSha: aSha }); continue; }
  const namn = path.basename(p.ncw).replace(/\.ncw$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const nr = String(index.length + 1).padStart(3, '0');
  const dir = path.join(UT, `${nr}_${namn}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'in.ncw'), ncwBuf);
  fs.writeFileSync(path.join(dir, 'facit.auf'), aufBuf);
  const rad = { nr, namn, dir: path.relative(HAR, dir), kalla: p.kalla, kallMapp: p.mapp, tid: p.tid, ncwSha: nSha, aufSha: aSha, pp, dubbletter: [] };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(rad, null, 1));
  sedda.set(nSha, rad);
  index.push(rad);
}
fs.writeFileSync(path.join(HAR, 'index.json'), JSON.stringify(index, null, 1));
const olikaAuf = index.filter((r) => r.dubbletter.some((d) => d.aufSha !== r.aufSha));
console.log(`${par.length} par hittade → ${index.length} unika NCW (${index.filter((r) => r.kalla === 'elucad').length} från eluCads GUI)`);
console.log(`samma NCW men olika AUF mellan körningar: ${olikaAuf.length} (${olikaAuf.slice(0, 5).map((r) => r.nr).join(', ')})`);
const perPp = {};
for (const r of index) perPp[r.pp || '(okänd)'] = (perPp[r.pp || '(okänd)'] || 0) + 1;
console.log('efterbehandlare:', perPp);
