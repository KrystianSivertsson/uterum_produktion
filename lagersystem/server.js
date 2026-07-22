const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '40mb' })); // 40mb: base64-kodade PDF-dokument från ASE60

// Intern endpoint BEFORE redirect middleware — anropas av ASE60 server-till-server via localhost
// Placeras här så att HTTP-anrop från localhost inte omdirigeras till HTTPS
const _ECW_DIR_EARLY = path.join(__dirname, 'data', 'ecw');
const _ECW_INDEX_EARLY = path.join(__dirname, 'data', 'ecw.json');
const _readJSONEarly = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const _writeJSONEarly = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));
app.post('/api/ecw-filer/intern', (req, res) => {
  if (req.headers['x-intern-secret'] !== 'ase60-intern') return res.status(403).end();
  const { projectId, projectName, filename, ecwBase64 } = req.body;
  if (!projectId || !ecwBase64) return res.status(400).json({ error: 'Saknar data' });
  if (!fs.existsSync(_ECW_DIR_EARLY)) fs.mkdirSync(_ECW_DIR_EARLY, { recursive: true });
  const safeId = String(projectId).replace(/[^a-z0-9_-]/gi, '_');
  const projDir = path.join(_ECW_DIR_EARLY, safeId);
  if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
  const ts = Date.now();
  const safeFilename = String(filename || 'CNCDATA.ECW').replace(/[^a-z0-9._-]/gi, '_');
  const filePath = path.join(projDir, `${ts}_${safeFilename}`);
  fs.writeFileSync(filePath, Buffer.from(ecwBase64, 'base64'));
  if (!fs.existsSync(_ECW_INDEX_EARLY)) _writeJSONEarly(_ECW_INDEX_EARLY, []);
  const index = _readJSONEarly(_ECW_INDEX_EARLY, []);
  index.push({ id: ts.toString(), projectId, projectName: projectName || projectId, filename: safeFilename, filePath, skapad: new Date().toISOString() });
  if (index.length > 500) index.splice(0, index.length - 500);
  _writeJSONEarly(_ECW_INDEX_EARLY, index);
  res.json({ ok: true });
});

// PDF-dokument (print-HTML från ASE60: CAD-ritning + beredning/glas) per kund/projekt.
// Lagras som självständig HTML — öppnas i flik och skrivs ut/sparas som PDF där.
const _PDF_DIR_EARLY = path.join(__dirname, 'data', 'pdf');
const _PDF_INDEX_EARLY = path.join(__dirname, 'data', 'pdf.json');
app.post('/api/pdf-filer/intern', (req, res) => {
  if (req.headers['x-intern-secret'] !== 'ase60-intern') return res.status(403).end();
  const { projectId, projectName, filename, htmlBase64 } = req.body;
  if (!projectId || !htmlBase64) return res.status(400).json({ error: 'Saknar data' });
  const safeId = String(projectId).replace(/[^a-z0-9_-]/gi, '_');
  const projDir = path.join(_PDF_DIR_EARLY, safeId);
  if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
  const ts = Date.now();
  const safeFilename = String(filename || 'ritning.html').replace(/[^a-z0-9._åäöÅÄÖ -]/gi, '_');
  const filePath = path.join(projDir, `${ts}_${safeFilename}.html`);
  fs.writeFileSync(filePath, Buffer.from(htmlBase64, 'base64'));
  if (!fs.existsSync(_PDF_INDEX_EARLY)) _writeJSONEarly(_PDF_INDEX_EARLY, []);
  const index = _readJSONEarly(_PDF_INDEX_EARLY, []);
  index.push({ id: ts.toString(), projectId, projectName: projectName || projectId, filename: safeFilename, filePath, skapad: new Date().toISOString() });
  if (index.length > 500) index.splice(0, index.length - 500);
  _writeJSONEarly(_PDF_INDEX_EARLY, index);
  res.json({ ok: true });
});

// Redirect HTTP → HTTPS (only when HTTPS server is running).
// Maskinanrop med x-api-key (t.ex. ase60-generatorns ECW-notiser) hoppar
// över redirecten — Node-fetch klarar inte självsignerade cert och en
// 301 på POST görs dessutom om till GET.
app.use((req, res, next) => {
  if (req.protocol === 'http' && req.headers.host && !req.headers['x-api-key']) {
    const httpsPort = process.env.HTTPS_PORT || 3443;
    const host = req.headers.host.split(':')[0];
    return res.redirect(301, `https://${host}:${httpsPort}${req.url}`);
  }
  next();
});

