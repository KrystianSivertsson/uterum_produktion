// AOC 50-takets material (profiler + tillbehör) för ett tak B × D mm, ur
// konfiguratorns egen motor (samma kedja som glasPanesHeadless/aoc50Dellista).
// Körs med vitest-miljöns beroenden: node tak-aoc50.mjs [bredd] [djup] [antal] → tak-aoc50.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
globalThis.window ??= { __fastRebuild: false };
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
const K = 'K:/Claude Projekt-Krystian Sivertsson/uterum-konfigurator';
const imp = (p) => import(pathToFileURL(path.join(K, p)).href);
const THREE = await import(pathToFileURL(path.join(K, 'node_modules/three/build/three.module.js')).href);
const { createRectangular, createDefaults } = await imp('src/uterum2/wireframeModel.js');
const { computeLayout } = await imp('src/uterum2/layoutEngine.js');
const { buildSectionGlassCassettes } = await imp('src/uterum2/glassCassettes.js');
const { resetGlassPanelSpecs, getGlassPanelSpecs } = await imp('src/uterum2/builders/glassBuilder2.js');
const { computeAoc50Dellista } = await imp('src/uterum2/aoc50Dellista.js');
const [B = 6000, D = 5000, N = 10] = process.argv.slice(2).map(Number);
const model = createRectangular(B, D);
const defaults = { ...createDefaults(), takTyp: 'glas' };
const wireframe = { ...model, defaults };
const layout = computeLayout(wireframe);
const m = new THREE.MeshBasicMaterial();
resetGlassPanelSpecs();
for (const sec of (layout.roofSections || layout.sections)) buildSectionGlassCassettes(new THREE.Group(), sec, { clearMat: m, tintedMat: m, spacerMat: m }, wireframe, { kortlingar: false });
const panes = getGlassPanelSpecs();
const d = computeAoc50Dellista(layout, wireframe, panes);
if (!d) throw new Error('ingen AOC 50-lista (takTyp?)');
console.log(`Tak ${B} × ${D}: ${JSON.stringify(d.sammanfattning)}`);
console.log(`glasrutor ${panes.length}:`, [...new Set(panes.map((p) => `${Math.round(p.widthFrontMm)}×${Math.round(p.lengthMm)}`))].join(', '));
fs.writeFileSync('tak-aoc50.json', JSON.stringify({ B, D, N, sammanfattning: d.sammanfattning, profiler: d.profiler, tillbehor: d.tillbehor,
  glas: panes.map((p) => ({ b: Math.round(p.widthFrontMm), l: Math.round(p.lengthMm) })) }, null, 1));
for (const p of d.profiler) console.log('P', p.artikel, p.antal, '×', p.langdMm, p.benamning || p.namn || '');
for (const t of d.tillbehor) console.log('T', t.artikel, t.antal, t.enhet || '', t.benamning || t.namn || '');
