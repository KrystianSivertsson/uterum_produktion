// Hur många partier räcker lagret till? Åtgång för 4 partier (atg-*.json, generatorns
// lager-atgang + bom) mot det gemensamma lagret (lager-server-nu.json), per färg.
import fs from 'node:fs';
const lager = JSON.parse(fs.readFileSync('lager-server-nu.json', 'utf8')).produkter;
const KERF = 4.6, N = 4;
const norm = (a) => String(a || '').trim().replace(/[A-Z]$/i, '');
const perArt = new Map();
for (const p of lager) { const a = norm(p.artikel); if (a) (perArt.get(a) || perArt.set(a, []).get(a)).push(p); }
const fargNyckel = (s) => String(s || '').toLowerCase().split(/[\s/,]+/).filter(Boolean)[0] || '';
const sammaFarg = (a, b) => { const na = fargNyckel(a), nb = fargNyckel(b); return na === nb || (na && nb && (na.startsWith(nb) || nb.startsWith(na))); };
const FARGER = ['Vit', 'Svart', 'Antracit'];
// Lager i stänger/st per färg: färgrader i den färgen + färglösa (översta fältet utan rader).
function iLager(art, farg) {
  const ps = perArt.get(norm(art)) || [];
  let n = 0, enhet = null, namn = null;
  for (const p of ps) {
    namn ??= p.namn; enhet ??= p.enhet || 'st';
    const rader = (p.farger || []).filter((f) => (parseInt(f.antal) || 0) > 0);
    if (rader.length) n += rader.filter((f) => !f.farg || sammaFarg(f.farg, farg)).reduce((s, f) => s + (parseInt(f.antal) || 0), 0);
    else n += Number(p.antal) || 0;
  }
  return { finns: ps.length > 0, n, enhet, namn };
}
const stangMm = (art) => { const p = (perArt.get(norm(art)) || [])[0]; const m = String(p?.dimension || '').match(/\d{4}/); return m ? +m[0] : 6000; };
function analys(fil, bomFil) {
  const d = JSON.parse(fs.readFileSync(fil, 'utf8'));
  const a = d.atgang.data;
  const rader = [];
  // Profiler (stänger). ASE60: head/tröskel ur samma 487850-stång; 504010 = profil 517340A.
  const stanger = new Map();
  for (const s of a.stanger) {
    const art = ['487000', '487860'].includes(s.artikel) ? '487850' : s.artikel === '504010' ? '517340' : s.artikel;
    const x = stanger.get(art) || { art, ben: s.benamning, behov: 0, langd: s.stangLangdMm, typ: 'stänger' };
    x.behov += s.antalStanger; stanger.set(art, x);
  }
  rader.push(...stanger.values());
  // Tillbehör. Bitar med längd → stänger ur lagrets stånglängd; meter → meter.
  const bomLangd = new Map();
  if (d.bom?.data?.lines) for (const l of d.bom.data.lines) if (l.lengthMm) (bomLangd.get(l.art) || bomLangd.set(l.art, []).get(l.art)).push(l);
  for (const o of a.ovrigt) {
    if (o.artikel === 'GLAS') { rader.push({ art: 'GLAS', ben: o.benamning, behov: o.antal, typ: 'st', glas: true }); continue; }
    const st = iLager(o.artikel, 'Vit');
    const bitar = o.langdMm ? [{ qty: o.antal, lengthMm: o.langdMm }] : (bomLangd.get(o.artikel) || []).map((l) => ({ qty: l.qty, lengthMm: l.lengthMm }));
    if (o.enhet === 'm') rader.push({ art: o.artikel, ben: o.benamning, behov: o.antal, typ: 'm' });
    else if (bitar.length && st.enhet === 'm') rader.push({ art: o.artikel, ben: o.benamning, behov: bitar.reduce((s, b) => s + b.qty * b.lengthMm / 1000, 0), typ: 'm' });
    else if (bitar.length && bitar[0].lengthMm > 250) {
      const L = stangMm(o.artikel);
      // grovt: först-passande per längd
      let behov = 0; for (const b of bitar) { const perStang = Math.max(1, Math.floor((L + KERF) / (b.lengthMm + KERF))); behov += Math.ceil(b.qty / perStang); }
      rader.push({ art: o.artikel, ben: `${o.benamning} (${bitar.map((b) => `${b.qty}×${Math.round(b.lengthMm)}`).join(', ')})`, behov, typ: 'stänger', langd: L });
    } else rader.push({ art: o.artikel, ben: o.benamning, behov: o.antal, typ: o.enhet || 'st' });
  }
  return { sys: d.sys, rader };
}
for (const f of ['atg-ase60.json', 'atg-ass32.json', 'atg-fasta.json']) {
  const { sys, rader } = analys(f);
  console.log(`\n==== ${sys.toUpperCase()} — 4 partier 2500 × 3400 ====`);
  const max = {};
  for (const farg of FARGER) max[farg] = Infinity;
  const brist = [];
  for (const r of rader) {
    if (r.glas) { console.log(`  GLAS     ${r.ben}: ${r.behov} st (glas ligger inte i lagret)`); continue; }
    const perParti = r.behov / N;
    const cells = FARGER.map((farg) => {
      const s = iLager(r.art, farg);
      const kan = s.finns ? Math.floor(s.n / perParti + 1e-9) : 0;
      max[farg] = Math.min(max[farg], kan);
      return { farg, s, kan };
    });
    const s0 = cells[0].s;
    const enhetVarn = s0.finns && r.typ !== 'stänger' && s0.enhet && r.typ !== s0.enhet ? ` ⚠ lagret i ${s0.enhet}` : '';
    const lagerText = !s0.finns ? 'FINNS INTE I LAGRET' : cells.map((c) => `${c.farg[0]}:${c.s.n}`).join(' ');
    const kanText = cells.map((c) => c.kan).join('/');
    const rad = `  ${r.art.padEnd(8)} ${String(r.ben).slice(0, 44).padEnd(44)} behov4 ${String(+r.behov.toFixed(1)).padStart(6)} ${String(r.typ).padEnd(7)} lager ${lagerText.padEnd(22)} räcker V/S/A ${kanText}${enhetVarn}`;
    console.log(rad);
    if (cells.some((c) => c.kan < 4)) brist.push(r.art);
  }
  console.log(`  → räcker till (V/S/A): ${FARGER.map((f) => `${f} ${max[f]}`).join(' · ')} partier; under 4: ${brist.join(', ')}`);
}
