/**
 * sync-u-live.mjs — håller U:\<kund>\ synkad LIVE mot UterumLager.
 *
 * Varför en lokal loop: lagersystemet kör på three.nordiska.io (Linux) och når
 * inte U:\ — den utdelningen finns bara på kontorets Windows-datorer. Servern
 * kan alltså aldrig skriva dit själv; synken måste dras HÄRIFRÅN.
 *
 * Kör en runda direkt vid start och sedan var SYNC_INTERVALL_S sekund
 * (standard 60). Rundan är billig när inget hänt: ett anrop per aktiverad kund
 * och filtyp, och filer som redan ligger på plats hoppas över på mtime.
 *
 * Kör:  node tools/sync-u-live.mjs
 *       sync-u-live.bat                    (dubbelklick)
 *       installera-live-synk.bat           (registrerar den som Windows-uppgift)
 */
import { synkaEnGang } from './sync-u.mjs';

const INTERVALL_MS = Math.max(15, Number(process.env.SYNC_INTERVALL_S) || 60) * 1000;
const sov = (ms) => new Promise((r) => setTimeout(r, ms));

let fel = 0;
console.log(`Live-synk igång — kollar var ${INTERVALL_MS / 1000} s. Avsluta med Ctrl+C.`);
for (;;) {
  try {
    const r = await synkaEnGang({ tyst: true });
    if (r.nya > 0 || r.mappar > 0) {
      console.log(`[${new Date().toLocaleTimeString('sv-SE')}] ${r.nya} nya filer, ${r.mappar} nya mappar`);
    }
    fel = 0;
  } catch (e) {
    fel++;
    // Backa av vid upprepade fel (nätet nere, servern startar om) så loggen
    // inte fylls och servern inte hamras.
    console.warn(`[${new Date().toLocaleTimeString('sv-SE')}] synk misslyckades (${fel}): ${e.message}`);
    if (fel > 3) await sov(INTERVALL_MS * Math.min(fel, 10));
  }
  await sov(INTERVALL_MS);
}
