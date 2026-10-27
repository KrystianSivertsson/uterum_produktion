// Vad krävs i lager för N miljöer (= partier) per färg och system?
// ASE60/ASS32 10 per färg, fasta hälften (5) — Krystian 2026-10-26. Åtgång ur den
// live generatorn (samma som kapavdraget), lager ur det gemensamma lagret.
// node behov-miljo.mjs [bredd] [höjd]  → behov-miljo.json + utskrift
import fs from 'node:fs';
const [B = 2500, H = 3400] = process.argv.slice(2).map(Number);
const G = 'https://three.nordiska.io/ase60';
const FARGER = ['Vit', 'Svart', 'Antracit'];
// Miljöer (partier) per färg och system: MILJO="ase60,ass32,fasta" (förval 10,10,5 — Krystian 2026-10-26).
const [nA, nS, nF] = (process.env.MILJO || "10,10,5").split(",").map(Number);
const ANTAL = { ase60: nA, ass32: nS, fasta: nF };
const KERF = 4.6;
const post = async (vag, body) => { const r = await fetch(G + vag, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${vag} ${r.status}`); return r.json(); };
const enhet = (sys, i) => sys === 'ass32'
  ? { id: `u${i}`, system: 'ass32', widthMm: B, heightMm: H, leaves: 2, opening: 'center-meet', track: 2, weight: 200, sashSeries: '92', innerPanel: 1, hardware: { hinge: 'ASE60-350', lock: 'DLO-276726', handle: 'DHA-inside' }, handleSide: 'inside', comNo: '', description: `P${i}`, positionId: `P${i}`, handedness: 'a' }
  : { id: `u${i}`, system: 'ase60', widthMm: B, heightMm: H, leaves: 2, opening: 'center-meet', track: 2, weight: 350, innerPanel: 2, hardware: { hinge: 'ASE60-350', lock: 'DLO-276726', handle: 'DHA-inside' }, handleSide: 'inside', comNo: '', description: `P${i}`, positionId: `P${i}` };
// ---- lagret
const cfg = JSON.parse(fs.readFileSync('K:/Claude Projekt-Krystian Sivertsson/lagersystem/tools/sync-u.config.json', 'utf8'));
const bas = cfg.url.replace(/\/+$/, '');
const { token } = await (await fetch(`${bas}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password ?? cfg.pass ?? cfg.losenord }) })).json();
const lager = (await (await fetch(`${bas}/api/lager`, { headers: { Authorization: `Bearer ${token}` } })).json()).produkter;
const norm = (a) => String(a || '').trim().replace(/[A-Z]$/i, '');
const perArt = new Map();
for (const p of lager) { const a = norm(p.artikel); if (a) (perArt.get(a) || perArt.set(a, []).get(a)).push(p); }
const fn = (s) => String(s || '').toLowerCase().split(/[\s/,]+/).filter(Boolean)[0] || '';
const sammaFarg = (a, b) => { const x = fn(a), y = fn(b); return x === y || (x && y && (x.startsWith(y) || y.startsWith(x))); };
/** Lager: { farg: antal } för färgrader, ofargat = översta fältet utan rader. */
function lagerAv(art) {
  const ps = perArt.get(norm(art)) || [];
  const ut = { finns: ps.length > 0, namn: ps[0]?.namn, enhet: ps[0]?.enhet || 'st', dim: ps[0]?.dimension, farg: {}, ofargat: 0 };
  for (const p of ps) {
    const rader = (p.farger || []).filter((f) => (parseInt(f.antal) || 0) > 0);
    if (rader.length) for (const f of rader) { const k = FARGER.find((F) => sammaFarg(F, f.farg)) || f.farg; ut.farg[k] = (ut.farg[k] || 0) + (parseInt(f.antal) || 0); }
    else ut.ofargat += Number(p.antal) || 0;
  }
  return ut;
}
const stangMm = (art) => { const m = String(lagerAv(art).dim || '').match(/\d{4}/); return m ? +m[0] : 6000; };
const stangerFor = (bitar, L) => { let n = 0; for (const b of bitar) { const per = Math.max(1, Math.floor((L + KERF) / (b.len + KERF))); n += Math.ceil(b.qty / per); } return n; };
// ---- behov: profiler per färg, tillbehör totalt
const prof = new Map();   // art → { ben, sys, farg: {Vit: stänger,...} }
const tillb = new Map();  // art → { ben, sys, enhet, behov, bitar: [{qty,len}] }
const glas = [];
const addProf = (sys, art, ben, farg, n) => { const x = prof.get(art) || { art, ben, sys, farg: {} }; x.farg[farg] = (x.farg[farg] || 0) + n; prof.set(art, x); };
const addTillb = (sys, art, ben, enh, antal, len) => {
  const x = tillb.get(art) || { art, ben, sys: new Set(), enhet: enh, behov: 0, bitar: [] };
  x.sys.add(sys);
  if (len) x.bitar.push({ qty: antal, len }); else x.behov += antal;
  tillb.set(art, x);
};
for (const farg of FARGER) {
  // ASE60
  const nA = ANTAL.ase60, unitsA = Array.from({ length: nA }, (_, i) => enhet('ase60', i + 1));
  const a = await post('/api/lager-atgang', { units: unitsA, projectColor: farg });
  const bom = await post('/api/bom', { units: unitsA });
  const bomLen = new Map(); for (const l of bom.lines || []) if (l.lengthMm) (bomLen.get(l.art) || bomLen.set(l.art, []).get(l.art)).push(l);
  for (const s of a.stanger) { const art = ['487000', '487860'].includes(s.artikel) ? '487850' : s.artikel === '504010' ? '517340' : s.artikel; addProf('ASE60', art, s.benamning, farg, s.antalStanger); }
  for (const o of a.ovrigt) {
    if (o.artikel === 'GLAS') { glas.push({ sys: 'ASE60', farg, ...o }); continue; }
    const bl = bomLen.get(o.artikel);
    if (bl?.length && !o.langdMm) for (const l of bl) addTillb('ASE60', o.artikel, o.benamning, 'st', l.qty, l.lengthMm);
    else addTillb('ASE60', o.artikel, o.benamning, o.enhet || 'st', o.antal, o.langdMm);
  }
  // ASS32
  const s32 = await post('/api/ass32/lager-atgang', { units: Array.from({ length: ANTAL.ass32 }, (_, i) => enhet('ass32', i + 1)), projectColor: farg });
  for (const s of s32.stanger) addProf('ASS32', s.artikel, s.benamning, farg, s.antalStanger);
  for (const o of s32.ovrigt) { if (o.artikel === 'GLAS') { glas.push({ sys: 'ASS32', farg, ...o }); continue; } addTillb('ASS32', o.artikel, o.benamning, o.enhet || 'st', o.antal, o.langdMm); }
  // Fasta (AWS 70.HI, rakt parti, 2 fält)
  const kilar = Array.from({ length: ANTAL.fasta }, (_, i) => ({ positionId: `Fast ${i + 1}`, bredd: B, kort: H, lang: H, spegel: false, falt: 2 }));
  const f = await post('/api/aws70kil/lager-atgang', { kilar, projectColor: farg });
  for (const s of f.stanger) addProf('Fasta', s.artikel, s.benamning, farg, s.antalStanger);
  for (const o of f.ovrigt) { if (o.artikel === 'GLAS') { glas.push({ sys: 'Fasta', farg, ...o }); continue; } addTillb('Fasta', o.artikel, o.benamning, o.enhet || 'st', o.antal, o.langdMm); }
}
// ---- Tak AOC 50 (Krystian 2026-10-26: "10 tak som är 5x6 meter typ", "svart och vit de som har
// färg"). Takets dellista ur konfiguratorns motor (verktyg/tak-aoc50.mjs → tak-aoc50.json).
// Täcklocken har färg (Svart, Vit), resten (add-on, tryckplattor, tätning, isolator) inte.
const TAK_N = Number(process.env.TAK ?? 10), TAK_FARGER = ["Svart", "Vit"], TAK_LACK = new Set(["493730", "161460"]);
const takFil = fs.existsSync("tak-aoc50.json") ? JSON.parse(fs.readFileSync("tak-aoc50.json", "utf8")) : null;
if (takFil && TAK_N > 0) {
  for (const p of takFil.profiler) {
    if (TAK_LACK.has(p.artikel)) for (const farg of TAK_FARGER) addProf("Tak AOC 50", p.artikel, p.namn, farg, stangerFor([{ qty: p.antal * TAK_N, len: p.langdMm }], stangMm(p.artikel)));
    else addTillb("Tak AOC 50", p.artikel, p.namn, "st", p.antal * TAK_N * TAK_FARGER.length, p.langdMm);
  }
  for (const x of takFil.tillbehor) addTillb("Tak AOC 50", x.artikel, x.namn, x.enhet || "st", x.antal * TAK_N * TAK_FARGER.length, null);
  const rutor = new Map(); for (const g of takFil.glas) { const k = `Glasruta ${g.b}×${g.l}mm (tak)`; rutor.set(k, (rutor.get(k) || 0) + 1); }
  for (const [k, n] of rutor) glas.push({ sys: "Tak AOC 50", benamning: k, antal: n * TAK_N * TAK_FARGER.length });
}
// ---- jämför
const rader = [];
for (const p of prof.values()) {
  const l = lagerAv(p.art);
  let pool = l.ofargat;
  for (const farg of FARGER) {
    const behov = p.farg[farg] || 0; if (!behov) continue;
    const har = l.farg[farg] || 0;
    let saknas = Math.max(0, behov - har);
    // Ofärgade stänger räknas INTE som en färg (ofärgad aluminium är inte vit) — de
    // nämns i anmärkningen, de kan lackas.
    rader.push({ grupp: 'Profil', sys: p.sys, art: p.art, ben: l.namn || p.ben, farg, enhet: `stänger à ${stangMm(p.art)}`, behov, iLager: har, saknas, finns: l.finns, anm: pool > 0 ? `${pool} ofärgade i lager (kan lackas)` : '' });
  }
}
for (const t of tillb.values()) {
  const l = lagerAv(t.art);
  let behov = t.behov, enh = t.enhet;
  if (t.bitar.length) {
    if (l.enhet === 'm') { behov += t.bitar.reduce((s, b) => s + b.qty * b.len / 1000, 0); enh = 'm'; }
    else if (t.bitar[0].len > 250) { behov += stangerFor(t.bitar, stangMm(t.art)); enh = `stänger à ${stangMm(t.art)}`; }
    else behov += t.bitar.reduce((s, b) => s + b.qty, 0);
  }
  const har = Object.values(l.farg).reduce((s, x) => s + x, 0) + l.ofargat;
  const enhetVarn = l.finns && !enh.startsWith('stänger') && l.enhet && l.enhet !== enh ? `lagret räknar i ${l.enhet}` : '';
  rader.push({ grupp: 'Tillbehör', sys: [...t.sys].join('+'), art: t.art, ben: l.namn || t.ben, farg: '', enhet: enh, behov: Math.round(behov * 10) / 10, iLager: har, saknas: Math.max(0, Math.round((behov - har) * 10) / 10), finns: l.finns, anm: enhetVarn });
}
const glasSum = new Map(); for (const g of glas) { const k = `${g.sys}|${g.benamning}`; glasSum.set(k, (glasSum.get(k) || 0) + g.antal); }
fs.writeFileSync('behov-miljo.json', JSON.stringify({ B, H, ANTAL, TAK: takFil && TAK_N > 0 ? { antal: TAK_N, farger: TAK_FARGER, B: takFil.B, D: takFil.D } : null, rader, glas: [...glasSum].map(([k, n]) => ({ sys: k.split('|')[0], ben: k.split('|')[1], antal: n })) }, null, 1));
const brist = rader.filter((r) => r.saknas > 0);
console.log(`${rader.length} rader, ${brist.length} med brist`);
for (const r of rader.sort((a, b) => a.grupp.localeCompare(b.grupp) || a.sys.localeCompare(b.sys) || a.art.localeCompare(b.art) || a.farg.localeCompare(b.farg)))
  console.log(`${r.grupp.padEnd(9)} ${r.sys.padEnd(11)} ${r.art.padEnd(8)} ${String(r.ben).slice(0, 30).padEnd(30)} ${r.farg.padEnd(8)} behov ${String(r.behov).padStart(7)} lager ${String(r.iLager).padStart(6)} saknas ${String(r.saknas).padStart(7)} ${r.enhet}${r.finns ? '' : ' (finns ej i registret)'}${r.anm ? ' ⚠ ' + r.anm : ''}`);
for (const [k, n] of glasSum) console.log(`GLAS ${k}: ${n} st`);
