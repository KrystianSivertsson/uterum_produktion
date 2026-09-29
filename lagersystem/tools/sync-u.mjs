/**
 * sync-u.mjs — speglar AKTIVERADE kunders filer till U:\<kundnamn>\
 *
 * Varför ett verktyg och inte servern: lagersystemet kör på three.nordiska.io
 * (Linux) och når inte U:\ — den är en Windows-utdelning som bara kontorets
 * datorer har mappad. Synken måste därför köras HÄR, från en dator med U:\.
 *
 * Aktiverad = kunden har minst en fil på kortet (samma regel som lagret
 * filtrerar på). Mappen får kundens för- och efternamn utan ordernummer och
 * utan v2/v3-suffix, så revisioner av samma kund hamnar i SAMMA mapp.
 *
 * Kör:  node tools/sync-u.mjs            (eller dubbelklicka sync-u.bat)
 *       node tools/sync-u.mjs --torr     visar vad som skulle hämtas
 *
 * Inloggning läses ur miljövariabler eller tools/sync-u.config.json:
 *   { "url": "https://three.nordiska.io/UterumLager",
 *     "user": "...", "pass": "...", "mal": "U:\\" }
 * Config-filen är gitignore:ad — lösenord ska inte checkas in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HAR = path.dirname(fileURLToPath(import.meta.url));
const TORR = process.argv.includes('--torr');

// Vissa dokument (ASS32-profilbladet, träkonstruktionen) skickas till lagret
// som HTML — de är byggda för webbläsarens "Spara som PDF". I kundmappen vill
// vi ha riktig PDF, så de renderas med Chrome/Edge i headless-läge.
const WEBBLASARE = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p)) || null;

/**
 * HTML → PDF bredvid originalet. Returnerar PDF-sökvägen, eller null om
 * ingen webbläsare finns eller renderingen gick fel (då behålls HTML:en).
 */
export function htmlTillPdf(htmlSokvag) {
  if (!WEBBLASARE) return null;
  const pdf = htmlSokvag.replace(/\.html?$/i, '.pdf');
  const url = 'file:///' + htmlSokvag.replace(/\\/g, '/');
  try {
    execFileSync(WEBBLASARE, [
      '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
      `--print-to-pdf=${pdf}`, url,
    ], { timeout: 180000, stdio: 'ignore' });
    return fs.existsSync(pdf) && fs.statSync(pdf).size > 0 ? pdf : null;
  } catch {
    return null;
  }
}

function laesKonfig() {
  const fil = path.join(HAR, 'sync-u.config.json');
  const fran = fs.existsSync(fil) ? JSON.parse(fs.readFileSync(fil, 'utf8')) : {};
  const cfg = {
    url: process.env.LAGER_URL || fran.url || 'https://three.nordiska.io/UterumLager',
    user: process.env.LAGER_USER || fran.user,
    pass: process.env.LAGER_PASS || fran.pass,
    mal: process.env.U_ROOT || fran.mal || 'U:\\',
  };
  if (!cfg.user || !cfg.pass) {
    console.error('Saknar inloggning. Skapa tools/sync-u.config.json:\n'
      + '  { "user": "ditt-anvandarnamn", "pass": "ditt-losenord" }\n'
      + 'eller sätt LAGER_USER / LAGER_PASS som miljövariabler.');
    process.exit(1);
  }
  return cfg;
}

/**
 * Kundnamn → mappnamn: bara för- och efternamn.
 * Ordernummer ("1054128 Fredrik Anfelter") och revisioner ("… v2", "v3")
 * skalas bort så alla versioner av en kund delar mapp.
 */
