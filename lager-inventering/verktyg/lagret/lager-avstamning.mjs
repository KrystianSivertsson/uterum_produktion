// Stäm av inventeringen (Inventering.xlsx) mot ändringsloggen och webbläsarnas kopior.
// Läser bara: lager-logg.json, lager-kopior.json, inventering-ny.json.
import fs from 'node:fs';
const logg = JSON.parse(fs.readFileSync('lager-logg.json', 'utf8'));
const kopior = JSON.parse(fs.readFileSync('lager-kopior.json', 'utf8'));
const inv = JSON.parse(fs.readFileSync('inventering-ny.json', 'utf8'))['Alla rader'].slice(1);
const NOLLNING = '2026-09-14';
// Bas = nyaste kopian med flest produkter.
const basK = [...kopior].sort((a, b) => b.produkter.length - a.produkter.length || b.tid.localeCompare(a.tid))[0];
const allaProd = new Map();
for (const k of kopior) for (const p of k.produkter) if (!allaProd.has(String(p.id))) allaProd.set(String(p.id), p);
const tal = (s) => parseFloat(String(s ?? '').replace(',', '.').replace(/[^\d.\-]/g, ''));
// Senaste saldo per produkt enligt loggen sedan nollningen.
const saldo = new Map();
for (const e of [...logg].filter((e) => e.tid >= NOLLNING).sort((a, b) => a.tid.localeCompare(b.tid))) {
  for (const a of e.andringar || []) {
    if (!/^(Påfyllning|Uttag|Återställd)$/.test(a.falt)) continue;
    saldo.set(String(e.produktId), { till: tal(a.till), text: `${a.falt} ${a.fran} → ${a.till}`, tid: e.tid, vem: e.user, namn: e.produktNamn });
  }
}
console.log(`Bas: ${basK.namn} ${basK.tid} (${basK.produkter.length} produkter). Produkter med saldo i loggen: ${saldo.size}`);
const saknas = [...saldo.keys()].filter((id) => !allaProd.has(id));
console.log(`Loggade produkt-id som inte finns i någon kopia: ${saknas.length}`, saknas.map((id) => saldo.get(id).namn).join(', '));
// Artikelnr → produkter
const perArt = new Map();
for (const p of allaProd.values()) { const a = String(p.artikel || '').trim(); if (a) (perArt.get(a) || perArt.set(a, []).get(a)).push(p); }
// Inventeringen per artikel
const invArt = new Map();
for (const r of inv) {
  const art = String(r[2] ?? '').trim();
  if (!/^\d{6,7}$/.test(art)) { (invArt.get('?') || invArt.set('?', []).get('?')).push(r); continue; }
  (invArt.get(art) || invArt.set(art, []).get(art)).push(r);
}
const rader = [];
for (const [art, rr] of invArt) {
  if (art === '?') continue;
  const prods = perArt.get(art) || [];
  const loggade = prods.filter((p) => saldo.has(String(p.id)));
  const status = !prods.length ? 'SAKNAS I SYSTEMET' : loggade.length ? 'INLAGD' : 'EJ INLAGD';
  rader.push({ art, status, inv: rr.map((r) => [r[1], r[3], r[4], r[5], r[6]].filter(Boolean).join(' · ')).join('  ||  '),
    produkt: prods.map((p) => `${p.namn} [${p.enhet || 'st'}]${p.farger?.length ? ' (färgrader)' : ''}`).join(' / '),
    logg: loggade.map((p) => `${saldo.get(String(p.id)).text}`).join(' / ') });
}
const ordning = { 'INLAGD': 0, 'EJ INLAGD': 1, 'SAKNAS I SYSTEMET': 2 };
rader.sort((a, b) => ordning[a.status] - ordning[b.status] || a.art.localeCompare(b.art));
const n = (s) => rader.filter((r) => r.status === s).length;
console.log(`Inventeringens artiklar: ${rader.length} — inlagda ${n('INLAGD')}, ej inlagda ${n('EJ INLAGD')}, saknas i systemet ${n('SAKNAS I SYSTEMET')}; rader utan läsbart artikelnr: ${(invArt.get('?') || []).length}`);
fs.writeFileSync('lager-avstamning.json', JSON.stringify(rader, null, 1));
for (const r of rader) console.log(`${r.status.padEnd(18)} ${r.art.padEnd(8)} ${r.produkt.slice(0, 50).padEnd(50)} | inv: ${r.inv.slice(0, 70)} | logg: ${r.logg.slice(0, 60)}`);
// Loggade produkter som inte finns i inventeringen
const invSet = new Set(invArt.keys());
console.log('\nLoggat saldo men artikeln finns inte i inventeringen:');
for (const [id, s] of saldo) { const p = allaProd.get(id); if (!p || !invSet.has(String(p.artikel || '').trim())) console.log(`  ${s.namn} (${p?.artikel || 'utan artikelnr'}) ${s.text}`); }
