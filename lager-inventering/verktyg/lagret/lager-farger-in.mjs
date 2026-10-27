// Inventering.xlsx blad "Färger (sida 2)" → färgrader i det gemensamma lagret
// (Krystian 2026-10-26 "gör så de blir rätt"). Inget dubbelt: redan inlagda
// totaler (376150 147, 487850 118, 358170 4) flyttas till färgraderna.
// Antracit → raden "Antracitgrå/RAL7016" (kapavdraget matchar "Antracit"
// mot den, inte mot "Grå"). Översta fältet = summan av färgraderna, som appen.
//   node lager-farger-in.mjs            → torrkörning
//   node lager-farger-in.mjs --skicka   → /api/lager/andringar + ändringsloggen
import fs from 'node:fs';
const SKICKA = process.argv.includes('--skicka');
const ANTRACIT = 'Antracitgrå/RAL7016';
const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
const bas = cfg.url.replace(/\/+$/, '');
const { token } = await (await fetch(`${bas}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const l = await (await fetch(`${bas}/api/lager`, { headers: H })).json();
if (!l.initierad) throw new Error('lagret ej initierat');

// Bladet "Färger (sida 2)": artikel → { Ofärgad, Svart, Antracit, Vit }
const blad = JSON.parse(fs.readFileSync('inventering-ny2.json', 'utf8'))['Färger (sida 2)'];
const rubrik = blad[0].map((x) => String(x ?? '').trim());
const tal = (v) => { const m = String(v ?? '').match(/\d+/); return m ? Number(m[0]) : 0; };
const rader = blad.slice(1).filter((r) => /^\d{6}$/.test(String(r[0] ?? '').trim()))
  .map((r) => ({ art: String(r[0]).trim(), ofargad: tal(r[rubrik.indexOf('Ofärgad')]), Svart: tal(r[rubrik.indexOf('Svart')]), Antracit: tal(r[rubrik.indexOf('Antracit')]), Vit: tal(r[rubrik.indexOf('Vit')]) }));

const NYA = {   // finns inte i lagret
  '517340': { namn: '517340', kategori: 'Schueco ASE 60', dimension: '6500 mm' },
  '309320': { namn: '309320', kategori: 'Schueco ASS 32', dimension: '6500 mm' },
};
const andrade = [], logg = [];
const mmAv = (p) => { const m = String(p.dimension || '').match(/\d{3,5}/); return m ? Number(m[0]) : 6000; };
for (const r of rader) {
  let p = l.produkter.find((x) => String(x.artikel).trim() === r.art);
  const ny = !p;
  if (ny) {
    const n = NYA[r.art];
    if (!n) { console.log('OKÄND, hoppar:', r.art); continue; }
    p = { id: `inv20261026_${r.art}`, namn: n.namn, artikel: r.art, antal: 0, minAntal: 5, kategori: n.kategori, dimension: n.dimension, enhet: 'st', farger: [] };
  }
  const fore = JSON.parse(JSON.stringify(p));
  if (r.ofargad && !r.Svart && !r.Antracit && !r.Vit) {          // bara ofärgat (358170) → översta fältet
    if ((Number(p.antal) || 0) === r.ofargad && !(p.farger || []).some((f) => f.antal > 0)) { console.log(`OFÖRÄNDRAD ${r.art} ${p.namn}: ${p.antal} st ofärgad`); continue; }
    p.antal = r.ofargad;
  } else {
    const L = (p.farger || []).find((f) => f.langd)?.langd || mmAv(p);
    let farger = (p.farger || []).map((f) => ({ ...f }));
    // Tom "Grå"-rad = antracit (lagrets gamla namn) → byt namn så avdraget hittar den.
    farger = farger.map((f) => (/^gr[åa]$/i.test(String(f.farg).trim()) && !(f.antal > 0) ? { ...f, farg: ANTRACIT } : f));
    const satt = (namn, antal) => {
      const key = namn === ANTRACIT ? /^(antracit|gr[åa])/i : new RegExp(`^${namn}`, 'i');
      const i = farger.findIndex((f) => key.test(String(f.farg).trim()));
      if (i >= 0) farger[i] = { ...farger[i], farg: namn === ANTRACIT ? ANTRACIT : farger[i].farg, antal };
      else if (antal > 0) farger.push({ farg: namn, langd: L, antal });
    };
    satt('Svart', r.Svart); satt(ANTRACIT, r.Antracit); satt('Vit', r.Vit);
    p.farger = farger;
    p.antal = farger.reduce((s, f) => s + (parseInt(f.antal) || 0), 0);   // som appen: summan av raderna
  }
  andrade.push(p);
  const fargText = (p.farger || []).filter((f) => f.antal > 0).map((f) => `${f.farg} ${f.antal}`).join(' · ');
  logg.push({ produktId: String(p.id), produktNamn: p.namn, andringar: [
    ...(ny ? [{ falt: 'Ny produkt', fran: '', till: `${p.artikel} i ${p.kategori}` }] : []),
    { falt: 'Påfyllning', fran: `${fore.antal || 0}st`, till: `${p.antal}st (inventering 21/10, färger: ${fargText || 'ofärgad'})` },
  ] });
  console.log(`${ny ? 'NY   ' : 'ÄNDRA'} ${r.art} ${String(p.namn).padEnd(24)} översta ${fore.antal || 0} → ${p.antal} | ${fargText}`);
}
if (!SKICKA) { console.log(`\nTORRKÖRNING — ${andrade.length} produkter skulle skickas`); process.exit(0); }
const r = await fetch(`${bas}/api/lager/andringar`, { method: 'POST', headers: H, body: JSON.stringify({ produkter: andrade }) });
console.log('andringar:', r.status, await r.text());
for (const e of logg) { const x = await fetch(`${bas}/api/changes`, { method: 'POST', headers: H, body: JSON.stringify(e) }); if (!x.ok) console.log('logg fel', e.produktNamn, x.status); }
console.log('loggposter:', logg.length);