// Lokalt (utan nginx): strippa /UterumLager-prefixet för API-anrop
app.use((req, res, next) => {
  if (req.url.startsWith('/UterumLager/api/')) req.url = req.url.slice('/UterumLager'.length);
  next();
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push_subs.json');
const CHANGES_FILE = path.join(DATA_DIR, 'changes.json');
const KUNDER_FILE = path.join(DATA_DIR, 'kunder.json');
const ECW_RUNS_FILE = path.join(DATA_DIR, 'ecw_runs.json');
const STAMPLING_FILE = path.join(DATA_DIR, 'stampling.json');

// Maskinnyckel för integrationen från ase60-generatorn (ECW-exporter).
// Kan bytas via miljövariabeln ECW_API_KEY — måste då matcha ase60-servern.
const ECW_API_KEY = process.env.ECW_API_KEY || 'ase60-lager-2026';

// VAPID keys — generate once, reuse
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
}
webpush.setVapidDetails('mailto:admin@nordiskauterum.se', vapidKeys.publicKey, vapidKeys.privateKey);
const { convertStepTextToBtl } = require('./step2btlIntegration');

const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
};
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const hash = (pw) => crypto.createHash('sha256').update(pw).digest('hex');

// Init default admin user
if (!fs.existsSync(USERS_FILE)) {
  writeJSON(USERS_FILE, [
    { id: '1', username: 'admin', password: hash('admin123'), role: 'admin', namn: 'Administratör' }
  ]);
}
if (!fs.existsSync(MESSAGES_FILE)) writeJSON(MESSAGES_FILE, []);
if (!fs.existsSync(TOKENS_FILE)) writeJSON(TOKENS_FILE, {});
if (!fs.existsSync(CHANGES_FILE)) writeJSON(CHANGES_FILE, []);
if (!fs.existsSync(KUNDER_FILE)) writeJSON(KUNDER_FILE, []);
if (!fs.existsSync(ECW_RUNS_FILE)) writeJSON(ECW_RUNS_FILE, []);
if (!fs.existsSync(STAMPLING_FILE)) writeJSON(STAMPLING_FILE, []);

// Auth middleware — accepts header OR query param (for iframe/PDF)
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  const tokens = readJSON(TOKENS_FILE, {});
  if (!token || !tokens[token]) return res.status(401).json({ error: 'Ej inloggad' });
  req.user = tokens[token];
  next();
};

// --- AUTH ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.username === username && u.password === hash(password));
  if (!user) return res.status(401).json({ error: 'Fel användarnamn eller lösenord' });
  const token = crypto.randomBytes(32).toString('hex');
  const tokens = readJSON(TOKENS_FILE, {});
  tokens[token] = { id: user.id, username: user.username, roll: user.role, namn: user.namn, avatar: user.avatar || null };
  writeJSON(TOKENS_FILE, tokens);
  res.json({ token, user: { id: user.id, username: user.username, roll: user.role, namn: user.namn, avatar: user.avatar || null } });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const tokens = readJSON(TOKENS_FILE, {});
  delete tokens[token];
  writeJSON(TOKENS_FILE, tokens);
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => res.json(req.user));

// --- USERS (admin only) ---
app.get('/api/users', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const users = readJSON(USERS_FILE, []);
  res.json(users.map(u => ({ id: u.id, username: u.username, roll: u.role, namn: u.namn, harPin: !!u.pinHash })));
});

app.post('/api/users', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const { username, password, roll, namn } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Användarnamn och lösenord krävs' });
  const users = readJSON(USERS_FILE, []);
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Användarnamn finns redan' });
  const newUser = { id: Date.now().toString(), username, password: hash(password), role: roll || 'user', namn: namn || username };
  users.push(newUser);
  writeJSON(USERS_FILE, users);
  res.json({ id: newUser.id, username: newUser.username, roll: newUser.role, namn: newUser.namn });
});

app.delete('/api/users/:id', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const users = readJSON(USERS_FILE, []);
  const kvar = users.filter(u => u.id !== req.params.id);
  if (kvar.length === users.length) return res.status(404).json({ error: 'Hittades ej' });
  writeJSON(USERS_FILE, kvar);
  res.json({ ok: true });
});

