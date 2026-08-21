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

/**
 * Samma fil sparas om vid varje körning i lagret (Ferdi Kilic har 244 ECW-
 * poster på ~4 filnamn). Kundmappen ska spegla det AKTUELLA läget, så vi
 * behåller den nyaste per filnamn — annars skrivs de över varandra i
 * godtycklig ordning och mappen blir en slump av gamla revisioner.
 */
function nyastePerFilnamn(lista, typ) {
  const bast = new Map();
  for (const f of lista) {
    const namn = medAndelse(f.filename, typ);
    const nu = bast.get(namn);
    if (!nu || new Date(f.skapad || 0) > new Date(nu.skapad || 0)) bast.set(namn, { ...f, _namn: namn });
  }
  return [...bast.values()];
}

async function main() {
  const cfg = laesKonfig();
  const bas = cfg.url.replace(/\/+$/, '');

  const inlogg = await fetch(`${bas}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  });
  if (!inlogg.ok) { console.error('Inloggning misslyckades:', inlogg.status); process.exit(1); }
  const { token } = await inlogg.json();
  const H = { Authorization: `Bearer ${token}` };

  const kunder = await (await fetch(`${bas}/api/kunder`, { headers: H })).json();
  const aktiva = (Array.isArray(kunder) ? kunder : []).filter(k => k.aktiverad);
  console.log(`${aktiva.length} aktiverade kunder (av ${kunder.length}) → ${cfg.mal}`);
  if (TORR) console.log('TORRKÖRNING — inget skrivs.\n');

  let nya = 0, fanns = 0, mappar = 0;
  for (const k of aktiva) {
    const projektId = k.ase60ProjectId || k.id;
    const mapp = mappNamn(k.namn);
    if (!mapp) { console.warn(`  hoppar över kund utan användbart namn (id ${k.id})`); continue; }
    const mal = path.join(cfg.mal, mapp);

    // Hämta filerna först — skapa inte tomma mappar för kunder utan filer.
    const attHamta = [];
    for (const typ of TYPER) {
      const r = await fetch(`${bas}/api/${typ.slug}/${encodeURIComponent(projektId)}`, { headers: H });
      if (!r.ok) continue;
      const lista = await r.json();
      if (!Array.isArray(lista) || !lista.length) continue;
      for (const f of nyastePerFilnamn(lista, typ)) {
        const dit = path.join(mal, f._namn);
        // Hoppa bara över om den lokala filen är minst lika ny — annars har
        // någon lagt en nyare version i lagret och mappen ska följa med.
        if (fs.existsSync(dit) && fs.statSync(dit).mtimeMs >= new Date(f.skapad || 0).getTime()) {
          fanns++; continue;
        }
        attHamta.push({ typ, f, dit, projektId });
      }
    }
    if (!attHamta.length) continue;

    console.log(`  ${mapp}  (+${attHamta.length})`);
    if (!TORR && !fs.existsSync(mal)) { fs.mkdirSync(mal, { recursive: true }); mappar++; }
    for (const { typ, f, dit } of attHamta) {
      if (TORR) { console.log(`     ${f._namn}`); nya++; continue; }
      const r = await fetch(`${bas}/api/${typ.slug}/${typ.ladda(encodeURIComponent(projektId), f)}`, { headers: H });
      if (!r.ok) { console.warn(`     MISSLYCKADES ${f._namn} (${r.status})`); continue; }
      fs.writeFileSync(dit, Buffer.from(await r.arrayBuffer()));
      // HTML-dokumenten ska ligga som PDF i kundmappen. Lyckas renderingen
      // tas HTML:en bort; annars behålls den så inget går förlorat.
      if (/\.html?$/i.test(dit)) {
        const pdf = htmlTillPdf(dit);
        if (pdf) {
          fs.rmSync(dit, { force: true });
          console.log(`     ${path.basename(pdf)}  (renderad ur HTML)`);
          nya++;
          continue;
        }
        console.warn(`     ${f._namn}  (kunde inte renderas till PDF — HTML behålls)`);
      }
      console.log(`     ${f._namn}`);
      nya++;
    }
  }
  console.log(`\nKlart: ${nya} ${TORR ? 'skulle hämtas' : 'nya filer'}, ${fanns} fanns redan, ${mappar} nya mappar.`);
}

// Kör bara när filen startas direkt — annars går mappNamn() inte att testa.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error('Synken avbröts:', e.message); process.exit(1); });
}
