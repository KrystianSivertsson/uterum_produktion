import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity,
  FlatList, Modal, Alert, SafeAreaView, StatusBar, Image, Platform, ScrollView,
  useWindowDimensions
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SEED_PRODUKTER } from './seedData';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { utils, write } from 'xlsx';

const API = typeof window !== 'undefined'
  ? `http://${window.location.hostname}:3001`
  : 'http://localhost:3001';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}
const STORAGE_KEY = 'lagersystem_produkter';
const TOKEN_KEY = 'lagersystem_token';
const FLIKAR = ['Alla produkter', 'Schueco ASE 60', 'Schueco ASS 32', 'Osorterat'];
const RITNINGAR = [{ id: 'ase60', label: 'ASE 60 Ritningar', fil: 'ritningar_ase60.pdf' }];

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
        <View style={um.panel}>
          <View style={um.rubrikRad}>
            <Text style={um.rubrik}>Hantera användare</Text>
            <TouchableOpacity onPress={onStang}><Text style={um.stang}>✕</Text></TouchableOpacity>
          </View>
          <FlatList
            data={anvandare}
            keyExtractor={i => i.id}
            style={{ maxHeight: 220, marginBottom: 16 }}
            renderItem={({ item }) => (
              <View style={um.rad}>
                <View>
                  <Text style={um.radNamn}>{item.namn}</Text>
                  <Text style={um.radUser}>@{item.username} · {item.roll}</Text>
                </View>
                {item.username !== 'admin' &&
                  <TouchableOpacity style={um.taBortKnapp} onPress={() => taBort(item.id)}>
                    <Text style={um.taBortText}>Ta bort</Text>
                  </TouchableOpacity>}
              </View>
            )}
          />
          <Text style={um.sektionRubrik}>Lägg till användare</Text>
          {fel ? <Text style={{ color: '#ef4444', marginBottom: 8 }}>{fel}</Text> : null}
          <TextInput style={um.input} placeholder="Visningsnamn" placeholderTextColor="#999" value={nyttVisningsnamn} onChangeText={setNyttVisningsnamn} />
          <TextInput style={um.input} placeholder="Användarnamn *" placeholderTextColor="#999" value={nyttNamn} onChangeText={setNyttNamn} autoCapitalize="none" />
          <TextInput style={um.input} placeholder="Lösenord *" placeholderTextColor="#999" value={nyttLosen} onChangeText={setNyttLosen} secureTextEntry />
          <View style={um.rollRad}>
            {['user','admin'].map(r => (
              <TouchableOpacity key={r} style={[um.rollKnapp, nyttRoll===r && um.rollAktiv]} onPress={() => setNyttRoll(r)}>
                <Text style={[um.rollText, nyttRoll===r && um.rollTextAktiv]}>{r === 'admin' ? 'Admin' : 'Användare'}</Text>
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

function ProfilModal({ user, token, onStang, onUppdatera }) {
  const [fliken, setFliken] = useState('avatar');
  const [valdAvatar, setValdAvatar] = useState(user.avatar || '😀');
  const [gammalt, setGammalt] = useState('');
  const [nytt, setNytt] = useState('');
  const [bekrafta, setBekrafta] = useState('');
  const [meddelande, setMeddelande] = useState('');
  const [fel, setFel] = useState('');

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
        <View style={pm.panel}>
          <View style={pm.rubrikRad}>
            <Text style={pm.rubrik}>Min profil</Text>
            <TouchableOpacity onPress={onStang}><Text style={pm.stang}>✕</Text></TouchableOpacity>
          </View>

          <View style={pm.anvInfo}>
            <Text style={pm.bigAvatar}>{user.avatar || '😀'}</Text>
            <View>
              <Text style={pm.anvNamn}>{user.namn}</Text>
              <Text style={pm.anvUser}>@{user.username} · {user.roll}</Text>
            </View>
          </View>

          <View style={pm.flikar}>
            {['avatar','lösenord'].map(f => (
              <TouchableOpacity key={f} style={[pm.flik, fliken===f && pm.flikAktiv]} onPress={() => { setFliken(f); setFel(''); setMeddelande(''); }}>
                <Text style={[pm.flikText, fliken===f && pm.flikTextAktiv]}>{f === 'avatar' ? '🖼 Avatar' : '🔒 Lösenord'}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {meddelande ? <View style={pm.okRad}><Text style={pm.okText}>✓ {meddelande}</Text></View> : null}
          {fel ? <View style={pm.felRad}><Text style={pm.felText}>{fel}</Text></View> : null}

          {fliken === 'avatar' && (
            <View>
              <View style={pm.avatarGrid}>
                {AVATARER.map(a => (
                  <TouchableOpacity key={a} style={[pm.avatarKnapp, valdAvatar===a && pm.avatarAktiv]} onPress={() => setValdAvatar(a)}>
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
              <TextInput style={pm.input} placeholder="Nuvarande lösenord" placeholderTextColor="#999"
                value={gammalt} onChangeText={setGammalt} secureTextEntry />
              <TextInput style={pm.input} placeholder="Nytt lösenord" placeholderTextColor="#999"
                value={nytt} onChangeText={setNytt} secureTextEntry />
              <TextInput style={pm.input} placeholder="Bekräfta nytt lösenord" placeholderTextColor="#999"
                value={bekrafta} onChangeText={setBekrafta} secureTextEntry />
              <TouchableOpacity style={pm.sparaKnapp} onPress={bytaLosen}>
                <Text style={pm.sparaText}>Byt lösenord</Text>
              </TouchableOpacity>
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
});

// ─── Chat panel ───────────────────────────────────────────────────────────────
function ChatPanel({ token, user, onStang }) {
  const [meddelanden, setMeddelanden] = useState([]);
  const [text, setText] = useState('');
  const [online, setOnline] = useState([]);
  const wsRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/api/messages`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setMeddelanden).catch(() => {});

    if (Platform.OS === 'web') {
      const ws = new WebSocket(`ws://${window.location.hostname}:3001/ws?token=${token}`);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'message') setMeddelanden(prev => [...prev, data.message]);
        if (data.type === 'online') setOnline(data.users);
      };
      return () => ws.close();
    }
  }, []);

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
    <View style={cp.panel}>
      <View style={cp.header}>
        <View>
          <Text style={cp.rubrik}>💬 Chat</Text>
          {online.length > 0 && <Text style={cp.online}>Online: {online.join(', ')}</Text>}
        </View>
        <TouchableOpacity onPress={onStang}><Text style={cp.stang}>✕</Text></TouchableOpacity>
      </View>
      <ScrollView ref={listRef} style={cp.lista} contentContainerStyle={{ padding: 12 }}>
        {meddelanden.map(m => {
          const arJag = m.username === user.username;
          return (
            <View key={m.id} style={[cp.bubblaWrap, arJag && cp.bubblaWrapJag]}>
              {!arJag && <Text style={cp.avsandare}>{m.user}</Text>}
              <View style={[cp.bubbla, arJag && cp.bubblaJag]}>
                <Text style={[cp.bubblaText, arJag && cp.bubblaTextJag]}>{m.text}</Text>
              </View>
              <Text style={cp.tid}>{formatTid(m.tid)}</Text>
            </View>
          );
        })}
      </ScrollView>
      <View style={cp.inputRad}>
        <TextInput
          style={cp.input}
          placeholder="Skriv ett meddelande..."
          placeholderTextColor="#999"
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
  const [visaAnvandare, setVisaAnvandare] = useState(false);
  const [visaChat, setVisaChat] = useState(false);
  const [visaProfil, setVisaProfil] = useState(false);
  const [visaSidebar, setVisaSidebar] = useState(false);
  const { width } = useWindowDimensions();
  const mobil = width < 768;

  useEffect(() => { kollaSession(); }, []);
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
    setModalVisible(true);
  };

  const oppnaRedigera = (produkt) => {
    setRedigeraProdukt(produkt);
    setFormNamn(produkt.namn);
    setFormAntal(String(produkt.antal));
    setFormKategori(produkt.kategori);
    setFormMinAntal(String(produkt.minAntal));
    setModalVisible(true);
  };

  const sparaProdukt = () => {
    if (!formNamn.trim()) { Alert.alert('Fel', 'Namn krävs'); return; }
    const antal = parseInt(formAntal) || 0;
    const minAntal = parseInt(formMinAntal) || 5;
    let nyLista;
    if (redigeraProdukt) {
      nyLista = produkter.map(p =>
        p.id === redigeraProdukt.id
          ? { ...p, namn: formNamn.trim(), antal, kategori: formKategori.trim(), minAntal }
          : p
      );
    } else {
      nyLista = [...produkter, {
        id: Date.now().toString(),
        namn: formNamn.trim(), antal,
        kategori: formKategori.trim(), minAntal,
      }];
    }
    setProdukter(nyLista);
    sparaProdukter(nyLista);
    setModalVisible(false);
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

  const filtreradeLista = arRitning ? [] : produkter.filter(p => {
    const matcherFlik = aktivFlik === 'Alla produkter' || p.kategori === aktivFlik;
    const matcherSok =
      p.namn.toLowerCase().includes(sok.toLowerCase()) ||
      (p.artikel || '').includes(sok) ||
      p.kategori.toLowerCase().includes(sok.toLowerCase());
    return matcherFlik && matcherSok;
  });

  const lagLager = filtreradeLista.filter(p => p.antal <= p.minAntal).length;
  const raknaProdukter = (flik) =>
    flik === 'Alla produkter' ? produkter.length : produkter.filter(p => p.kategori === flik).length;

  if (kollarSession) return <View style={styles.container} />;
  if (!inloggad) return <LoginSkarm onLogin={loggaIn} />;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#fff" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerVanster}>
          {mobil && (
            <TouchableOpacity style={styles.hamburger} onPress={() => setVisaSidebar(v => !v)}>
              <Text style={styles.hamburgerText}>☰</Text>
            </TouchableOpacity>
          )}
          <Image source={require('./assets/logo.jpg')} style={[styles.logo, mobil && { width: 130, height: 38 }]} resizeMode="contain" />
        </View>
        <View style={styles.headerHoger}>
          <TouchableOpacity onPress={() => setVisaProfil(true)} style={styles.avatarKnapp}>
            <Text style={styles.avatarEmoji}>{inloggad.avatar || '😀'}</Text>
            {!mobil && <Text style={styles.headerAnv}>{inloggad.namn}</Text>}
          </TouchableOpacity>
          {inloggad.roll === 'admin' && (
            <TouchableOpacity style={styles.headerKnapp} onPress={() => setVisaAnvandare(true)}>
              <Text style={styles.headerKnappText}>{mobil ? '👥' : 'Användare'}</Text>
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
        {(!mobil || visaSidebar) && <View style={[styles.sidebar, mobil && styles.sidebarMobil]}>
          <Text style={styles.sidebarTitel}>Kategorier</Text>
          {FLIKAR.map(flik => (
            <TouchableOpacity
              key={flik}
              style={[styles.sidebarFlik, aktivFlik === flik && styles.sidebarFlikAktiv]}
              onPress={() => { setAktivFlik(flik); setSok(''); }}
            >
              <Text style={[styles.sidebarFlikText, aktivFlik === flik && styles.sidebarFlikTextAktiv]}>
                {flik}
              </Text>
              <View style={[styles.sidebarBadge, aktivFlik === flik && styles.sidebarBadgeAktiv]}>
                <Text style={[styles.sidebarBadgeText, aktivFlik === flik && styles.sidebarBadgeTextAktiv]}>
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
        <View style={styles.innehall}>
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
              <View style={styles.varning}>
                <Text style={styles.varningText}>⚠️ {lagLager} produkt{lagLager > 1 ? 'er' : ''} har lågt lager</Text>
              </View>
            )}
            <View style={styles.toppRad}>
              <Text style={[styles.kategoriRubrik, mobil && { fontSize: 16 }]}>{aktivFlik}</Text>
              <TextInput
                style={[styles.sokInput, mobil && { width: 150, fontSize: 13 }]}
                placeholder={mobil ? 'Sök...' : 'Sök produkt eller artikelnr...'}
                placeholderTextColor="#999"
                value={sok}
                onChangeText={setSok}
              />
            </View>

            {!mobil && (
              <View style={styles.tabellHuvud}>
                <Text style={[styles.tabellHuvudText, { flex: 1.2 }]}>Artikelnr</Text>
                <Text style={[styles.tabellHuvudText, { flex: 3 }]}>Produkt</Text>
                <Text style={[styles.tabellHuvudText, { flex: 2 }]}>Kategori</Text>
                <Text style={[styles.tabellHuvudText, { flex: 1, textAlign: 'center' }]}>Antal</Text>
                <Text style={[styles.tabellHuvudText, { flex: 1, textAlign: 'center' }]}>Status</Text>
                <Text style={[styles.tabellHuvudText, { flex: 2, textAlign: 'right' }]}>Åtgärder</Text>
              </View>
            )}

            <FlatList
              data={filtreradeLista}
              keyExtractor={item => item.id}
              contentContainerStyle={styles.lista}
              ListEmptyComponent={<Text style={styles.tomText}>Inga produkter.</Text>}
              renderItem={({ item, index }) => {
                const lavt = item.antal <= item.minAntal;
                if (mobil) {
                  return (
                    <View style={[styles.kort, lavt && styles.kortLavt]}>
                      <View style={styles.kortTopp}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.kortNamn}>{item.namn}</Text>
                          <Text style={styles.kortArtikel}>{item.artikel || '—'}</Text>
                        </View>
                        <View style={[styles.statusBadge, lavt ? styles.statusLavt : styles.statusOk]}>
                          <Text style={styles.statusText}>{lavt ? 'Lågt' : 'OK'}</Text>
                        </View>
                      </View>
                      <View style={styles.kortBotten}>
                        <Text style={styles.kortAntal}>
                          Antal: <Text style={[{ fontWeight: '700' }, lavt && styles.radAntalLavt]}>{item.antal}</Text>
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
                  <View style={[styles.rad, index % 2 === 0 && styles.radJamn, lavt && styles.radLavt]}>
                    <Text style={[styles.radText, { flex: 1.2 }, styles.radArtikelnr]}>{item.artikel || '—'}</Text>
                    <Text style={[styles.radText, { flex: 3 }, styles.radNamn]}>{item.namn}</Text>
                    <Text style={[styles.radText, { flex: 2 }]}>{item.kategori || '—'}</Text>
                    <Text style={[styles.radText, { flex: 1, textAlign: 'center' }, lavt && styles.radAntalLavt]}>{item.antal}</Text>
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
          </>}
        </View>
      </View>

      {/* Chat floating panel */}
      {visaChat && <ChatPanel token={token} user={inloggad} onStang={() => setVisaChat(false)} />}

      {visaProfil && <ProfilModal user={inloggad} token={token} onStang={() => setVisaProfil(false)} onUppdatera={(u) => setInloggad(u)} />}
      {visaAnvandare && <AnvandarHantering token={token} onStang={() => setVisaAnvandare(false)} />}

      {/* Produkt modal */}
      <Modal visible={modalVisible} animationType="fade" transparent>
        <View style={styles.modalBakgrund}>
          <View style={styles.modalKort}>
            <Text style={styles.modalTitel}>{redigeraProdukt ? 'Redigera produkt' : 'Ny produkt'}</Text>
            <TextInput style={styles.input} placeholder="Produktnamn *" placeholderTextColor="#999"
              value={formNamn} onChangeText={setFormNamn} />
            <Text style={styles.inputLabel}>Kategori</Text>
            <View style={styles.kategoriRow}>
              {FLIKAR.filter(f => f !== 'Alla produkter').map(f => (
                <TouchableOpacity key={f}
                  style={[styles.kategoriKnapp, formKategori === f && styles.kategoriKnappAktiv]}
                  onPress={() => setFormKategori(f)}>
                  <Text style={[styles.kategoriText, formKategori === f && styles.kategoriTextAktiv]}>{f}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput style={styles.input} placeholder="Antal i lager" placeholderTextColor="#999"
              value={formAntal} onChangeText={setFormAntal} keyboardType="numeric" />
            <TextInput style={styles.input} placeholder="Varning vid antal (standard 5)" placeholderTextColor="#999"
              value={formMinAntal} onChangeText={setFormMinAntal} keyboardType="numeric" />
            <View style={styles.modalKnappar}>
              <TouchableOpacity style={styles.avbrytKnapp} onPress={() => setModalVisible(false)}>
                <Text style={styles.avbrytText}>Avbryt</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.sparaKnapp} onPress={sparaProdukt}>
                <Text style={styles.sparaText}>Spara</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
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