// Admin sätter/återställer en användares 4-siffriga stämplings-PIN.
app.patch('/api/users/:id/pin', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const { pin } = req.body;
  if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN måste vara 4 siffror' });
  const users = readJSON(USERS_FILE, []);
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Hittades ej' });
  users[idx].pinHash = hash(pin);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

// --- PROFIL ---
app.patch('/api/me/password', authMiddleware, (req, res) => {
  const { nyttLosen, gammaltLosen } = req.body;
  if (!nyttLosen || !gammaltLosen) return res.status(400).json({ error: 'Fyll i båda fälten' });
  const users = readJSON(USERS_FILE, []);
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Användare ej hittad' });
  if (users[idx].password !== hash(gammaltLosen)) return res.status(401).json({ error: 'Fel nuvarande lösenord' });
  users[idx].password = hash(nyttLosen);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

app.patch('/api/me/avatar', authMiddleware, (req, res) => {
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: 'Avatar saknas' });
  const users = readJSON(USERS_FILE, []);
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Användare ej hittad' });
  users[idx].avatar = avatar;
  writeJSON(USERS_FILE, users);
  const tokens = readJSON(TOKENS_FILE, {});
  Object.keys(tokens).forEach(t => { if (tokens[t].id === req.user.id) tokens[t].avatar = avatar; });
  writeJSON(TOKENS_FILE, tokens);
  res.json({ ok: true, avatar });
});

// --- STÄMPLING (kiosk-läge: en delad inloggning, alla användare syns och
// stämplar in/ut med egen PIN) ---
const STAMPLING_OMRADEN = ['Träfräs', 'Alufräs', 'Beslag'];

app.get('/api/stampling/anvandare', authMiddleware, (req, res) => {
  const users = readJSON(USERS_FILE, []);
  const stampling = readJSON(STAMPLING_FILE, []);
  const senaste = new Map();
  for (const e of stampling) {
    const prev = senaste.get(e.userId);
    if (!prev || e.tid > prev.tid) senaste.set(e.userId, e);
  }
  res.json(users.filter(u => u.username !== 'admin').map(u => {
    const sisteEvent = senaste.get(u.id) || null;
    const arInne = sisteEvent && sisteEvent.typ === 'in';
    return {
      id: u.id,
      username: u.username,
      namn: u.namn,
      avatar: u.avatar || null,
      harPin: !!u.pinHash,
      status: sisteEvent ? sisteEvent.typ : 'ut',
      omrade: arInne ? (sisteEvent.omrade || null) : null,
      kundId: arInne ? (sisteEvent.kundId || null) : null,
      kundNamn: arInne ? (sisteEvent.kundNamn || null) : null,
      senastAndrad: sisteEvent ? sisteEvent.tid : null,
    };
  }));
});

app.post('/api/stampling/stampla', authMiddleware, (req, res) => {
  const { userId, pin, omrade, kundId, kundNamn } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'userId och pin krävs' });
  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Användare hittades ej' });
  if (!user.pinHash) return res.status(400).json({ error: 'Ingen PIN satt för denna användare — be admin sätta en' });
  if (user.pinHash !== hash(String(pin))) return res.status(401).json({ error: 'Fel PIN' });

  const stampling = readJSON(STAMPLING_FILE, []);
  const forra = stampling.filter(e => e.userId === userId).sort((a, b) => a.tid < b.tid ? 1 : -1)[0];
  const nyTyp = forra && forra.typ === 'in' ? 'ut' : 'in';
  if (nyTyp === 'in' && !STAMPLING_OMRADEN.includes(omrade)) {
    return res.status(400).json({ error: 'Välj vad du kör: Träfräs, Alufräs eller Beslag' });
  }
  if (nyTyp === 'in' && !kundNamn) {
    return res.status(400).json({ error: 'Välj kund, eller Internt / övrigt' });
  }
  const event = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    userId, namn: user.namn, typ: nyTyp,
    omrade: nyTyp === 'in' ? omrade : null,
    kundId: nyTyp === 'in' ? (kundId || null) : null,
    kundNamn: nyTyp === 'in' ? kundNamn : null,
    tid: new Date().toISOString(),
  };
  stampling.push(event);
  writeJSON(STAMPLING_FILE, stampling);
  res.json({ ok: true, event });
});

// Stämplingar för en specifik kund (visas direkt i kundkortet) — alla
// inloggade får se detta, till skillnad från den fulla admin-loggen.
app.get('/api/stampling/kund/:kundId', authMiddleware, (req, res) => {
  const { omrade } = req.query;
  let events = readJSON(STAMPLING_FILE, []).filter(e => e.kundId === req.params.kundId);
  if (omrade) events = events.filter(e => e.omrade === omrade);
  res.json(events.sort((a, b) => a.tid < b.tid ? 1 : -1).slice(0, 200));
});

