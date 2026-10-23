/**
 * auf-auto.mjs — AUF AUTOMATISKT ur kundmappens ECW:er (Krystian 2026-10-23
 * "auf filer auto direkt till lagersystemet inte bara u").
 *
 * U-synken (sync-u.mjs) anropar aufForMapp() efter varje kundmapp. Varje ECW i
 * U:\<kund>\ som är ny eller ändrad sedan förra AUF:en körs genom Onyx AUF-
 * kedja (uterum-konfigurator/tools/handerna/auf: ECW → NCW → eluCads egen
 * efterbehandlare ncx, med alla spärrar i vakt.mjs — inget skickas någonsin
 * till maskinen). Det är ECW:n SOM LIGGER I U som gäller, även när den är
 * handredigerad i eluCad. AUF:en hamnar i U:\<kund>\AUF (Onyx)\ (som Onyx-
 * jobben) OCH laddas upp till kundkortet i lagret (/api/auf-filer).
 *
 *   • Bara ECW:er ändrade efter aufFran (standard 2026-10-15) får en NY AUF —
 *     gamla ordrar lämnas i fred. En AUF som redan ligger i AUF (Onyx) och är
 *     nyare än ECW:n tas som den är och laddas upp.
 *   • En ändrad ECW ersätter sin förra AUF bara om den förra är kedjans egen och
 *     orörd (manifestet, eller Onyx-sidovagnen .txt); annars <namn>_2.auf.
 *   • Högst MAX_PER_RUNDA nya AUF per synkrunda så live-synken inte står still.
 *   • Fel (t.ex. ECW som konverteraren vägrar) loggas en gång och provas igen
 *     först när ECW:n ändras.
 *
 * Av: "auf": false i sync-u.config.json. Annan sökväg till kedjan: "aufKedja".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HAR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HAR, 'auf-auto-manifest.json');
const STANDARD_KEDJA = path.resolve(HAR, '..', '..', 'uterum-konfigurator', 'tools', 'handerna', 'auf');
export const STANDARD_FRAN = '2026-10-15';
export const MAX_PER_RUNDA = 8;
const MIN_ALDER_MS = 15_000;          // ECW:n ska stå still (synken/eluCad skriver kanske)

const tid = () => new Date().toLocaleTimeString('sv-SE');

let kedja = null;
let kedjaFel = null;
/** Laddar AUF-kedjan en gång (index.mjs + vakt.mjs). null om den saknas — loggas en gång. */
async function laddaKedja(mapp) {
  if (kedja || kedjaFel) return kedja;
  try {
    const index = await import(pathToFileURL(path.join(mapp, 'index.mjs')).href);
    const vakt = await import(pathToFileURL(path.join(mapp, 'vakt.mjs')).href);
    kedja = { ...index, maskinUppsattning: vakt.maskinUppsattning };
  } catch (e) {
    kedjaFel = e.message;
    console.warn(`[${tid()}] AUF-kedjan kunde inte laddas (${mapp}): ${e.message.split('\n')[0]} — inga AUF görs`);
  }
  return kedja;
}

function laesManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}
function sparaManifest(m) {
  try { fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1)); } catch (e) { console.warn('auf-manifestet kunde inte sparas:', e.message); }
}

/** Kundkortet AUF:en hör till: det som har ECW:n (nyaste), annars mappens nyaste kort. */
export function projektFor(ecwNamn, poster) {
  const nyast = (a, b) => String(b.f?.skapad || '').localeCompare(String(a.f?.skapad || ''));
  const exakt = poster.filter((p) => p.typ?.slug === 'ecw-filer' && String(p.f?.filename || '').toLowerCase() === ecwNamn.toLowerCase()).sort(nyast)[0];
  return (exakt || [...poster].sort(nyast)[0])?.projektId ?? null;
}

/** Får en ny AUF ersätta den som ligger där? Bara kedjans egen, orörda. */
export function arEgenAuf(aufFil, m) {
  if (!fs.existsSync(aufFil)) return true;
  if (m?.aufSize != null) {
    const st = fs.statSync(aufFil);
    return st.size === m.aufSize && Math.abs(st.mtimeMs - m.aufMtimeMs) < 2000;
  }
  try { return /Skapad av Onyx/.test(fs.readFileSync(aufFil.replace(/\.auf$/i, '.txt'), 'utf8')); } catch { return false; }
}

