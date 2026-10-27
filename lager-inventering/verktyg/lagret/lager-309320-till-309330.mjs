// Krystian 2026-10-26: "309320 (91 st) är glaslisten" — generatorn/kapavdraget
// använder 309330 (Glzg br 50). Flytta färgraderna dit och ta bort 309320-raden
// (skapad samma dag ur inventeringens "Färger (sida 2)"). Inget dubbelt.
//   node lager-309320-till-309330.mjs [--skicka]
import fs from 'node:fs';
const SKICKA = process.argv.includes('--skicka');
const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
const bas = cfg.url.replace(/\/+$/, '');
const { token } = await (await fetch(`${bas}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const l = await (await fetch(`${bas}/api/lager`, { headers: H })).json();
const fran = l.produkter.find((p) => String(p.artikel) === '309320');
const till = l.produkter.find((p) => String(p.artikel) === '309330');
if (!fran || !till) throw new Error(`saknas: 309320 ${!!fran}, 309330 ${!!till}`);
const ny = JSON.parse(JSON.stringify(till));
const langd = (till.farger || []).find((f) => f.langd)?.langd || 6500;
let farger = (till.farger || []).map((f) => ({ ...f, farg: /^gr[åa]$/i.test(String(f.farg).trim()) ? 'Antracitgrå/RAL7016' : f.farg }));
for (const f of (fran.farger || []).filter((x) => x.antal > 0)) {
  const nyckel = String(f.farg).toLowerCase().split(/[\s/]+/)[0];
  const i = farger.findIndex((x) => String(x.farg).toLowerCase().startsWith(nyckel));
  if (i >= 0) farger[i] = { ...farger[i], antal: (parseInt(farger[i].antal) || 0) + f.antal };
  else farger.push({ farg: f.farg, langd, antal: f.antal });
}
ny.farger = farger;
ny.antal = farger.reduce((s, f) => s + (parseInt(f.antal) || 0), 0);
const text = farger.filter((f) => f.antal > 0).map((f) => `${f.farg} ${f.antal}`).join(' · ');
console.log(`309330 ${till.namn}: ${till.antal} → ${ny.antal} (${text}); 309320 (${fran.id}, ${fran.antal}) tas bort`);
if (!SKICKA) { console.log('TORRKÖRNING'); process.exit(0); }
const r = await fetch(`${bas}/api/lager/andringar`, { method: 'POST', headers: H, body: JSON.stringify({ produkter: [ny], borttagna: [String(fran.id)] }) });
console.log('andringar:', r.status, await r.text());
for (const e of [
  { produktId: String(till.id), produktNamn: till.namn, andringar: [{ falt: 'Påfyllning', fran: `${till.antal}st`, till: `${ny.antal}st (inventering 21/10 — räknad som 309320, är glaslisten 309330: ${text})` }] },
  { produktId: String(fran.id), produktNamn: fran.namn, andringar: [{ falt: 'Borttagen', fran: `${fran.antal}st`, till: 'flyttad till 309330 Glzg br 50 (samma glaslist)' }] },
]) { const x = await fetch(`${bas}/api/changes`, { method: 'POST', headers: H, body: JSON.stringify(e) }); console.log('logg', e.produktNamn, x.status); }