// Admin-logg — filtrerbar på användare/datumintervall (YYYY-MM-DD).
app.get('/api/stampling/logg', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const { userId, fran, till } = req.query;
  let events = readJSON(STAMPLING_FILE, []);
  if (userId) events = events.filter(e => e.userId === userId);
  if (fran) events = events.filter(e => e.tid >= fran);
  if (till) events = events.filter(e => e.tid <= till + 'T23:59:59.999Z');
  res.json(events.sort((a, b) => a.tid < b.tid ? 1 : -1).slice(0, 2000));
});

// Admin: lägg till en stämpling manuellt (retroaktivt) eller redigera/ta bort en befintlig.
function validateStamplingFalt(body, user) {
  const { typ, omrade, tid } = body;
  if (typ !== 'in' && typ !== 'ut') return 'typ måste vara "in" eller "ut"';
  if (typ === 'in' && !STAMPLING_OMRADEN.includes(omrade)) return 'Välj vad som kördes: Träfräs, Alufräs eller Beslag';
  if (!tid || isNaN(new Date(tid).getTime())) return 'Ogiltig tid';
  if (!user) return 'Användare hittades ej';
  return null;
}

app.post('/api/stampling/logg', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const { userId, typ, omrade, kundId, kundNamn, tid } = req.body;
  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.id === userId);
  const felmeddelande = validateStamplingFalt(req.body, user);
  if (felmeddelande) return res.status(400).json({ error: felmeddelande });

  const stampling = readJSON(STAMPLING_FILE, []);
  const event = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    userId, namn: user.namn, typ,
    omrade: typ === 'in' ? omrade : null,
    kundId: typ === 'in' ? (kundId || null) : null,
    kundNamn: typ === 'in' ? (kundNamn || null) : null,
    tid: new Date(tid).toISOString(),
    manuell: true, andradAv: req.user.namn || req.user.username,
  };
  stampling.push(event);
  writeJSON(STAMPLING_FILE, stampling);
  res.json({ ok: true, event });
});

app.patch('/api/stampling/logg/:id', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const stampling = readJSON(STAMPLING_FILE, []);
  const idx = stampling.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Stämpling hittades ej' });

  const befintlig = stampling[idx];
  const userId = req.body.userId || befintlig.userId;
  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.id === userId);
  const faltAttValidera = { typ: req.body.typ ?? befintlig.typ, omrade: req.body.omrade ?? befintlig.omrade, tid: req.body.tid ?? befintlig.tid };
  const felmeddelande = validateStamplingFalt(faltAttValidera, user);
  if (felmeddelande) return res.status(400).json({ error: felmeddelande });

  const uppdaterad = {
    ...befintlig,
    userId, namn: user.namn,
    typ: faltAttValidera.typ,
    omrade: faltAttValidera.typ === 'in' ? faltAttValidera.omrade : null,
    kundId: faltAttValidera.typ === 'in' ? (req.body.kundId ?? befintlig.kundId ?? null) : null,
    kundNamn: faltAttValidera.typ === 'in' ? (req.body.kundNamn ?? befintlig.kundNamn ?? null) : null,
    tid: new Date(faltAttValidera.tid).toISOString(),
    manuell: true, andradAv: req.user.namn || req.user.username,
  };
  stampling[idx] = uppdaterad;
  writeJSON(STAMPLING_FILE, stampling);
  res.json({ ok: true, event: uppdaterad });
});

app.delete('/api/stampling/logg/:id', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const stampling = readJSON(STAMPLING_FILE, []);
  const kvar = stampling.filter(e => e.id !== req.params.id);
  if (kvar.length === stampling.length) return res.status(404).json({ error: 'Stämpling hittades ej' });
  writeJSON(STAMPLING_FILE, kvar);
  res.json({ ok: true });
});

// --- PUSH NOTIFICATIONS ---
app.get('/api/push/vapidkey', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Ogiltig prenumeration' });
  const subs = readJSON(PUSH_SUBS_FILE, {});
  subs[req.user.username] = sub;
  writeJSON(PUSH_SUBS_FILE, subs);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', authMiddleware, (req, res) => {
  const subs = readJSON(PUSH_SUBS_FILE, {});
  delete subs[req.user.username];
  writeJSON(PUSH_SUBS_FILE, subs);
  res.json({ ok: true });
});

// --- ÄNDRINGSLOGG ---
app.get('/api/changes', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Ej behörighet' });
  const changes = readJSON(CHANGES_FILE, []);
  const { produktId } = req.query;
  const result = produktId ? changes.filter(c => c.produktId === produktId) : changes;
  res.json(result.slice(-200).reverse());
});

