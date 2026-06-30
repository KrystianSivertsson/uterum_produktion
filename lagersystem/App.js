import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity,
  FlatList, Modal, Alert, SafeAreaView, StatusBar, Image, Platform, ScrollView,
  useWindowDimensions, Animated
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SEED_PRODUKTER } from './seedData';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { utils, write } from 'xlsx';

const API = typeof window !== 'undefined'
  ? window.location.origin
  : 'http://localhost:3001';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}
const STORAGE_KEY = 'lagersystem_produkter';
const TOKEN_KEY = 'lagersystem_token';
const TEMA_KEY = 'lagersystem_tema';
const FLIKAR = ['Alla produkter', 'Schueco ASE 60', 'Schueco ASS 32', 'Osorterat'];
const RITNINGAR = [{ id: 'ase60', label: 'ASE 60 Ritningar', fil: 'ritningar_ase60.pdf' }];

const TemaContext = React.createContext(null);

const LJUST = {
  bg: '#f0f2f5', header: '#ffffff', headerBorder: '#e0e0e0',
  sidebar: '#1a2235', sidebarText: '#aab', sidebarTextAktiv: '#ffffff',
  sidebarBadge: '#2a3448', sidebarBadgeText: '#778',
  kort: '#ffffff', kortBorder: '#e8eaf0',
  text: '#333333', textMuted: '#888888', textRubrik: '#1a2235',
  input: '#f8f9fa', inputBorder: '#e0e0e0', inputText: '#333333',
  tabellHuvud: '#e8eaf0', tabellHuvudText: '#556',
  rad: '#ffffff', radJamn: '#fafbfc',
  modal: '#ffffff',
  varning: '#fef2f2', varningBorder: '#fca5a5', varningText: '#b91c1c',
  sokInput: '#ffffff',
};

const MÖRKT = {
  bg: '#0f1117', header: '#141926', headerBorder: '#2a3448',
  sidebar: '#0d1422', sidebarText: '#7a8899', sidebarTextAktiv: '#ffffff',
  sidebarBadge: '#1a2438', sidebarBadgeText: '#556',
  kort: '#1a2235', kortBorder: '#2a3448',
  text: '#d0d8e8', textMuted: '#7a8899', textRubrik: '#ffffff',
  input: '#0f1117', inputBorder: '#2a3448', inputText: '#d0d8e8',
  tabellHuvud: '#1a2235', tabellHuvudText: '#7a8899',
  rad: '#1a2235', radJamn: '#151e2e',
  modal: '#1a2235',
  varning: '#2a1515', varningBorder: '#5a2a2a', varningText: '#f87171',
  sokInput: '#0f1117',
};

// ─── Login screen ────────────────────────────────────────────────────────────
function LoginSkarm({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fel, setFel] = useState('');
  const [laddar, setLaddar] = useState(false);

  const logga = async () => {
    if (!username || !password) { setFel('Fyll i alla fält'); return; }
    setLaddar(true); setFel('');
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setFel(data.error || 'Inloggning misslyckades'); }
      else { await AsyncStorage.setItem(TOKEN_KEY, data.token); onLogin(data.user, data.token); }
    } catch { setFel('Kunde inte ansluta till servern (kör server.js?)'); }
    setLaddar(false);
  };

  return (
    <View style={ls.bakgrund}>
      <View style={ls.kort}>
        <Image source={require('./assets/logo.jpg')} style={ls.logo} resizeMode="contain" />
        <Text style={ls.titel}>Logga in</Text>
        {fel ? <View style={ls.felRad}><Text style={ls.felText}>{fel}</Text></View> : null}
        <TextInput style={ls.input} placeholder="Användarnamn" placeholderTextColor="#999"
          value={username} onChangeText={setUsername} autoCapitalize="none" />
        <TextInput style={ls.input} placeholder="Lösenord" placeholderTextColor="#999"
          value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={ls.knapp} onPress={logga} disabled={laddar}>
          <Text style={ls.knappText}>{laddar ? 'Loggar in...' : 'Logga in'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const ls = StyleSheet.create({
  bakgrund: { flex: 1, backgroundColor: '#1a2235', justifyContent: 'center', alignItems: 'center' },
  kort: { backgroundColor: '#fff', borderRadius: 16, padding: 40, width: 400, alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 24 },
  logo: { width: 200, height: 55, marginBottom: 24 },
  titel: { fontSize: 22, fontWeight: '700', color: '#1a2235', marginBottom: 20 },
  felRad: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 10, width: '100%', marginBottom: 12 },
  felText: { color: '#b91c1c', textAlign: 'center' },
  input: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
    padding: 12, fontSize: 14, color: '#333', width: '100%', marginBottom: 12 },
  knapp: { backgroundColor: '#2563eb', borderRadius: 8, padding: 14, width: '100%', alignItems: 'center' },
  knappText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});

