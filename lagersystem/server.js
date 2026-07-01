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
app.use(express.json({ limit: '20mb' }));

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

// Redirect HTTP → HTTPS (only when HTTPS server is running)
app.use((req, res, next) => {
  if (req.protocol === 'http' && req.headers.host) {
    const httpsPort = process.env.HTTPS_PORT || 3443;
    const host = req.headers.host.split(':')[0];
    return res.redirect(301, `https://${host}:${httpsPort}${req.url}`);
  }
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
  res.json(users.map(u => ({ id: u.id, username: u.username, roll: u.role, namn: u.namn })));
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

// Proxy ASE60 projects for linking to customers
app.get('/api/ase60-projekt', authMiddleware, async (req, res) => {
  try {
    const r = await fetch('http://localhost:3017/api/projects');
    const data = await r.json();
    res.json(data.projects || []);
  } catch {
    res.json([]);
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

// --- Static web app ---
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

function pushChatNotification(message, senderUsername) {
  const subs = readJSON(PUSH_SUBS_FILE, {});
  const onlineUsers = new Set([...clients.values()].map(u => u.username));
  Object.entries(subs).forEach(([username, sub]) => {
    if (username === senderUsername) return;
    if (onlineUsers.has(username)) return; // redan i chatten, behöver ingen push
    const payload = JSON.stringify({
      title: `💬 ${message.user}`,
      body: message.text,
      url: '/',
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
  const online = [...clients.values()].map(u => u.namn);
  broadcast({ type: 'online', users: online });
}

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res) => res.sendFile(path.join(distPath, 'index.html')));
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