async function laddaUpp({ bas, H, projektId, mapp, rad }) {
  const r = await fetch(`${bas}/api/auf-filer/${encodeURIComponent(projektId)}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: mapp, filename: path.basename(rad.aufFil),
      aufBase64: fs.readFileSync(rad.aufFil).toString('base64'),
      ecw: rad.ecw, ecwSha256: rad.ecwSha || null, info: rad.info || null,
    }),
  });
  if (!r.ok) throw new Error(`lagret svarade ${r.status}`);
}

/**
 * AUF för en kundmapp. budget = { kvar } delas över hela synkrundan.
 * @returns {{ gjorda: number, uppladdade: number }}
 */
export async function aufForMapp({ mapp, mal, poster, bas, H, cfg = {}, budget = { kvar: MAX_PER_RUNDA } }) {
  if (cfg.auf === false || !fs.existsSync(mal)) return { gjorda: 0, uppladdade: 0 };
  const k = await laddaKedja(cfg.aufKedja || process.env.UTERUM_AUF_KEDJA || STANDARD_KEDJA);
  if (!k) return { gjorda: 0, uppladdade: 0 };
  const fran = Date.parse(cfg.aufFran || STANDARD_FRAN);
  const manifest = laesManifest();
  const utDir = path.join(mal, k.UT_UNDERMAPP || 'AUF (Onyx)');
  let andrat = false, gjorda = 0, uppladdade = 0, upps = null;

  // Ny rad sparas alltid i manifestet; uppladdningen provas tills den gått.
  const upp = async (nyckel, rad) => {
    if (manifest[nyckel] !== rad) { manifest[nyckel] = rad; andrat = true; }
    const projektId = projektFor(rad.ecw, poster);
    if (!projektId || rad.uppladdad === projektId) return;
    try {
      await laddaUpp({ bas, H, projektId, mapp, rad });
      rad.uppladdad = projektId;
      delete rad.uppFel;
      uppladdade++;
      console.log(`[${tid()}] ${mapp}  AUF → lagret: ${path.basename(rad.aufFil)}`);
    } catch (e) {
      if (!rad.uppFel) console.warn(`[${tid()}] ${mapp}  AUF ${path.basename(rad.aufFil)} kunde inte laddas upp (${e.message}) — försöker igen`);
      rad.uppFel = e.message;
    }
    andrat = true;
  };

  for (const ecwFil of k.listaEcw(mal)) {
    const ecwNamn = path.basename(ecwFil);
    const namn = ecwNamn.replace(/\.ecw$/i, '');
    const nyckel = `${mapp}/${ecwNamn}`.toLowerCase();
    let st;
    try { st = fs.statSync(ecwFil); } catch { continue; }
    const m = manifest[nyckel];
    if (m && m.size === st.size && Math.abs(m.mtimeMs - st.mtimeMs) < 2000) {
      if (m.aufFil && fs.existsSync(m.aufFil)) await upp(nyckel, m);   // uppladdningen kan ha fallerat förra gången
      continue;
    }
    if (Date.now() - st.mtimeMs < MIN_ALDER_MS) continue;
    const aufFil = path.join(utDir, `${namn}.auf`);

    // Redan gjord (Onyx-jobb) och nyare än ECW:n → ta den som den är.
    if (!m && fs.existsSync(aufFil) && fs.statSync(aufFil).mtimeMs >= st.mtimeMs) {
      const ast = fs.statSync(aufFil);
      await upp(nyckel, { size: st.size, mtimeMs: st.mtimeMs, ecw: ecwNamn, aufFil, aufSize: ast.size, aufMtimeMs: ast.mtimeMs, fanns: true });
      continue;
    }
    if (st.mtimeMs < fran) continue;            // gammal order — ingen ny AUF
    if (budget.kvar <= 0) break;                // resten nästa runda
    budget.kvar--;

    try {
      upps ??= k.maskinUppsattning();           // spärrarna först — fel här stoppar AUF:erna
    } catch (e) {
      console.warn(`[${tid()}] AUF stoppad av spärren: ${e.message.split('\n')[0]}`);
      budget.kvar = 0;
      break;
    }
    let r;
    try { r = await k.skapaAuf(ecwFil, { upps, utDir, ersatt: arEgenAuf(aufFil, m) }); }
    catch (e) { r = { ok: false, fel: [e.message.split('\n')[0]] }; }
    if (!r.ok) {
      const fel = (r.fel || ['okänt fel']).join('; ').slice(0, 300);
      if (m?.fel !== fel) console.warn(`[${tid()}] ${mapp}  AUF ✗ ${ecwNamn}: ${fel}`);
      manifest[nyckel] = { size: st.size, mtimeMs: st.mtimeMs, ecw: ecwNamn, fel };
      andrat = true;
      continue;
    }
    const ast = fs.statSync(r.aufFil);
    const varn = (r.varningar?.length || 0);
    const info = varn ? `NC-X: ${varn} varning(ar) — se ${path.basename(r.aufFil).replace(/\.auf$/i, '.txt')} i U` : null;
    console.log(`[${tid()}] ${mapp}  AUF ✓ ${path.basename(r.aufFil)}${varn ? ` (${varn} varning(ar))` : ''}`);
    gjorda++;
    await upp(nyckel, { size: st.size, mtimeMs: st.mtimeMs, ecw: ecwNamn, aufFil: r.aufFil, aufSize: ast.size, aufMtimeMs: ast.mtimeMs, ecwSha: r.ecwSha, info });
  }
  if (andrat) sparaManifest(manifest);
  return { gjorda, uppladdade };
}
