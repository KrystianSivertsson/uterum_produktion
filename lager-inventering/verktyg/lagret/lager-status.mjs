// Läget i det gemensamma lagret: servern, kopiorna och ändringsloggen (läser bara).
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
const bas = cfg.url.replace(/\/+$/, '');
const { token } = await (await fetch(`${bas}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
const H = { Authorization: `Bearer ${token}` };
const l = await (await fetch(`${bas}/api/lager`, { headers: H })).json();
const pos = (l.produkter || []).filter((p) => Number(p.antal) > 0);
console.log(`SERVERN: initierad=${l.initierad} version=${l.version} produkter=${(l.produkter || []).length} ordrar=${(l.ordrar || []).length} med saldo>0: ${pos.length} summa=${pos.reduce((a, p) => a + Number(p.antal), 0)}`);
const kopior = await (await fetch(`${bas}/api/lager/snapshots`, { headers: H })).json();
console.log(`KOPIOR (${kopior.length}):`);
for (const k of kopior) console.log(`  ${k.namn || k.user} · ${k.enhet} · ${k.produkter} produkter · saldosumma ${k.saldoSumma} · ${k.tid} · ${k.webblasare.slice(0, 60)}`);
const logg = await (await fetch(`${bas}/api/changes`, { headers: H })).json();
console.log(`LOGG: ${logg.length} senaste, nyast ${logg[0]?.tid} (${logg[0]?.user})`);
const perDag = {};
for (const e of logg) { const d = e.tid.slice(0, 10) + ' ' + e.user; perDag[d] = (perDag[d] || 0) + 1; }
for (const [d, n] of Object.entries(perDag).slice(0, 15)) console.log(`  ${d}: ${n}`);
for (const e of logg.slice(0, 12)) console.log(`  ${e.tid.slice(0, 16)} ${e.user}: ${e.produktNamn} — ${(e.andringar || []).map((a) => `${a.falt} ${a.fran}→${a.till}`).join('; ')}`);
