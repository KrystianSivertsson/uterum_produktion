// Gemensamma lagrets startläge ur ändringsloggen (Krystian 2026-10-25: alla
// enheter visade bara nollningen + två tillägg; påfyllningarna 21/10 fanns bara
// i loggen). Grund = nyaste kopian; loggens ändringar sedan nollningen läggs på
// i tidsordning. Inget läggs till två gånger: saldot SÄTTS till loggens "till".
//   node lager-bygg-ur-logg.mjs             → torrkörning (inget ändras)
//   node lager-bygg-ur-logg.mjs --initiera  → POST /api/lager/initiera
import fs from 'node:fs';
const INITIERA = process.argv.includes('--initiera');
const NOLLNING = '2026-09-14';
const logg = JSON.parse(fs.readFileSync('lager-logg.json', 'utf8'));
const kopior = JSON.parse(fs.readFileSync('lager-kopior.json', 'utf8'));
const bas = [...kopior].sort((a, b) => b.tid.localeCompare(a.tid))[0];
const produkter = bas.produkter.map((p) => JSON.parse(JSON.stringify(p)));
const perId = new Map(produkter.map((p) => [String(p.id), p]));
// Produkter som bara finns i äldre kopior (t.ex. 219 mot 208) — tas med om loggen rör dem.
const aldre = new Map();
for (const k of kopior) for (const p of k.produkter) if (!aldre.has(String(p.id))) aldre.set(String(p.id), p);
// Första talet i loggens text ("493st (+493)" → 493, "1,5" → 1.5).
const tal = (s) => { const m = String(s ?? '').match(/-?\d+(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(',', '.')) : NaN; };
const rapport = [];
for (const e of [...logg].sort((a, b) => a.tid.localeCompare(b.tid))) {
  const id = String(e.produktId);
  let p = perId.get(id);
  const rorSaldo = (e.andringar || []).some((a) => /^(Påfyllning|Uttag|Återställd)$/.test(a.falt));
  if (!p && rorSaldo && e.tid >= NOLLNING && aldre.has(id)) { p = JSON.parse(JSON.stringify(aldre.get(id))); produkter.push(p); perId.set(id, p); rapport.push(`tillagd ur äldre kopia: ${p.namn} (${id})`); }
  if (!p) { if (rorSaldo && e.tid >= NOLLNING) rapport.push(`SAKNAS: ${e.produktNamn} (${id})`); continue; }
  for (const a of e.andringar || []) {
    if (/^(Påfyllning|Uttag|Återställd)$/.test(a.falt)) { if (e.tid >= NOLLNING) p.antal = tal(a.till); }
    else if (a.falt === 'Enhet') p.enhet = a.till;
    else if (a.falt === 'Artikelnr') p.artikel = a.till;
    else if (a.falt === 'Kategori') p.kategori = a.till;
    else if (a.falt === 'Varningsgräns') p.minAntal = tal(a.till);
  }
}
// Seal Bk: loggen visar 22 → 22 trots +800 (felet med översta fältet, rättat 23/10).
// Inventeringen: 1 pkt = 20 st, 22 + 18 pkt = 800 st.
const sealBk = perId.get('2001');
if (sealBk) { rapport.push(`Seal Bk: ${sealBk.antal} → 800 (inventeringen 40 pkt à 20 st)`); sealBk.antal = 800; }
// Ordrar: alla kopiornas, en per id (nyaste kopian vinner).
const ordrar = new Map();
for (const k of [...kopior].sort((a, b) => a.tid.localeCompare(b.tid))) for (const o of k.ordrar || []) ordrar.set(String(o.id), o);
const radSumma = (p) => (Array.isArray(p.farger) ? p.farger.reduce((s, f) => s + (parseInt(f.antal) || 0), 0) : 0);
const medSaldo = produkter.filter((p) => (Number(p.antal) || 0) > 0 || radSumma(p) > 0);
console.log(`Grund: ${bas.namn} ${bas.tid} (${bas.produkter.length} produkter) → ${produkter.length} produkter, ${ordrar.size} ordrar`);
console.log(`Produkter med saldo: ${medSaldo.length}`);
for (const r of rapport) console.log('  ' + r);
fs.writeFileSync('lager-startlage-logg.json', JSON.stringify({ produkter, ordrar: [...ordrar.values()] }, null, 1));
for (const p of medSaldo.sort((a, b) => String(a.kategori).localeCompare(String(b.kategori)) || String(a.namn).localeCompare(String(b.namn))))
  console.log(`  ${String(p.kategori || '').slice(0, 22).padEnd(22)} ${String(p.artikel || '').padEnd(8)} ${String(p.namn).slice(0, 40).padEnd(40)} ${p.antal} ${p.enhet || 'st'}${radSumma(p) ? ` + rader ${radSumma(p)}` : ''}`);
if (INITIERA) {
  const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
  const url = cfg.url.replace(/\/+$/, '');
  const { token } = await (await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
  const r = await fetch(`${url}/api/lager/initiera`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ produkter, ordrar: [...ordrar.values()] }) });
  console.log('initiera:', r.status, await r.text());
}