app.post('/api/changes', authMiddleware, (req, res) => {
  const { produktId, produktNamn, andringar } = req.body;
  if (!produktId || !andringar) return res.status(400).json({ error: 'Saknar data' });
  const changes = readJSON(CHANGES_FILE, []);
  changes.push({
    id: Date.now().toString(),
    tid: new Date().toISOString(),
    user: req.user.namn,
    username: req.user.username,
    produktId,
    produktNamn,
    andringar,
  });
  if (changes.length > 1000) changes.splice(0, changes.length - 1000);
  writeJSON(CHANGES_FILE, changes);
  res.json({ ok: true });
});

// --- KUNDER ---
app.get('/api/kunder', authMiddleware, (req, res) => {
  res.json(readJSON(KUNDER_FILE, []));
});

app.post('/api/kunder', authMiddleware, (req, res) => {
  const { namn, farg, ase60ProjectId, matt } = req.body;
  if (!namn?.trim()) return res.status(400).json({ error: 'Namn krävs' });
  const kunder = readJSON(KUNDER_FILE, []);
  const ny = {
    id: Date.now().toString(),
    namn: namn.trim(),
    skapad: new Date().toISOString(),
    skapadAv: req.user.namn,
    farg: farg || '',
    ase60ProjectId: ase60ProjectId || null,
    matt: Array.isArray(matt) ? matt : [],
  };
  kunder.push(ny);
  writeJSON(KUNDER_FILE, kunder);
  res.json(ny);
});

// Upsert: ASE60-projekt visas som kunder utan att finnas i kunder.json,
// så material/klart-status skapas vid första sparningen
app.put('/api/kunder/:id', authMiddleware, (req, res) => {
  const kunder = readJSON(KUNDER_FILE, []);
  let idx = kunder.findIndex(k => k.id === req.params.id);
  if (idx === -1) {
    const { namn, farg, ase60ProjectId, matt } = req.body || {};
    kunder.push({
      id: req.params.id,
      namn: (namn || '').trim() || req.params.id,
      skapad: new Date().toISOString(),
      skapadAv: req.user.namn,
      farg: farg || '',
      ase60ProjectId: ase60ProjectId || null,
      matt: Array.isArray(matt) ? matt : [],
    });
    idx = kunder.length - 1;
  }
  const { material, klart, logg } = req.body || {};
  if (material !== undefined) kunder[idx].material = material;
  if (klart !== undefined) kunder[idx].klart = klart;
  if (logg !== undefined) kunder[idx].logg = logg;
  writeJSON(KUNDER_FILE, kunder);
  res.json(kunder[idx]);
});

// ASE60-generatorns API: 3017 på servern, 3000 lokalt (dev). Provar i ordning.
const ASE60_BASES = [process.env.ASE60_URL || 'http://localhost:3017', 'http://localhost:3000'];
async function ase60Fetch(apiPath, opts) {
  let senasteFel = new Error('ASE60 unreachable');
  for (const base of ASE60_BASES) {
    try {
      return await fetch(base + apiPath, opts);
    } catch (e) { senasteFel = e; }
  }
  throw senasteFel;
}

// Proxy ASE60 projects for linking to customers
app.get('/api/ase60-projekt', authMiddleware, async (req, res) => {
  try {
    const r = await ase60Fetch('/api/projects');
    const data = await r.json();
    res.json(data.projects || []);
  } catch {
    res.json([]);
  }
});

// Profiloptimering från ASE60 för ett projekt: antal stänger per profil och lagerlängd.
// Serien (82/92) är redan invald i profilerna som optimeringen använder.
app.get('/api/ase60-optimering/:projectId', authMiddleware, async (req, res) => {
  try {
    const pr = await ase60Fetch(`/api/projects/${encodeURIComponent(req.params.projectId)}`);
    if (!pr.ok) return res.status(404).json({ error: 'Projektet hittades inte i ASE60-generatorn' });
    const proj = await pr.json();
    if (!Array.isArray(proj.units) || proj.units.length === 0) {
      return res.json({ projekt: proj.name || '', serier: [], profiler: [] });
    }
    // Fullstandig materiallista (profiler + beslag/tatningar/glas) — se
    // ase60-generator/server/domain/bom.ts. Ersatte tidigare /api/pack-anropet
    // som bara raknade av de tva raprofilerna (karm + baga).
    const bomR = await ase60Fetch('/api/bom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: proj.units }),
    });
    if (!bomR.ok) return res.status(502).json({ error: 'Materiallistan misslyckades i ASE60-generatorn' });
    const bomResult = await bomR.json();
    const profiler = (bomResult.lines || []).map(l => ({
      artikel: l.art,
      beskrivning: l.desc,
      langdMm: l.lengthMm || null,
      antal: l.qty,
    }));
    const serier = [...new Set(proj.units.map(u => u && u.series).filter(Boolean))];
    res.json({ projekt: proj.name || '', serier, profiler, bomWarnings: bomResult.warnings || [] });
  } catch {
    res.status(502).json({ error: 'Kunde inte nå ASE60-generatorn' });
  }
});

