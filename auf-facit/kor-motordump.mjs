// Engångskörning: NC-X över hela facit-samlingen med DAGENS .nct/.ncc/.ncm och
// produktionens efterbehandlare (p1) + motordump.ncp (p2). Ger per par:
//   par/<nr>/ny/ny.auf (nytt facit), motor.txt (motorns värden), *.err, klar.json
// Delar låset %APPDATA%\uterum-handerna\auf\ncx.lock med U-synkens AUF-kedja,
// så synkens AUF:er hinner emellan. Väntar om eluCad kör NC-X. Kan återupptas.
//   node kor-motordump.mjs [--filter text] [--max n] [--timeout s]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const kor = promisify(execFile);
const HAR = path.dirname(fileURLToPath(import.meta.url));
const ELU = 'C:\\elusoft\\eluCad 4.0';
const NCX = path.join(ELU, 'ncx', 'ncx.exe');
const UPPS = {
  t: path.join(ELU, 'user', 'database', 'SBZ151-2008-7m.nct'),
  c: path.join(ELU, 'user', 'database', 'SBZ151-2008-7m.ncc'),
  m: path.join(ELU, 'user', 'database', 'SBZ151_ME _7m.ncm'),
  p1: path.join(ELU, 'ncx', 'E151NUM_7M_LIFT.ncp'),
  p2: path.join(HAR, 'motordump.ncp'),
};
const JOBB_PS1 = path.join(HAR, '..', 'uterum-konfigurator', 'tools', 'handerna', 'auf', 'ncx-jobb.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const LAS = path.join(process.env.APPDATA, 'uterum-handerna', 'auf', 'ncx.lock');
const LOGG = path.join(HAR, 'kor-motordump.log');

const args = process.argv.slice(2);
const flagga = (n, std = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : std; };
const filter = flagga('--filter'), max = Number(flagga('--max', '0')) || Infinity, timeoutSek = Number(flagga('--timeout', '300'));
const vila = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();
const logg = (s) => { const rad = `[${new Date().toLocaleTimeString('sv-SE')}] ${s}`; console.log(rad); fs.appendFileSync(LOGG, rad + '\n'); };

// eluCad-dongeln (CodeMeter-stickan 3320460). Utan den hänger NC-X tills tidsgränsen.
async function dongelInne() {
  try {
    const { stdout } = await kor(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-PnpDevice -InstanceId 'USB\\VID_064F&PID_2AF9\\000003320460' -ErrorAction SilentlyContinue).Status"], { windowsHide: true, encoding: 'utf8' });
    return String(stdout).trim() === 'OK';
  } catch { return false; }
}
async function vantaPaDongel() {
  if (await dongelInne()) return;
  logg('väntar på eluCad-dongeln (sätt i stickan i kontorsdatorn)');
  while (!(await dongelInne())) await vila(30_000);
  logg('dongeln sitter i — fortsätter');
}

async function ncxIgang() {
  const { stdout } = await kor('tasklist.exe', ['/FI', 'IMAGENAME eq ncx.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'latin1' });
  return /"ncx\.exe"/i.test(String(stdout));
}
async function taLas() {
  const gammalMs = (180 + 600 + 120) * 1000;
  const mitt = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  for (;;) {
    try {
      const fd = fs.openSync(LAS, 'wx');
      fs.writeSync(fd, JSON.stringify({ id: mitt, pid: process.pid, start: new Date().toISOString(), vem: 'kor-motordump' }));
      fs.closeSync(fd);
      return () => { try { if (JSON.parse(fs.readFileSync(LAS, 'utf8')).id === mitt) fs.unlinkSync(LAS); } catch { /* borta */ } };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { if (Date.now() - fs.statSync(LAS).mtimeMs > gammalMs) fs.unlinkSync(LAS); } catch { /* försvann */ }
    await vila(3000);
  }
}

const shaVid = Object.fromEntries(Object.entries(UPPS).map(([k, f]) => [k, sha(f)]));
fs.writeFileSync(path.join(HAR, 'kor-motordump-uppsattning.json'), JSON.stringify({ start: new Date().toISOString(), filer: UPPS, sha: shaVid }, null, 1));
// Spara kopior av exakt de filer som körs (agentens råd: hashar räcker inte).
const kopior = path.join(HAR, 'uppsattning-2026-10-27');
fs.mkdirSync(kopior, { recursive: true });
for (const f of Object.values(UPPS)) fs.copyFileSync(f, path.join(kopior, path.basename(f)));

const index = JSON.parse(fs.readFileSync(path.join(HAR, 'index.json'), 'utf8'));
let gjorda = 0, timeoutIRad = 0;
for (const r of index) {
  if (filter && !r.namn.includes(filter)) continue;
  if (gjorda >= max) break;
  const dir = path.join(HAR, r.dir), ny = path.join(dir, 'ny');
  try { if (JSON.parse(fs.readFileSync(path.join(ny, 'klar.json'), 'utf8')).ok) continue; } catch { /* inte körd */ }
  await vantaPaDongel();
  fs.rmSync(ny, { recursive: true, force: true });
  fs.mkdirSync(ny, { recursive: true });
  fs.copyFileSync(path.join(dir, 'in.ncw'), path.join(ny, 'in.ncw'));
  const argv = [`w=${path.join(ny, 'in.ncw')}`, `t=${UPPS.t}`, `c=${UPPS.c}`, `m=${UPPS.m}`, `p1=${UPPS.p1}`, 'o1=ny.auf', `p2=${UPPS.p2}`, 'o2=motor.txt'];
  fs.writeFileSync(path.join(ny, 'ncx-args.json'), JSON.stringify(argv));
  // Kedjans filer får inte ha ändrats under körningen.
  for (const [k, f] of Object.entries(UPPS)) if (sha(f) !== shaVid[k]) { logg(`STOPP: ${path.basename(f)} har ändrats under körningen`); process.exit(1); }
  const frigor = await taLas();
  let svar = {};
  const t0 = Date.now();
  try {
    while (await ncxIgang()) await vila(5000);   // eluCad (eller synken) kör NC-X
    const { stdout } = await kor(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', JOBB_PS1,
      '-Exe', NCX, '-Cwd', ny, '-ArgsFil', path.join(ny, 'ncx-args.json'), '-TimeoutSek', String(timeoutSek)],
    { windowsHide: true, timeout: (timeoutSek + 60) * 1000, maxBuffer: 4e6 });
    svar = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
  } catch (e) { svar = { fel: String(e.message).split('\n')[0] }; }
  finally { frigor(); }
  const sek = Math.round((Date.now() - t0) / 1000);
  const auf = path.join(ny, 'ny.auf'), dump = path.join(ny, 'motor.txt');
  const ok = !svar.tidsgrans && !svar.fel && fs.existsSync(auf) && fs.statSync(auf).size > 100 && fs.existsSync(dump);
  const err = fs.readdirSync(ny).find((f) => /\.err$/i.test(f));
  const errText = err ? fs.readFileSync(path.join(ny, err), 'latin1') : '';
  const fel = (errText.match(/^!ERROR.*$/gm) || []).slice(0, 3);
  fs.writeFileSync(path.join(ny, 'klar.json'), JSON.stringify({ ok, sek, svar, fel, aufStorlek: ok ? fs.statSync(auf).size : 0, dumpStorlek: fs.existsSync(dump) ? fs.statSync(dump).size : 0 }, null, 1));
  gjorda++;
  logg(`${r.nr} ${r.namn}: ${ok ? 'ok' : 'MISSLYCKADES'} ${sek} s${fel.length ? ' ' + fel.join(' | ') : ''}${svar.tidsgrans ? ' (tidsgräns)' : ''}`);
  if (!ok && !svar.tidsgrans && gjorda <= 3) { logg('STOPP: de första jobben misslyckas utan tidsgräns — kolla motordump.ncp och .err'); process.exit(1); }
  timeoutIRad = svar.tidsgrans && (await dongelInne()) ? timeoutIRad + 1 : 0;
  if (timeoutIRad >= 2) { logg('STOPP: två tidsgränser i rad med dongeln i — något annat är fel'); process.exit(1); }
}
logg(`klart: ${gjorda} körda`);
