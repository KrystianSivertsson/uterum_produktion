// Produkterna med saldo 0 i det gemensamma lagret: finns de i Inventering.xlsx?
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
const bas = cfg.url.replace(/\/+$/, '');
const { token } = await (await fetch(`${bas}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
const l = await (await fetch(`${bas}/api/lager`, { headers: { Authorization: `Bearer ${token}` } })).json();
const inv = JSON.parse(fs.readFileSync('inventering-ny.json', 'utf8'))['Alla rader'].slice(1);
// Felskrivna nummer i inventeringen → rätt nummer (samma som avstämningen 25/10).
const RATT = { '224487': '224497', '242609': '242509', '278211': '279211', '227123': '227129', '288864': '298864', '288900': '298900', '288736': '298736', '284835': '284835' };
const invPer = new Map();
for (const r of inv) { const a0 = String(r[2] ?? '').trim(); const a = RATT[a0] || a0; (invPer.get(a) || invPer.set(a, []).get(a)).push(r); }
const radSumma = (p) => (Array.isArray(p.farger) ? p.farger.reduce((s, f) => s + (parseInt(f.antal) || 0), 0) : 0);
const nollor = l.produkter.filter((p) => !((Number(p.antal) || 0) > 0 || radSumma(p) > 0));
console.log(`Servern: version ${l.version}, ${l.produkter.length} produkter, ${nollor.length} på 0`);
const grupper = { 'I listan men aldrig inlagt': [], 'Inte i listan': [], 'Utan artikelnummer': [] };
for (const p of nollor) {
  const a = String(p.artikel || '').trim();
  const rader = a ? invPer.get(a) : null;
  const txt = `${String(p.kategori || '').padEnd(22).slice(0, 22)} ${a.padEnd(8)} ${String(p.namn).slice(0, 38).padEnd(38)} ${p.enhet || 'st'}${p.farger?.length ? ' (färgrader)' : ''}`;
  if (!a) grupper['Utan artikelnummer'].push(txt);
  else if (rader) grupper['I listan men aldrig inlagt'].push(`${txt} | listan: ${rader.map((r) => [r[0], r[3], r[4], r[5]].filter(Boolean).join(' · ')).join(' || ').slice(0, 90)}`);
  else grupper['Inte i listan'].push(txt);
}
for (const [g, rader] of Object.entries(grupper)) { console.log(`\n== ${g}: ${rader.length}`); for (const r of rader.sort()) console.log('  ' + r); }