// --- ECW-FILER (läsa/ladda ner — autentiserade endpoints) ---
const ECW_DIR = path.join(DATA_DIR, 'ecw');
const ECW_INDEX_FILE = path.join(DATA_DIR, 'ecw.json');
if (!fs.existsSync(ECW_DIR)) fs.mkdirSync(ECW_DIR, { recursive: true });
if (!fs.existsSync(ECW_INDEX_FILE)) writeJSON(ECW_INDEX_FILE, []);

// Lista ECW-filer för ett projekt (autentiserat)
app.get('/api/ecw-filer/:ase60ProjectId', authMiddleware, (req, res) => {
  const index = readJSON(ECW_INDEX_FILE, []);
  const filer = index.filter(f => f.projectId === req.params.ase60ProjectId);
  res.json(filer.map(f => ({ id: f.id, filename: f.filename, skapad: f.skapad, projectName: f.projectName })));
});

// Ladda ner en ECW-fil
app.get('/api/ecw-filer/:ase60ProjectId/:id/ladda-ner', authMiddleware, (req, res) => {
  const index = readJSON(ECW_INDEX_FILE, []);
  const fil = index.find(f => f.projectId === req.params.ase60ProjectId && f.id === req.params.id);
  if (!fil || !fs.existsSync(fil.filePath)) return res.status(404).json({ error: 'Fil hittades ej' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${fil.filename}"`);
  res.sendFile(path.resolve(fil.filePath));
});

// Ta bort en ECW-fil (admin only)
app.delete('/api/ecw-filer/:ase60ProjectId/:id', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Kräver admin' });
  const index = readJSON(ECW_INDEX_FILE, []);
  const idx = index.findIndex(f => f.projectId === req.params.ase60ProjectId && f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Fil hittades ej' });
  const fil = index[idx];
  try { if (fs.existsSync(fil.filePath)) fs.unlinkSync(fil.filePath); } catch {}
  index.splice(idx, 1);
  writeJSON(ECW_INDEX_FILE, index);
  res.json({ ok: true });
});

app.delete('/api/kunder/:id', authMiddleware, (req, res) => {
  const kunder = readJSON(KUNDER_FILE, []);
  const kvar = kunder.filter(k => k.id !== req.params.id);
  if (kvar.length === kunder.length) return res.status(404).json({ error: 'Kund hittades ej' });
  writeJSON(KUNDER_FILE, kvar);
  res.json({ ok: true });
});

// --- PDF-DOKUMENT per kund/projekt (print-HTML från ASE60) ---
const PDF_INDEX_FILE = path.join(__dirname, 'data', 'pdf.json');

app.get('/api/pdf-filer/:ase60ProjectId', authMiddleware, (req, res) => {
  const index = readJSON(PDF_INDEX_FILE, []);
  const filer = index.filter(f => f.projectId === req.params.ase60ProjectId);
  res.json(filer.map(f => ({ id: f.id, filename: f.filename, skapad: f.skapad, projectName: f.projectName })));
});

// Visa dokumentet i webbläsaren (öppnas i flik → skriv ut/spara som PDF där)
app.get('/api/pdf-filer/:ase60ProjectId/:id/visa', authMiddleware, (req, res) => {
  const index = readJSON(PDF_INDEX_FILE, []);
  const fil = index.find(f => f.projectId === req.params.ase60ProjectId && f.id === req.params.id);
  if (!fil || !fs.existsSync(fil.filePath)) return res.status(404).json({ error: 'Fil hittades ej' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(fil.filePath));
});

app.delete('/api/pdf-filer/:ase60ProjectId/:id', authMiddleware, (req, res) => {
  if (req.user.roll !== 'admin') return res.status(403).json({ error: 'Kräver admin' });
  const index = readJSON(PDF_INDEX_FILE, []);
  const idx = index.findIndex(f => f.projectId === req.params.ase60ProjectId && f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Fil hittades ej' });
  try { if (fs.existsSync(index[idx].filePath)) fs.unlinkSync(index[idx].filePath); } catch {}
  index.splice(idx, 1);
  writeJSON(PDF_INDEX_FILE, index);
  res.json({ ok: true });
});

// --- ECW-KÖRNINGAR (integration från ase60-generatorn) ---
// POST kräver antingen maskinnyckel (x-api-key) eller inloggad användare.
app.post('/api/ecw-runs', (req, res) => {
  const key = req.headers['x-api-key'];
  const token = req.headers.authorization?.replace('Bearer ', '');
  const tokens = readJSON(TOKENS_FILE, {});
  if (key !== ECW_API_KEY && !(token && tokens[token])) {
    return res.status(401).json({ error: 'Ej behörig' });
  }
  const { projekt, comNo, filnamn, partier, kalla } = req.body || {};
  if (!projekt?.trim()) return res.status(400).json({ error: 'projekt krävs' });
  const runs = readJSON(ECW_RUNS_FILE, []);
  const run = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    tid: new Date().toISOString(),
    projekt: projekt.trim(),
    comNo: comNo || '',
    filnamn: filnamn || '',
    partier: Array.isArray(partier) ? partier : [],
    kalla: kalla || 'ase60-generator',
  };
  runs.push(run);
  if (runs.length > 500) runs.splice(0, runs.length - 500);
  writeJSON(ECW_RUNS_FILE, runs);
  broadcast({ type: 'ecw-run', run });

  // Auto-upsert kundkort från ASE60-exporten: kund med färg + projektkoppling
  // skapas/uppdateras direkt när ECW genereras. Alufräs-fliken räknar sedan
  // profilåtgång via ase60ProjectId och avdraget godkänns i Klart-rutan.
  const { projectId, farg } = req.body || {};
  const kunder = readJSON(KUNDER_FILE, []);
  let idx = projectId ? kunder.findIndex(k => k.ase60ProjectId === projectId) : -1;
  if (idx === -1) idx = kunder.findIndex(k => (k.namn || '').toLowerCase() === projekt.trim().toLowerCase());
  const matt = (Array.isArray(partier) ? partier : [])
    .map(p => ({ widthMm: p.breddMm, heightMm: p.hoejdMm, leaves: p.baagar }))
    .filter(m => m.widthMm && m.heightMm);
  if (idx === -1) {
    kunder.push({
      id: Date.now().toString(),
      namn: projekt.trim(),
      skapad: new Date().toISOString(),
      skapadAv: 'ase60-generator',
      farg: farg || '',
      ase60ProjectId: projectId || null,
      matt,
    });
  } else {
    if (farg) kunder[idx].farg = farg;
    if (projectId) kunder[idx].ase60ProjectId = projectId;
    if (matt.length) kunder[idx].matt = matt;
  }
  writeJSON(KUNDER_FILE, kunder);

  res.json(run);
});

app.get('/api/ecw-runs', authMiddleware, (req, res) => {
  res.json(readJSON(ECW_RUNS_FILE, []).slice(-200).reverse());
});

// --- CHAT ---
app.get('/api/messages', authMiddleware, (req, res) => {
  const messages = readJSON(MESSAGES_FILE, []);
  res.json(messages.slice(-100));
});

app.post('/api/convert-step', authMiddleware, (req, res) => {
  const { filename, content } = req.body || {};
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'STEP content is required' });
  }
  try {
    const btl = convertStepTextToBtl(content, filename || 'model.step');
    res.json({ btl, filename: (filename || 'model.step').replace(/\.[^.]+$/, '.btl') });
  } catch (err) {
    console.error('STEP conversion error:', err);
    res.status(500).json({ error: 'Conversion failed', details: err.message });
  }
});

