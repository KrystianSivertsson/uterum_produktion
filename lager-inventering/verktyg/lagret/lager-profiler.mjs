import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
const bas = cfg.url.replace(/\/+$/, '');
const { token } = await (await fetch(`${bas}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
const l = await (await fetch(`${bas}/api/lager`, { headers: { Authorization: `Bearer ${token}` } })).json();
const med = l.produkter.filter((p) => Array.isArray(p.farger) && p.farger.length);
console.log(`${med.length} produkter med färgrader, ${med.reduce((s, p) => s + p.farger.length, 0)} rader`);
for (const p of med.sort((a, b) => String(a.kategori).localeCompare(String(b.kategori)) || String(a.artikel).localeCompare(String(b.artikel))))
  console.log(`${String(p.kategori).slice(0, 22).padEnd(22)} ${String(p.artikel || '').padEnd(8)} ${String(p.namn).slice(0, 30).padEnd(30)} antal ${p.antal} | ${p.farger.map((f) => `${f.farg} ${f.langd}: ${f.antal}`).join(' · ')}`);
fs.writeFileSync('lager-server-nu.json', JSON.stringify(l));
