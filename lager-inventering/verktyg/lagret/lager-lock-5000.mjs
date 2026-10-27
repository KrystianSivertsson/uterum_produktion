// Locken 490240 och 460640 är 5000 mm-stänger (Krystian 2026-10-26 "5000mm på alla lock").
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
const bas = cfg.url.replace(/\/+$/, '');
const { token } = await (await fetch(`${bas}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const l = await (await fetch(`${bas}/api/lager`, { headers: H })).json();
const andrade = [], logg = [];
for (const art of ['490240', '460640']) {
  for (const p of l.produkter.filter((x) => String(x.artikel) === art)) {
    const fore = `${p.dimension} · ${(p.farger || []).map((f) => `${f.farg} ${f.langd}:${f.antal}`).join(', ')}`;
    const ny = { ...p, dimension: '5000 mm', farger: (p.farger || []).map((f) => ({ ...f, langd: 5000 })) };
    andrade.push(ny);
    logg.push({ produktId: String(p.id), produktNamn: p.namn, andringar: [{ falt: 'Dimension', fran: fore, till: '5000 mm (alla lock är 5000 mm-stänger)' }] });
    console.log(art, p.namn, ':', fore, '→ 5000 mm');
  }
}
if (!process.argv.includes('--skicka')) { console.log('TORRKÖRNING'); process.exit(0); }
const r = await fetch(`${bas}/api/lager/andringar`, { method: 'POST', headers: H, body: JSON.stringify({ produkter: andrade }) });
console.log('andringar:', r.status, await r.text());
for (const e of logg) console.log('logg', (await fetch(`${bas}/api/changes`, { method: 'POST', headers: H, body: JSON.stringify(e) })).status);