// --- Artikel-bilder ---
app.use('/artikel-bilder', express.static(path.join(__dirname, 'artikel-bilder')));

// --- Hem-meny (portal mellan systemen på three.nordiska.io) ---
// nginx proxar /start hit; /partiberedning och /produktion är egna
// nginx-redirects (till /ase60/ resp. /UterumLager/) så länkarna funkar
// direkt utan att gå via denna server.
app.get('/start', (req, res) => {
  res.sendFile(path.join(__dirname, 'start.html'));
});

// --- Static web app ---
// Lokalt (utan nginx som strippar prefixet) serveras bygget även under /UterumLager
app.use('/UterumLager', express.static(path.join(__dirname, 'dist')));
app.use(express.static(path.join(__dirname, 'dist')));
app.get(/(.*)/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Bygg appen först: npx expo export --platform web');
});

// --- PDF ---
app.get('/api/pdf/:fil', authMiddleware, (req, res) => {
  const fil = path.basename(req.params.fil);
  const filePath = path.join(DATA_DIR, fil);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fil hittades ej' });
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(filePath);
});

// --- WebSocket (chat) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const tokens = readJSON(TOKENS_FILE, {});
  const user = tokens[token];
  if (!user) { ws.close(4001, 'Ej autentiserad'); return; }

  clients.set(ws, user);
  broadcastOnline();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'chat') {
        const message = {
          id: Date.now().toString(),
          user: user.namn,
          username: user.username,
          avatar: user.avatar || '😀',
          text: msg.text,
          tid: new Date().toISOString(),
        };
        const messages = readJSON(MESSAGES_FILE, []);
        messages.push(message);
        if (messages.length > 500) messages.splice(0, messages.length - 500);
        writeJSON(MESSAGES_FILE, messages);
        broadcast({ type: 'message', message });
        pushChatNotification(message, user.username);
      }
      if (SAMTAL_TYPER.includes(msg.type)) {
        relaySamtalsSignal(ws, user, msg);
      }
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastOnline();
  });
});