// ─── User management ─────────────────────────────────────────────────────────
function AnvandarHantering({ token, onStang }) {
  const { c } = React.useContext(TemaContext) || { c: LJUST };
  const [anvandare, setAnvandare] = useState([]);
  const [nyttNamn, setNyttNamn] = useState('');
  const [nyttLosen, setNyttLosen] = useState('');
  const [nyttRoll, setNyttRoll] = useState('user');
  const [nyttVisningsnamn, setNyttVisningsnamn] = useState('');
  const [fel, setFel] = useState('');

  useEffect(() => { hamtaAnvandare(); }, []);

  const hamtaAnvandare = async () => {
    const res = await fetch(`${API}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setAnvandare(await res.json());
  };

  const laggTill = async () => {
    if (!nyttNamn || !nyttLosen) { setFel('Fyll i användarnamn och lösenord'); return; }
    const res = await fetch(`${API}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username: nyttNamn, password: nyttLosen, roll: nyttRoll, namn: nyttVisningsnamn || nyttNamn }),
    });
    const data = await res.json();
    if (!res.ok) { setFel(data.error); return; }
    setNyttNamn(''); setNyttLosen(''); setNyttVisningsnamn(''); setFel('');
    hamtaAnvandare();
  };

  const taBort = async (id) => {
    await fetch(`${API}/api/users/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    hamtaAnvandare();
  };

  return (
    <Modal visible animationType="fade" transparent>
      <View style={um.bakgrund}>
        <View style={[um.panel, { backgroundColor: c.modal }]}>
          <View style={um.rubrikRad}>
            <Text style={[um.rubrik, { color: c.textRubrik }]}>Hantera användare</Text>
            <TouchableOpacity onPress={onStang}><Text style={[um.stang, { color: c.textMuted }]}>✕</Text></TouchableOpacity>
          </View>
          <FlatList
            data={anvandare}
            keyExtractor={i => i.id}
            style={{ maxHeight: 220, marginBottom: 16 }}
            renderItem={({ item }) => (
              <View style={[um.rad, { borderBottomColor: c.kortBorder }]}>
                <View>
                  <Text style={[um.radNamn, { color: c.textRubrik }]}>{item.namn}</Text>
                  <Text style={[um.radUser, { color: c.textMuted }]}>@{item.username} · {item.roll}</Text>
                </View>
                {item.username !== 'admin' &&
                  <TouchableOpacity style={um.taBortKnapp} onPress={() => taBort(item.id)}>
                    <Text style={um.taBortText}>Ta bort</Text>
                  </TouchableOpacity>}
              </View>
            )}
          />
          <Text style={[um.sektionRubrik, { color: c.textMuted }]}>Lägg till användare</Text>
          {fel ? <Text style={{ color: '#ef4444', marginBottom: 8 }}>{fel}</Text> : null}
          <TextInput style={[um.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Visningsnamn" placeholderTextColor={c.textMuted} value={nyttVisningsnamn} onChangeText={setNyttVisningsnamn} />
          <TextInput style={[um.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Användarnamn *" placeholderTextColor={c.textMuted} value={nyttNamn} onChangeText={setNyttNamn} autoCapitalize="none" />
          <TextInput style={[um.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Lösenord *" placeholderTextColor={c.textMuted} value={nyttLosen} onChangeText={setNyttLosen} secureTextEntry />
          <View style={um.rollRad}>
            {['user','admin'].map(r => (
              <TouchableOpacity key={r} style={[um.rollKnapp, { backgroundColor: c.input }, nyttRoll===r && um.rollAktiv]} onPress={() => setNyttRoll(r)}>
                <Text style={[um.rollText, { color: c.text }, nyttRoll===r && um.rollTextAktiv]}>{r === 'admin' ? 'Admin' : 'Användare'}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={um.laggKnapp} onPress={laggTill}>
            <Text style={um.laggText}>+ Lägg till</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const um = StyleSheet.create({
  bakgrund: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  panel: { backgroundColor: '#fff', borderRadius: 16, padding: 28, width: 460,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20 },
  rubrikRad: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  rubrik: { fontSize: 18, fontWeight: '700', color: '#1a2235' },
  stang: { fontSize: 20, color: '#888' },
  rad: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  radNamn: { fontSize: 14, fontWeight: '600', color: '#1a2235' },
  radUser: { fontSize: 12, color: '#888', marginTop: 2 },
  taBortKnapp: { backgroundColor: '#fee2e2', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  taBortText: { color: '#ef4444', fontSize: 13, fontWeight: '600' },
  sektionRubrik: { fontSize: 14, fontWeight: '700', color: '#556', textTransform: 'uppercase',
    letterSpacing: 0.5, marginTop: 8, marginBottom: 12 },
  input: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8,
    padding: 10, fontSize: 14, color: '#333', marginBottom: 10 },
  rollRad: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  rollKnapp: { flex: 1, backgroundColor: '#f0f2f5', borderRadius: 8, padding: 10, alignItems: 'center' },
  rollAktiv: { backgroundColor: '#2563eb' },
  rollText: { color: '#555', fontWeight: '600' },
  rollTextAktiv: { color: '#fff' },
  laggKnapp: { backgroundColor: '#16a34a', borderRadius: 8, padding: 12, alignItems: 'center' },
  laggText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

// ─── Profile modal ───────────────────────────────────────────────────────────
const AVATARER = ['😀','😎','🧑‍💻','👷','🧰','🔧','📦','🏗️','🪟','🏠','⭐','🦊','🐺','🦁','🐻','🐼','🤖','👾'];

function ProfilModal({ user, token, onStang, onUppdatera, prenumereraPush }) {
  const { c } = React.useContext(TemaContext) || { c: LJUST };
  const [fliken, setFliken] = useState('avatar');
  const [valdAvatar, setValdAvatar] = useState(user.avatar || '😀');
  const [gammalt, setGammalt] = useState('');
  const [nytt, setNytt] = useState('');
  const [bekrafta, setBekrafta] = useState('');
  const [meddelande, setMeddelande] = useState('');
  const [fel, setFel] = useState('');
  const [notisStatus, setNotisStatus] = useState(() => {
    if (typeof Notification === 'undefined') return 'ej-stödd';
    return Notification.permission;
  });

  const aktiveraNotisar = async () => {
    setFel(''); setMeddelande('');
    if (!window.isSecureContext) {
      setFel('Kräver HTTPS — gå till https://' + window.location.hostname + ':3443');
      return;
    }
    try {
      await prenumereraPush(token);
      setNotisStatus(Notification.permission);
      if (Notification.permission === 'granted') setMeddelande('Notiser aktiverade!');
      else setFel('Notisbehörighet nekades');
    } catch (e) {
      setFel('Fel: ' + e.message);
    }
  };

  const sparaAvatar = async () => {
    setFel(''); setMeddelande('');
    const res = await fetch(`${API}/api/me/avatar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ avatar: valdAvatar }),
    });
    if (res.ok) { setMeddelande('Avatar sparad!'); onUppdatera({ ...user, avatar: valdAvatar }); }
    else setFel('Kunde inte spara');
  };

  const bytaLosen = async () => {
    setFel(''); setMeddelande('');
    if (nytt !== bekrafta) { setFel('Lösenorden matchar inte'); return; }
    if (nytt.length < 4) { setFel('Minst 4 tecken'); return; }
    const res = await fetch(`${API}/api/me/password`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ gammaltLosen: gammalt, nyttLosen: nytt }),
    });
    const data = await res.json();
    if (res.ok) { setMeddelande('Lösenord ändrat!'); setGammalt(''); setNytt(''); setBekrafta(''); }
    else setFel(data.error || 'Misslyckades');
  };

  return (
    <Modal visible animationType="fade" transparent>
      <View style={pm.bakgrund}>
        <View style={[pm.panel, { backgroundColor: c.modal }]}>
          <View style={pm.rubrikRad}>
            <Text style={[pm.rubrik, { color: c.textRubrik }]}>Min profil</Text>
            <TouchableOpacity onPress={onStang}><Text style={[pm.stang, { color: c.textMuted }]}>✕</Text></TouchableOpacity>
          </View>

          <View style={[pm.anvInfo, { backgroundColor: c.input }]}>
            <Text style={pm.bigAvatar}>{user.avatar || '😀'}</Text>
            <View>
              <Text style={[pm.anvNamn, { color: c.textRubrik }]}>{user.namn}</Text>
              <Text style={[pm.anvUser, { color: c.textMuted }]}>@{user.username} · {user.roll}</Text>
            </View>
          </View>

          <View style={pm.flikar}>
            {['avatar','lösenord','notiser'].map(f => (
              <TouchableOpacity key={f} style={[pm.flik, { backgroundColor: c.input }, fliken===f && pm.flikAktiv]} onPress={() => { setFliken(f); setFel(''); setMeddelande(''); }}>
                <Text style={[pm.flikText, { color: c.text }, fliken===f && pm.flikTextAktiv]}>
                  {f === 'avatar' ? '🖼 Avatar' : f === 'lösenord' ? '🔒 Lösenord' : '🔔 Notiser'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {meddelande ? <View style={pm.okRad}><Text style={pm.okText}>✓ {meddelande}</Text></View> : null}
          {fel ? <View style={pm.felRad}><Text style={pm.felText}>{fel}</Text></View> : null}

          {fliken === 'avatar' && (
            <View>
              <View style={pm.avatarGrid}>
                {AVATARER.map(a => (
                  <TouchableOpacity key={a} style={[pm.avatarKnapp, { backgroundColor: c.input }, valdAvatar===a && pm.avatarAktiv]} onPress={() => setValdAvatar(a)}>
                    <Text style={pm.avatarEmoji}>{a}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={pm.sparaKnapp} onPress={sparaAvatar}>
                <Text style={pm.sparaText}>Spara avatar</Text>
              </TouchableOpacity>
            </View>
          )}

          {fliken === 'lösenord' && (
            <View>
              <TextInput style={[pm.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Nuvarande lösenord" placeholderTextColor={c.textMuted}
                value={gammalt} onChangeText={setGammalt} secureTextEntry />
              <TextInput style={[pm.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Nytt lösenord" placeholderTextColor={c.textMuted}
                value={nytt} onChangeText={setNytt} secureTextEntry />
              <TextInput style={[pm.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Bekräfta nytt lösenord" placeholderTextColor={c.textMuted}
                value={bekrafta} onChangeText={setBekrafta} secureTextEntry />
              <TouchableOpacity style={pm.sparaKnapp} onPress={bytaLosen}>
                <Text style={pm.sparaText}>Byt lösenord</Text>
              </TouchableOpacity>
            </View>
          )}

          {fliken === 'notiser' && (
            <View style={{ paddingTop: 8 }}>
              <View style={[pm.notisInfoRad, { borderBottomColor: c.kortBorder }]}>
                <Text style={[pm.notisLabel, { color: c.textMuted }]}>Protokoll:</Text>
                <Text style={[pm.notisVarde, { color: c.text }]}>{typeof window !== 'undefined' ? window.location.protocol : '–'}</Text>
              </View>
              <View style={[pm.notisInfoRad, { borderBottomColor: c.kortBorder }]}>
                <Text style={[pm.notisLabel, { color: c.textMuted }]}>Behörighet:</Text>
                <Text style={[pm.notisVarde, { color: c.text }, notisStatus === 'granted' && { color: '#16a34a' }, notisStatus === 'denied' && { color: '#ef4444' }]}>
                  {notisStatus === 'granted' ? '✓ Tillåten' : notisStatus === 'denied' ? '✗ Nekad' : notisStatus === 'ej-stödd' ? 'Stöds ej' : 'Ej vald'}
                </Text>
              </View>
              {notisStatus === 'denied' && (
                <Text style={[pm.notisHjälp, { color: c.textMuted }]}>Notiser är blockerade i webbläsaren. Gå till Chrome-inställningar → Webbplatsinställningar → Notiser och tillåt denna sida.</Text>
              )}
              {notisStatus !== 'granted' && notisStatus !== 'denied' && (
                <TouchableOpacity style={pm.sparaKnapp} onPress={aktiveraNotisar}>
                  <Text style={pm.sparaText}>🔔 Aktivera notiser</Text>
                </TouchableOpacity>
              )}
              {notisStatus === 'granted' && (
                <Text style={{ color: '#16a34a', textAlign: 'center', marginTop: 8 }}>Notiser är aktiverade ✓</Text>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const pm = StyleSheet.create({
  bakgrund: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  panel: { backgroundColor: '#fff', borderRadius: 16, padding: 28, width: 420, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20 },
  rubrikRad: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  rubrik: { fontSize: 18, fontWeight: '700', color: '#1a2235' },
  stang: { fontSize: 20, color: '#888' },
  anvInfo: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#f8f9fa', borderRadius: 12, padding: 14, marginBottom: 16 },
  bigAvatar: { fontSize: 40 },
  anvNamn: { fontSize: 16, fontWeight: '700', color: '#1a2235' },
  anvUser: { fontSize: 13, color: '#888', marginTop: 2 },
  flikar: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  flik: { flex: 1, backgroundColor: '#f0f2f5', borderRadius: 8, padding: 10, alignItems: 'center' },
  flikAktiv: { backgroundColor: '#2563eb' },
  flikText: { color: '#555', fontWeight: '600', fontSize: 13 },
  flikTextAktiv: { color: '#fff' },
  okRad: { backgroundColor: '#dcfce7', borderRadius: 8, padding: 10, marginBottom: 12 },
  okText: { color: '#16a34a', fontWeight: '600' },
  felRad: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 10, marginBottom: 12 },
  felText: { color: '#b91c1c' },
  avatarGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  avatarKnapp: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#f0f2f5', justifyContent: 'center', alignItems: 'center' },
  avatarAktiv: { backgroundColor: '#dbeafe', borderWidth: 2, borderColor: '#2563eb' },
  avatarEmoji: { fontSize: 24 },
  input: { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, padding: 12, fontSize: 14, color: '#333', marginBottom: 10 },
  sparaKnapp: { backgroundColor: '#2563eb', borderRadius: 8, padding: 13, alignItems: 'center' },
  sparaText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  notisInfoRad: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  notisLabel: { color: '#888', fontSize: 14 },
  notisVarde: { fontSize: 14, fontWeight: '600', color: '#1a2235' },
  notisHjälp: { color: '#888', fontSize: 12, marginTop: 12, lineHeight: 18 },
});

// ─── Chat panel ───────────────────────────────────────────────────────────────
function ChatPanel({ user, onStang, meddelanden, online, wsRef }) {
  const { c } = React.useContext(TemaContext) || { c: LJUST };
  const [text, setText] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 50);
  }, [meddelanden]);

  const skicka = () => {
    const trimmed = text.trim();
    if (!trimmed || !wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(JSON.stringify({ type: 'chat', text: trimmed }));
    setText('');
  };

  const formatTid = (iso) => {
    const d = new Date(iso);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  };

  return (
    <View style={[cp.panel, { backgroundColor: c.modal, borderColor: c.kortBorder }]}>
      <View style={cp.header}>
        <View>
          <Text style={cp.rubrik}>💬 Chat</Text>
          {online.length > 0 && <Text style={cp.online}>Online: {online.join(', ')}</Text>}
        </View>
        <TouchableOpacity onPress={onStang}><Text style={cp.stang}>✕</Text></TouchableOpacity>
      </View>
      <ScrollView ref={listRef} style={[cp.lista, { backgroundColor: c.bg }]} contentContainerStyle={{ padding: 12 }}>
        {meddelanden.map(m => {
          const arJag = m.username === user.username;
          return (
            <View key={m.id} style={[cp.bubblaWrap, arJag && cp.bubblaWrapJag]}>
              {!arJag && <Text style={[cp.avsandare, { color: c.textMuted }]}>{m.user}</Text>}
              <View style={[cp.bubbla, { backgroundColor: c.kort, borderColor: c.kortBorder }, arJag && cp.bubblaJag]}>
                <Text style={[cp.bubblaText, { color: c.text }, arJag && cp.bubblaTextJag]}>{m.text}</Text>
              </View>
              <Text style={[cp.tid, { color: c.textMuted }]}>{formatTid(m.tid)}</Text>
            </View>
          );
        })}
      </ScrollView>
      <View style={[cp.inputRad, { backgroundColor: c.modal, borderTopColor: c.kortBorder }]}>
        <TextInput
          style={[cp.input, { backgroundColor: c.input, color: c.inputText }]}
          placeholder="Skriv ett meddelande..."
          placeholderTextColor={c.textMuted}
          value={text}
          onChangeText={setText}
          onSubmitEditing={skicka}
          returnKeyType="send"
        />
        <TouchableOpacity style={cp.skickaKnapp} onPress={skicka}>
          <Text style={cp.skickaText}>↑</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const cp = StyleSheet.create({
  panel: { position: 'absolute', right: 20, bottom: 20, width: 360, height: 480,
    backgroundColor: '#fff', borderRadius: 16, shadowColor: '#000', shadowOpacity: 0.2,
    shadowRadius: 20, elevation: 10, zIndex: 100, overflow: 'hidden',
    borderWidth: 1, borderColor: '#e0e0e0' },
  header: { backgroundColor: '#1a2235', padding: 14, flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center' },
  rubrik: { color: '#fff', fontWeight: '700', fontSize: 15 },
  online: { color: '#7dd3fc', fontSize: 11, marginTop: 2 },
  stang: { color: '#fff', fontSize: 18 },
  lista: { flex: 1, backgroundColor: '#f8f9fa' },
  bubblaWrap: { marginBottom: 10, alignItems: 'flex-start' },
  bubblaWrapJag: { alignItems: 'flex-end' },
  avsandare: { fontSize: 11, color: '#888', marginBottom: 3, marginLeft: 4 },
  bubbla: { backgroundColor: '#fff', borderRadius: 12, borderBottomLeftRadius: 2,
    paddingHorizontal: 12, paddingVertical: 8, maxWidth: 260,
    borderWidth: 1, borderColor: '#e0e0e0' },
  bubblaJag: { backgroundColor: '#2563eb', borderColor: '#2563eb', borderBottomLeftRadius: 12, borderBottomRightRadius: 2 },
  bubblaText: { color: '#333', fontSize: 14 },
  bubblaTextJag: { color: '#fff' },
  tid: { fontSize: 10, color: '#bbb', marginTop: 2, marginHorizontal: 4 },
  inputRad: { flexDirection: 'row', padding: 10, borderTopWidth: 1, borderTopColor: '#e0e0e0',
    backgroundColor: '#fff', gap: 8 },
  input: { flex: 1, backgroundColor: '#f0f2f5', borderRadius: 20, paddingHorizontal: 14,
    paddingVertical: 8, fontSize: 14, color: '#333' },
  skickaKnapp: { backgroundColor: '#2563eb', borderRadius: 20, width: 38, height: 38,
    justifyContent: 'center', alignItems: 'center' },
  skickaText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});

// ─── Chat Bubble (Messenger-stil) ─────────────────────────────────────────────
function ChatBubble({ senasteMeddelande, antal, onPress }) {
  const scale = useRef(new Animated.Value(0)).current;
  const bounce = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!senasteMeddelande) return;
    scale.setValue(0);
    bounce.setValue(0);
    Animated.sequence([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 200, friction: 8 }),
      Animated.sequence([
        Animated.timing(bounce, { toValue: -12, duration: 120, useNativeDriver: true }),
        Animated.spring(bounce, { toValue: 0, useNativeDriver: true, tension: 300, friction: 6 }),
      ]),
    ]).start();
  }, [senasteMeddelande]);

  if (!senasteMeddelande) return null;

  return (
    <Animated.View style={[cb.wrap, { transform: [{ scale }, { translateY: bounce }] }]}>
      <TouchableOpacity style={cb.bubbla} onPress={onPress} activeOpacity={0.85}>
        <Text style={cb.avatar}>{senasteMeddelande.avatar || '😀'}</Text>
        {antal > 0 && (
          <View style={cb.badge}>
            <Text style={cb.badgeText}>{antal > 9 ? '9+' : antal}</Text>
          </View>
        )}
      </TouchableOpacity>
      <View style={cb.tooltip}>
        <Text style={cb.tooltipNamn}>{senasteMeddelande.user}</Text>
        <Text style={cb.tooltipText} numberOfLines={1}>{senasteMeddelande.text}</Text>
      </View>
    </Animated.View>
  );
}

const cb = StyleSheet.create({
  wrap: { position: 'absolute', bottom: 100, right: 24, alignItems: 'flex-end', zIndex: 200 },
  bubbla: {
    width: 58, height: 58, borderRadius: 29,
    backgroundColor: '#1a2235',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, elevation: 12,
    borderWidth: 2.5, borderColor: '#2563eb',
  },
  avatar: { fontSize: 28 },
  badge: {
    position: 'absolute', top: -2, right: -2,
    backgroundColor: '#ef4444', borderRadius: 10,
    minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 4, borderWidth: 1.5, borderColor: '#fff',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  tooltip: {
    marginTop: 6, backgroundColor: '#1a2235', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 7, maxWidth: 200,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6,
  },
  tooltipNamn: { color: '#7dd3fc', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  tooltipText: { color: '#e0e0e0', fontSize: 12 },
});

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [inloggad, setInloggad] = useState(null);
  const [token, setToken] = useState(null);
  const [kollarSession, setKollarSession] = useState(true);

  const [produkter, setProdukter] = useState([]);
  const [aktivFlik, setAktivFlik] = useState('Alla produkter');
  const [sok, setSok] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [redigeraProdukt, setRedigeraProdukt] = useState(null);
  const [formNamn, setFormNamn] = useState('');
  const [formAntal, setFormAntal] = useState('');
  const [formKategori, setFormKategori] = useState('');
  const [formMinAntal, setFormMinAntal] = useState('5');
  const [formEnhet, setFormEnhet] = useState('st');
  const [visaAnvandare, setVisaAnvandare] = useState(false);
  const [visaChat, setVisaChat] = useState(false);
  const [visaProfil, setVisaProfil] = useState(false);
  const [visaSidebar, setVisaSidebar] = useState(false);
  const [sorteringsKolumn, setSorteringsKolumn] = useState(null);
  const [sorteringsRiktning, setSorteringsRiktning] = useState('asc');
  const [tema, setTema] = useState('ljust');
  const c = tema === 'mörkt' ? MÖRKT : LJUST;

  const toggleTema = async () => {
    const nytt = tema === 'ljust' ? 'mörkt' : 'ljust';
    setTema(nytt);
    await AsyncStorage.setItem(TEMA_KEY, nytt);
  };
  const [meddelanden, setMeddelanden] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [chatBubble, setChatBubble] = useState(null);
  const [olastaAntal, setOlastaAntal] = useState(0);
  const wsRef = useRef(null);
  const visaChatRef = useRef(false);
  const { width } = useWindowDimensions();
  const mobil = width < 768;

  useEffect(() => { visaChatRef.current = visaChat; }, [visaChat]);

  useEffect(() => {
    if (!token || Platform.OS !== 'web') return;
    fetch(`${API}/api/messages`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setMeddelanden).catch(() => {});
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws?token=${token}`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'message') {
        setMeddelanden(prev => [...prev, data.message]);
        if (!visaChatRef.current) {
          setChatBubble(data.message);
          setOlastaAntal(n => n + 1);
        }
      }
      if (data.type === 'online') setOnlineUsers(data.users);
    };
    return () => ws.close();
  }, [token]);

  useEffect(() => {
    if (visaChat) { setChatBubble(null); setOlastaAntal(0); }
  }, [visaChat]);

  useEffect(() => {
    kollaSession();
    AsyncStorage.getItem(TEMA_KEY).then(v => { if (v) setTema(v); });
  }, []);
  useEffect(() => { if (inloggad) laddaProdukter(); }, [inloggad]);

  const kollaSession = async () => {
    const sparadToken = await AsyncStorage.getItem(TOKEN_KEY);
    if (sparadToken) {
      try {
        const res = await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${sparadToken}` } });
        if (res.ok) { const user = await res.json(); setInloggad(user); setToken(sparadToken); prenumereraPush(sparadToken); }
      } catch {}
    }
    setKollarSession(false);
  };

  const loggaIn = (user, tok) => { setInloggad(user); setToken(tok); prenumereraPush(tok); };

  const prenumereraPush = async (tok) => {
    if (Platform.OS !== 'web' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch(`${API}/api/push/vapidkey`);
      const { publicKey } = await keyRes.json();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch(`${API}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify(sub),
      });
    } catch (e) { console.warn('Push-prenumeration misslyckades:', e); }
  };

  const loggaUt = async () => {
    try { await fetch(`${API}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
    await AsyncStorage.removeItem(TOKEN_KEY);
    setInloggad(null); setToken(null);
  };

  const laddaProdukter = async () => {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      setProdukter(data ? JSON.parse(data) : SEED_PRODUKTER);
      if (!data) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(SEED_PRODUKTER));
    } catch {}
  };

  const sparaProdukter = async (lista) => {
    try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(lista)); } catch {}
  };

  const arRitning = RITNINGAR.some(r => r.id === aktivFlik);

  const oppnaLaggTill = () => {
    setRedigeraProdukt(null);
    setFormNamn(''); setFormAntal('');
    setFormKategori(aktivFlik === 'Alla produkter' || arRitning ? '' : aktivFlik);
    setFormMinAntal('5');
    setFormEnhet('st');
    setModalVisible(true);
  };

  const oppnaRedigera = (produkt) => {
    setRedigeraProdukt(produkt);
    setFormNamn(produkt.namn);
    setFormAntal(String(produkt.antal));
    setFormKategori(produkt.kategori);
    setFormMinAntal(String(produkt.minAntal));
    setFormEnhet(produkt.enhet || 'st');
    setModalVisible(true);
  };

  const sparaProdukt = () => {
    if (!formNamn.trim()) { Alert.alert('Fel', 'Namn krävs'); return; }
    const antal = parseInt(formAntal) || 0;
    const minAntal = parseInt(formMinAntal) || 5;
    const genomfor = () => {
      let nyLista;
      if (redigeraProdukt) {
        nyLista = produkter.map(p =>
          p.id === redigeraProdukt.id
            ? { ...p, namn: formNamn.trim(), antal, kategori: formKategori.trim(), minAntal, enhet: formEnhet }
            : p
        );
      } else {
        nyLista = [...produkter, {
          id: Date.now().toString(),
          namn: formNamn.trim(), antal,
          kategori: formKategori.trim(), minAntal, enhet: formEnhet,
        }];
      }
      setProdukter(nyLista);
      sparaProdukter(nyLista);
      setModalVisible(false);
    };
    if (redigeraProdukt) {
      Alert.alert('Spara ändring?', '', [
        { text: 'Avbryt', style: 'cancel' },
        { text: 'Spara', onPress: genomfor },
      ]);
    } else {
      genomfor();
    }
  };

  const taBortProdukt = (id) => {
    if (inloggad?.roll !== 'admin') return;
    Alert.alert('Ta bort', 'Är du säker?', [
      { text: 'Avbryt', style: 'cancel' },
      { text: 'Ta bort', style: 'destructive', onPress: () => {
        const nyLista = produkter.filter(p => p.id !== id);
        setProdukter(nyLista); sparaProdukter(nyLista);
      }}
    ]);
  };

  const exporteraExcel = async () => {
    try {
      const lista = filtreradeLista.map(p => ({
        Namn: p.namn, Kategori: p.kategori, Antal: p.antal,
        'Min antal': p.minAntal,
        Status: p.antal <= p.minAntal ? 'Lågt lager' : 'OK',
      }));
      const ws = utils.json_to_sheet(lista);
      const wb = utils.book_new();
      utils.book_append_sheet(wb, ws, 'Lager');
      const csv = write(wb, { type: 'string', bookType: 'csv' });
      const filePath = FileSystem.documentDirectory + 'lagerlista.csv';
      await FileSystem.writeAsStringAsync(filePath, csv);
      await Sharing.shareAsync(filePath);
    } catch { Alert.alert('Fel', 'Kunde inte exportera'); }
  };

  const sortera = (kolumn) => {
    if (sorteringsKolumn === kolumn) {
      setSorteringsRiktning(r => r === 'asc' ? 'desc' : 'asc');
    } else {
      setSorteringsKolumn(kolumn);
      setSorteringsRiktning('asc');
    }
  };

  const filtreradeLista = arRitning ? [] : (() => {
    const filtered = produkter.filter(p => {
      const matcherFlik = aktivFlik === 'Alla produkter' || p.kategori === aktivFlik;
      const matcherSok =
        p.namn.toLowerCase().includes(sok.toLowerCase()) ||
        (p.artikel || '').includes(sok) ||
        p.kategori.toLowerCase().includes(sok.toLowerCase());
      return matcherFlik && matcherSok;
    });
    if (!sorteringsKolumn) return filtered;
    return [...filtered].sort((a, b) => {
      if (sorteringsKolumn === 'antal') {
        return sorteringsRiktning === 'asc' ? a.antal - b.antal : b.antal - a.antal;
      }
      let va, vb;
      if (sorteringsKolumn === 'artikel') { va = (a.artikel || ''); vb = (b.artikel || ''); }
      else if (sorteringsKolumn === 'namn') { va = a.namn; vb = b.namn; }
      else if (sorteringsKolumn === 'kategori') { va = a.kategori; vb = b.kategori; }
      va = va.toLowerCase(); vb = vb.toLowerCase();
      if (va < vb) return sorteringsRiktning === 'asc' ? -1 : 1;
      if (va > vb) return sorteringsRiktning === 'asc' ? 1 : -1;
      return 0;
    });
  })();

  const lagLager = filtreradeLista.filter(p => p.antal <= p.minAntal).length;
  const raknaProdukter = (flik) =>
    flik === 'Alla produkter' ? produkter.length : produkter.filter(p => p.kategori === flik).length;

  if (kollarSession) return <View style={[styles.container, { backgroundColor: c.bg }]} />;
  if (!inloggad) return <TemaContext.Provider value={{ tema, c }}><LoginSkarm onLogin={loggaIn} /></TemaContext.Provider>;

  return (
    <TemaContext.Provider value={{ tema, c, toggleTema }}>
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]}>
      <StatusBar barStyle={tema === 'mörkt' ? 'light-content' : 'dark-content'} backgroundColor={c.header} />

      {/* Header */}
      <View style={[styles.header, { backgroundColor: c.header, borderBottomColor: c.headerBorder }]}>
        <View style={styles.headerVanster}>
          {mobil && (
            <TouchableOpacity style={styles.hamburger} onPress={() => setVisaSidebar(v => !v)}>
              <Text style={[styles.hamburgerText, { color: c.textRubrik }]}>☰</Text>
            </TouchableOpacity>
          )}
          <Image source={require('./assets/logo.jpg')} style={[styles.logo, mobil && { width: 130, height: 38 }]} resizeMode="contain" />
        </View>
        <View style={styles.headerHoger}>
          <TouchableOpacity onPress={toggleTema} style={[styles.headerKnapp, { backgroundColor: c.bg }]}>
            <Text style={styles.headerKnappText}>{tema === 'mörkt' ? '☀️' : '🌙'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setVisaProfil(true)} style={[styles.avatarKnapp, { backgroundColor: c.bg }]}>
            <Text style={styles.avatarEmoji}>{inloggad.avatar || '😀'}</Text>
            {!mobil && <Text style={[styles.headerAnv, { color: c.textMuted }]}>{inloggad.namn}</Text>}
          </TouchableOpacity>
          {inloggad.roll === 'admin' && (
            <TouchableOpacity style={[styles.headerKnapp, { backgroundColor: c.bg }]} onPress={() => setVisaAnvandare(true)}>
              <Text style={[styles.headerKnappText, { color: c.text }]}>{mobil ? '👥' : 'Användare'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.chatHeaderKnapp} onPress={() => setVisaChat(v => !v)}>
            <Text style={styles.headerKnappText}>💬</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.headerKnapp, { backgroundColor: '#fee2e2' }]} onPress={loggaUt}>
            <Text style={[styles.headerKnappText, { color: '#ef4444' }]}>{mobil ? '⏏' : 'Logga ut'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.body}>
        {/* Sidebar overlay på mobil */}
        {mobil && visaSidebar && (
          <TouchableOpacity style={styles.overlay} onPress={() => setVisaSidebar(false)} activeOpacity={1} />
        )}

        {/* Sidebar */}
        {(!mobil || visaSidebar) && <View style={[styles.sidebar, mobil && styles.sidebarMobil, { backgroundColor: c.sidebar }]}>
          <Text style={[styles.sidebarTitel, { color: c.sidebarText }]}>Kategorier</Text>
          {FLIKAR.map(flik => (
            <TouchableOpacity
              key={flik}
              style={[styles.sidebarFlik, aktivFlik === flik && styles.sidebarFlikAktiv]}
              onPress={() => { setAktivFlik(flik); setSok(''); }}
            >
              <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, aktivFlik === flik && styles.sidebarFlikTextAktiv]}>
                {flik}
              </Text>
              <View style={[styles.sidebarBadge, { backgroundColor: c.sidebarBadge }, aktivFlik === flik && styles.sidebarBadgeAktiv]}>
                <Text style={[styles.sidebarBadgeText, { color: c.sidebarBadgeText }, aktivFlik === flik && styles.sidebarBadgeTextAktiv]}>
                  {raknaProdukter(flik)}
                </Text>
              </View>
            </TouchableOpacity>
          ))}

          <View style={styles.sidebarDivider} />

          <Text style={styles.sidebarTitel}>Ritningar</Text>
          {RITNINGAR.map(r => (
            <TouchableOpacity
              key={r.id}
              style={[styles.sidebarFlik, aktivFlik === r.id && styles.sidebarFlikAktiv]}
              onPress={() => { setAktivFlik(r.id); setSok(''); }}
            >
              <Text style={[styles.sidebarFlikText, aktivFlik === r.id && styles.sidebarFlikTextAktiv]}>
                📄 {r.label}
              </Text>
            </TouchableOpacity>
          ))}

          <View style={styles.sidebarDivider} />

          <TouchableOpacity style={styles.laggTillKnapp} onPress={oppnaLaggTill}>
            <Text style={styles.laggTillText}>+ Ny produkt</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.exportKnapp} onPress={exporteraExcel}>
            <Text style={styles.exportText}>↓ Exportera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.chatKnapp} onPress={() => { setVisaChat(v => !v); setVisaSidebar(false); }}>
            <Text style={styles.chatText}>💬 Chat</Text>
          </TouchableOpacity>
        </View>}

        {/* Innehåll */}
        <View style={[styles.innehall, { backgroundColor: c.bg }]}>
          {arRitning && Platform.OS === 'web' && (() => {
            const ritning = RITNINGAR.find(r => r.id === aktivFlik);
            return React.createElement('iframe', {
              key: ritning.id,
              src: `${API}/api/pdf/${ritning.fil}?token=${token}`,
              style: { width: '100%', height: '100%', border: 'none', borderRadius: 8 },
              title: ritning.label,
            });
          })()}

          {!arRitning && <>
            {lagLager > 0 && (
              <View style={[styles.varning, { backgroundColor: c.varning, borderColor: c.varningBorder }]}>
                <Text style={[styles.varningText, { color: c.varningText }]}>⚠️ {lagLager} produkt{lagLager > 1 ? 'er' : ''} har lågt lager</Text>
              </View>
            )}
            <View style={styles.toppRad}>
              <Text style={[styles.kategoriRubrik, { color: c.textRubrik }, mobil && { fontSize: 16 }]}>{aktivFlik}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {mobil && (
                  <View style={{ flexDirection: 'row', gap: 4 }}>
                    <TouchableOpacity
                      style={[styles.sortKnapp, { backgroundColor: sorteringsKolumn === 'artikel' ? '#2563eb' : c.input, borderColor: c.inputBorder }]}
                      onPress={() => sortera('artikel')}>
                      <Text style={[styles.sortText, { color: sorteringsKolumn === 'artikel' ? '#fff' : c.textMuted }]}>
                        Nr {sorteringsKolumn === 'artikel' ? (sorteringsRiktning === 'asc' ? '▲' : '▼') : ''}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.sortKnapp, { backgroundColor: sorteringsKolumn === 'antal' ? '#2563eb' : c.input, borderColor: c.inputBorder }]}
                      onPress={() => sortera('antal')}>
                      <Text style={[styles.sortText, { color: sorteringsKolumn === 'antal' ? '#fff' : c.textMuted }]}>
                        Saldo {sorteringsKolumn === 'antal' ? (sorteringsRiktning === 'asc' ? '▲' : '▼') : ''}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
                <TextInput
                  style={[styles.sokInput, { backgroundColor: c.sokInput, borderColor: c.inputBorder, color: c.text }, mobil && { width: 120, fontSize: 13 }]}
                  placeholder={mobil ? 'Sök...' : 'Sök produkt eller artikelnr...'}
                  placeholderTextColor={c.textMuted}
                  value={sok}
                  onChangeText={setSok}
                />
              </View>
            </View>

            <>
                {!mobil && (
                  <View style={[styles.tabellHuvud, { backgroundColor: c.tabellHuvud }]}>
                    <TouchableOpacity style={{ flex: 1.2, flexDirection: 'row', alignItems: 'center', gap: 4 }} onPress={() => sortera('artikel')}>
                      <Text style={[styles.tabellHuvudText, { color: sorteringsKolumn === 'artikel' ? '#2563eb' : c.tabellHuvudText }]}>Artikelnr</Text>
                      {sorteringsKolumn === 'artikel' && <Text style={{ color: '#2563eb', fontSize: 11 }}>{sorteringsRiktning === 'asc' ? '▲' : '▼'}</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity style={{ flex: 3, flexDirection: 'row', alignItems: 'center', gap: 4 }} onPress={() => sortera('namn')}>
                      <Text style={[styles.tabellHuvudText, { color: sorteringsKolumn === 'namn' ? '#2563eb' : c.tabellHuvudText }]}>Produkt</Text>
                      {sorteringsKolumn === 'namn' && <Text style={{ color: '#2563eb', fontSize: 11 }}>{sorteringsRiktning === 'asc' ? '▲' : '▼'}</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity style={{ flex: 2, flexDirection: 'row', alignItems: 'center', gap: 4 }} onPress={() => sortera('kategori')}>
                      <Text style={[styles.tabellHuvudText, { color: sorteringsKolumn === 'kategori' ? '#2563eb' : c.tabellHuvudText }]}>Kategori</Text>
                      {sorteringsKolumn === 'kategori' && <Text style={{ color: '#2563eb', fontSize: 11 }}>{sorteringsRiktning === 'asc' ? '▲' : '▼'}</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }} onPress={() => sortera('antal')}>
                      <Text style={[styles.tabellHuvudText, { textAlign: 'center', color: sorteringsKolumn === 'antal' ? '#2563eb' : c.tabellHuvudText }]}>Antal</Text>
                      {sorteringsKolumn === 'antal' && <Text style={{ color: '#2563eb', fontSize: 11 }}>{sorteringsRiktning === 'asc' ? '▲' : '▼'}</Text>}
                    </TouchableOpacity>
                    <Text style={[styles.tabellHuvudText, { flex: 1, textAlign: 'center', color: c.tabellHuvudText }]}>Status</Text>
                    <Text style={[styles.tabellHuvudText, { flex: 2, textAlign: 'right', color: c.tabellHuvudText }]}>Åtgärder</Text>
                  </View>
                )}

                <FlatList
                  data={filtreradeLista}
                  keyExtractor={item => item.id}
                  contentContainerStyle={styles.lista}
                  ListEmptyComponent={<Text style={[styles.tomText, { color: c.textMuted }]}>Inga produkter.</Text>}
                  renderItem={({ item, index }) => {
                const lavt = item.antal <= item.minAntal;
                if (mobil) {
                  return (
                    <View style={[styles.kort, { backgroundColor: lavt ? c.varning : c.kort, borderColor: lavt ? c.varningBorder : c.kortBorder }]}>
                      <View style={styles.kortTopp}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.kortNamn, { color: c.textRubrik }]}>{item.namn}</Text>
                          <Text style={[styles.kortArtikel, { color: c.textMuted }]}>{item.artikel || '—'}</Text>
                        </View>
                        <View style={[styles.statusBadge, lavt ? styles.statusLavt : styles.statusOk]}>
                          <Text style={styles.statusText}>{lavt ? 'Lågt' : 'OK'}</Text>
                        </View>
                      </View>
                      <View style={styles.kortBotten}>
                        <Text style={[styles.kortAntal, { color: c.text }]}>
                          Antal: <Text style={[{ fontWeight: '700' }, lavt && styles.radAntalLavt]}>{item.antal}{item.enhet || 'st'}</Text>
                        </Text>
                        <View style={styles.radKnappar}>
                          <TouchableOpacity style={styles.redigeraKnapp} onPress={() => oppnaRedigera(item)}>
                            <Text style={styles.redigeraText}>Redigera</Text>
                          </TouchableOpacity>
                          {inloggad.roll === 'admin' && (
                            <TouchableOpacity style={styles.taBortKnapp} onPress={() => taBortProdukt(item.id)}>
                              <Text style={styles.taBortText}>✕</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    </View>
                  );
                }
                return (
                  <View style={[styles.rad, { backgroundColor: lavt ? c.varning : (index % 2 === 0 ? c.radJamn : c.rad), borderBottomColor: lavt ? c.varningBorder : c.kortBorder }]}>
                    <Text style={[styles.radText, { flex: 1.2, color: c.textMuted }]}>{item.artikel || '—'}</Text>
                    <Text style={[styles.radText, { flex: 3, fontWeight: '600', color: c.textRubrik }]}>{item.namn}</Text>
                    <Text style={[styles.radText, { flex: 2, color: c.text }]}>{item.kategori || '—'}</Text>
                    <Text style={[styles.radText, { flex: 1, textAlign: 'center', color: c.text }, lavt && styles.radAntalLavt]}>{item.antal}{item.enhet || 'st'}</Text>
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <View style={[styles.statusBadge, lavt ? styles.statusLavt : styles.statusOk]}>
                        <Text style={styles.statusText}>{lavt ? 'Lågt' : 'OK'}</Text>
                      </View>
                    </View>
                    <View style={[styles.radKnappar, { flex: 2 }]}>
                      <TouchableOpacity style={styles.redigeraKnapp} onPress={() => oppnaRedigera(item)}>
                        <Text style={styles.redigeraText}>Redigera</Text>
                      </TouchableOpacity>
                      {inloggad.roll === 'admin' && (
                        <TouchableOpacity style={styles.taBortKnapp} onPress={() => taBortProdukt(item.id)}>
                          <Text style={styles.taBortText}>✕</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              }}
            />
          </>
        </>}
        </View>
      </View>

      {/* Chat floating panel */}
      {visaChat && <ChatPanel user={inloggad} onStang={() => setVisaChat(false)} meddelanden={meddelanden} online={onlineUsers} wsRef={wsRef} />}
      {!visaChat && <ChatBubble senasteMeddelande={chatBubble} antal={olastaAntal} onPress={() => setVisaChat(true)} />}

      {visaProfil && <ProfilModal user={inloggad} token={token} onStang={() => setVisaProfil(false)} onUppdatera={(u) => setInloggad(u)} prenumereraPush={prenumereraPush} />}
      {visaAnvandare && <AnvandarHantering token={token} onStang={() => setVisaAnvandare(false)} />}

      {/* Produkt modal */}
      <Modal visible={modalVisible} animationType="fade" transparent>
        <View style={styles.modalBakgrund}>
          <View style={[styles.modalKort, { backgroundColor: c.modal }]}>
            <Text style={[styles.modalTitel, { color: c.textRubrik }]}>{redigeraProdukt ? 'Redigera produkt' : 'Ny produkt'}</Text>
            <TextInput style={[styles.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Produktnamn *" placeholderTextColor={c.textMuted}
              value={formNamn} onChangeText={setFormNamn} />
            <Text style={[styles.inputLabel, { color: c.textMuted }]}>Kategori</Text>
            <View style={styles.kategoriRow}>
              {FLIKAR.filter(f => f !== 'Alla produkter').map(f => (
                <TouchableOpacity key={f}
                  style={[styles.kategoriKnapp, { backgroundColor: c.input }, formKategori === f && styles.kategoriKnappAktiv]}
                  onPress={() => setFormKategori(f)}>
                  <Text style={[styles.kategoriText, { color: c.text }, formKategori === f && styles.kategoriTextAktiv]}>{f}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[styles.inputLabel, { color: c.textMuted }]}>Antal i lager</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <TextInput style={[styles.input, { flex: 1, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Antal" placeholderTextColor={c.textMuted}
                value={formAntal} onChangeText={setFormAntal} keyboardType="numeric" />
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {['st', 'm'].map(e => (
                  <TouchableOpacity key={e}
                    style={[styles.kategoriKnapp, { backgroundColor: c.input, paddingHorizontal: 18 }, formEnhet === e && styles.kategoriKnappAktiv]}
                    onPress={() => setFormEnhet(e)}>
                    <Text style={[styles.kategoriText, { color: c.text }, formEnhet === e && styles.kategoriTextAktiv]}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            {inloggad.roll === 'admin' && (
              <TextInput style={[styles.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Varning vid antal (standard 5)" placeholderTextColor={c.textMuted}
                value={formMinAntal} onChangeText={setFormMinAntal} keyboardType="numeric" />
            )}
            <View style={styles.modalKnappar}>
              <TouchableOpacity style={[styles.avbrytKnapp, { backgroundColor: c.input }]} onPress={() => setModalVisible(false)}>
                <Text style={[styles.avbrytText, { color: c.textMuted }]}>Avbryt</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.sparaKnapp} onPress={sparaProdukt}>
                <Text style={styles.sparaText}>Spara</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
    </TemaContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f2f5' },
  header: {
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: 1, borderBottomColor: '#e0e0e0',
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, elevation: 3,
  },
  headerVanster: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hamburger: { padding: 6 },
  hamburgerText: { fontSize: 22, color: '#1a2235' },
  logo: { width: 200, height: 55 },
  headerHoger: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatarKnapp: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#f0f2f5', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  avatarEmoji: { fontSize: 20 },
  headerAnv: { color: '#555', fontSize: 13 },
  headerKnapp: { backgroundColor: '#f0f2f5', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  chatHeaderKnapp: { backgroundColor: '#1e3a5f', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  headerKnappText: { color: '#333', fontSize: 13, fontWeight: '600' },
  body: { flex: 1, flexDirection: 'row' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 10 },
  sidebar: { width: 220, backgroundColor: '#1a2235', paddingTop: 24, paddingHorizontal: 12 },
  sidebarMobil: { position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 20, elevation: 20 },
  sidebarTitel: { color: '#8899aa', fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
    textTransform: 'uppercase', marginBottom: 10, paddingLeft: 8 },
  sidebarFlik: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, marginBottom: 4 },
  sidebarFlikAktiv: { backgroundColor: '#2563eb' },
  sidebarFlikText: { color: '#aab', fontSize: 14 },
  sidebarFlikTextAktiv: { color: '#fff', fontWeight: '600' },
  sidebarBadge: { backgroundColor: '#2a3448', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  sidebarBadgeAktiv: { backgroundColor: '#1d4ed8' },
  sidebarBadgeText: { color: '#778', fontSize: 12 },
  sidebarBadgeTextAktiv: { color: '#fff' },
  sidebarDivider: { height: 1, backgroundColor: '#2a3448', marginVertical: 16 },
  laggTillKnapp: { backgroundColor: '#16a34a', borderRadius: 8, paddingVertical: 11, alignItems: 'center', marginBottom: 8 },
  laggTillText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  exportKnapp: { backgroundColor: '#2a3448', borderRadius: 8, paddingVertical: 11, alignItems: 'center', marginBottom: 8 },
  exportText: { color: '#aab', fontWeight: '600', fontSize: 14 },
  chatKnapp: { backgroundColor: '#1e3a5f', borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  chatText: { color: '#7dd3fc', fontWeight: '600', fontSize: 14 },
  innehall: { flex: 1, padding: 12, overflow: 'hidden' },
  kort: { backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 8,
    borderWidth: 1, borderColor: '#e8eaf0' },
  kortLavt: { backgroundColor: '#fff5f5', borderColor: '#fca5a5' },
  kortTopp: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  kortNamn: { fontSize: 14, fontWeight: '700', color: '#1a2235', flexWrap: 'wrap' },
  kortArtikel: { fontSize: 12, color: '#888', marginTop: 2 },
  kortBotten: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kortAntal: { fontSize: 13, color: '#555' },
  varning: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fca5a5', borderRadius: 8, padding: 10, marginBottom: 14 },
  varningText: { color: '#b91c1c', fontWeight: '600' },
  toppRad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  sortKnapp: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1 },
  sortText: { fontSize: 12, fontWeight: '600' },
  kategoriRubrik: { fontSize: 20, fontWeight: '700', color: '#1a2235' },
  sokInput: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: '#333', width: 240 },
  tabellHuvud: { flexDirection: 'row', backgroundColor: '#e8eaf0', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, marginBottom: 4 },
  tabellHuvudText: { fontSize: 12, fontWeight: '700', color: '#556', textTransform: 'uppercase', letterSpacing: 0.5 },
  lista: { paddingBottom: 20 },
  tomText: { color: '#999', textAlign: 'center', marginTop: 40, fontSize: 15 },
  rad: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  radJamn: { backgroundColor: '#fafbfc' },
  radLavt: { backgroundColor: '#fff5f5' },
  radText: { fontSize: 14, color: '#333' },
  radNamn: { fontWeight: '600', color: '#1a2235' },
  radArtikelnr: { color: '#888', fontSize: 13 },
  radAntalLavt: { color: '#ef4444', fontWeight: '700' },
  statusBadge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  statusOk: { backgroundColor: '#dcfce7' },
  statusLavt: { backgroundColor: '#fee2e2' },
  statusText: { fontSize: 12, fontWeight: '600', color: '#333' },
  radKnappar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6 },
  redigeraKnapp: { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#bfdbfe', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  redigeraText: { color: '#2563eb', fontSize: 13, fontWeight: '600' },
  taBortKnapp: { backgroundColor: '#fff5f5', borderWidth: 1, borderColor: '#fecaca', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  taBortText: { color: '#ef4444', fontSize: 13 },
  modalBakgrund: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalKort: { backgroundColor: '#fff', borderRadius: 16, padding: 28, width: 420,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20 },
  modalTitel: { color: '#1a2235', fontSize: 20, fontWeight: 'bold', marginBottom: 16 },
  inputLabel: { color: '#666', fontSize: 13, marginBottom: 6 },
  kategoriRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  kategoriKnapp: { backgroundColor: '#f0f2f5', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  kategoriKnappAktiv: { backgroundColor: '#2563eb' },
  kategoriText: { color: '#555', fontSize: 13 },
  kategoriTextAktiv: { color: '#fff', fontWeight: 'bold' },
  input: { backgroundColor: '#f8f9fa', color: '#333', borderRadius: 8, padding: 12,
    fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: '#e0e0e0' },
  modalKnappar: { flexDirection: 'row', gap: 10, marginTop: 4 },
  avbrytKnapp: { flex: 1, backgroundColor: '#f0f2f5', borderRadius: 8, padding: 13, alignItems: 'center' },
  avbrytText: { color: '#666', fontWeight: 'bold' },
  sparaKnapp: { flex: 1, backgroundColor: '#16a34a', borderRadius: 8, padding: 13, alignItems: 'center' },
  sparaText: { color: '#fff', fontWeight: 'bold' },
});
