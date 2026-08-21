/**
 * konvertera-html.mjs — engångskörning: renderar HTML-dokument som redan
 * ligger i U:\<kund>\ till PDF (nya filer konverteras av sync-u.mjs direkt).
 *
 * Kör:  node tools/konvertera-html.mjs            (U: som standard)
 *       node tools/konvertera-html.mjs --torr     visar vad som skulle göras
 *       node tools/konvertera-html.mjs "D:\nagot" annan rot
 */
import fs from 'node:fs';
import path from 'node:path';
import { htmlTillPdf } from './sync-u.mjs';

const torr = process.argv.includes('--torr');
const rot = process.argv.slice(2).find(a => !a.startsWith('--')) || 'U:' + String.fromCharCode(92);

let ok = 0, fel = 0, hoppade = 0;
for (const mapp of fs.readdirSync(rot, { withFileTypes: true })) {
  if (!mapp.isDirectory() || mapp.name.startsWith('$') || mapp.name.startsWith('System')) continue;
  const dir = path.join(rot, mapp.name);
  for (const f of fs.readdirSync(dir)) {
    if (!/\.html?$/i.test(f)) continue;
    const html = path.join(dir, f);
    const pdf = html.replace(/\.html?$/i, '.pdf');
    if (fs.existsSync(pdf)) { hoppade++; continue; }
    if (torr) { console.log(`  skulle rendera: ${mapp.name}\\${f}`); ok++; continue; }
    const ut = htmlTillPdf(html);
    if (ut) { fs.rmSync(html, { force: true }); console.log(`  ${mapp.name}\\${path.basename(ut)}`); ok++; }
    else { console.warn(`  MISSLYCKADES ${mapp.name}\\${f}`); fel++; }
  }
}
console.log(`\nKlart: ${ok} ${torr ? 'skulle renderas' : 'renderade'}, ${fel} misslyckades, ${hoppade} hade redan PDF.`);