function broadcast(data) {
  const json = JSON.stringify(data);
  clients.forEach((_, ws) => { if (ws.readyState === 1) ws.send(json); });
}

// --- SAMTAL (WebRTC-signalering) ---
const SAMTAL_TYPER = ['call-offer', 'call-answer', 'call-ice', 'call-decline', 'call-end'];

function relaySamtalsSignal(avsandareWs, avsandare, msg) {
  const fran = { username: avsandare.username, namn: avsandare.namn, avatar: avsandare.avatar || '😀' };
  const json = JSON.stringify({ ...msg, from: fran });
  let levererat = false;
  clients.forEach((u, klientWs) => {
    if (u.username === msg.to && klientWs !== avsandareWs && klientWs.readyState === 1) {
      klientWs.send(json);
      levererat = true;
    }
  });
  // Om mottagaren svarar/avvisar i en flik: säg åt användarens övriga flikar att sluta ringa
  if (msg.type === 'call-answer' || msg.type === 'call-decline') {
    const taget = JSON.stringify({ type: 'call-taken' });
    clients.forEach((u, klientWs) => {
      if (u.username === avsandare.username && klientWs !== avsandareWs && klientWs.readyState === 1) {
        klientWs.send(taget);
      }
    });
  }
  if (!levererat && msg.type === 'call-offer') {
    if (avsandareWs.readyState === 1) {
      avsandareWs.send(JSON.stringify({ type: 'call-unavailable', to: msg.to }));
    }
    pushMissatSamtal(fran, msg.to);
  }
}

function pushMissatSamtal(fran, tillUsername) {
  const subs = readJSON(PUSH_SUBS_FILE, {});
  const sub = subs[tillUsername];
  if (!sub) return;
  const payload = JSON.stringify({
    title: '📞 Missat samtal',
    body: `${fran.namn} försökte ringa dig`,
    url: '/UterumLager/',
  });
  webpush.sendNotification(sub, payload).catch(() => {
    const subs2 = readJSON(PUSH_SUBS_FILE, {});
    delete subs2[tillUsername];
    writeJSON(PUSH_SUBS_FILE, subs2);
  });
}

function pushChatNotification(message, senderUsername) {
  const subs = readJSON(PUSH_SUBS_FILE, {});
  const onlineUsers = new Set([...clients.values()].map(u => u.username));
  Object.entries(subs).forEach(([username, sub]) => {
    if (username === senderUsername) return;
    if (onlineUsers.has(username)) return; // redan i chatten, behöver ingen push
    const payload = JSON.stringify({
      title: `💬 ${message.user}`,
      body: message.text,
      url: '/UterumLager/',
    });
    webpush.sendNotification(sub, payload).catch(() => {
      // Ta bort ogiltiga prenumerationer
      const subs2 = readJSON(PUSH_SUBS_FILE, {});
      delete subs2[username];
      writeJSON(PUSH_SUBS_FILE, subs2);
    });
  });
}

function broadcastOnline() {
  const setts = new Set();
  const online = [];
  clients.forEach(u => {
    if (setts.has(u.username)) return;
    setts.add(u.username);
    online.push({ namn: u.namn, username: u.username, avatar: u.avatar || '😀' });
  });
  broadcast({ type: 'online', users: online });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`Server kör på http://localhost:${PORT}`));

const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath  = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
  const httpsServer = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
  new WebSocketServer({ server: httpsServer, path: '/ws' }).on('connection', (...args) => wss.emit('connection', ...args));
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => console.log(`HTTPS kör på https://localhost:${HTTPS_PORT}`));
}