export function mappNamn(namn) {
  return String(namn || '')
    .replace(/^[\s\d._-]+/, '')                 // ledande ordernummer
    .replace(/[\s_-]*\bv\.?\s*\d+\s*$/i, '')    // v2 / v3 / V 2 i slutet
    .replace(/[<>:"/\\|?*]+/g, ' ')             // otillåtna tecken i Windows-mappnamn
    .replace(/\s+/g, ' ')
    .trim();
}

const TYPER = [
  { slug: 'ecw-filer', andelse: '.ECW', ladda: (id, f) => `${id}/${f.id}/ladda-ner` },
  { slug: 'btl-filer', andelse: '.btl', ladda: (id, f) => `${id}/${f.id}/ladda-ner` },
  { slug: 'step-filer', andelse: '.zip', ladda: (id, f) => `${id}/${f.id}/ladda-ner` },
  { slug: 'pdf-filer', andelse: '.pdf', ladda: (id, f) => `${id}/${f.id}/visa` },
];

/** PDF:erna sparas utan ändelse i lagret — lägg på typens om den saknas. */
function medAndelse(filnamn, typ) {
  const n = String(filnamn || '').trim() || 'fil';
  return /\.[A-Za-z0-9]{2,4}$/.test(n) ? n : n + typ.andelse;
}

/** Namnet filen får i kundmappen (HTML-dokument renderas till PDF). */
function lokaltNamn(namn) {
  return /\.html?$/i.test(namn) ? namn.replace(/\.html?$/i, '.pdf') : namn;
}

/** Filtyp ur en lokal fils ändelse (för att känna igen gamla versioner i mappen). */
function typForLokal(namn) {
  const ext = (String(namn).match(/\.([A-Za-z0-9]{2,4})$/)?.[1] || '').toLowerCase();
  if (ext === 'ecw') return TYPER[0];
  if (ext === 'btl') return TYPER[1];
  if (ext === 'zip') return TYPER[2];
  if (ext === 'pdf' || ext === 'html' || ext === 'htm') return TYPER[3];
  return null;
}

// OBS: NEST hör INTE hit. Generatorns nästade ytterkarm (…_outer_frame_NEST_
// FLIP_SAW.ECW, outerFrameNest 'extra') ligger BREDVID den vanliga filen och
// måste ha egen dokumentnyckel — annars raderar synken den ena. Läggs till
// först om generatorn går över till 'replace' (då ska den gamla vanliga bort).
const VARIANT = /(?:[_ -](?:REF|FLIP|SAW|FR))+$/i;
// …men NEST gäller bara tillsammans med den vanliga karmfilen från SAMMA
// export (båda pushas i samma anrop, sekunder isär). Är den vanliga nyare än
// så gav en senare export ingen NEST (klämvarning, X-gräns, utan sågkap) och
// den gamla NEST-filen har gamla mått: den hämtas inte och tas bort ur
// kundmappen med den vanliga filen som ersattAv.
const NEST_NYCKEL = / nest$/;
export const NEST_TOLERANS_MS = 10000;
const TIDSSTAMPEL = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Generatorns varianter i ett filnamn: _SAW = sågkapen med, _REF = testläge. */
export function variantAv(filnamn) {
  const n = String(filnamn || '').trim().replace(/\.[A-Za-z0-9]{2,4}$/, '');
  const v = (n.match(VARIANT)?.[0] || '').toUpperCase();
  return { saw: /SAW/.test(v), ref: /REF/.test(v) };
}

/** Tidsstämpeln i ett genererat filnamn (ms), eller null. */
function namnTid(namn) {
  const m = TIDSSTAMPEL.exec(String(namn));
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/**
 * Dokumentnyckel: alla versioner och varianter av SAMMA dokument ger samma
 * nyckel, så bara den nyaste hamnar i kundmappen (Krystian 2026-09-29: "den
 * ska ju ta bort auto när det kommer en ny"). Skalar bort:
 *   • ändelse (PDF:er saknar ofta ändelse i lagret; .html renderas till .pdf)
 *   • tidsstämpel  2d-vyer-2026-09-29T17-33-08 → 2d-vyer
 *   • generatorns varianter  _REF/_FLIP/_SAW/_FR  (…outer_frame_FLIP_SAW → …outer_frame)
 *     — _NEST (nästad ytterkarm) är ett EGET dokument och skalas inte bort
 *   • kundens namn med ordernummer/v2 i början → {kund}
 *     ("Miranda Jensen v2", "Miranda_Jensen_FLIP_SAW", "1054209_Fredrik_Eriksson_v2_ASS32")
 */
export function dokNyckel(filnamn, typ, mapp) {
  let n = String(filnamn || '').trim().replace(/\.[A-Za-z0-9]{2,4}$/, '');
  n = n.replace(/[-_ ]?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:[-.]\d+)?Z?/g, '');
  n = n.replace(VARIANT, '');
  n = n.replace(/[_\s]+/g, ' ').trim().toLowerCase();
  if (mapp) {
    const kund = new RegExp(`^(?:\\d[\\d._-]*\\s+)?${escRe(String(mapp).toLowerCase())}(?:\\s+v\\.?\\s*\\d+)?(?=\\s|$)`);
    n = n.replace(kund, '{kund}');
  }
  return `${typ.slug}:${n}`;
}

/**
 * Samma dokument sparas om vid varje körning i lagret (Ferdi Kilic har 244
 * ECW-poster), med nya namn (tidsstämplar, _FLIP_SAW) och ibland på flera
 * kundkort (Miranda Jensen + Miranda Jensen v2 → samma mapp). Kundmappen ska
 * spegla det AKTUELLA läget: den nyaste versionen per dokument. Undantag som
 * alltid behålls bredvid: den nyaste _SAW-varianten när den nyaste filen
 * saknar sågkapen, och den nyaste produktionsfilen när den nyaste är _REF.
 * @returns {Map<string, {namn, nyckel, typ, f, projektId, behall: object[]}>}
 */
export function nyastePerDokument(poster, mapp) {
  const perNyckel = new Map();
  for (const p of poster) {
    const namn = medAndelse(p.f.filename, p.typ);
    const nyckel = dokNyckel(namn, p.typ, mapp);
    if (!perNyckel.has(nyckel)) perNyckel.set(nyckel, []);
    perNyckel.get(nyckel).push({ ...p, namn, nyckel, variant: variantAv(namn), tid: new Date(p.f.skapad || 0).getTime() });
  }
  const ut = new Map();
  for (const [nyckel, lista] of perNyckel) {
    lista.sort((a, b) => b.tid - a.tid);
    const akt = lista[0];
    const behall = [akt];
    if (!akt.variant.saw) {
      const saw = lista.find((x) => x.variant.saw);
      if (saw) behall.push(saw);
    }
    if (akt.variant.ref) {
      const prod = lista.find((x) => !x.variant.ref);
      if (prod && !behall.includes(prod)) behall.push(prod);
    }
    ut.set(nyckel, { ...akt, behall });
  }
  for (const [nyckel, a] of [...ut]) {
    if (!NEST_NYCKEL.test(nyckel)) continue;
    const vanlig = ut.get(nyckel.replace(NEST_NYCKEL, ''));
    if (vanlig && a.tid < vanlig.tid - NEST_TOLERANS_MS) ut.delete(nyckel);   // inaktuell NEST
  }
  return ut;
}

// Kundmappar synken ALDRIG rör, varken skriver eller tar bort i (U:\Laghem =
// handgjorda test-BTL:er som aldrig får skrivas över eller raderas).
// Utökas i sync-u.config.json med "skyddade": ["…"].
const SKYDDADE = ['Laghem'];

/**
 * Äldre versioner i kundmappen som ska bort. En fil tas bort bara om ALLT gäller:
 *   • samma dokumentnyckel som en aktuell fil men annat namn, och de aktuella
 *     filerna ligger FÄRSKA i mappen (ofarsk() = saknas eller äldre än lagret)
 *   • den är inte öppen (eluCad/Office lägger ~$<namn> bredvid — eluCad låser
 *     inte filen själv, så låsfilen är enda tecknet)
 *   • den är synkens egen: i manifestet och oförändrad sedan synken skrev den,
 *     eller (filer från före manifestet) namnet finns i lagrets historik för
 *     mappen eller är ett genererat namn med tidsstämpel ÄLDRE än den aktuella
 *   • den är inte en _SAW-fil som skulle ersättas av en fil utan sågkap
 * Handplacerade och handredigerade filer rörs aldrig.
 */
export function gamlaVersioner(lokalaFiler, aktuella, historik, mapp, {
  ofarsk = () => false, manifest = null, andrad = () => false,
} = {}) {
  const lagt = new Set(lokalaFiler.map((x) => x.toLowerCase()));
  const ut = [];
  for (const namn of lokalaFiler) {
    if (namn.startsWith('~$')) continue;
    const typ = typForLokal(namn);
    if (!typ) continue;
    const nyckel = dokNyckel(namn, typ, mapp);
    // NEST utan aktuell NEST-post (inaktuell, eller struken ur lagret) ersätts
    // av den vanliga karmfilen — samma villkor som för andra gamla versioner.
    const akt = aktuella.get(nyckel) ?? (NEST_NYCKEL.test(nyckel) ? aktuella.get(nyckel.replace(NEST_NYCKEL, '')) : undefined);
    if (!akt) continue;
    const behall = akt.behall.map((b) => lokaltNamn(b.namn).toLowerCase());
    if (behall.includes(namn.toLowerCase())) continue;
    if (!behall.every((b) => lagt.has(b) && !ofarsk(b))) continue;       // nya finns/är inte färsk än
    if (lagt.has(`~$${namn}`.toLowerCase())) continue;                     // öppen
    const v = variantAv(namn);
    if (v.saw && !akt.behall.some((b) => b.variant.saw)) continue;
    const t = namnTid(namn);
    if (t !== null && t >= akt.tid - 1000) continue;                        // inte äldre än den aktuella
    const iManifest = manifest?.has?.(namn.toLowerCase());
    let egen;
    if (iManifest) egen = !andrad(namn);
    else egen = historik.has(namn.toLowerCase()) || t !== null;
    if (!egen) continue;
    ut.push({ namn, ersattAv: lokaltNamn(akt.namn) });
  }
  return ut;
}

/** Ordernumret i början av ett kundnamn ("1054128 Fredrik Anfelter"), annars ''. */
function ordernr(namn) {
  return /^\s*(\d{5,})/.exec(String(namn || ''))?.[1] || '';
}

// Manifest över filer synken själv skrivit (mapp/namn → storlek + mtime) —
// en fil som ändrats efteråt är handredigerad och tas aldrig bort.
const MANIFEST = path.join(HAR, 'sync-u-manifest.json');
function laesManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}
function sparaManifest(m) {
  try { fs.writeFileSync(MANIFEST, JSON.stringify(m)); } catch (e) { console.warn('manifestet kunde inte sparas:', e.message); }
}

/** Är den lokala filen en riktig PDF? (äldre körningar sparade HTML som .pdf) */
function arRiktigPdf(sokvag) {
  try {
    const fd = fs.openSync(sokvag, 'r');
    const b = Buffer.alloc(5);
    fs.readSync(fd, b, 0, 5, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === '%PDF-';
  } catch { return false; }
}

/**
 * En synk-runda. `tyst` loggar bara det som faktiskt hämtas — live-läget kör
 * varje minut och ska inte spamma loggen med "0 nya filer".
 */
export async function synkaEnGang({ tyst = false } = {}) {
  const cfg = laesKonfig();
  const bas = cfg.url.replace(/\/+$/, '');
  const skyddade = new Set([...SKYDDADE, ...(cfg.skyddade || [])].map((s) => String(s).toLowerCase()));
  const manifest = laesManifest();
  let manifestAndrat = false;

  const inlogg = await fetch(`${bas}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  });
  // Kasta (inte process.exit) — live-loopen fångar och försöker igen.
  if (!inlogg.ok) throw new Error(`Inloggning misslyckades: ${inlogg.status}`);
  const { token } = await inlogg.json();
  const H = { Authorization: `Bearer ${token}` };

  const kunder = await (await fetch(`${bas}/api/kunder`, { headers: H })).json();
  const aktiva = (Array.isArray(kunder) ? kunder : []).filter(k => k.aktiverad);
  if (!tyst) console.log(`${aktiva.length} aktiverade kunder (av ${kunder.length}) → ${cfg.mal}`);
  if (TORR) console.log('TORRKÖRNING — inget skrivs eller tas bort.\n');

  // Alla kundkort som hamnar i samma mapp (v2/v3) räknas ihop: nyaste
  // versionen per dokument vinner oavsett kort — men bara inom SAMMA order.
  const perMapp = new Map();
  for (const k of aktiva) {
    const mapp = mappNamn(k.namn);
    if (!mapp) { console.warn(`  hoppar över kund utan användbart namn (id ${k.id})`); continue; }
    if (!perMapp.has(mapp)) perMapp.set(mapp, []);
    perMapp.get(mapp).push(k);
  }

  let nya = 0, fanns = 0, mappar = 0, borttagna = 0;
  for (const [mapp, kort] of perMapp) {
    if (skyddade.has(mapp.toLowerCase())) {
      if (!tyst) console.log(`  ${mapp}: skyddad mapp — rörs inte`);
      continue;
    }
    const mal = path.join(cfg.mal, mapp);

    // Hämta listorna först — skapa inte tomma mappar för kunder utan filer.
    // Fallerar en lista hoppas mappen över helt i det här varvet: annars kan
    // ett äldre korts filer se "nyast" ut och den verkligt aktuella raderas.
    const poster = [];
    let ofullstandig = false;
    for (const k of kort) {
      const projektId = k.ase60ProjectId || k.id;
      for (const typ of TYPER) {
        try {
          const r = await fetch(`${bas}/api/${typ.slug}/${encodeURIComponent(projektId)}`, { headers: H });
          if (!r.ok) { if (r.status !== 404) ofullstandig = true; continue; }
          const lista = await r.json();
          if (!Array.isArray(lista)) { ofullstandig = true; continue; }
          for (const f of lista) poster.push({ typ, f, projektId, ordernr: ordernr(k.namn) });
        } catch { ofullstandig = true; }
      }
    }
    if (ofullstandig) { console.warn(`  ${mapp}: lagret svarade inte för alla listor — mappen hoppas över det här varvet`); continue; }
    if (!poster.length) continue;

    // Olika ordrar (olika ordernummer) i samma mapp ersätter aldrig varandra:
    // räkna aktuella per order och ta inte bort något mellan dem.
    const ordrar = [...new Set(poster.map((p) => p.ordernr).filter(Boolean))];
    const flerOrdrar = ordrar.length > 1;
    const grupper = flerOrdrar ? ordrar.map((o) => poster.filter((p) => p.ordernr === o || !p.ordernr)) : [poster];
    const historik = new Set(poster.flatMap((p) => {
      const n = medAndelse(p.f.filename, p.typ);
      return [n.toLowerCase(), lokaltNamn(n).toLowerCase()];
    }));
    const aktuellaPerGrupp = grupper.map((g) => nyastePerDokument(g, mapp));

    const ofarsk = (namn) => {
      for (const akt of aktuellaPerGrupp) {
        for (const a of akt.values()) {
          for (const b of a.behall) {
            if (lokaltNamn(b.namn).toLowerCase() !== namn.toLowerCase()) continue;
            const s = path.join(mal, lokaltNamn(b.namn));
            if (!fs.existsSync(s)) return true;
            if (fs.statSync(s).mtimeMs < b.tid) return true;
            if (/\.pdf$/i.test(s) && !arRiktigPdf(s)) return true;
            return false;
          }
        }
      }
      return false;
    };

    const attHamta = [];
    const sett = new Set();
    for (const akt of aktuellaPerGrupp) {
      for (const a of akt.values()) {
        for (const b of a.behall) {
          const lok = lokaltNamn(b.namn);
          if (sett.has(lok.toLowerCase())) continue;
          sett.add(lok.toLowerCase());
          // HTML-dokument renderas till PDF och HTML:en tas bort — kontrollera
          // därför PDF:en. Hoppa bara över om den lokala filen är minst lika ny
          // (och en riktig PDF) — annars ska mappen följa med lagret.
          if (!ofarsk(lok)) { fanns++; continue; }
          if (fs.existsSync(path.join(mal, `~$${lok}`)) || fs.existsSync(path.join(mal, `~$${b.namn}`))) {
            console.warn(`  ${mapp}\\${lok} är öppen — skrivs när den stängts`);
            continue;
          }
          attHamta.push({ ...b, dit: path.join(mal, b.namn) });
        }
      }
    }

    if (attHamta.length) {
      if (tyst) console.log(`[${new Date().toLocaleTimeString('sv-SE')}] ${mapp}  (+${attHamta.length})`);
      else console.log(`  ${mapp}  (+${attHamta.length})`);
      if (!TORR && !fs.existsSync(mal)) { fs.mkdirSync(mal, { recursive: true }); mappar++; }
    }
    for (let { typ, f, dit, projektId, namn } of attHamta) {
      if (TORR) { console.log(`     ${namn}`); nya++; continue; }
      const r = await fetch(`${bas}/api/${typ.slug}/${typ.ladda(encodeURIComponent(projektId), f)}`, { headers: H });
      if (!r.ok) { console.warn(`     MISSLYCKADES ${namn} (${r.status})`); continue; }
      // Äldre PDF-poster utan ändelse kan vara HTML — spara som .html och rendera.
      if (/\.pdf$/i.test(dit) && /text\/html/i.test(r.headers.get('content-type') || '')) dit = dit.replace(/\.pdf$/i, '.html');
      try {
        fs.writeFileSync(dit, Buffer.from(await r.arrayBuffer()));
      } catch (e) {
        console.warn(`     ${namn}  kunde inte skrivas (${e.code || e.message}) — försöker igen nästa runda`);
        continue;
      }
      let slut = dit;
      // HTML-dokumenten ska ligga som PDF i kundmappen. Lyckas renderingen
      // tas HTML:en bort; annars behålls den så inget går förlorat.
      if (/\.html?$/i.test(dit)) {
        const pdf = htmlTillPdf(dit);
        if (pdf) {
          fs.rmSync(dit, { force: true });
          slut = pdf;
          console.log(`     ${path.basename(pdf)}  (renderad ur HTML)`);
        } else {
          console.warn(`     ${namn}  (kunde inte renderas till PDF — HTML behålls)`);
        }
      } else {
        console.log(`     ${namn}`);
      }
      try {
        const st = fs.statSync(slut);
        manifest[`${mapp}/${path.basename(slut)}`.toLowerCase()] = { size: st.size, mtimeMs: st.mtimeMs };
        manifestAndrat = true;
      } catch { /* manifestet är en säkerhetsmarginal, inte kritiskt */ }
      nya++;
    }

    // Äldre versioner bort när den nya ligger på plats — aldrig mellan olika ordrar.
    if (flerOrdrar || !fs.existsSync(mal)) continue;
    const lokala = fs.readdirSync(mal, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    const mfNyckel = (namn) => `${mapp}/${namn}`.toLowerCase();
    const mfSet = { has: (namnLower) => Object.prototype.hasOwnProperty.call(manifest, `${mapp}/${namnLower}`.toLowerCase()) };
    const andrad = (namn) => {
      const e = manifest[mfNyckel(namn)];
      if (!e) return false;
      try { const st = fs.statSync(path.join(mal, namn)); return st.size !== e.size || Math.abs(st.mtimeMs - e.mtimeMs) > 2000; }
      catch { return true; }
    };
    for (const { namn, ersattAv } of gamlaVersioner(lokala, aktuellaPerGrupp[0], historik, mapp, { ofarsk, manifest: mfSet, andrad })) {
      if (TORR) { console.log(`     − ${mapp}\\${namn}  (ersatt av ${ersattAv})`); borttagna++; continue; }
      try {
        fs.rmSync(path.join(mal, namn));
        delete manifest[mfNyckel(namn)];
        manifestAndrat = true;
        console.log(`[${new Date().toLocaleTimeString('sv-SE')}] ${mapp}  − ${namn}  (ersatt av ${ersattAv})`);
        borttagna++;
      } catch (e) {
        console.warn(`     ${mapp}\\${namn}  kunde inte tas bort (${e.code || e.message}) — försöker igen nästa runda`);
      }
    }
  }
  if (manifestAndrat && !TORR) sparaManifest(manifest);
  if (!tyst) console.log(`
Klart: ${nya} ${TORR ? 'skulle hämtas' : 'nya filer'}, ${fanns} fanns redan, ${borttagna} ${TORR ? 'skulle tas bort' : 'äldre versioner borttagna'}, ${mappar} nya mappar.`);
  return { nya, fanns, mappar, borttagna, aktiva: aktiva.length };
}

// Kör bara när filen startas direkt — annars går mappNamn() inte att testa.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  synkaEnGang().catch(e => { console.error('Synken avbröts:', e.message); process.exit(1); });
}
