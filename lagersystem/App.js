import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity,
  FlatList, Modal, Alert, SafeAreaView, StatusBar, Image, Platform, ScrollView,
  useWindowDimensions, Animated
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SEED_PRODUKTER, SEED_AWS70HI, SEED_AOC50, SEED_TRABALKAR, SEED_ASE60_82MM_NYA } from './seedData';
import { INVENTERING_DATUM, appliceraInventering } from './inventeringsData';
import { LEVERANS_NYA_2026 } from './leveransArtiklar2026';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { utils, write, read } from 'xlsx';

const API = typeof window !== 'undefined'
  ? (window.location.pathname.startsWith('/UterumLager')
      ? `${window.location.origin}/UterumLager`
      : window.location.origin)
  : 'http://localhost:3001';

// ASE60-generatorn körs som egen app (samma origin, nginx-proxad på /ase60/)
// — inbäddad i en egen ruta/etapp här, inte en API-proxy som ase60Projekt.
const ASE60_URL = typeof window !== 'undefined'
  ? `${window.location.origin}/ase60/`
  : 'https://three.nordiska.io/ase60/';
// SIMULERING_URL definieras efter BAS nedan (behöver bas-prefixet /UterumLager
// i prod, eftersom /simulator INTE är nginx-proxad — den nås via appens egen
// proxade väg /UterumLager/simulator/).

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}
const STORAGE_KEY = 'lagersystem_produkter';
const ORDRAR_KEY = 'lagersystem_ordrar';
const TOKEN_KEY = 'lagersystem_token';
const TEMA_KEY = 'lagersystem_tema';
const FLIKAR = ['Alla produkter', 'Schueco ASE 60', 'Schueco ASS 32', 'Schueco AWS/ADS 70 HI', 'Schueco AOC 50', 'Trä balkar', 'Osorterat'];
const FORINSTALLDA_FARGER = ['Svart/RAL9005', 'Vit/NCS-0502-Y', 'Antracitgrå/RAL7016'];
// Paket kunden köpt — styr vilket system (ASE60/ASS32) den räknas som i
// Sammanställningen. Exakt samma lista + mappning som Uterum-Konfiguratorns
// egen paket-väljare (paketTillSystem, wireframeModel.js) och ase60-
// generatorns systemmeny (client/src/main.ts) — hölls tidigare bara
// Bostandard/Vårpaket/Höstpaket/Vinterpaket här, vilket gjorde att kund-sync
// aldrig kunde sätta Boyta/Sommar/Förlängd Sommar korrekt. OBS: annat begrepp
// än paket-registret nedan (produktsystem ASE60/ASS32/AWS70HI/AOC50) —
// namnkrock, inte samma sak.
const PAKET_OPTIONS = ['Bostandard', 'Boyta', 'Sommar', 'Förlängd Sommar', 'Vår & Höst', 'Vinter'];
function paketTillSystem(paket) {
  if (paket === 'Bostandard' || paket === 'Boyta') return 'ASE60';
  if (paket === 'Sommar' || paket === 'Förlängd Sommar' || paket === 'Vår & Höst' || paket === 'Vinter') return 'ASS32';
  return null;
}
function kundSokTraff(sok, ...falt) {
  const q = (sok || '').trim().toLowerCase();
  if (!q) return true;
  return falt.some(f => (f || '').toLowerCase().includes(q));
}
// Fallback/initialt värde — ersätts live av GET /api/paket (proxy till
// ase60-generatorns paket-registry) i App(), se laddaPaket(). Filnamnen är
// lagersystemets egna (data/*.pdf) och känns inte till av ase60-generator.
const RITNING_FIL = { ase60: 'ritningar_ase60.pdf', ass32: 'ritningar_ass32.pdf', aws70hi: 'ritningar_aws70hi.pdf', aoc50: 'ritningar_aoc50.pdf' };
const RITNINGAR_FALLBACK = [
  { id: 'ase60', label: 'ASE 60 Ritningar', fil: 'ritningar_ase60.pdf' },
  { id: 'ass32', label: 'ASS 32 Ritningar', fil: 'ritningar_ass32.pdf' },
  { id: 'aws70hi', label: 'AWS/ADS 70 HI Ritningar', fil: 'ritningar_aws70hi.pdf' },
  { id: 'aoc50', label: 'AOC 50 Ritningar', fil: 'ritningar_aoc50.pdf' },
];
const KUND_FLIKAR = ['Träfräs', 'Alufräs', 'Beslag', 'Glas'];
// Planeringstavlans moment (Daniel 2026-08-20): milstolparna runt kundkortets
// materialflikar — bygglov och beredning först, sedan produktionen, leverans
// sist. Kundkortet behåller KUND_FLIKAR: de nya momenten är PLANERINGS-egna och
// bokar inte ut något material, de bockas bara av på tavlan.
const PLANERING_MOMENT = ['Bygglov', 'Beredning', ...KUND_FLIKAR, 'Leverans'];
// Sorteringsval på planeringstavlan.
const PLANERING_SORT = [
  { id: 'leverans', text: 'Leveransdatum', falt: 'leveransDatum' },
  { id: 'start', text: 'Prod. start', falt: 'produktionStart' },
  { id: 'klart', text: 'Klart senast', falt: 'klartDatum' },
  { id: 'namn', text: 'Kund A–Ö' },
  { id: 'framsteg', text: 'Minst klart först' },
];

// ─── Adressrader (URL ↔ vy) ───────────────────────────────────────────────────
// Appen är ett enda komponentträd utan router-bibliotek, så vyn har hittills
// bara levt i React-state: en omladdning kastade alltid tillbaka en till
// startvyn och bakåtknappen lämnade appen helt. Här speglas vy-staten i
// history-API:t i stället, så varje klick får en egen adress.
//
// Basvägen får INTE hårdkodas: i produktion monteras bygget under /UterumLager
// (nginx strippar prefixet innan Node ser det), lokalt kan samma bygge ligga i
// roten. Den läses därför av i runtime.
const RUTT_ROTER = ['kunder', 'ase60', 'simulering', 'lager', 'ritning', 'ordrar', 'lagerforslag', 'sammanstallning', 'andringar', 'stampling', 'planering', 'beredning'];

function harledBas() {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.location) return '';
  const vag = window.location.pathname;
  // Expo bakar in bundlens absoluta väg i index.html (app.json
  // experiments.baseUrl). Den säger var bygget är TÄNKT att ligga — stämmer den
  // med adressen är det basen. Samma bygge serveras också från roten lokalt,
  // och då får prefixet inte användas.
  const src = document.querySelector('script[src*="/_expo/static/js/"]')?.getAttribute('src') || '';
  const i = src.indexOf('/_expo/static/js/');
  const bakad = i > 0 && src.startsWith('/') ? src.slice(0, i) : '';
  if (bakad && (vag === bakad || vag.startsWith(`${bakad}/`))) return bakad;
  // Ingen bakad bas (dev-servern) eller den stämmer inte: ta första segmentet,
  // men bara om det inte redan är en av appens egna rutter — då ligger appen i
  // roten och hela adressen är rutt.
  const forsta = vag.split('/').filter(Boolean)[0];
  return forsta && !RUTT_ROTER.includes(forsta) ? `/${forsta}` : '';
}
const BAS = harledBas();

// SBZ151 3D-simulatorn serveras av lagersystem-servern på {BAS}/simulator. I
// prod är /simulator INTE nginx-proxad (fångas av en annan app), men
// /UterumLager/* rutas till uterum-lager-servern och nginx strippar prefixet →
// serverns /simulator-route svarar. Lokalt (BAS='') blir det origin/simulator/.
// Simulatorns egna fetch:ar är relativa så de följer med under samma prefix.
const SIMULERING_URL = typeof window !== 'undefined'
  ? `${window.location.origin}${BAS}/simulator/?embed=true&controls=1`
  : 'https://three.nordiska.io/UterumLager/simulator/?embed=true&controls=1';

// Slug som tål svenska kundnamn. Både namnen och segmenten ur adressen körs
// genom samma funktion, så matchningen blir okänslig för hur webbläsaren råkar
// procent-koda tecknen.
function slugga(text) {
  const ren = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return encodeURIComponent(ren);
}
function sluggaSegment(segment) {
  let text = segment;
  try { text = decodeURIComponent(segment); } catch { /* trasig kodning — matcha rått */ }
  return slugga(text);
}

// Vy-state → adress (utan bas). Nästlingen speglar renderingen: en vald kund
// eller produkt ligger "inuti" sin flik.
function vagForVy({ aktivFlik, valdKund, aktivKundFlik, valdProdukt, valdAse60Projekt }) {
  if (aktivFlik === '__kunder__') {
    if (!valdKund) return '/kunder/';
    return `/kunder/${slugga(valdKund.namn)}/${slugga(aktivKundFlik || KUND_FLIKAR[0])}/`;
  }
  if (aktivFlik === '__ase60__') return valdAse60Projekt ? `/ase60/${slugga(valdAse60Projekt.name)}/` : '/ase60/';
  if (aktivFlik === '__simulering__') return '/simulering/';
  if (aktivFlik === '__ordrar__') return '/ordrar/';
  if (aktivFlik === '__lagerforslag__') return '/lagerforslag/';
  if (aktivFlik === '__sammanstallning__') return '/sammanstallning/';
  if (aktivFlik === '__planering__') return '/planering/';
  if (aktivFlik === '__beredning__') return '/beredning/';
  if (aktivFlik === '__andringar__') return '/andringar/';
  if (FLIKAR.includes(aktivFlik)) {
    const kategori = `/lager/${slugga(aktivFlik)}/`;
    return valdProdukt ? `${kategori}${slugga(valdProdukt.artikel || valdProdukt.id)}/` : kategori;
  }
  if (RITNING_FIL[aktivFlik]) return `/ritning/${slugga(aktivFlik)}/`;
  return '/'; // __stampling__ är startvyn
}

// Adress → vy. Kund/produkt/projekt lämnas som slugs: de listorna hämtas först
// efter inloggning, så de matchas mot riktiga objekt när datan finns.
function tolkaVag(pathname) {
  const vag = pathname || '/';
  const utanBas = BAS && vag.startsWith(BAS) ? vag.slice(BAS.length) : vag;
  const [rot, andra, tredje] = utanBas.split('/').filter(Boolean).map(sluggaSegment);
  switch (rot) {
    case 'kunder': return { flik: '__kunder__', kundSlug: andra || null, kundFlikSlug: tredje || null };
    case 'ase60': return { flik: '__ase60__', ase60Slug: andra || null };
    case 'simulering': return { flik: '__simulering__' };
    case 'ordrar': return { flik: '__ordrar__' };
    case 'lagerforslag': return { flik: '__lagerforslag__' };
    case 'sammanstallning': return { flik: '__sammanstallning__' };
    case 'planering': return { flik: '__planering__' };
    case 'beredning': return { flik: '__beredning__' };
    case 'andringar': return { flik: '__andringar__' };
    case 'lager': return { flik: FLIKAR.find(f => slugga(f) === andra) || FLIKAR[0], produktSlug: tredje || null };
    case 'ritning': return { flik: RITNING_FIL[andra] ? andra : '__stampling__' };
    default: return { flik: '__stampling__' }; // inklusive '/' och okända vägar
  }
}

// Adresser jämförs kanoniskt — webbläsaren kan koda samma tecken annorlunda än
// slugga() gör, och då är det fortfarande samma vy.
function kanoniskVag(pathname) {
  const vag = pathname || '/';
  const utanBas = BAS && vag.startsWith(BAS) ? vag.slice(BAS.length) : vag;
  const segment = utanBas.split('/').filter(Boolean).map(sluggaSegment);
  return segment.length ? `/${segment.join('/')}/` : '/';
}

const VY_TITLAR = {
  __stampling__: 'Stämpling', __kunder__: 'Kunder', __ase60__: 'ASE60-generator', __simulering__: 'Simulering',
  __sammanstallning__: 'Sammanställning', __lagerforslag__: 'Lagerförslag',
  __ordrar__: 'Ordrar', __andringar__: 'Ändringslogg', __planering__: 'Planering',
  __beredning__: 'Beredning',
};
function titelForVy({ aktivFlik, valdKund, valdProdukt }) {
  const del = valdProdukt?.namn || valdKund?.namn || VY_TITLAR[aktivFlik] || aktivFlik;
  return `${del} – Lagersystem`;
}

// Ett ASE60-projekt visas som en kund i listan. Samma objekt behövs både när
// man klickar i listan och när en /kunder/<kund>/-adress ska matchas mot datan.
function kundFranAse60Projekt(proj, sparad) {
  return {
    id: proj.id, namn: proj.name, farg: proj.color, ase60ProjectId: proj.id,
    matt: proj.units?.map(u => ({ widthMm: u.widthMm, heightMm: u.heightMm, leaves: u.leaves })) || [],
    material: sparad?.material || {}, klart: sparad?.klart || {}, paket: sparad?.paket || proj.paket || null,
  };
}

const TemaContext = React.createContext(null);

function fargTillCSS(farg) {
  if (!farg) return '#888';
  const f = farg.toLowerCase();
  if (f.includes('9005') || f.includes('svart') || f.includes('black')) return '#141414';
  if (f.includes('7016') || f.includes('antracit') || f.includes('anthracit')) return '#3d4045';
  if (f.includes('7015') || f.includes('skiffergrå') || f.includes('skiffer')) return '#4f5358';
  if (f.includes('9010') || f.includes('vit') || f.includes('white') || f.includes('0502')) return '#f5f3ea';
  if (f.includes('7021') || f.includes('svartgrå') || f.includes('black grey')) return '#2b2d2f';
  if (f.includes('7035') || f.includes('ljusgrå') || f.includes('light grey')) return '#c8cbc4';
  if (f.includes('8014') || f.includes('brun') || f.includes('brown')) return '#5a3e28';
  return '#888';
}

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
// ─── Alufräs (ECW-filer från ASE60) ──────────────────────────────────────────
function AlufrasFlik({ ase60ProjectId, token, API, c, roll }) {
  const [filer, setFiler] = useState([]);
  const [laddar, setLaddar] = useState(true);

  const laddaFiler = () => {
    if (!ase60ProjectId || !token) { setLaddar(false); return; }
    fetch(`${API}/api/ecw-filer/${encodeURIComponent(ase60ProjectId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setFiler(Array.isArray(data) ? data : []); setLaddar(false); })
      .catch(() => setLaddar(false));
  };

  useEffect(() => { laddaFiler(); }, [ase60ProjectId]);

  const laddaNer = (fil) => {
    const url = `${API}/api/ecw-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}/ladda-ner?token=${token}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fil.filename;
    a.click();
  };

  const taBort = async (fil) => {
    if (!window.confirm(`Ta bort "${fil.filename}"?`)) return;
    await fetch(`${API}/api/ecw-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    laddaFiler();
  };

  if (laddar) return (
    <View style={{ padding: 32, alignItems: 'center' }}>
      <Text style={{ color: c.textMuted }}>Hämtar ECW-filer...</Text>
    </View>
  );

  if (filer.length === 0) return (
    <View style={{ padding: 16, alignItems: 'center', marginBottom: 12 }}>
      <Text style={{ color: c.textMuted, fontSize: 14, textAlign: 'center' }}>
        Inga ECW-filer ännu.{'\n'}Exportera från ASE60 och filen dyker upp här automatiskt.
      </Text>
    </View>
  );

  return (
    <View style={{ marginBottom: 12 }}>
      {filer.slice().reverse().map(fil => (
        <View
          key={fil.id}
          style={{ backgroundColor: c.kort, borderColor: c.kortBorder, borderWidth: 1, borderRadius: 12,
            padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text style={{ fontSize: 22 }}>📄</Text>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => laddaNer(fil)}>
            <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14 }}>{fil.filename}</Text>
            <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>
              {new Date(fil.skapad).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => laddaNer(fil)}>
            <Text style={{ color: '#2563eb', fontWeight: '600', fontSize: 13 }}>⬇ Ladda ner</Text>
          </TouchableOpacity>
          {roll === 'admin' && (
            <TouchableOpacity onPress={() => taBort(fil)}>
              <Text style={{ color: '#ef4444', fontWeight: '600', fontSize: 13 }}>🗑 Ta bort</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

// ─── Träfräs (BTL-filer från Uterum-Konfiguratorn) ───────────────────────────
function BtlFlik({ ase60ProjectId, token, API, c, roll }) {
  const [filer, setFiler] = useState([]);
  const [laddar, setLaddar] = useState(true);

  const laddaFiler = () => {
    if (!ase60ProjectId || !token) { setLaddar(false); return; }
    fetch(`${API}/api/btl-filer/${encodeURIComponent(ase60ProjectId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setFiler(Array.isArray(data) ? data : []); setLaddar(false); })
      .catch(() => setLaddar(false));
  };

  useEffect(() => { laddaFiler(); }, [ase60ProjectId]);

  const laddaNer = (fil) => {
    const url = `${API}/api/btl-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}/ladda-ner?token=${token}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fil.filename;
    a.click();
  };

  const taBort = async (fil) => {
    if (!window.confirm(`Ta bort "${fil.filename}"?`)) return;
    await fetch(`${API}/api/btl-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    laddaFiler();
  };

  if (laddar) return (
    <View style={{ padding: 32, alignItems: 'center' }}>
      <Text style={{ color: c.textMuted }}>Hämtar BTL-filer...</Text>
    </View>
  );

  if (filer.length === 0) return (
    <View style={{ padding: 16, alignItems: 'center', marginBottom: 12 }}>
      <Text style={{ color: c.textMuted, fontSize: 14, textAlign: 'center' }}>
        Inga BTL-filer ännu.{'\n'}Exportera takstolar från Uterum-Konfiguratorn och filen dyker upp här automatiskt.
      </Text>
    </View>
  );

  return (
    <View style={{ marginBottom: 12 }}>
      {filer.slice().reverse().map(fil => (
        <View
          key={fil.id}
          style={{ backgroundColor: c.kort, borderColor: c.kortBorder, borderWidth: 1, borderRadius: 12,
            padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text style={{ fontSize: 22 }}>🪵</Text>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => laddaNer(fil)}>
            <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14 }}>{fil.filename}</Text>
            <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>
              {new Date(fil.skapad).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => laddaNer(fil)}>
            <Text style={{ color: '#2563eb', fontWeight: '600', fontSize: 13 }}>⬇ Ladda ner</Text>
          </TouchableOpacity>
          {roll === 'admin' && (
            <TouchableOpacity onPress={() => taBort(fil)}>
              <Text style={{ color: '#ef4444', fontWeight: '600', fontSize: 13 }}>🗑 Ta bort</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

// ─── STEP-filer (3D CAD-montering: takstolar+bärlinor+stolpar+glas som
// solids, zip med assembly + platta delar) från Uterum-Konfiguratorns
// "Exportera STEP"-knapp — samma mönster som BtlFlik ovan.
function StepFlik({ ase60ProjectId, token, API, c, roll }) {
  const [filer, setFiler] = useState([]);
  const [laddar, setLaddar] = useState(true);

  const laddaFiler = () => {
    if (!ase60ProjectId || !token) { setLaddar(false); return; }
    fetch(`${API}/api/step-filer/${encodeURIComponent(ase60ProjectId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setFiler(Array.isArray(data) ? data : []); setLaddar(false); })
      .catch(() => setLaddar(false));
  };

  useEffect(() => { laddaFiler(); }, [ase60ProjectId]);

  const laddaNer = (fil) => {
    const url = `${API}/api/step-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}/ladda-ner?token=${token}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fil.filename;
    a.click();
  };

  const taBort = async (fil) => {
    if (!window.confirm(`Ta bort "${fil.filename}"?`)) return;
    await fetch(`${API}/api/step-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    laddaFiler();
  };

  if (laddar) return (
    <View style={{ padding: 32, alignItems: 'center' }}>
      <Text style={{ color: c.textMuted }}>Hämtar STEP-filer...</Text>
    </View>
  );

  if (filer.length === 0) return (
    <View style={{ padding: 16, alignItems: 'center', marginBottom: 12 }}>
      <Text style={{ color: c.textMuted, fontSize: 14, textAlign: 'center' }}>
        Inga STEP-filer ännu.{'\n'}Exportera STEP från Uterum-Konfiguratorn och filen dyker upp här automatiskt.
      </Text>
    </View>
  );

  return (
    <View style={{ marginBottom: 12 }}>
      {filer.slice().reverse().map(fil => (
        <View
          key={fil.id}
          style={{ backgroundColor: c.kort, borderColor: c.kortBorder, borderWidth: 1, borderRadius: 12,
            padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text style={{ fontSize: 22 }}>📐</Text>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => laddaNer(fil)}>
            <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14 }}>{fil.filename}</Text>
            <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>
              {new Date(fil.skapad).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => laddaNer(fil)}>
            <Text style={{ color: '#2563eb', fontWeight: '600', fontSize: 13 }}>⬇ Ladda ner</Text>
          </TouchableOpacity>
          {roll === 'admin' && (
            <TouchableOpacity onPress={() => taBort(fil)}>
              <Text style={{ color: '#ef4444', fontWeight: '600', fontSize: 13 }}>🗑 Ta bort</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

// ─── PDF-dokument (ritningar/beredning från ASE60) per kund ──────────────────
function PdfFlik({ ase60ProjectId, token, API, c, roll }) {
  const [filer, setFiler] = useState([]);

  const laddaFiler = () => {
    if (!ase60ProjectId || !token) return;
    fetch(`${API}/api/pdf-filer/${encodeURIComponent(ase60ProjectId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setFiler(Array.isArray(data) ? data : []))
      .catch(() => {});
  };

  useEffect(() => { laddaFiler(); }, [ase60ProjectId]);

  const oppna = (fil) => {
    // Öppnas i ny flik — skriv ut / spara som PDF därifrån
    window.open(`${API}/api/pdf-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}/visa?token=${token}`, '_blank');
  };

  const taBort = async (fil) => {
    if (!window.confirm(`Ta bort "${fil.filename}"?`)) return;
    await fetch(`${API}/api/pdf-filer/${encodeURIComponent(ase60ProjectId)}/${fil.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    laddaFiler();
  };

  if (filer.length === 0) return null;

  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>PDF-DOKUMENT</Text>
      {filer.slice().reverse().map(fil => (
        <View
          key={fil.id}
          style={{ backgroundColor: c.kort, borderColor: c.kortBorder, borderWidth: 1, borderRadius: 12,
            padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text style={{ fontSize: 22 }}>🖨️</Text>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => oppna(fil)}>
            <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14 }}>{fil.filename}</Text>
            <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>
              {new Date(fil.skapad).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => oppna(fil)}>
            <Text style={{ color: '#2563eb', fontWeight: '600', fontSize: 13 }}>📄 Öppna</Text>
          </TouchableOpacity>
          {roll === 'admin' && (
            <TouchableOpacity onPress={() => taBort(fil)}>
              <Text style={{ color: '#ef4444', fontWeight: '600', fontSize: 13 }}>🗑 Ta bort</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

function AnvandarHantering({ token, onStang }) {
  const { c } = React.useContext(TemaContext) || { c: LJUST };
  const [anvandare, setAnvandare] = useState([]);
  const [nyttNamn, setNyttNamn] = useState('');
  const [nyttLosen, setNyttLosen] = useState('');
  const [nyttRoll, setNyttRoll] = useState('user');
  const [nyttVisningsnamn, setNyttVisningsnamn] = useState('');
  const [fel, setFel] = useState('');
  const [pinRedigerarId, setPinRedigerarId] = useState(null);
  const [pinVarde, setPinVarde] = useState('');
  const [pinFel, setPinFel] = useState('');

  useEffect(() => { hamtaAnvandare(); }, []);

  const hamtaAnvandare = async () => {
    const res = await fetch(`${API}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setAnvandare(await res.json());
  };

  const sparaPin = async (id) => {
    if (!/^\d{4}$/.test(pinVarde)) { setPinFel('PIN måste vara exakt 4 siffror'); return; }
    const res = await fetch(`${API}/api/users/${id}/pin`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pin: pinVarde }),
    });
    const data = await res.json();
    if (!res.ok) { setPinFel(data.error); return; }
    setPinRedigerarId(null); setPinVarde(''); setPinFel('');
    hamtaAnvandare();
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
            style={{ maxHeight: 280, marginBottom: 16 }}
            renderItem={({ item }) => (
              <View style={[um.rad, { borderBottomColor: c.kortBorder, flexDirection: 'column', alignItems: 'stretch' }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <Text style={[um.radNamn, { color: c.textRubrik }]}>{item.namn}</Text>
                    <Text style={[um.radUser, { color: c.textMuted }]}>@{item.username} · {item.roll} · PIN: {item.harPin ? '✓ satt' : '— ej satt'}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      style={[um.taBortKnapp, { backgroundColor: '#dbeafe' }]}
                      onPress={() => { setPinRedigerarId(pinRedigerarId === item.id ? null : item.id); setPinVarde(''); setPinFel(''); }}>
                      <Text style={[um.taBortText, { color: '#2563eb' }]}>{item.harPin ? 'Byt PIN' : 'Sätt PIN'}</Text>
                    </TouchableOpacity>
                    {item.username !== 'admin' &&
                      <TouchableOpacity style={um.taBortKnapp} onPress={() => taBort(item.id)}>
                        <Text style={um.taBortText}>Ta bort</Text>
                      </TouchableOpacity>}
                  </View>
                </View>
                {pinRedigerarId === item.id && (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <TextInput
                      style={[um.input, { flex: 1, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                      placeholder="4 siffror" placeholderTextColor={c.textMuted}
                      value={pinVarde} onChangeText={t => setPinVarde(t.replace(/\D/g, '').slice(0, 4))}
                      keyboardType="numeric" secureTextEntry maxLength={4} />
                    <TouchableOpacity style={[um.laggKnapp, { paddingHorizontal: 14 }]} onPress={() => sparaPin(item.id)}>
                      <Text style={um.laggText}>Spara</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {pinRedigerarId === item.id && pinFel ? <Text style={{ color: '#ef4444', marginTop: 6, fontSize: 12 }}>{pinFel}</Text> : null}
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

// ─── Stämpling (kiosk-läge: en delad inloggning, alla anställda syns och
// stämplar in/ut med egen PIN) ──────────────────────────────────────────────
function formatKlockslag(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}
function formatDatum(iso) {
  return new Date(iso).toLocaleDateString('sv-SE');
}

const STAMPLING_OMRADEN = ['Träfräs', 'Alufräs', 'Beslag'];

const STAMPLING_INTERNT = { id: null, namn: 'Internt / övrigt' };

function StamplingVy({ token, inloggad }) {
  const { c } = React.useContext(TemaContext) || { c: LJUST };
  const [anvandare, setAnvandare] = useState([]);
  const [kunder, setKunder] = useState([]);
  const [vald, setVald] = useState(null); // { id, namn, status }
  const [valtOmrade, setValtOmrade] = useState(null);
  const [valdKund, setValdKund] = useState(null); // { id, namn } eller STAMPLING_INTERNT
  const [kundSok, setKundSok] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [fel, setFel] = useState('');
  const [bekraftelse, setBekraftelse] = useState('');
  const [skickar, setSkickar] = useState(false);
  const [visaLogg, setVisaLogg] = useState(false);

  const hamtaAnvandare = useCallback(() => {
    if (!token) return;
    fetch(`${API}/api/stampling/anvandare`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setAnvandare).catch(() => {});
  }, [token]);

  useEffect(() => {
    hamtaAnvandare();
    const iv = setInterval(hamtaAnvandare, 20000);
    return () => clearInterval(iv);
  }, [hamtaAnvandare]);

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/kunder`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setKunder(Array.isArray(d) ? d : [])).catch(() => {});
  }, [token]);

  const oppnaStampling = (person) => {
    setVald(person); setPinInput(''); setFel(''); setBekraftelse('');
    setValtOmrade(null); setValdKund(null); setKundSok('');
  };

  const kundTraffar = kundSok.trim()
    ? kunder.filter(k => k.namn.toLowerCase().includes(kundSok.toLowerCase())).slice(0, 8)
    : kunder.slice(0, 8);

  const stampla = async () => {
    const kommerBliIn = vald?.status !== 'in';
    if (kommerBliIn && !valtOmrade) { setFel('Välj vad du kör: Träfräs, Alufräs eller Beslag'); return; }
    if (kommerBliIn && !valdKund) { setFel('Välj kund, eller Internt / övrigt'); return; }
    if (pinInput.length !== 4) { setFel('Ange 4 siffror'); return; }
    setSkickar(true);
    const res = await fetch(`${API}/api/stampling/stampla`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: vald.id, pin: pinInput,
        omrade: kommerBliIn ? valtOmrade : undefined,
        kundId: kommerBliIn ? valdKund?.id : undefined,
        kundNamn: kommerBliIn ? valdKund?.namn : undefined,
      }),
    });
    const data = await res.json();
    setSkickar(false);
    if (!res.ok) { setFel(data.error || 'Något gick fel'); setPinInput(''); return; }
    const detaljText = data.event.typ === 'in' ? ` (${data.event.omrade} · ${data.event.kundNamn})` : '';
    setBekraftelse(`${vald.namn} stämplade ${data.event.typ === 'in' ? 'IN' : 'UT'}${detaljText} ${formatKlockslag(data.event.tid)}`);
    setVald(null);
    hamtaAnvandare();
  };

  const taBortPerson = async (person) => {
    const genomfor = async () => {
      await fetch(`${API}/api/users/${person.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      hamtaAnvandare();
    };
    const fraga = `Ta bort ${person.namn} helt (hela användarkontot, inte bara från stämplingen)?`;
    if (Platform.OS === 'web') {
      if (window.confirm(fraga)) genomfor();
    } else {
      Alert.alert('Ta bort?', fraga, [{ text: 'Avbryt', style: 'cancel' }, { text: 'Ta bort', style: 'destructive', onPress: genomfor }]);
    }
  };

  return (
    <ScrollView style={{ flex: 1 }}>
      {bekraftelse ? (
        <View style={{ backgroundColor: '#dcfce7', borderColor: '#16a34a', borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <Text style={{ color: '#15803d', fontWeight: '700' }}>✓ {bekraftelse}</Text>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={[styles.kategoriRubrik, { color: c.textRubrik }]}>⏱️ Stämpling</Text>
        {inloggad?.roll === 'admin' && (
          <TouchableOpacity
            onPress={() => setVisaLogg(v => !v)}
            style={{ backgroundColor: visaLogg ? '#2563eb' : c.input, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: c.inputBorder }}>
            <Text style={{ color: visaLogg ? '#fff' : c.text, fontWeight: '600' }}>{visaLogg ? '← Tillbaka' : '📋 Logg & rapport'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {visaLogg && inloggad?.roll === 'admin' ? (
        <StamplingLogg token={token} anvandare={anvandare} kunder={kunder} c={c} />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {anvandare.length === 0 && (
            <Text style={{ color: c.textMuted }}>Inga användare hittades.</Text>
          )}
          {anvandare.map(p => (
            <View key={p.id} style={{ width: 160 }}>
              <TouchableOpacity
                onPress={() => oppnaStampling(p)}
                style={{
                  backgroundColor: c.kort, borderColor: p.status === 'in' ? '#16a34a' : c.kortBorder,
                  borderWidth: p.status === 'in' ? 2 : 1, borderRadius: 12, padding: 16, alignItems: 'center',
                }}>
                <Text style={{ fontSize: 32, marginBottom: 8 }}>{p.avatar || '👤'}</Text>
                <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 15, textAlign: 'center' }}>{p.namn}</Text>
                <View style={{
                  marginTop: 8, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12,
                  backgroundColor: p.status === 'in' ? '#dcfce7' : '#f0f2f5',
                }}>
                  <Text style={{ color: p.status === 'in' ? '#15803d' : '#888', fontWeight: '600', fontSize: 12, textAlign: 'center' }}>
                    {p.status === 'in' ? `Inne${p.omrade ? ' · ' + p.omrade : ''}${p.kundNamn ? ' · ' + p.kundNamn : ''}` : 'Ute'}
                  </Text>
                </View>
                {p.senastAndrad && (
                  <Text style={{ color: c.textMuted, fontSize: 10, marginTop: 4 }}>sedan {formatKlockslag(p.senastAndrad)}</Text>
                )}
                {!p.harPin && (
                  <Text style={{ color: '#ef4444', fontSize: 10, marginTop: 4 }}>PIN ej satt</Text>
                )}
              </TouchableOpacity>
              {inloggad?.roll === 'admin' && p.username !== 'admin' && (
                <TouchableOpacity onPress={() => taBortPerson(p)} style={{ marginTop: 6, alignItems: 'center', paddingVertical: 4 }}>
                  <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600' }}>🗑 Ta bort</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>
      )}

      <Modal visible={!!vald} animationType="fade" transparent onRequestClose={() => setVald(null)}>
        <View style={um.bakgrund}>
          <View style={[um.panel, { backgroundColor: c.modal, width: 340 }]}>
            <View style={um.rubrikRad}>
              <Text style={[um.rubrik, { color: c.textRubrik }]}>{vald?.namn}</Text>
              <TouchableOpacity onPress={() => setVald(null)}><Text style={[um.stang, { color: c.textMuted }]}>✕</Text></TouchableOpacity>
            </View>
            {vald?.status !== 'in' && (
              <>
                <Text style={{ color: c.textMuted, marginBottom: 8 }}>Vad kör du?</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  {STAMPLING_OMRADEN.map(o => (
                    <TouchableOpacity
                      key={o}
                      onPress={() => setValtOmrade(o)}
                      style={{ flex: 1, backgroundColor: valtOmrade === o ? '#2563eb' : c.input, borderRadius: 8, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: valtOmrade === o ? '#2563eb' : c.inputBorder }}>
                      <Text style={{ color: valtOmrade === o ? '#fff' : c.text, fontWeight: '600', fontSize: 12 }}>{o}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={{ color: c.textMuted, marginBottom: 8 }}>
                  Hos vilken kund?{valdKund ? ` — vald: ${valdKund.namn}` : ''}
                </Text>
                <TextInput
                  style={[um.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText, marginBottom: 8 }]}
                  placeholder="Sök kund..." placeholderTextColor={c.textMuted}
                  value={kundSok} onChangeText={t => { setKundSok(t); setValdKund(null); }} />
                <ScrollView style={{ maxHeight: 130, marginBottom: 8 }}>
                  {kundTraffar.map(k => (
                    <TouchableOpacity
                      key={k.id}
                      onPress={() => { setValdKund({ id: k.id, namn: k.namn }); setKundSok(k.namn); }}
                      style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, marginBottom: 4,
                        backgroundColor: valdKund?.id === k.id ? '#2563eb' : c.input, borderWidth: 1,
                        borderColor: valdKund?.id === k.id ? '#2563eb' : c.inputBorder }}>
                      <Text style={{ color: valdKund?.id === k.id ? '#fff' : c.text, fontWeight: '600', fontSize: 13 }}>{k.namn}</Text>
                    </TouchableOpacity>
                  ))}
                  {kunder.length === 0 && (
                    <Text style={{ color: c.textMuted, fontSize: 12 }}>Inga kunder hittades.</Text>
                  )}
                </ScrollView>
                <TouchableOpacity
                  onPress={() => { setValdKund(STAMPLING_INTERNT); setKundSok(''); }}
                  style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginBottom: 14,
                    backgroundColor: valdKund?.id === null && valdKund ? '#2563eb' : c.input, borderWidth: 1,
                    borderColor: valdKund?.id === null && valdKund ? '#2563eb' : c.inputBorder }}>
                  <Text style={{ color: valdKund?.id === null && valdKund ? '#fff' : c.textMuted, fontWeight: '600', fontSize: 12 }}>
                    Internt / övrigt (inget kundjobb)
                  </Text>
                </TouchableOpacity>
              </>
            )}
            <Text style={{ color: c.textMuted, marginBottom: 12 }}>
              Ange din 4-siffriga PIN för att stämpla {vald?.status === 'in' ? 'UT' : 'IN'}.
            </Text>
            {fel ? <Text style={{ color: '#ef4444', marginBottom: 8 }}>{fel}</Text> : null}
            <TextInput
              style={[um.input, { textAlign: 'center', fontSize: 24, letterSpacing: 8, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
              value={pinInput} onChangeText={t => setPinInput(t.replace(/\D/g, '').slice(0, 4))}
              keyboardType="numeric" secureTextEntry maxLength={4} autoFocus
              onSubmitEditing={stampla} />
            <TouchableOpacity style={[um.laggKnapp, skickar && { opacity: 0.6 }]} disabled={skickar} onPress={stampla}>
              <Text style={um.laggText}>{skickar ? 'Skickar...' : `Stämpla ${vald?.status === 'in' ? 'UT' : 'IN'}`}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function tidTillDatumOchKlocka(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = n => String(n).padStart(2, '0');
  return {
    datum: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    klocka: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function StamplingLogg({ token, anvandare, kunder, c }) {
  const [events, setEvents] = useState([]);
  const [filterUserId, setFilterUserId] = useState('');
  const [fran, setFran] = useState('');
  const [till, setTill] = useState('');
  const [laddar, setLaddar] = useState(true);

  const [visaForm, setVisaForm] = useState(false);
  const [redigerarId, setRedigerarId] = useState(null);
  const [formUserId, setFormUserId] = useState('');
  const [formTyp, setFormTyp] = useState('in');
  const [formOmrade, setFormOmrade] = useState(null);
  const [formKund, setFormKund] = useState(null);
  const [formKundSok, setFormKundSok] = useState('');
  const [formDatum, setFormDatum] = useState('');
  const [formKlocka, setFormKlocka] = useState('');
  const [formFel, setFormFel] = useState('');
  const [formSkickar, setFormSkickar] = useState(false);

  const oppnaNyttFormular = () => {
    const { datum, klocka } = tidTillDatumOchKlocka();
    setRedigerarId(null); setFormUserId(anvandare[0]?.id || ''); setFormTyp('in');
    setFormOmrade(null); setFormKund(null); setFormKundSok('');
    setFormDatum(datum); setFormKlocka(klocka); setFormFel(''); setVisaForm(true);
  };

  const oppnaRedigera = (e) => {
    const { datum, klocka } = tidTillDatumOchKlocka(e.tid);
    setRedigerarId(e.id); setFormUserId(e.userId); setFormTyp(e.typ);
    setFormOmrade(e.omrade || null);
    setFormKund(e.kundNamn ? { id: e.kundId || null, namn: e.kundNamn } : null);
    setFormKundSok(e.kundNamn || '');
    setFormDatum(datum); setFormKlocka(klocka); setFormFel(''); setVisaForm(true);
  };

  const taBortEvent = async (e) => {
    const fraga = `Ta bort stämplingen "${e.namn} ${e.typ === 'in' ? 'IN' : 'UT'} ${formatDatum(e.tid)}"?`;
    const genomfor = async () => {
      await fetch(`${API}/api/stampling/logg/${e.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      hamta();
    };
    if (Platform.OS === 'web') { if (window.confirm(fraga)) genomfor(); }
    else Alert.alert('Ta bort?', fraga, [{ text: 'Avbryt', style: 'cancel' }, { text: 'Ta bort', style: 'destructive', onPress: genomfor }]);
  };

  const formKundTraffar = formKundSok.trim()
    ? (kunder || []).filter(k => k.namn.toLowerCase().includes(formKundSok.toLowerCase())).slice(0, 8)
    : (kunder || []).slice(0, 8);

  const sparaFormular = async () => {
    setFormFel('');
    if (!formUserId) { setFormFel('Välj användare'); return; }
    if (formTyp === 'in' && !formOmrade) { setFormFel('Välj vad som kördes'); return; }
    if (formTyp === 'in' && !formKund) { setFormFel('Välj kund, eller Internt / övrigt'); return; }
    if (!formDatum || !formKlocka) { setFormFel('Ange datum och tid'); return; }
    const tid = new Date(`${formDatum}T${formKlocka}:00`);
    if (isNaN(tid.getTime())) { setFormFel('Ogiltigt datum/tid'); return; }
    setFormSkickar(true);
    const body = {
      userId: formUserId, typ: formTyp,
      omrade: formTyp === 'in' ? formOmrade : undefined,
      kundId: formTyp === 'in' ? formKund?.id : undefined,
      kundNamn: formTyp === 'in' ? formKund?.namn : undefined,
      tid: tid.toISOString(),
    };
    const url = redigerarId ? `${API}/api/stampling/logg/${redigerarId}` : `${API}/api/stampling/logg`;
    const res = await fetch(url, {
      method: redigerarId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setFormSkickar(false);
    if (!res.ok) { setFormFel(data.error || 'Något gick fel'); return; }
    setVisaForm(false);
    hamta();
  };

  const hamta = useCallback(() => {
    setLaddar(true);
    const qs = new URLSearchParams();
    if (filterUserId) qs.set('userId', filterUserId);
    if (fran) qs.set('fran', fran);
    if (till) qs.set('till', till);
    fetch(`${API}/api/stampling/logg?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setEvents(Array.isArray(d) ? d : []); setLaddar(false); })
      .catch(() => setLaddar(false));
  }, [token, filterUserId, fran, till]);

  useEffect(() => { hamta(); }, [hamta]);

  // Enkel timsammanställning: parar ihop kronologiska in/ut-par per användare
  // inom den filtrerade perioden.
  const timmarPerAnvandare = React.useMemo(() => {
    const perAnvandare = new Map();
    for (const e of events) {
      const lista = perAnvandare.get(e.userId) || [];
      lista.push(e);
      perAnvandare.set(e.userId, lista);
    }
    const resultat = [];
    for (const [userId, lista] of perAnvandare) {
      const sorterad = [...lista].sort((a, b) => a.tid < b.tid ? -1 : 1);
      let totalMs = 0;
      let inTid = null;
      for (const e of sorterad) {
        if (e.typ === 'in') inTid = e.tid;
        else if (e.typ === 'ut' && inTid) { totalMs += new Date(e.tid) - new Date(inTid); inTid = null; }
      }
      resultat.push({ userId, namn: sorterad[0]?.namn || '?', timmar: totalMs / 3600000 });
    }
    return resultat.sort((a, b) => b.timmar - a.timmar);
  }, [events]);

  return (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <View style={{ backgroundColor: c.input, borderRadius: 8, borderWidth: 1, borderColor: c.inputBorder, minWidth: 160 }}>
          <TouchableOpacity
            onPress={() => {
              const idx = anvandare.findIndex(a => a.id === filterUserId);
              const next = anvandare[idx + 1];
              setFilterUserId(filterUserId === '' ? (anvandare[0]?.id || '') : (next ? next.id : ''));
            }}
            style={{ padding: 10 }}>
            <Text style={{ color: c.text }}>
              {filterUserId ? `👤 ${anvandare.find(a => a.id === filterUserId)?.namn || '?'}` : '👤 Alla användare (tryck för att bläddra)'}
            </Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={[um.input, { marginBottom: 0, width: 140, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
          placeholder="Från (ÅÅÅÅ-MM-DD)" placeholderTextColor={c.textMuted} value={fran} onChangeText={setFran} />
        <TextInput
          style={[um.input, { marginBottom: 0, width: 140, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
          placeholder="Till (ÅÅÅÅ-MM-DD)" placeholderTextColor={c.textMuted} value={till} onChangeText={setTill} />
        <TouchableOpacity onPress={hamta} style={{ backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Filtrera</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={oppnaNyttFormular} style={{ backgroundColor: '#16a34a', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>+ Lägg till stämpling</Text>
        </TouchableOpacity>
      </View>

      {timmarPerAnvandare.length > 0 && (
        <View style={{ backgroundColor: c.kort, borderColor: c.kortBorder, borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <Text style={{ color: c.textRubrik, fontWeight: '700', marginBottom: 8 }}>Sammanställning (avslutade pass i perioden)</Text>
          {timmarPerAnvandare.map(t => (
            <View key={t.userId} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={{ color: c.text }}>{t.namn}</Text>
              <Text style={{ color: c.textRubrik, fontWeight: '600' }}>{t.timmar.toFixed(1)} h</Text>
            </View>
          ))}
        </View>
      )}

      {laddar ? <Text style={{ color: c.textMuted }}>Laddar...</Text> : (
        <View>
          {events.length === 0 && <Text style={{ color: c.textMuted }}>Inga stämplingar i perioden.</Text>}
          {events.map(e => (
            <View key={e.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.kortBorder }}>
              <Text style={{ color: c.text, flex: 1 }}>{e.namn}{e.manuell ? ' ✎' : ''}</Text>
              <Text style={{ color: e.typ === 'in' ? '#16a34a' : '#ef4444', fontWeight: '600', width: 40 }}>{e.typ === 'in' ? 'IN' : 'UT'}</Text>
              <Text style={{ color: c.textMuted, width: 70 }}>{e.omrade || ''}</Text>
              <Text style={{ color: c.textMuted, width: 100 }} numberOfLines={1}>{e.kundNamn || ''}</Text>
              <Text style={{ color: c.textMuted, width: 120 }}>{formatDatum(e.tid)} {new Date(e.tid).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</Text>
              <TouchableOpacity onPress={() => oppnaRedigera(e)} style={{ paddingHorizontal: 6 }}>
                <Text style={{ color: '#2563eb', fontSize: 13 }}>✎</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => taBortEvent(e)} style={{ paddingHorizontal: 6 }}>
                <Text style={{ color: '#ef4444', fontSize: 13 }}>🗑</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      <Modal visible={visaForm} animationType="fade" transparent onRequestClose={() => setVisaForm(false)}>
        <View style={um.bakgrund}>
          <View style={[um.panel, { backgroundColor: c.modal, width: 360 }]}>
            <View style={um.rubrikRad}>
              <Text style={[um.rubrik, { color: c.textRubrik }]}>{redigerarId ? 'Redigera stämpling' : 'Lägg till stämpling'}</Text>
              <TouchableOpacity onPress={() => setVisaForm(false)}><Text style={[um.stang, { color: c.textMuted }]}>✕</Text></TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              <Text style={{ color: c.textMuted, marginBottom: 6 }}>Anställd</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {anvandare.map(a => (
                  <TouchableOpacity key={a.id} onPress={() => setFormUserId(a.id)}
                    style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1,
                      backgroundColor: formUserId === a.id ? '#2563eb' : c.input, borderColor: formUserId === a.id ? '#2563eb' : c.inputBorder }}>
                    <Text style={{ color: formUserId === a.id ? '#fff' : c.text, fontSize: 12, fontWeight: '600' }}>{a.namn}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={{ color: c.textMuted, marginBottom: 6 }}>Typ</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                {[['in', 'Stämpla IN'], ['ut', 'Stämpla UT']].map(([v, label]) => (
                  <TouchableOpacity key={v} onPress={() => setFormTyp(v)}
                    style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1,
                      backgroundColor: formTyp === v ? '#2563eb' : c.input, borderColor: formTyp === v ? '#2563eb' : c.inputBorder }}>
                    <Text style={{ color: formTyp === v ? '#fff' : c.text, fontWeight: '600', fontSize: 12 }}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {formTyp === 'in' && (
                <>
                  <Text style={{ color: c.textMuted, marginBottom: 6 }}>Vad kördes?</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                    {STAMPLING_OMRADEN.map(o => (
                      <TouchableOpacity key={o} onPress={() => setFormOmrade(o)}
                        style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1,
                          backgroundColor: formOmrade === o ? '#2563eb' : c.input, borderColor: formOmrade === o ? '#2563eb' : c.inputBorder }}>
                        <Text style={{ color: formOmrade === o ? '#fff' : c.text, fontWeight: '600', fontSize: 12 }}>{o}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={{ color: c.textMuted, marginBottom: 6 }}>
                    Kund{formKund ? ` — vald: ${formKund.namn}` : ''}
                  </Text>
                  <TextInput
                    style={[um.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText, marginBottom: 6 }]}
                    placeholder="Sök kund..." placeholderTextColor={c.textMuted}
                    value={formKundSok} onChangeText={t => { setFormKundSok(t); setFormKund(null); }} />
                  <ScrollView style={{ maxHeight: 100, marginBottom: 6 }}>
                    {formKundTraffar.map(k => (
                      <TouchableOpacity key={k.id} onPress={() => { setFormKund({ id: k.id, namn: k.namn }); setFormKundSok(k.namn); }}
                        style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, marginBottom: 4,
                          backgroundColor: formKund?.id === k.id ? '#2563eb' : c.input, borderWidth: 1,
                          borderColor: formKund?.id === k.id ? '#2563eb' : c.inputBorder }}>
                        <Text style={{ color: formKund?.id === k.id ? '#fff' : c.text, fontSize: 13, fontWeight: '600' }}>{k.namn}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  <TouchableOpacity onPress={() => { setFormKund(STAMPLING_INTERNT); setFormKundSok(''); }}
                    style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginBottom: 12,
                      backgroundColor: formKund?.id === null && formKund ? '#2563eb' : c.input, borderWidth: 1,
                      borderColor: formKund?.id === null && formKund ? '#2563eb' : c.inputBorder }}>
                    <Text style={{ color: formKund?.id === null && formKund ? '#fff' : c.textMuted, fontWeight: '600', fontSize: 12 }}>
                      Internt / övrigt (inget kundjobb)
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              <Text style={{ color: c.textMuted, marginBottom: 6 }}>Datum och tid</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <TextInput
                  style={[um.input, { flex: 1, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                  placeholder="ÅÅÅÅ-MM-DD" placeholderTextColor={c.textMuted} value={formDatum} onChangeText={setFormDatum} />
                <TextInput
                  style={[um.input, { width: 90, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                  placeholder="TT:MM" placeholderTextColor={c.textMuted} value={formKlocka} onChangeText={setFormKlocka} />
              </View>

              {formFel ? <Text style={{ color: '#ef4444', marginBottom: 8 }}>{formFel}</Text> : null}
              <TouchableOpacity style={[um.laggKnapp, formSkickar && { opacity: 0.6 }]} disabled={formSkickar} onPress={sparaFormular}>
                <Text style={um.laggText}>{formSkickar ? 'Sparar...' : (redigerarId ? 'Spara ändringar' : 'Lägg till')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Stämpla + beredning direkt i kundkortets kategoriflikar — samlad aktivitetslogg
// (vem stämplade in/ut och vad som beretts, t.ex. "ECW skickat till Alufräs") visas
// direkt så man ser vad som är gjort och när, utan att gå via den fristående Stämpling-vyn.
function KundAktivitet({ token, valdKund, aktivKundFlik, inloggad, uppdateraKund, ecwRuns, c }) {
  const [anvandare, setAnvandare] = useState([]);
  const [stampLogg, setStampLogg] = useState([]);
  const [visaStampla, setVisaStampla] = useState(false);
  const [visaBeredning, setVisaBeredning] = useState(false);
  const [vald, setVald] = useState(null);
  const [pinInput, setPinInput] = useState('');
  const [fel, setFel] = useState('');
  const [skickar, setSkickar] = useState(false);
  const [beredningText, setBeredningText] = useState('');

  const kundId = valdKund.id;
  const kundNamn = valdKund.namn;
  const kategori = aktivKundFlik;
  const arStamplingsbar = STAMPLING_OMRADEN.includes(kategori);

  const hamtaStampling = useCallback(() => {
    if (!token || !arStamplingsbar) { setStampLogg([]); return; }
    fetch(`${API}/api/stampling/kund/${kundId}?omrade=${encodeURIComponent(kategori)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setStampLogg(Array.isArray(d) ? d : [])).catch(() => {});
  }, [token, kundId, kategori, arStamplingsbar]);

  useEffect(() => { hamtaStampling(); }, [hamtaStampling]);

  useEffect(() => {
    if (!token || !arStamplingsbar) return;
    fetch(`${API}/api/stampling/anvandare`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setAnvandare).catch(() => {});
  }, [token, arStamplingsbar]);

  const oppnaStampla = () => { setVald(null); setPinInput(''); setFel(''); setVisaStampla(true); };

  const stampla = async () => {
    if (!vald) { setFel('Välj person'); return; }
    if (pinInput.length !== 4) { setFel('Ange 4 siffror'); return; }
    setSkickar(true);
    const kommerBliIn = vald.status !== 'in';
    const res = await fetch(`${API}/api/stampling/stampla`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: vald.id, pin: pinInput,
        omrade: kommerBliIn ? kategori : undefined,
        kundId: kommerBliIn ? kundId : undefined,
        kundNamn: kommerBliIn ? kundNamn : undefined,
      }),
    });
    const data = await res.json();
    setSkickar(false);
    if (!res.ok) { setFel(data.error || 'Något gick fel'); setPinInput(''); return; }
    setVisaStampla(false);
    hamtaStampling();
  };

  const sparaBeredning = () => {
    const trimmed = beredningText.trim();
    if (!trimmed) return;
    const entry = { id: Date.now().toString(), kategori, text: trimmed, av: inloggad?.namn || inloggad?.username || '', tid: new Date().toISOString() };
    uppdateraKund({ ...valdKund, logg: [...(valdKund.logg || []), entry] });
    setBeredningText('');
    setVisaBeredning(false);
  };

  const beredningLogg = (valdKund.logg || []).filter(e => e.kategori === kategori);
  const materialLista = valdKund.material?.[kategori] || [];
  const kundRuns = (ecwRuns || []).filter(run =>
    run.projekt?.toLowerCase() === kundNamn?.toLowerCase() ||
    (run.comNo && run.comNo.toLowerCase() === kundNamn?.toLowerCase()));
  const kombinerad = [
    ...stampLogg.map(e => ({ id: 's' + e.id, ikon: '⏱️', text: `${e.namn} stämplade ${e.typ === 'in' ? 'IN' : 'UT'}`, tid: e.tid })),
    ...beredningLogg.map(e => ({ id: 'b' + e.id, ikon: '📝', text: `${e.text} (${e.av})`, tid: e.tid })),
  ].sort((a, b) => a.tid < b.tid ? 1 : -1).slice(0, 8);

  return (
    <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16, padding: 14 }]}>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
        {arStamplingsbar && (
          <TouchableOpacity onPress={oppnaStampla} style={{ backgroundColor: '#2563eb', borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>⏱️ Stämpla</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => setVisaBeredning(true)} style={{ backgroundColor: c.input, borderColor: c.inputBorder, borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14 }}>
          <Text style={{ color: c.text, fontWeight: '700', fontSize: 13 }}>📝 Beredning</Text>
        </TouchableOpacity>
      </View>

      {kombinerad.length === 0 ? (
        <Text style={{ color: c.textMuted, fontSize: 12 }}>Inget loggat ännu för {kategori}.</Text>
      ) : (
        kombinerad.map(e => (
          <Text key={e.id} style={{ color: c.textMuted, fontSize: 12, marginBottom: 3 }}>
            {e.ikon} {e.text} · {formatKlockslag(e.tid)}
          </Text>
        ))
      )}

      <Modal visible={visaStampla} animationType="fade" transparent onRequestClose={() => setVisaStampla(false)}>
        <View style={um.bakgrund}>
          <View style={[um.panel, { backgroundColor: c.modal, width: 320 }]}>
            <View style={um.rubrikRad}>
              <Text style={[um.rubrik, { color: c.textRubrik }]}>Stämpla · {kategori}</Text>
              <TouchableOpacity onPress={() => setVisaStampla(false)}><Text style={[um.stang, { color: c.textMuted }]}>✕</Text></TouchableOpacity>
            </View>
            {!vald ? (
              <ScrollView style={{ maxHeight: 280 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {anvandare.length === 0 && <Text style={{ color: c.textMuted, fontSize: 12 }}>Inga användare hittades.</Text>}
                  {anvandare.map(p => (
                    <TouchableOpacity key={p.id} onPress={() => setVald(p)}
                      style={{ width: 120, backgroundColor: c.input, borderColor: p.status === 'in' ? '#16a34a' : c.inputBorder, borderWidth: p.status === 'in' ? 2 : 1, borderRadius: 10, padding: 10, alignItems: 'center' }}>
                      <Text style={{ fontSize: 24 }}>{p.avatar || '👤'}</Text>
                      <Text style={{ color: c.text, fontWeight: '600', fontSize: 12, textAlign: 'center', marginTop: 4 }}>{p.namn}</Text>
                      <Text style={{ color: p.status === 'in' ? '#16a34a' : c.textMuted, fontSize: 10, marginTop: 2, textAlign: 'center' }}>
                        {p.status === 'in' ? `Inne · ${p.omrade}${p.kundNamn ? ' · ' + p.kundNamn : ''}` : 'Ute'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            ) : (
              <>
                <Text style={{ color: c.textMuted, marginBottom: 8 }}>
                  {vald.namn} — {vald.status === 'in'
                    ? `stämplar UT${vald.kundNamn && vald.kundNamn !== kundNamn ? ` (var inne på ${vald.kundNamn})` : ''}`
                    : `stämplar IN på ${kategori} · ${kundNamn}`}
                </Text>
                {fel ? <Text style={{ color: '#ef4444', marginBottom: 8 }}>{fel}</Text> : null}
                <TextInput
                  style={[um.input, { textAlign: 'center', fontSize: 22, letterSpacing: 6, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                  value={pinInput} onChangeText={t => setPinInput(t.replace(/\D/g, '').slice(0, 4))}
                  keyboardType="numeric" secureTextEntry maxLength={4} autoFocus onSubmitEditing={stampla} />
                <TouchableOpacity style={[um.laggKnapp, skickar && { opacity: 0.6 }]} disabled={skickar} onPress={stampla}>
                  <Text style={um.laggText}>{skickar ? 'Skickar...' : `Stämpla ${vald.status === 'in' ? 'UT' : 'IN'}`}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setVald(null)} style={{ marginTop: 8, alignItems: 'center' }}>
                  <Text style={{ color: c.textMuted, fontSize: 12 }}>← Välj annan person</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      <Modal visible={visaBeredning} animationType="fade" transparent onRequestClose={() => setVisaBeredning(false)}>
        <View style={um.bakgrund}>
          <View style={[um.panel, { backgroundColor: c.modal, width: 480 }]}>
            <View style={um.rubrikRad}>
              <Text style={[um.rubrik, { color: c.textRubrik }]}>Beredning · {kategori}</Text>
              <TouchableOpacity onPress={() => setVisaBeredning(false)}><Text style={[um.stang, { color: c.textMuted }]}>✕</Text></TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 500 }}>
              {kategori === 'Glas' && (valdKund.matt?.length > 0) && (
                <View style={{ marginBottom: 14 }}>
                  <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>GLASMÅTT</Text>
                  {valdKund.matt.map((m, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 }}>
                      <Text style={{ color: c.textMuted, fontSize: 12 }}>Enhet {i + 1}:</Text>
                      <Text style={{ color: c.text, fontSize: 13, fontWeight: '600' }}>{m.widthMm} × {m.heightMm} mm</Text>
                      {m.leaves ? <Text style={{ color: c.textMuted, fontSize: 12 }}>· {m.leaves} båge{m.leaves === 1 ? '' : 'ar'}</Text> : null}
                    </View>
                  ))}
                </View>
              )}

              {(kategori === 'Alufräs' || kategori === 'Beslag') && (
                <PdfFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
              )}

              {kategori === 'Träfräs' && (
                <>
                  <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>BTL-FILER</Text>
                  <BtlFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
                  <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 }}>STEP-FILER</Text>
                  <StepFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
                </>
              )}

              {kategori === 'Alufräs' && (
                <>
                  <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>ECW-FILER</Text>
                  <AlufrasFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
                  {kundRuns.length > 0 && (
                    <View style={{ marginBottom: 12 }}>
                      <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>ECW-KÖRNINGAR</Text>
                      {kundRuns.map(run => (
                        <View key={run.id} style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 8 }]}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14 }}>✅ {run.projekt}</Text>
                            <Text style={{ color: c.textMuted, fontSize: 12 }}>{new Date(run.tid).toLocaleString('sv-SE')}</Text>
                          </View>
                          {(run.partier || []).map((p, i) => (
                            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                              <Text style={{ color: c.textMuted, fontSize: 13, minWidth: 34, fontWeight: '600' }}>{p.label}</Text>
                              <Text style={{ color: c.text, fontSize: 13 }}>{p.breddMm} × {p.hoejdMm} mm</Text>
                              <Text style={{ color: c.textMuted, fontSize: 12 }}>{p.baagar} bågar · {p.serie}-serien</Text>
                            </View>
                          ))}
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}

              {materialLista.length > 0 && (
                <View style={{ marginBottom: 14 }}>
                  <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>MATERIAL — {kategori}</Text>
                  {materialLista.map(m => (
                    <View key={m.produktId} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: c.kortBorder }}>
                      <Text style={{ color: c.text, fontSize: 13 }}>{m.namn}</Text>
                      <Text style={{ color: c.textMuted, fontSize: 13 }}>{m.antal}{m.enhet}</Text>
                    </View>
                  ))}
                </View>
              )}

              <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>LÄGG TILL ANTECKNING</Text>
              <Text style={{ color: c.textMuted, marginBottom: 8 }}>Vad är gjort? T.ex. "ECW skickat till Alufräs"</Text>
              <TextInput
                style={[um.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                value={beredningText} onChangeText={setBeredningText}
                placeholder="Beskrivning..." placeholderTextColor={c.textMuted} onSubmitEditing={sparaBeredning} />
              <TouchableOpacity style={um.laggKnapp} onPress={sparaBeredning}>
                <Text style={um.laggText}>Spara</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Sammanställning — ungefärlig summering av alla kunders glas/mått/material,
// grupperat per system (ASE60 = Bostandard, ASS32 = Vår-/Höst-/Vinterpaket)
// via kundens paket-tagg. Kunder utan paket men med ASE60-koppling räknas
// ändå som ASE60 (de har mått/glasdata som bevisar systemet).
function SammanstallningVy({ kunder, ase60Projekt, c }) {
  const alla = React.useMemo(() => {
    const combined = [];
    for (const proj of ase60Projekt) {
      const sparad = kunder.find(k => k.id === proj.id || k.ase60ProjectId === proj.id);
      combined.push({
        id: proj.id, namn: proj.name,
        // system följer med per parti — annars går det inte att se att kunden
        // är ASS32 när paket-taggen saknas (se systemFor nedan).
        matt: proj.units?.map(u => ({ widthMm: u.widthMm, heightMm: u.heightMm, leaves: u.leaves, system: u.system || 'ase60' })) || [],
        material: sparad?.material || {},
        paket: sparad?.paket || proj.paket || null,
        ase60ProjectId: proj.id,
      });
    }
    for (const k of kunder.filter(k => !ase60Projekt.some(p => p.id === k.ase60ProjectId || p.id === k.id))) {
      combined.push({ id: k.id, namn: k.namn, matt: k.matt || [], material: k.material || {}, paket: k.paket || null, ase60ProjectId: k.ase60ProjectId || null });
    }
    return combined;
  }, [kunder, ase60Projekt]);

  // Paket-taggen först. Saknas den (nästan alla Konfigurator-projekt har tomt
  // paket) läser vi av partiernas FAKTISKA system — units.system från
  // generatorn, eller serie från ecw-runs. Utan det klassades varje ASS32-kund
  // som ASE60 av fallbacken, så ASS32 syntes aldrig i sammanställningen.
  const arAss32Parti = (m) => String(m?.system || m?.serie || '').toUpperCase() === 'ASS32';
  const systemFor = (k) => {
    const franPaket = paketTillSystem(k.paket);
    if (franPaket) return franPaket;
    const matt = k.matt || [];
    if (matt.length && matt.every(arAss32Parti)) return 'ASS32';
    if (matt.some(arAss32Parti)) return 'BLANDAT';
    return (k.ase60ProjectId || matt.length > 0) ? 'ASE60' : 'Ospecificerat';
  };

  const grupper = React.useMemo(() => {
    const map = new Map();
    for (const k of alla) {
      const s = systemFor(k);
      const g = map.get(s) || { namn: s, kunder: [], glasAntal: 0, glasYtaM2: 0, material: new Map() };
      g.kunder.push(k);
      for (const m of (k.matt || [])) {
        const leaves = m.leaves || 1;
        g.glasAntal += leaves;
        g.glasYtaM2 += (m.widthMm / 1000) * (m.heightMm / 1000) * leaves;
      }
      for (const kategori of Object.keys(k.material || {})) {
        for (const item of (k.material[kategori] || [])) {
          const key = item.artikel || item.produktId;
          const ex = g.material.get(key) || { namn: item.namn, artikel: item.artikel, enhet: item.enhet, antal: 0 };
          ex.antal += parseInt(item.antal) || 0;
          g.material.set(key, ex);
        }
      }
      map.set(s, g);
    }
    return [...map.values()].sort((a, b) => b.kunder.length - a.kunder.length);
  }, [alla]);

  const rubrikFor = (namn) => {
    if (namn === 'ASE60') return '🪟 ASE 60 (Bostandard)';
    if (namn === 'ASS32') return '🏡 ASS 32 (Vår-/Höst-/Vinterpaket)';
    if (namn === 'BLANDAT') return '🧩 Blandat (ASE 60 + ASS 32)';
    return '❔ Ospecificerat paket';
  };

  return (
    <ScrollView style={{ flex: 1 }}>
      <Text style={[styles.kategoriRubrik, { color: c.textRubrik, marginBottom: 4 }]}>📊 Sammanställning</Text>
      <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 16 }}>
        Ungefärlig beräkning baserad på inlagda kunder, mått och material — ingen exakt lagerinventering.
      </Text>

      <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16, padding: 14 }]}>
        <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 }}>TOTALT ANTAL KUNDER</Text>
        <Text style={{ color: c.textRubrik, fontSize: 28, fontWeight: '700' }}>{alla.length}</Text>
      </View>

      {grupper.map(g => {
        const material = [...g.material.values()].sort((a, b) => b.antal - a.antal);
        return (
          <View key={g.namn} style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16, padding: 14 }]}>
            <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 16, marginBottom: 10 }}>{rubrikFor(g.namn)}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 20, marginBottom: 12 }}>
              <View>
                <Text style={{ color: c.textMuted, fontSize: 11 }}>Kunder</Text>
                <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 20 }}>{g.kunder.length}</Text>
              </View>
              {g.glasAntal > 0 && (
                <>
                  <View>
                    <Text style={{ color: c.textMuted, fontSize: 11 }}>Glas (st)</Text>
                    <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 20 }}>{g.glasAntal}</Text>
                  </View>
                  <View>
                    <Text style={{ color: c.textMuted, fontSize: 11 }}>Glasyta (ca m²)</Text>
                    <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 20 }}>{g.glasYtaM2.toFixed(1)}</Text>
                  </View>
                </>
              )}
            </View>
            {material.length > 0 && (
              <View style={{ marginBottom: 10 }}>
                <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
                  MATERIAL/PROFILER (topp {Math.min(10, material.length)} av {material.length})
                </Text>
                {material.slice(0, 10).map((m, i) => (
                  <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: c.kortBorder }}>
                    <Text style={{ color: c.text, fontSize: 13 }}>{m.namn}{m.artikel ? ` (${m.artikel})` : ''}</Text>
                    <Text style={{ color: c.textMuted, fontSize: 13 }}>{m.antal}{m.enhet || ''}</Text>
                  </View>
                ))}
              </View>
            )}
            <Text style={{ color: c.textMuted, fontSize: 11 }}>
              Kunder: {g.kunder.map(k => k.namn).join(', ')}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

// ─── Planering ────────────────────────────────────────────────────────────────
// Produktionstavla: en rad per kund med leverans-/start-/klart-datum och en ruta
// per moment (samma moment som kundkortets flikar). Tabell och inte kanban för
// att hela veckan ska rymmas på en skärm i verkstaden.
const PLANERING_VARNING_DAGAR = 7; // gult när klart-datumet är inom en vecka

// Dagens datum som ÅÅÅÅ-MM-DD i LOKAL tid. toISOString() hade gett UTC och
// därmed fel dygn under svensk sommartid tidiga morgnar — och då hade
// "försenad"-markeringen slagit om ett dygn för tidigt.
function idagISO() {
  return new Date().toLocaleDateString('sv-SE');
}
// Heldagar kvar till ett datum. Räknas på UTC-midnatt för båda datumen så att
// sommartidsskiftet inte ger 23/25-timmarsdygn och avrundningsfel.
function dagarKvar(datum) {
  if (!datum) return null;
  const [a, m, d] = String(datum).split('-').map(Number);
  const [ia, im, idag] = idagISO().split('-').map(Number);
  if (!a || !m || !d) return null;
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ia, im - 1, idag)) / 86400000);
}
const dagarText = (n) => `${n} dag${Math.abs(n) === 1 ? '' : 'ar'}`;

// Radens färg styrs av klart-datumet OCH hur många moment som är avbockade: en
// kund som hunnit klart är grön även om datumet passerat.
function planeringStatus(klartDatum, klara, totalt) {
  if (totalt > 0 && klara >= totalt) return { niva: 'klar', text: '✓ Klar', farg: '#16a34a', ton: 'rgba(22,163,74,0.10)' };
  const dagar = dagarKvar(klartDatum);
  if (dagar === null) return { niva: 'oplanerad', text: 'Inget datum', farg: '#94a3b8', ton: null };
  if (dagar < 0) return { niva: 'sen', text: `${dagarText(-dagar)} sen`, farg: '#ef4444', ton: 'rgba(239,68,68,0.13)' };
  if (dagar === 0) return { niva: 'snart', text: 'Ska va klart idag', farg: '#f59e0b', ton: 'rgba(245,158,11,0.15)' };
  if (dagar <= PLANERING_VARNING_DAGAR) return { niva: 'snart', text: `${dagarText(dagar)} kvar`, farg: '#f59e0b', ton: 'rgba(245,158,11,0.15)' };
  return { niva: 'normal', text: `${dagarText(dagar)} kvar`, farg: '#64748b', ton: null };
}

const kortDatum = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getDate()}/${d.getMonth() + 1}`; };
const fornamn = (namn) => String(namn || '').trim().split(/\s+/)[0] || '';

// Datumfält. react-native-webs TextInput kan inte bli type="date" (den sätter
// alltid type själv), och verkstadens surfplatta ska ha en riktig datumväljare
// i stället för fritext — därför ett äkta input-element på webben och TextInput
// som reserv på native.
function DatumFalt({ varde, onValt, c, tema }) {
  const [lokal, setLokal] = React.useState(varde || '');
  // Servern är facit: när svaret kommit (eller någon annan ändrat) synkas fältet.
  React.useEffect(() => { setLokal(varde || ''); }, [varde]);
  if (Platform.OS === 'web') {
    return React.createElement('input', {
      type: 'date',
      value: lokal,
      onChange: (e) => { setLokal(e.target.value); onValt(e.target.value); },
      style: {
        backgroundColor: c.input, color: c.inputText, border: `1px solid ${c.inputBorder}`,
        borderRadius: 6, padding: '6px 6px', fontSize: 13, width: '100%', boxSizing: 'border-box',
        fontFamily: 'inherit', colorScheme: tema === 'mörkt' ? 'dark' : 'light',
      },
    });
  }
  return (
    <TextInput
      style={[styles.input, { marginBottom: 0, fontSize: 13, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
      placeholder="ÅÅÅÅ-MM-DD" placeholderTextColor={c.textMuted}
      value={lokal} onChangeText={setLokal} onBlur={() => onValt(lokal)} />
  );
}

// Väljaren som lyfter in en kund på tavlan. Leveransdatumet sätts direkt här,
// och det är ett medvetet val: en rad utan leveransdatum syns ändå inte på
// tavlan, så "lägg till tomt och fyll i sen" hade gett en rad som fanns i
// verkstadens huvud men försvann vid nästa omladdning. Ett steg, ett sparande,
// och kunden är antingen inplanerad eller inte.
function LaggTillPaTavlanModal({ valjbara, c, tema, mobil, sparar, onStang, onLagg }) {
  const [sok, setSok] = React.useState('');
  const [vald, setVald] = React.useState(null);
  const [datum, setDatum] = React.useState('');
  const q = sok.trim().toLowerCase();
  const traffar = q ? valjbara.filter(k => (k.namn || '').toLowerCase().includes(q)) : valjbara;

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onStang}>
      <View style={um.bakgrund}>
        <View style={[um.panel, { backgroundColor: c.modal, width: mobil ? '92%' : 460 }]}>
          <View style={um.rubrikRad}>
            <Text style={[um.rubrik, { color: c.textRubrik }]}>Lägg till kund på tavlan</Text>
            <TouchableOpacity onPress={onStang}><Text style={[um.stang, { color: c.textMuted }]}>✕</Text></TouchableOpacity>
          </View>

          {!vald ? (
            <>
              <TextInput
                style={[um.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText, marginBottom: 8 }]}
                placeholder="Sök kund..." placeholderTextColor={c.textMuted}
                value={sok} onChangeText={setSok} autoFocus />
              {/* Listan kan bli lång (alla gamla projekt ligger här) — egen
                  scroll så panelen aldrig växer utanför surfplattans skärm. */}
              <ScrollView style={{ maxHeight: 300 }}>
                {traffar.length === 0 && (
                  <Text style={{ color: c.textMuted, fontSize: 13, paddingVertical: 10 }}>
                    {valjbara.length === 0 ? 'Alla kunder ligger redan på tavlan.' : 'Ingen kund matchar sökningen.'}
                  </Text>
                )}
                {traffar.map(k => (
                  <TouchableOpacity
                    key={k.id}
                    onPress={() => { setVald(k); setDatum(''); }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 10,
                      borderRadius: 8, marginBottom: 4, backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder }}>
                    {!!k.farg && <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: fargTillCSS(k.farg), borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' }} />}
                    <Text style={{ color: c.text, fontSize: 14, fontWeight: '600', flex: 1 }}>{k.namn}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                {!!vald.farg && <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: fargTillCSS(vald.farg), borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' }} />}
                <Text style={{ color: c.textRubrik, fontSize: 16, fontWeight: '700' }}>{vald.namn}</Text>
              </View>
              <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 8 }}>
                Leveransdatum — datumet kunden är lovad, och det som lägger kunden på tavlan.
                Produktionsstart och klart-datum fyller du i på raden efteråt.
              </Text>
              <DatumFalt varde={datum} onValt={setDatum} c={c} tema={tema} />
              <TouchableOpacity
                onPress={() => onLagg(vald, datum)}
                disabled={!datum || sparar}
                style={[um.laggKnapp, { marginTop: 12 }, (!datum || sparar) && { opacity: 0.5 }]}>
                <Text style={um.laggText}>{sparar ? 'Sparar...' : 'Lägg till på tavlan'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setVald(null)} style={{ marginTop: 10, alignItems: 'center' }}>
                <Text style={{ color: c.textMuted, fontSize: 12 }}>← Välj annan kund</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function PlaneringVy({ kunder, ase60Projekt, token, c, mobil, onKundSparad, onOppnaKund }) {
  const { tema } = React.useContext(TemaContext) || {};
  const [sok, setSok] = React.useState('');
  // Klara kunder göms som standard — tavlan ska visa det som ligger kvar.
  const [visaKlara, setVisaKlara] = React.useState(false);
  const [visaLaggTill, setVisaLaggTill] = React.useState(false);
  // Sorteringsval (leveransdatum som förr). Rader utan datum läggs sist —
  // annars hamnar tomma fält först och skymmer det som faktiskt är planerat.
  const [sortering, setSortering] = React.useState('leverans');
  const [fel, setFel] = React.useState('');
  const [sparar, setSparar] = React.useState(null); // kundId:falt som just skickas
  // Räknare som remountar datumfälten. Ångrar man borttagningen av en kund ska
  // fältet hoppa tillbaka till serverns värde, och det gör det bara om den
  // lokala kopian i DatumFalt nollställs.
  const [aterstall, setAterstall] = React.useState(0);

  // Samma sammanslagning som Sammanställningen: ASE60-projekten visas som kunder
  // även innan de finns i kunder.json. Är kunden redan sparad används DEN radens
  // id, annars skulle en andra rad skapas för samma projekt.
  const lista = React.useMemo(() => {
    const alla = [];
    for (const proj of ase60Projekt) {
      const sparad = kunder.find(k => k.id === proj.id || k.ase60ProjectId === proj.id);
      alla.push({
        id: sparad?.id || proj.id, namn: proj.name, farg: sparad?.farg || proj.color || '',
        ase60ProjectId: proj.id, planering: sparad?.planering || {}, klart: sparad?.klart || {},
      });
    }
    for (const k of kunder.filter(k => !ase60Projekt.some(p => p.id === k.ase60ProjectId || p.id === k.id))) {
      alla.push({
        id: k.id, namn: k.namn, farg: k.farg || '', ase60ProjectId: k.ase60ProjectId || null,
        planering: k.planering || {}, klart: k.klart || {},
      });
    }
    return alla;
  }, [kunder, ase60Projekt]);

  // Tavlan är inte kundregistret. En kund hör hit först när någon planerat in
  // den, och det är leveransdatumet som säger det — utan den gränsen hamnade
  // varenda gammalt ASE60-projekt på tavlan och gjorde den oanvändbar.
  const arPlanerad = (k) => !!k.planering?.leveransDatum;
  // "Klar" = alla moment avbockade, i planeringen eller på kundkortet.
  const arKlar = (k) => PLANERING_MOMENT.every(f => k.planering?.moment?.[f]?.klar || k.klart?.[f]);

  const planerade = React.useMemo(() => lista.filter(arPlanerad), [lista]);
  // Kunder som ännu inte är inplanerade — de som "+ Lägg till kund" väljer bland.
  const valjbara = React.useMemo(
    () => lista.filter(k => !arPlanerad(k)).sort((a, b) => (a.namn || '').localeCompare(b.namn || '', 'sv')),
    [lista]);

  const rader = React.useMemo(() => {
    const q = sok.trim().toLowerCase();
    // En kund där ALLA moment är avbockade är färdigproducerad och hör inte
    // hemma på produktionstavlan längre. Den göms bara — "Visa klara" tar fram
    // den igen, inget raderas.
    return planerade
      .filter(k => visaKlara || !arKlar(k))
      .filter(k => !q || (k.namn || '').toLowerCase().includes(q))
      // Vald sortering styr ordningen (leveransdatum som default — datumet
      // kunden är lovad). Lika värden sorteras på namn så ordningen inte
      // hoppar mellan omritningar. Saknat datum läggs sist.
      .sort((a, b) => {
        const namn = () => (a.namn || '').localeCompare(b.namn || '', 'sv');
        const val = PLANERING_SORT.find(s => s.id === sortering) || PLANERING_SORT[0];
        if (val.id === 'namn') return namn();
        if (val.id === 'framsteg') {
          const fa = antalKlara(a), fb = antalKlara(b);
          return fa !== fb ? fa - fb : namn();
        }
        const da = a.planering?.[val.falt] || '', db = b.planering?.[val.falt] || '';
        if (!da && !db) return namn();
        if (!da) return 1;          // utan datum sist
        if (!db) return -1;
        return da !== db ? (da < db ? -1 : 1) : namn();
      });
  }, [planerade, sok, visaKlara, sortering]);

  // Ett moment räknas som avrapporterat även när det bockats av på kundkortet
  // (där dras materialet från lagret) — annars hade planeringen visat 0/4 för en
  // kund som verkstaden redan kört färdigt.
  const momentStatus = (rad, moment) => {
    const p = rad.planering?.moment?.[moment];
    if (p?.klar) return { klar: true, av: p.av, tid: p.tid, kalla: 'planering' };
    const k = rad.klart?.[moment];
    if (k) return { klar: true, av: k.av, tid: k.tid, kalla: 'kundkort' };
    return { klar: false };
  };
  const antalKlara = (rad) => PLANERING_MOMENT.filter(f => momentStatus(rad, f).klar).length;

  // Returnerar om det gick vägen, så att den som lägger till en kund kan stänga
  // väljaren först när servern svarat (och annars låta felrutan synas).
  const skicka = (rad, url, metod, body, nyckel) => {
    if (!token) return Promise.resolve(false);
    setSparar(nyckel);
    setFel('');
    return fetch(url, {
      method: metod,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // namn/ase60ProjectId följer med så att servern kan skapa raden för ett
      // ASE60-projekt som ännu inte finns i kunder.json.
      body: JSON.stringify({ ...body, namn: rad.namn, ase60ProjectId: rad.ase60ProjectId }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('spara'))))
      .then(kund => { onKundSparad(kund); setSparar(null); return true; })
      .catch(() => { setSparar(null); setFel('Kunde inte spara — kontrollera nätverket och försök igen.'); return false; });
  };

  const sattDatum = (rad, falt, varde) => {
    // Leveransdatumet är det som håller kunden kvar på tavlan: rensas det
    // försvinner raden. Fråga först — annars kan ett feltryck i datumfältet ta
    // bort kunden mitt under handen på användaren.
    if (falt === 'leveransDatum' && !varde && rad.planering?.leveransDatum) {
      const fraga = `Ta bort ${rad.namn} från planeringstavlan?\n\n`
        + 'Övriga datum och avbockningar finns kvar — kunden kommer tillbaka när du sätter ett nytt leveransdatum.';
      if (Platform.OS === 'web' && !window.confirm(fraga)) {
        setAterstall(n => n + 1); // ångrat: låt fältet hoppa tillbaka till det sparade datumet
        return Promise.resolve(false);
      }
    }
    return skicka(rad, `${API}/api/kunder/${rad.id}/planering`, 'PUT', { [falt]: varde }, `${rad.id}:${falt}`);
  };

  // Väljarens enda uppgift: sätta leveransdatumet, för det är det som lyfter in
  // kunden på tavlan.
  const laggTillPaTavlan = (rad, datum) =>
    sattDatum(rad, 'leveransDatum', datum).then(ok => { if (ok) setVisaLaggTill(false); });

  const vaxlaMoment = (rad, moment) => {
    const status = momentStatus(rad, moment);
    if (status.klar && status.kalla === 'kundkort') {
      setFel(`${moment} är avrapporterat från kundkortet (materialet är utbokat) — ångra det där.`);
      return;
    }
    if (status.klar) {
      const fraga = `Ångra avbockning av ${moment} för ${rad.namn}?`;
      if (Platform.OS === 'web' && !window.confirm(fraga)) return;
    }
    skicka(rad, `${API}/api/kunder/${rad.id}/planering/moment`, 'POST',
      { moment, klar: !status.klar }, `${rad.id}:${moment}`);
  };

  const KOL = { kund: 200, datum: 132, moment: 108, framsteg: 104, status: 140 };
  const tabellBredd = KOL.kund + KOL.datum * 3 + KOL.moment * PLANERING_MOMENT.length + KOL.framsteg + KOL.status;
  // Nyckeltalen räknas på ALLA planerade kunder, inte på raderna som råkar synas:
  // sökrutan och "Visa klara" ska inte kunna flytta siffrorna, då gick de inte
  // att lita på som lägesbild (och Klara hade alltid visat 0 när klara göms).
  // Varje planerad kund hamnar i exakt en hink — klar / sen / snart / på tid —
  // så Kunder är summan de tre andra räknas ur.
  const summering = React.useMemo(() => ({
    kunder: planerade.length,
    sena: planerade.filter(r => planeringStatus(r.planering?.klartDatum, antalKlara(r), PLANERING_MOMENT.length).niva === 'sen').length,
    snart: planerade.filter(r => planeringStatus(r.planering?.klartDatum, antalKlara(r), PLANERING_MOMENT.length).niva === 'snart').length,
    klara: planerade.filter(arKlar).length,
  }), [planerade]);
  // Länkfärg: samma blå som "← Tillbaka till kunder", ljusare i mörkt tema där
  // den annars försvinner mot de tonade radbakgrunderna.
  const lankFarg = tema === 'mörkt' ? '#93c5fd' : '#2563eb';

  const Rubrik = ({ text, bredd, center }) => (
    <View style={{ width: bredd, paddingHorizontal: 8, paddingVertical: 10 }}>
      <Text style={{ color: c.tabellHuvudText, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textAlign: center ? 'center' : 'left' }}>{text}</Text>
    </View>
  );

  return (
    <ScrollView style={{ flex: 1 }}>
      <Text style={[styles.kategoriRubrik, { color: c.textRubrik, marginBottom: 4 }]}>📅 Planering</Text>
      <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 12 }}>
        Kunder med leveransdatum ligger på tavlan — sätt datum, bocka av momenten allt eftersom,
        och när allt är klart faller kunden av.
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, paddingVertical: 8, paddingHorizontal: 12 }]}>
          <Text style={{ color: c.textMuted, fontSize: 11 }}>Kunder</Text>
          <Text style={{ color: c.textRubrik, fontSize: 18, fontWeight: '700' }}>{summering.kunder}</Text>
        </View>
        <View style={[styles.kort, { backgroundColor: c.kort, borderColor: '#ef4444', paddingVertical: 8, paddingHorizontal: 12 }]}>
          <Text style={{ color: c.textMuted, fontSize: 11 }}>Försenade</Text>
          <Text style={{ color: '#ef4444', fontSize: 18, fontWeight: '700' }}>{summering.sena}</Text>
        </View>
        <View style={[styles.kort, { backgroundColor: c.kort, borderColor: '#f59e0b', paddingVertical: 8, paddingHorizontal: 12 }]}>
          <Text style={{ color: c.textMuted, fontSize: 11 }}>Inom {PLANERING_VARNING_DAGAR} dagar</Text>
          <Text style={{ color: '#f59e0b', fontSize: 18, fontWeight: '700' }}>{summering.snart}</Text>
        </View>
        <View style={[styles.kort, { backgroundColor: c.kort, borderColor: '#16a34a', paddingVertical: 8, paddingHorizontal: 12 }]}>
          <Text style={{ color: c.textMuted, fontSize: 11 }}>Klara</Text>
          <Text style={{ color: '#16a34a', fontSize: 18, fontWeight: '700' }}>{summering.klara}</Text>
        </View>
        {/* Enda vägen in på tavlan: en kund utan leveransdatum syns inte, så
            utan väljaren hade tavlan stått tom och aldrig gått att fylla. */}
        <TouchableOpacity
          onPress={() => setVisaLaggTill(true)}
          style={{ backgroundColor: '#2563eb', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>+ Lägg till kund</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setVisaKlara(v => !v)}
          style={[styles.kort, { backgroundColor: visaKlara ? '#16a34a22' : c.kort, borderColor: visaKlara ? '#16a34a' : c.kortBorder, paddingVertical: 8, paddingHorizontal: 12, justifyContent: 'center' }]}>
          <Text style={{ color: visaKlara ? '#16a34a' : c.textMuted, fontSize: 12, fontWeight: '600' }}>
            {visaKlara ? '✓ Visar klara' : 'Visa klara'}
          </Text>
        </TouchableOpacity>
        <TextInput
          style={[styles.sokInput, { backgroundColor: c.sokInput, borderColor: c.inputBorder, color: c.text, width: mobil ? 130 : 200 }]}
          placeholder="Sök kund..." placeholderTextColor={c.textMuted}
          value={sok} onChangeText={setSok} />
        {/* Sortering — knapprad i stället för dropdown så valet syns direkt
            och går att träffa med fingret på surfplattan i verkstan. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <Text style={{ color: c.textMuted, fontSize: 11, marginRight: 2 }}>Sortera:</Text>
          {PLANERING_SORT.map(s => {
            const vald = sortering === s.id;
            return (
              <TouchableOpacity key={s.id} onPress={() => setSortering(s.id)}
                style={[styles.kort, {
                  backgroundColor: vald ? '#2563eb22' : c.kort,
                  borderColor: vald ? '#2563eb' : c.kortBorder,
                  paddingVertical: 7, paddingHorizontal: 10, justifyContent: 'center',
                }]}>
                <Text style={{ color: vald ? '#2563eb' : c.textMuted, fontSize: 12, fontWeight: vald ? '700' : '600' }}>
                  {s.text}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {!!fel && (
        <View style={[styles.varning, { backgroundColor: c.varning, borderColor: c.varningBorder, marginBottom: 12 }]}>
          <Text style={[styles.varningText, { color: c.varningText }]}>{fel}</Text>
        </View>
      )}

      {rader.length === 0 && (
        <Text style={{ color: c.textMuted, textAlign: 'center', marginTop: 40, lineHeight: 20 }}>
          {sok.trim()
            ? 'Ingen planerad kund matchar sökningen.'
            : planerade.length === 0
              ? 'Tavlan är tom — ingen kund har något leveransdatum ännu.\nTryck "+ Lägg till kund", välj kund och sätt leveransdatumet, så dyker raden upp här.'
              : 'Alla planerade kunder är klara. Tryck "Visa klara" för att se dem.'}
        </Text>
      )}

      {/* Sökrutan och "Visa klara" ändrar vad som syns men inte nyckeltalen —
          säg därför rakt ut hur många rader listan är nere på just nu. */}
      {rader.length > 0 && rader.length !== planerade.length && (
        <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 6 }}>
          Visar {rader.length} av {planerade.length} planerade kunder.
        </Text>
      )}

      {/* Tabellen får scrolla i sidled i stället för att tryckas ihop — på
          surfplattan är kolumnerna annars för smala för att träffa med fingret. */}
      {rader.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={true} style={{ marginBottom: 20 }}>
          <View style={{ width: tabellBredd }}>
            <View style={{ flexDirection: 'row', backgroundColor: c.tabellHuvud, borderRadius: 8, marginBottom: 4 }}>
              <Rubrik text="KUND" bredd={KOL.kund} />
              <Rubrik text="LEVERANS" bredd={KOL.datum} />
              <Rubrik text="PROD. START" bredd={KOL.datum} />
              <Rubrik text="KLART SENAST" bredd={KOL.datum} />
              {PLANERING_MOMENT.map(f => <Rubrik key={f} text={f.toUpperCase()} bredd={KOL.moment} center />)}
              <Rubrik text="KLART" bredd={KOL.framsteg} center />
              <Rubrik text="STATUS" bredd={KOL.status} />
            </View>

            {rader.map((rad, i) => {
              const klara = antalKlara(rad);
              const status = planeringStatus(rad.planering?.klartDatum, klara, PLANERING_MOMENT.length);
              return (
                <View key={rad.id} style={{
                  flexDirection: 'row', alignItems: 'center', borderRadius: 8, marginBottom: 3,
                  borderLeftWidth: 4, borderLeftColor: status.ton ? status.farg : 'transparent',
                  // Genomskinlig ton i stället för fast pastellfärg: samma
                  // markering fungerar i både ljust och mörkt tema.
                  backgroundColor: status.ton || (i % 2 ? c.radJamn : c.rad),
                }}>
                  {/* Bara kundrutan är klickbar, inte hela raden: datumfälten
                      och momentrutorna ligger i samma rad och ett feltryck på
                      surfplattan skulle annars kasta iväg en till kundkortet. */}
                  <TouchableOpacity
                    onPress={() => onOppnaKund?.(rad)}
                    disabled={!onOppnaKund}
                    style={{ width: KOL.kund - 4, paddingHorizontal: 8, paddingVertical: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {!!rad.farg && <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: fargTillCSS(rad.farg), borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' }} />}
                      <Text numberOfLines={2} style={{ color: onOppnaKund ? lankFarg : c.text, fontWeight: '600', fontSize: 14, flex: 1 }}>{rad.namn}</Text>
                      {!!onOppnaKund && <Text style={{ color: lankFarg, fontSize: 15, fontWeight: '700' }}>›</Text>}
                    </View>
                  </TouchableOpacity>
                  {['leveransDatum', 'produktionStart', 'klartDatum'].map(falt => (
                    <View key={falt} style={{ width: KOL.datum, paddingHorizontal: 6, opacity: sparar === `${rad.id}:${falt}` ? 0.5 : 1 }}>
                      {/* aterstall i nyckeln: ångrad borttagning ska rita om
                          fältet med serverns datum, inte det tömda. */}
                      <DatumFalt key={aterstall} varde={rad.planering?.[falt] || ''} c={c} tema={tema}
                        onValt={v => sattDatum(rad, falt, v)} />
                    </View>
                  ))}
                  {PLANERING_MOMENT.map(moment => {
                    const m = momentStatus(rad, moment);
                    return (
                      <View key={moment} style={{ width: KOL.moment, paddingHorizontal: 4, paddingVertical: 4 }}>
                        <TouchableOpacity
                          onPress={() => vaxlaMoment(rad, moment)}
                          disabled={sparar === `${rad.id}:${moment}`}
                          style={{
                            borderRadius: 6, borderWidth: 1, paddingVertical: 5, paddingHorizontal: 4, alignItems: 'center',
                            backgroundColor: m.klar ? '#dcfce7' : c.input,
                            borderColor: m.klar ? '#16a34a' : c.inputBorder,
                            borderStyle: m.kalla === 'kundkort' ? 'dashed' : 'solid',
                            opacity: sparar === `${rad.id}:${moment}` ? 0.5 : 1,
                          }}>
                          <Text style={{ color: m.klar ? '#15803d' : c.textMuted, fontSize: 12, fontWeight: '600' }}>
                            {m.klar ? '✓' : '○'} {moment}
                          </Text>
                          {m.klar && (
                            <Text numberOfLines={1} style={{ color: '#166534', fontSize: 9, marginTop: 1 }}>
                              {fornamn(m.av) || '—'} {kortDatum(m.tid)}
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                  <View style={{ width: KOL.framsteg, paddingHorizontal: 8, alignItems: 'center' }}>
                    <Text style={{ color: klara === PLANERING_MOMENT.length ? '#16a34a' : c.text, fontWeight: '700', fontSize: 14 }}>
                      {klara}/{PLANERING_MOMENT.length}
                    </Text>
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: c.inputBorder, width: '100%', marginTop: 3 }}>
                      <View style={{ height: 4, borderRadius: 2, backgroundColor: klara === PLANERING_MOMENT.length ? '#16a34a' : '#2563eb', width: `${(klara / PLANERING_MOMENT.length) * 100}%` }} />
                    </View>
                  </View>
                  <View style={{ width: KOL.status, paddingHorizontal: 8 }}>
                    <Text style={{ color: status.farg, fontSize: 12, fontWeight: '700' }}>{status.text}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}

      {rader.length > 0 && (
        <Text style={{ color: c.textMuted, fontSize: 11, marginBottom: 20 }}>
          Röd rad = klart-datumet har passerat, gul = inom {PLANERING_VARNING_DAGAR} dagar, grön = alla moment avbockade.
          Streckad ruta = avbockad på kundkortet (materialet utbokat) och ångras där.
          Klicka på kundnamnet för att öppna kundkortet. Rensar du leveransdatumet lämnar kunden tavlan.
        </Text>
      )}

      {visaLaggTill && (
        <LaggTillPaTavlanModal
          valjbara={valjbara} c={c} tema={tema} mobil={mobil} sparar={!!sparar}
          onStang={() => setVisaLaggTill(false)}
          onLagg={laggTillPaTavlan} />
      )}
    </ScrollView>
  );
}

// Lagerförslag / Räckvidd — hur länge lagret räcker: medelförbrukning per kund
// (av inlagda kunders material) separerat per PAKET + FÄRG, och hur många
// kunder nuvarande lagersaldo räcker till per artikel. "Räcker till" =
// lagersaldo ÷ medel per kund. Flaskhalsen (minsta räckvidden bland artiklarna)
// visar hur många kunder hela lagret räcker till för det paketet/färgen.
//
// FÖRBRUKNING_ESTIMAT: teoretisk materialåtgång per genomsnittskund, beräknad
// i ase60-generatorn (computeBeredning / computeBeredningAss32) för en
// representativ parti 3880×2195 mm × 2,43 partier/kund (snitt av
// konfigurator-projektens öppningar, "alla stolpar + 1"). Profiler & packningar
// i löpmeter, beslag/tillbehör/glas i styck. Estimat — förfinas när fler
// kunders paket/partier finns.
const FORBRUKNING_ESTIMAT = {
  partierPerKund: 2.43,
  partiMm: '3880 × 2195',
  system: [
    {
      namn: 'ASS32', styck: 365,
      profiler: [
        { a: '376150', n: 'Outer frame 46 / karm', m: 29.5 },
        { a: '308130', n: 'Track / löpskena', m: 27.7 },
        { a: '284084', n: 'Interlock PVC', m: 20.6 },
        { a: '309190', n: 'Attach-profil 36', m: 18.8 },
        { a: '224634', n: 'Cover horisontell', m: 18.7 },
        { a: '133720', n: 'Vent frame 68 / ribba', m: 18.1 },
        { a: '224690', n: 'Cover vertikal', m: 10.3 },
        { a: '284348', n: 'Cover vertikal', m: 10.3 },
        { a: '309320', n: 'Vent frame / bågram', m: 10.3 },
        { a: '309330', n: 'Glaslist 50', m: 10.3 },
        { a: '133730', n: 'Vent frame 53 / stolpe', m: 10.2 },
      ],
      packningar: [
        { a: '224497', n: 'Brush seal centre bar', m: 77.2 },
        { a: '284262', n: 'Cover gasket', m: 62.1 },
        { a: '224481', n: 'Glazing gasket 24', m: 48.0 },
      ],
    },
    {
      namn: 'ASE60', styck: 923,
      profiler: [
        { a: '504010', n: 'Vent frame 60/82 (bågram)', m: 39.2 },
        { a: '184020', n: 'Glaslist 22-7', m: 36.4 },
        { a: '487000', n: 'Outer frame 48/48 (karm)', m: 20.1 },
        { a: '203195', n: 'Insert prof.', m: 19.3 },
        { a: '203194', n: 'Guide profile', m: 18.4 },
        { a: '201316', n: 'Track St 15', m: 18.4 },
        { a: '278419', n: 'Slider / topprofil', m: 17.7 },
        { a: '460640', n: 'Cover 2/3-tr', m: 10.3 },
        { a: '278368', n: 'Clip-on magnetlist', m: 10.2 },
        { a: '490240', n: 'Cover VF 60', m: 10.2 },
        { a: '542000', n: 'Cover OF', m: 10.1 },
        { a: '220777', n: 'Interlock P-p', m: 10.0 },
        { a: '220787', n: 'Cover prof.', m: 10.0 },
        { a: '203198', n: 'Cover prof.', m: 9.9 },
        { a: '513000', n: 'Struct. prf.', m: 9.5 },
        { a: '487860', n: 'Outer frame botten/tröskel', m: 9.4 },
        { a: '333480', n: 'Gutter 47', m: 9.4 },
        { a: '359700', n: 'Drip bar 36', m: 9.3 },
        { a: '203196', n: 'Insert prof.', m: 9.2 },
        { a: '219657', n: 'Bar 8mm / spanjolett', m: 6.8 },
        { a: '246434', n: 'Glazing clip', m: 4.7 },
        { a: '306300', n: 'Glaslist BS 15-7', m: 4.7 },
      ],
      packningar: [
        { a: '244058', n: 'Gasket cord 2,5', m: 89.3 },
        { a: '244829', n: 'Rebate gasket', m: 40.5 },
        { a: '284321', n: 'Glazing rebate 6', m: 37.0 },
        { a: '284834', n: 'Glazing gasket 3-4', m: 37.0 },
        { a: '244670', n: 'Brush seal centre 8', m: 21.1 },
        { a: '244830', n: 'Rebate gasket', m: 19.3 },
        { a: '244669', n: 'Centre gasket', m: 10.5 },
      ],
    },
  ],
};

function LagerforslagVy({ kunder, produkter, c }) {
  const normFarg = (s) => (s || '').toLowerCase().split(/[\s/,]+/).filter(Boolean)[0] || '';
  const parseDimMm = (d) => { const m = /(\d[\d\s]*)\s*mm/i.exec(String(d || '')); return m ? parseInt(m[1].replace(/\s/g, ''), 10) : null; };

  const produktByArtikel = React.useMemo(() => {
    const m = new Map();
    for (const p of (produkter || [])) {
      const a = String(p.artikel || '').trim();
      if (!a) continue;
      // Flera produkter kan dela artikel (t.ex. extra-post) — summera saldot.
      const ex = m.get(a);
      if (ex) { ex.antal += parseInt(p.antal) || 0; if (Array.isArray(p.farger)) ex.farger.push(...p.farger); if (!ex.dimMm) ex.dimMm = parseDimMm(p.dimension); }
      else m.set(a, { namn: p.namn, antal: parseInt(p.antal) || 0, farger: Array.isArray(p.farger) ? [...p.farger] : [], dimMm: parseDimMm(p.dimension), enhet: p.enhet || 'st' });
    }
    return m;
  }, [produkter]);

  // Lagersaldo i löpmeter för en artikel: packningar lagras redan i meter,
  // profiler i stänger → antal × stocklängd (dimension, fallback 6000 mm).
  const lagerMeterForArtikel = (artikel) => {
    const p = produktByArtikel.get(String(artikel).trim());
    if (!p || !p.antal) return null;
    if (p.enhet === 'm') return p.antal;
    return p.antal * (p.dimMm || 6000) / 1000;
  };

  // Lagersaldo för en artikel i en viss färg (per-färg om produkten spårar
  // färger, annars totalt saldo — gäller färg-neutrala delar som packningar).
  const stockForArtikelFarg = (artikel, farg) => {
    const p = produktByArtikel.get(String(artikel).trim());
    if (!p) return null;
    if (p.farger && p.farger.length > 0) {
      const nf = normFarg(farg);
      const hit = p.farger.find(f => normFarg(f.farg) === nf);
      return hit ? (parseInt(hit.antal) || 0) : 0;
    }
    return p.antal;
  };

  const grupper = React.useMemo(() => {
    const map = new Map();
    for (const k of (kunder || [])) {
      const paket = (k.paket || '').trim() || 'Ospecificerat paket';
      const farg = (k.farg || '').trim() || 'Ospecificerad färg';
      const key = paket + '||' + farg;
      const g = map.get(key) || { paket, farg, antalKunder: 0, medMaterial: 0, artikelSum: new Map() };
      g.antalKunder++;
      const harMaterial = k.material && Object.keys(k.material).length > 0;
      if (harMaterial) {
        g.medMaterial++;
        for (const kat of Object.keys(k.material)) {
          for (const item of (k.material[kat] || [])) {
            const art = String(item.artikel || item.produktId || '').trim();
            if (!art) continue;
            const ex = g.artikelSum.get(art) || { namn: item.namn, artikel: art, enhet: item.enhet, sum: 0 };
            ex.sum += parseInt(item.antal) || 0;
            g.artikelSum.set(art, ex);
          }
        }
      }
      map.set(key, g);
    }
    const out = [];
    for (const g of map.values()) {
      const n = g.medMaterial;
      const rader = [...g.artikelSum.values()].map(a => {
        const medel = n > 0 ? a.sum / n : 0;
        const lager = stockForArtikelFarg(a.artikel, g.farg);
        const rackerTill = (medel > 0 && lager != null) ? Math.floor(lager / medel) : null;
        return { ...a, medel, lager, rackerTill };
      }).sort((x, y) => (x.rackerTill ?? Infinity) - (y.rackerTill ?? Infinity));
      const medRackvidd = rader.filter(r => r.rackerTill != null);
      const flaskhals = medRackvidd.length ? Math.min(...medRackvidd.map(r => r.rackerTill)) : null;
      out.push({ ...g, rader, flaskhals });
    }
    return out.sort((a, b) => a.paket.localeCompare(b.paket, 'sv') || a.farg.localeCompare(b.farg, 'sv'));
  }, [kunder, produktByArtikel]);

  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('.', ',');

  return (
    <ScrollView style={{ flex: 1 }}>
      <Text style={[styles.kategoriRubrik, { color: c.textRubrik, marginBottom: 4 }]}>📦 Lagerförslag — hur länge lagret räcker</Text>
      <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 16 }}>
        Medelförbrukning per kund (av inlagda kunders material), separerat per paket och färg.
        "Räcker till" = lagersaldo ÷ medel per kund. Flaskhalsen (artikeln som tar slut först)
        avgör hur många kunder hela lagret räcker till.
      </Text>

      <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 12, padding: 14 }]}>
        <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 15, marginBottom: 2 }}>
          📐 Förbrukning per genomsnittskund (estimat)
        </Text>
        <Text style={{ color: c.textMuted, fontSize: 11 }}>
          {fmt(FORBRUKNING_ESTIMAT.partierPerKund)} partier/kund · representativ parti {FORBRUKNING_ESTIMAT.partiMm} mm ·
          profiler &amp; packningar i löpmeter per artikel, beslag/tillbehör/glas i styck.
        </Text>
        <Text style={{ color: c.textMuted, fontSize: 10, marginTop: 6 }}>
          Estimat — partiantalet vilar ännu på ett facit (ferdi kilic = 3) och ASE60 är kalibrerat vid höjd 2280.
          Paket per kund saknas i konfiguratorn, så sortering per paket görs när den datan finns.
        </Text>
      </View>

      {FORBRUKNING_ESTIMAT.system.map(sys => {
        const withRack = (list) => list.map(p => {
          const lm = lagerMeterForArtikel(p.a);
          return { ...p, lagerM: lm, racker: (lm != null && p.m > 0) ? Math.floor(lm / p.m) : null };
        });
        const prof = withRack(sys.profiler);
        const pack = withRack(sys.packningar);
        const medRack = [...prof, ...pack].filter(x => x.racker != null);
        const flaskhals = medRack.length ? Math.min(...medRack.map(x => x.racker)) : null;
        const flaskhalsArt = flaskhals != null ? medRack.find(x => x.racker === flaskhals) : null;
        const sumProf = sys.profiler.reduce((s, p) => s + p.m, 0);
        const sumPack = sys.packningar.reduce((s, p) => s + p.m, 0);
        const rad = (p) => (
          <View key={p.a} style={{ flexDirection: 'row', paddingVertical: 2, alignItems: 'center' }}>
            <Text style={{ width: 54, color: c.textMuted, fontSize: 12 }}>{p.a}</Text>
            <Text style={{ flex: 1, color: c.text, fontSize: 12 }} numberOfLines={1}>{p.n}</Text>
            <Text style={{ width: 58, color: c.text, fontSize: 12, textAlign: 'right', fontWeight: '600' }}>{fmt(p.m)} m</Text>
            <Text style={{ width: 66, fontSize: 12, textAlign: 'right', fontWeight: '700', color: p.racker == null ? c.textMuted : (p.racker < 3 ? '#ef4444' : '#16a34a') }}>
              {p.racker == null ? '—' : `${p.racker} kund`}
            </Text>
          </View>
        );
        const kolHuvud = (
          <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.kortBorder, paddingBottom: 3, marginBottom: 3 }}>
            <Text style={{ width: 54, color: c.textMuted, fontSize: 10, fontWeight: '700' }}>ARTIKEL</Text>
            <Text style={{ flex: 1, color: c.textMuted, fontSize: 10, fontWeight: '700' }}></Text>
            <Text style={{ width: 58, color: c.textMuted, fontSize: 10, fontWeight: '700', textAlign: 'right' }}>SNITT/KUND</Text>
            <Text style={{ width: 66, color: c.textMuted, fontSize: 10, fontWeight: '700', textAlign: 'right' }}>RÄCKER TILL</Text>
          </View>
        );
        return (
          <View key={sys.namn} style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 12, padding: 14 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
              <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 16 }}>{sys.namn}</Text>
              {flaskhals != null ? (
                <View style={{ backgroundColor: flaskhals < 3 ? '#fee2e2' : '#dcfce7', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
                  <Text style={{ color: flaskhals < 3 ? '#ef4444' : '#16a34a', fontWeight: '700', fontSize: 13 }}>
                    Lagret räcker till ~{flaskhals} kund{flaskhals === 1 ? '' : 'er'}
                  </Text>
                </View>
              ) : (
                <Text style={{ color: c.textMuted, fontSize: 11 }}>lagersaldo saknas för profilerna</Text>
              )}
            </View>
            <Text style={{ color: c.textMuted, fontSize: 11, marginBottom: 8 }}>
              Snitt {fmt(FORBRUKNING_ESTIMAT.partierPerKund)} partier/kund · {fmt(sumProf)} m profil · {fmt(sumPack)} m packning · {sys.styck} st beslag per kund
              {flaskhalsArt ? ` · flaskhals: ${flaskhalsArt.a} ${flaskhalsArt.n}` : ''}
            </Text>
            {kolHuvud}
            <Text style={{ color: '#3b82f6', fontWeight: '700', fontSize: 12, marginTop: 2, marginBottom: 3 }}>Profiler (löpmeter) · {sys.profiler.length} st</Text>
            {prof.map(rad)}
            <Text style={{ color: '#3b82f6', fontWeight: '700', fontSize: 12, marginTop: 8, marginBottom: 3 }}>Packningar (löpmeter) · {sys.packningar.length} st</Text>
            {pack.map(rad)}
            <Text style={{ color: c.textMuted, fontSize: 10, marginTop: 8 }}>
              "Räcker till" = lagersaldo ÷ snittförbrukning/kund (profiler: stänger × stocklängd; packningar: meter). Flaskhalsen — artikeln som tar slut först — avgör hur många kunder hela lagret räcker till. "—" = artikeln saknas i lagret.
            </Text>
          </View>
        );
      })}

      {grupper.length === 0 && (
        <Text style={{ color: c.textMuted, fontSize: 13 }}>Inga kunder inlagda ännu.</Text>
      )}

      {grupper.map(g => (
        <View key={g.paket + g.farg} style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16, padding: 14 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <View>
              <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 16 }}>{g.paket} · {g.farg}</Text>
              <Text style={{ color: c.textMuted, fontSize: 11 }}>
                {g.antalKunder} kund{g.antalKunder === 1 ? '' : 'er'} · {g.medMaterial} med materiallista (medel-underlag)
              </Text>
            </View>
            {g.flaskhals != null && (
              <View style={{ backgroundColor: g.flaskhals < 3 ? '#fee2e2' : '#dcfce7', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: g.flaskhals < 3 ? '#ef4444' : '#16a34a', fontWeight: '700', fontSize: 13 }}>
                  Lagret räcker till ~{g.flaskhals} kund{g.flaskhals === 1 ? '' : 'er'}
                </Text>
              </View>
            )}
          </View>

          {g.medMaterial === 0 ? (
            <Text style={{ color: c.textMuted, fontSize: 12 }}>Ingen kund i den här gruppen har en materiallista än — kan inte beräkna medel.</Text>
          ) : g.rader.length === 0 ? (
            <Text style={{ color: c.textMuted, fontSize: 12 }}>Inga artiklar i materiallistorna.</Text>
          ) : (
            <View>
              <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.kortBorder, paddingBottom: 4, marginBottom: 4 }}>
                <Text style={{ flex: 3, color: c.textMuted, fontSize: 11, fontWeight: '700' }}>ARTIKEL</Text>
                <Text style={{ flex: 1, color: c.textMuted, fontSize: 11, fontWeight: '700', textAlign: 'right' }}>MEDEL/KUND</Text>
                <Text style={{ flex: 1, color: c.textMuted, fontSize: 11, fontWeight: '700', textAlign: 'right' }}>I LAGER</Text>
                <Text style={{ flex: 1, color: c.textMuted, fontSize: 11, fontWeight: '700', textAlign: 'right' }}>RÄCKER TILL</Text>
              </View>
              {g.rader.map(r => (
                <View key={r.artikel} style={{ flexDirection: 'row', paddingVertical: 3 }}>
                  <Text style={{ flex: 3, color: c.text, fontSize: 13 }} numberOfLines={1}>{r.namn || r.artikel} <Text style={{ color: c.textMuted, fontSize: 11 }}>{r.artikel}</Text></Text>
                  <Text style={{ flex: 1, color: c.text, fontSize: 13, textAlign: 'right' }}>{fmt(r.medel)}{r.enhet || ''}</Text>
                  <Text style={{ flex: 1, color: r.lager == null ? c.textMuted : c.text, fontSize: 13, textAlign: 'right' }}>{r.lager == null ? '—' : r.lager}</Text>
                  <Text style={{ flex: 1, fontSize: 13, textAlign: 'right', fontWeight: '700', color: r.rackerTill == null ? c.textMuted : (r.rackerTill < 3 ? '#ef4444' : '#16a34a') }}>
                    {r.rackerTill == null ? '—' : `${r.rackerTill} st`}
                  </Text>
                </View>
              ))}
              <Text style={{ color: c.textMuted, fontSize: 10, marginTop: 6 }}>
                "—" i lager = artikeln finns inte i lagerlistan (dras ej). Färg-neutrala delar räknar totalt saldo.
              </Text>
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

// Läs av ett inklistrat ordermejl → rader { artikel, antal, namn }. Heuristik:
// 6-siffrigt artikelnr per rad (ev. bokstavssuffix), antal = "N st/stk/pcs"
// eller sista lilla heltalet som inte är en dimension (NNNN mm) eller pris.
// Dubbletter av samma artikel summeras. Användaren verifierar/justerar sedan.
function parseOrderMail(text) {
  const lines = String(text || '').split(/\r?\n/);
  const map = new Map();
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ').replace(/ /g, ' ').replace(/\s+$/, '');
    if (line.trim().length < 6) continue;
    const artM = line.match(/\b(\d{6}[A-Za-z]?)\b/);
    if (!artM) continue;
    const artikel = artM[1].toUpperCase();
    const before = line.slice(0, artM.index);
    const after = line.slice(artM.index + artM[0].length);
    let antal = null;
    // 1) "N st/stk/pcs" var som helst på raden
    const unitM = (before + '  ' + after).match(/\b(\d{1,4})\s*(?:st|stk|st\.|stück|stueck|stuck|pcs|pce|pc|ea)\b/i);
    if (unitM) antal = parseInt(unitM[1], 10);
    // 2) "N x/× " precis före artikelnumret
    if (antal == null) { const xm = before.match(/(\d{1,4})\s*[x×]\s*$/i); if (xm) antal = parseInt(xm[1], 10); }
    // 3) kolumn-tal efter artikeln (föregås av 2+ blanksteg, ej mm/decimal)
    if (antal == null) {
      const cols = [...after.matchAll(/\s{2,}(\d{1,3})\b(?!\s*(?:mm|cm|%|[.,]\d))/g)]
        .map(m => parseInt(m[1], 10)).filter(n => n >= 1 && n <= 999);
      if (cols.length) antal = cols[cols.length - 1];
    }
    // Benämning: texten efter artikeln, städad från antal/enhet/dimension/pris
    let namn = after
      .replace(/\b\d{1,4}\s*(?:st|stk|stück|stueck|stuck|pcs|pce|pc|ea)\b/gi, ' ')
      .replace(/\b\d{2,5}\s*mm\b/gi, ' ')
      .replace(/\b\d+[.,]\d+\b/g, ' ')
      .replace(/\s{2,}\d{1,3}\s*$/, ' ')
      .replace(/[|;:#*=]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!namn) namn = before.replace(/^\s*(?:pos\.?\s*)?\d+[\s.)]*/i, '').replace(/\d{1,4}\s*[x×]\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
    namn = namn.replace(/^[-–\s]+/, '').slice(0, 42);
    // dimension (stocklängd) om den finns på raden — matar produktens dimension
    const dimM = (before + '  ' + after).match(/\b(\d{3,5})\s*mm\b/i);
    const dimension = dimM ? dimM[1] + ' mm' : '';
    const ex = map.get(artikel);
    if (ex) { if (antal != null) ex.antal = (ex.antal || 0) + antal; if (!ex.dimension && dimension) ex.dimension = dimension; }
    else map.set(artikel, { artikel, antal, namn, dimension });
  }
  return [...map.values()].map(x => ({ artikel: x.artikel, antal: x.antal != null ? String(x.antal) : '', namn: x.namn, kategori: '', enhet: 'st', dimension: x.dimension || '' }));
}

// Plocka ut ordernr + leverantör ur mejlet (best effort) för förifyllning och
// dubblett-nyckel så samma mejl inte läses in två gånger.
function parseOrderMeta(text) {
  const t = String(text || '');
  let referens = '';
  // Schüco: "Order No. / Date  137046598 / ..." → 9-siffrigt ordernr först.
  let m = t.match(/order\s*no\.?\s*(?:\/\s*date)?\s*[:#]?\s*(\d{6,10})/i);
  if (!m) m = t.match(/(?:ordernr|order\s*nummer|auftrag(?:s?(?:nr|nummer))?|best(?:ällning)?\s*(?:nr|nummer)|ab[-\s]?nr)\.?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\/-]{3,})/i);
  if (m) referens = m[1].trim();
  let leverantor = '';
  if (/sch[üu]co/i.test(t)) leverantor = 'Schüco';
  return { referens, leverantor };
}

// Dubblett-nyckel för en beställning: ordernr om det finns, annars signatur av
// artikel:antal (sorterad). Används för att blocka att samma mejl läses in igen.
function orderNyckel(referens, rader) {
  const r = String(referens || '').trim().toLowerCase();
  if (r) return 'ref:' + r;
  const sig = (rader || []).filter(x => String(x.artikel || '').trim())
    .map(x => `${String(x.artikel).trim().toLowerCase()}:${parseInt(x.antal) || 0}`).sort().join('|');
  return sig ? 'sig:' + sig : '';
}

// Ordrar — våra inköpsbeställningar av profiler & material. Att lägga in en
// beställning fyller på lagersaldot för kända artiklar och skapar nya produkter
// automatiskt (se laggInOrder i App). Allt klient-sida (AsyncStorage).
function OrdrarVy({ ordrar, produkter, onLaggInOrder, onImporteraOrdrar, onTaBortOrder, onRensaLogg, inloggad, token, c }) {
  const nyRad = () => ({ artikel: '', antal: '', namn: '', kategori: '', enhet: 'st', dimension: '' });
  const [visaForm, setVisaForm] = React.useState(false);
  const [leverantor, setLeverantor] = React.useState('');
  const [referens, setReferens] = React.useState('');
  const [notering, setNotering] = React.useState('');
  const [rader, setRader] = React.useState([nyRad()]);
  const [mejl, setMejl] = React.useState('');
  const [bilder, setBilder] = React.useState([]);

  const byArtikel = React.useMemo(() => {
    const m = new Map();
    for (const p of (produkter || [])) { const a = String(p.artikel || '').trim().toLowerCase(); if (a) m.set(a, p); }
    return m;
  }, [produkter]);

  const inp = { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 };
  const patchRad = (i, patch) => setRader(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  const laggRad = () => setRader(rs => [...rs, nyRad()]);
  const taBortRad = (i) => setRader(rs => rs.length > 1 ? rs.filter((_, j) => j !== i) : rs);

  // Fil-import: Excel/CSV → parseOrderMail på ihopslagna rader; bild → nedskalad
  // data-URI bifogad på ordern. Drag-drop + fil-väljare (webb).
  const valjFil = (accept, onFil) => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) onFil(f); };
    input.click();
  };
  const laesExcel = (file) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = read(ev.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = utils.sheet_to_json(sheet, { header: 1, blankrows: false });
        const text = rows.map(r => Array.isArray(r) ? r.join('  ') : '').join('\n');
        const p = parseOrderMail(text);
        if (p.length) setRader(p);
        else if (Platform.OS === 'web') window.alert('Hittade inga artiklar (6-siffrigt artikelnr + antal) i filen.');
        const meta = parseOrderMeta(text);
        if (meta.referens) setReferens(r => r || meta.referens);
        if (meta.leverantor) setLeverantor(l => l || meta.leverantor);
      } catch (err) { if (Platform.OS === 'web') window.alert('Kunde inte läsa filen: ' + err.message); }
    };
    reader.readAsArrayBuffer(file);
  };
  const laesPdf = (file) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const res = await fetch(`${API}/api/pdf-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ pdfBase64: ev.target.result }),
        });
        if (!res.ok) throw new Error('Server ' + res.status);
        const { text } = await res.json();
        const p = parseOrderMail(text);
        if (p.length) setRader(p);
        else if (Platform.OS === 'web') window.alert('Hittade inga artiklar (6-siffrigt artikelnr + antal) i PDF:en.');
        const meta = parseOrderMeta(text);
        if (meta.referens) setReferens(r => r || meta.referens);
        if (meta.leverantor) setLeverantor(l => l || meta.leverantor);
      } catch (err) { if (Platform.OS === 'web') window.alert('Kunde inte läsa PDF: ' + err.message); }
    };
    reader.readAsDataURL(file);
  };
  const bifogaBild = (file) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      if (Platform.OS === 'web') {
        const img = new window.Image();
        img.onload = () => {
          const max = 1000; let w = img.width, h = img.height;
          if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
          try {
            const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            setBilder(bs => [...bs, canvas.toDataURL('image/jpeg', 0.7)]);
          } catch { setBilder(bs => [...bs, dataUrl]); }
        };
        img.onerror = () => setBilder(bs => [...bs, dataUrl]);
        img.src = dataUrl;
      } else setBilder(bs => [...bs, dataUrl]);
    };
    reader.readAsDataURL(file);
  };
  // Historik-import: en .json med en array av ordrar → logg-poster (rör ej saldot).
  const laesHistorikJson = (file) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const lista = Array.isArray(data) ? data : (Array.isArray(data.ordrar) ? data.ordrar : null);
        if (!lista) { if (Platform.OS === 'web') window.alert('JSON:en ska vara en lista av ordrar.'); return; }
        const res = onImporteraOrdrar(lista);
        if (Platform.OS === 'web') window.alert(`Historik importerad: ${res.added} nya, ${res.updated} uppdaterade ordrar (logg). Lagersaldot är oförändrat.`);
      } catch (err) { if (Platform.OS === 'web') window.alert('Kunde inte läsa JSON: ' + err.message); }
    };
    reader.readAsText(file);
  };
  const hanteraFil = (file) => {
    if (!file) return;
    const namn = (file.name || '').toLowerCase();
    if (/\.pdf$/.test(namn) || file.type === 'application/pdf') laesPdf(file);
    else if (/\.json$/.test(namn) || /json/.test(file.type || '')) laesHistorikJson(file);
    else if ((file.type && file.type.indexOf('image/') === 0) || /\.(png|jpe?g|gif|webp|heic)$/.test(namn)) bifogaBild(file);
    else if (/\.(xlsx?|csv)$/.test(namn) || /sheet|excel|csv/.test(file.type || '')) laesExcel(file);
    else if (Platform.OS === 'web') window.alert('Släpp en PDF, Excel/CSV, bild, eller historik-JSON.');
  };

  const fmtDatum = (iso) => { try { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; } catch { return iso; } };

  const avlasta = rader.filter(r => String(r.artikel || '').trim()).length;
  const nyckelNu = orderNyckel(referens, rader);
  const dubblett = nyckelNu ? ordrar.find(o => o.nyckel === nyckelNu) : null;

  const importRad = (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <TouchableOpacity onPress={() => valjFil('.pdf,.xlsx,.xls,.csv', hanteraFil)} style={{ backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }}>
        <Text style={{ color: c.text, fontSize: 13, fontWeight: '600' }}>📎 PDF / Excel</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => valjFil('image/*', bifogaBild)} style={{ backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }}>
        <Text style={{ color: c.text, fontSize: 13, fontWeight: '600' }}>🖼 Bild</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => valjFil('.json,application/json', laesHistorikJson)} style={{ backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }}>
        <Text style={{ color: c.text, fontSize: 13, fontWeight: '600' }}>📥 Historik (JSON)</Text>
      </TouchableOpacity>
      <Text style={{ color: c.textMuted, fontSize: 11 }}>eller släpp filen här</Text>
    </View>
  );

  const spara = () => {
    const giltiga = rader.filter(r => r.artikel.trim() && (parseInt(r.antal) || 0) > 0);
    if (!giltiga.length && !bilder.length) { if (Platform.OS === 'web') window.alert('Lägg till minst en rad, eller bifoga en fil/bild.'); return; }
    const nyckel = orderNyckel(referens, giltiga);
    const dup = nyckel ? ordrar.find(o => o.nyckel === nyckel) : null;
    if (dup && Platform.OS === 'web') {
      const fraga = `Denna beställning verkar redan inlagd (${dup.referens || fmtDatum(dup.tid)}).\nLägg in igen ändå? Lagersaldot ökas då en gång till.`;
      if (!window.confirm(fraga)) return;
    }
    onLaggInOrder({ leverantor, referens, notering, rader: giltiga, nyckel, bilder });
    setLeverantor(''); setReferens(''); setNotering(''); setRader([nyRad()]); setMejl(''); setBilder([]); setVisaForm(false);
  };

  return (
    <ScrollView style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <Text style={[styles.kategoriRubrik, { color: c.textRubrik }]}>🧾 Ordrar — beställningar av profiler &amp; material</Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {inloggad?.roll === 'admin' && ordrar.some(o => o.endastLogg) && (
            <TouchableOpacity onPress={() => {
              const n = ordrar.filter(o => o.endastLogg).length;
              if (Platform.OS !== 'web' || window.confirm(`Rensa alla ${n} logg-ordrar (historik)? Rör inte lagersaldot.`)) onRensaLogg();
            }} style={{ backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={{ color: '#ef4444', fontWeight: '700', fontSize: 13 }}>🗑 Rensa logg</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setVisaForm(v => !v)} style={{ backgroundColor: visaForm ? c.input : '#2563eb', borderWidth: visaForm ? 1 : 0, borderColor: c.inputBorder, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 }}>
            <Text style={{ color: visaForm ? c.text : '#fff', fontWeight: '700' }}>{visaForm ? '✕ Stäng' : '+ Ny beställning'}</Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 14 }}>
        Lägg in en beställning — kända artiklar fyller på lagersaldot, nya artiklar läggs till i systemet automatiskt.
      </Text>

      {visaForm && (
        <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16, padding: 14 }]}>
          <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 13, marginBottom: 4 }}>📩 Klistra in ordermejlet</Text>
          <TextInput
            style={[inp, { minHeight: 84, textAlignVertical: 'top' }]}
            placeholder="Klistra in / släpp mejlet här — artiklar och antal läses av direkt"
            placeholderTextColor={c.textMuted}
            multiline
            value={mejl}
            onChangeText={t => {
              setMejl(t);
              const p = parseOrderMail(t);
              if (p.length) setRader(p);
              const meta = parseOrderMeta(t);
              if (meta.referens && !referens) setReferens(meta.referens);
              if (meta.leverantor && !leverantor) setLeverantor(meta.leverantor);
            }}
          />
          {mejl.trim() ? (
            <Text style={{ color: avlasta ? '#16a34a' : '#d97706', fontSize: 12, marginTop: 4 }}>
              {avlasta ? `✓ ${avlasta} artikel${avlasta === 1 ? '' : 'ar'} avläst${avlasta === 1 ? '' : 'a'} — kontrollera nedan` : 'Inga artiklar hittades — fyll i manuellt nedan'}
            </Text>
          ) : null}
          {dubblett ? (
            <View style={{ backgroundColor: '#fef3c7', borderRadius: 8, padding: 8, marginTop: 6 }}>
              <Text style={{ color: '#92400e', fontSize: 12, fontWeight: '600' }}>⚠ Verkar redan inlagd {dubblett.referens ? `(${dubblett.referens})` : fmtDatum(dubblett.tid)} — spara inte igen om det är samma order.</Text>
            </View>
          ) : null}

          {Platform.OS === 'web'
            ? React.createElement('div', {
                onDragOver: (e) => { e.preventDefault(); },
                onDrop: (e) => { e.preventDefault(); const fs = e.dataTransfer && e.dataTransfer.files; if (fs) { for (let i = 0; i < fs.length; i++) hanteraFil(fs[i]); } },
                style: { border: '1px dashed ' + c.inputBorder, borderRadius: '8px', padding: '10px', marginTop: '10px' },
              }, importRad)
            : importRad}

          {bilder.length > 0 && (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {bilder.map((b, i) => (
                <View key={i} style={{ position: 'relative' }}>
                  <Image source={{ uri: b }} style={{ width: 64, height: 48, borderRadius: 6, borderWidth: 1, borderColor: c.kortBorder }} resizeMode="cover" />
                  <TouchableOpacity onPress={() => setBilder(bs => bs.filter((_, j) => j !== i))} style={{ position: 'absolute', top: -6, right: -6, backgroundColor: '#ef4444', borderRadius: 10, width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#fff', fontSize: 11 }}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 12, marginBottom: 4 }}>Eller fyll i manuellt / justera nedan:</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <TextInput style={[inp, { flex: 1, minWidth: 140 }]} placeholder="Leverantör (t.ex. Schüco)" placeholderTextColor={c.textMuted} value={leverantor} onChangeText={setLeverantor} />
            <TextInput style={[inp, { flex: 1, minWidth: 140 }]} placeholder="Ordernr / referens" placeholderTextColor={c.textMuted} value={referens} onChangeText={setReferens} />
          </View>

          {rader.map((r, i) => {
            const match = byArtikel.get(r.artikel.trim().toLowerCase());
            return (
              <View key={i} style={{ borderTopWidth: 1, borderTopColor: c.kortBorder, paddingTop: 8, marginTop: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <TextInput style={[inp, { flex: 2 }]} placeholder="Artikelnr" placeholderTextColor={c.textMuted} value={r.artikel} onChangeText={t => patchRad(i, { artikel: t })} />
                  <TextInput style={[inp, { width: 84 }]} placeholder="Antal" placeholderTextColor={c.textMuted} keyboardType="numeric" value={r.antal} onChangeText={t => patchRad(i, { antal: t.replace(/[^0-9]/g, '') })} />
                  {rader.length > 1 && (
                    <TouchableOpacity onPress={() => taBortRad(i)} style={{ padding: 6 }}><Text style={{ color: '#ef4444', fontSize: 16 }}>✕</Text></TouchableOpacity>
                  )}
                </View>
                {r.artikel.trim() ? (
                  match ? (
                    <Text style={{ color: '#16a34a', fontSize: 12, marginTop: 4 }}>✓ {match.namn} — finns ({match.antal}{match.enhet || 'st'}{match.kategori ? ` · ${match.kategori}` : ''}), fylls på</Text>
                  ) : (
                    <View style={{ marginTop: 6 }}>
                      <Text style={{ color: '#d97706', fontSize: 12, marginBottom: 4 }}>✳ Ny artikel — fyll i uppgifter så läggs den till i systemet</Text>
                      <TextInput style={[inp, { marginBottom: 6 }]} placeholder="Benämning" placeholderTextColor={c.textMuted} value={r.namn} onChangeText={t => patchRad(i, { namn: t })} />
                      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                        <TextInput style={[inp, { flex: 2, minWidth: 120 }]} placeholder="Kategori" placeholderTextColor={c.textMuted} value={r.kategori} onChangeText={t => patchRad(i, { kategori: t })} />
                        <TextInput style={[inp, { width: 80 }]} placeholder="Enhet" placeholderTextColor={c.textMuted} value={r.enhet} onChangeText={t => patchRad(i, { enhet: t })} />
                        <TextInput style={[inp, { flex: 1, minWidth: 110 }]} placeholder="Dimension" placeholderTextColor={c.textMuted} value={r.dimension} onChangeText={t => patchRad(i, { dimension: t })} />
                      </View>
                    </View>
                  )
                ) : null}
              </View>
            );
          })}

          <TouchableOpacity onPress={laggRad} style={{ marginTop: 10 }}><Text style={{ color: '#2563eb', fontWeight: '700', fontSize: 13 }}>+ Lägg till rad</Text></TouchableOpacity>
          <TextInput style={[inp, { marginTop: 10 }]} placeholder="Notering (valfritt)" placeholderTextColor={c.textMuted} value={notering} onChangeText={setNotering} />
          <TouchableOpacity onPress={spara} style={{ backgroundColor: '#16a34a', borderRadius: 8, paddingVertical: 11, marginTop: 12, alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Spara beställning</Text>
          </TouchableOpacity>
        </View>
      )}

      {ordrar.length === 0 ? (
        <Text style={{ color: c.textMuted, fontSize: 13 }}>Inga beställningar inlagda ännu.</Text>
      ) : ordrar.map(o => {
        const antalRader = o.rader.length;
        const nya = o.rader.filter(r => r.status === 'ny').length;
        return (
          <View key={o.id} style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 12, padding: 14 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 15 }}>{o.leverantor || 'Beställning'}{o.referens ? ` · ${o.referens}` : ''}</Text>
                {o.projekt ? <Text style={{ color: c.textMuted, fontSize: 12 }}>{o.projekt}</Text> : null}
                {o.endastLogg ? <View style={{ backgroundColor: '#e5e7eb', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}><Text style={{ color: '#4b5563', fontSize: 10, fontWeight: '700' }}>LOGG · rör ej saldo</Text></View> : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ color: c.textMuted, fontSize: 11 }}>{fmtDatum(o.tid)}</Text>
                {inloggad?.roll === 'admin' && (
                  <TouchableOpacity onPress={() => {
                    const fraga = `Ta bort order ${o.referens || ''}?${o.endastLogg ? '' : '\nOBS: lagersaldot återställs INTE automatiskt.'}`;
                    if (Platform.OS !== 'web' || window.confirm(fraga)) onTaBortOrder(o.id);
                  }} style={{ padding: 4 }}>
                    <Text style={{ color: '#ef4444', fontSize: 15 }}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            {o.rader.map((r, i) => (
              <View key={i} style={{ flexDirection: 'row', paddingVertical: 2, alignItems: 'center' }}>
                <Text style={{ width: 64, color: c.textMuted, fontSize: 12 }}>{r.artikel}</Text>
                <Text style={{ flex: 1, color: c.text, fontSize: 13 }} numberOfLines={1}>{r.namn}</Text>
                <Text style={{ width: 72, color: c.text, fontSize: 13, textAlign: 'right', fontWeight: '600' }}>+{r.antal} {r.enhet}</Text>
                <Text style={{ width: 74, textAlign: 'right', fontSize: 11, fontWeight: '700', color: r.status === 'logg' ? c.textMuted : (r.status === 'ny' ? '#d97706' : '#16a34a') }}>{r.status === 'logg' ? 'logg' : (r.status === 'ny' ? 'ny' : `→ ${r.nyttSaldo}`)}</Text>
              </View>
            ))}
            {o.notering ? <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 6, fontStyle: 'italic' }}>{o.notering}</Text> : null}
            {o.bilder && o.bilder.length > 0 && (
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {o.bilder.map((b, i) => (
                  <Image key={i} source={{ uri: b }} style={{ width: 72, height: 54, borderRadius: 6, borderWidth: 1, borderColor: c.kortBorder }} resizeMode="cover" />
                ))}
              </View>
            )}
            <Text style={{ color: c.textMuted, fontSize: 10, marginTop: 6 }}>{antalRader} artikl{antalRader === 1 ? 'a' : 'ar'}{nya ? ` · ${nya} ny` : ''}{o.bilder && o.bilder.length ? ` · ${o.bilder.length} bild${o.bilder.length === 1 ? '' : 'er'}` : ''}{o.av ? ` · inlagd av ${o.av}` : ''}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

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
function ChatPanel({ user, onStang, meddelanden, online, wsRef, onRing, samtalAktivt }) {
  const { c } = React.useContext(TemaContext) || { c: LJUST };
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const onlineAndra = (online || []).filter(o => o && typeof o === 'object' && o.username !== user.username);

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
          <Text style={cp.online}>
            {onlineAndra.length > 0 ? `${onlineAndra.length + 1} online` : 'Bara du är online'}
          </Text>
        </View>
        <TouchableOpacity onPress={onStang}><Text style={cp.stang}>✕</Text></TouchableOpacity>
      </View>
      {onlineAndra.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={cp.onlineRad}
          contentContainerStyle={cp.onlineRadInnehall}
        >
          {onlineAndra.map(u => (
            <TouchableOpacity
              key={u.username}
              style={[cp.onlineChip, samtalAktivt && { opacity: 0.5 }]}
              onPress={() => onRing?.(u)}
              disabled={samtalAktivt}
            >
              <Text style={cp.onlineAvatar}>{u.avatar || '😀'}</Text>
              <Text style={cp.onlineNamn} numberOfLines={1}>{u.namn}</Text>
              <Text style={cp.onlineRing}>📞</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
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
  onlineRad: { backgroundColor: '#141c2e', flexGrow: 0 },
  onlineRadInnehall: { gap: 8, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center' },
  onlineChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#2a3448', borderRadius: 16,
    paddingVertical: 5, paddingHorizontal: 10,
  },
  onlineAvatar: { fontSize: 15 },
  onlineNamn: { color: '#fff', fontSize: 12, fontWeight: '600', maxWidth: 90 },
  onlineRing: { fontSize: 13 },
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

// ─── Samtal (Messenger-stil) ──────────────────────────────────────────────────
function SamtalTimer({ start }) {
  const [, tvinga] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tvinga(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const sek = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const mm = Math.floor(sek / 60).toString().padStart(2, '0');
  const ss = (sek % 60).toString().padStart(2, '0');
  return <Text style={so.timer}>{mm}:{ss}</Text>;
}

function SamtalOverlay({ samtal, onSvara, onAvvisa, onLaggPa, onMute }) {
  const puls = useRef(new Animated.Value(1)).current;
  const ringer = samtal.fas !== 'pågår';

  useEffect(() => {
    if (!ringer) { puls.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(puls, { toValue: 1.12, duration: 700, useNativeDriver: true }),
      Animated.timing(puls, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [ringer]);

  // Pågående samtal: kompakt flytande panel högst upp
  if (samtal.fas === 'pågår') {
    return (
      <View style={so.aktivWrap} pointerEvents="box-none">
        <View style={so.aktivPanel}>
          <Text style={so.aktivAvatar}>{samtal.motpart.avatar || '😀'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={so.aktivNamn} numberOfLines={1}>{samtal.motpart.namn}</Text>
            <SamtalTimer start={samtal.start} />
          </View>
          <TouchableOpacity style={[so.rundKnappLiten, samtal.mutad ? so.knappMutad : so.knappNeutral]} onPress={onMute}>
            <Text style={so.knappIkonLiten}>{samtal.mutad ? '🔇' : '🎙'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[so.rundKnappLiten, so.knappRod]} onPress={onLaggPa}>
            <Text style={so.knappIkonLiten}>📞</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Ringer (in/ut): fullskärmsoverlay
  const inkommande = samtal.fas === 'inkommande';
  return (
    <View style={so.overlay}>
      <View style={so.mitt}>
        <Animated.View style={[so.avatarRing, { transform: [{ scale: puls }] }]}>
          <Text style={so.storAvatar}>{samtal.motpart.avatar || '😀'}</Text>
        </Animated.View>
        <Text style={so.namn}>{samtal.motpart.namn}</Text>
        <Text style={so.status}>{inkommande ? 'Inkommande samtal…' : 'Ringer…'}</Text>
      </View>
      <View style={so.knappRad}>
        {inkommande ? (
          <>
            <View style={so.knappKolumn}>
              <TouchableOpacity style={[so.rundKnapp, so.knappRod]} onPress={onAvvisa}>
                <Text style={so.knappIkon}>📞</Text>
              </TouchableOpacity>
              <Text style={so.knappEtikett}>Avvisa</Text>
            </View>
            <View style={so.knappKolumn}>
              <TouchableOpacity style={[so.rundKnapp, so.knappGron]} onPress={onSvara}>
                <Text style={so.knappIkon}>📞</Text>
              </TouchableOpacity>
              <Text style={so.knappEtikett}>Svara</Text>
            </View>
          </>
        ) : (
          <View style={so.knappKolumn}>
            <TouchableOpacity style={[so.rundKnapp, so.knappRod]} onPress={onLaggPa}>
              <Text style={so.knappIkon}>📞</Text>
            </TouchableOpacity>
            <Text style={so.knappEtikett}>Avbryt</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const so = StyleSheet.create({
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(15,17,23,0.94)', zIndex: 500,
    justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 90, paddingBottom: 70,
  },
  mitt: { alignItems: 'center' },
  avatarRing: {
    width: 120, height: 120, borderRadius: 60,
    backgroundColor: '#1a2235', justifyContent: 'center', alignItems: 'center',
    borderWidth: 3, borderColor: '#2563eb', marginBottom: 20,
  },
  storAvatar: { fontSize: 56 },
  namn: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 6 },
  status: { color: '#7dd3fc', fontSize: 15 },
  knappRad: { flexDirection: 'row', gap: 70 },
  knappKolumn: { alignItems: 'center', gap: 8 },
  rundKnapp: {
    width: 68, height: 68, borderRadius: 34,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 10, elevation: 8,
  },
  knappGron: { backgroundColor: '#22c55e' },
  knappRod: { backgroundColor: '#ef4444', transform: [{ rotate: '135deg' }] },
  knappIkon: { fontSize: 28 },
  knappEtikett: { color: '#ccc', fontSize: 13 },
  aktivWrap: {
    position: 'absolute', top: 70, left: 0, right: 0,
    alignItems: 'center', zIndex: 400,
  },
  aktivPanel: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#1a2235', borderRadius: 30,
    paddingVertical: 8, paddingHorizontal: 14,
    width: 300, maxWidth: '92%',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 14, elevation: 12,
    borderWidth: 1.5, borderColor: '#2563eb',
  },
  aktivAvatar: { fontSize: 26 },
  aktivNamn: { color: '#fff', fontSize: 14, fontWeight: '700' },
  timer: { color: '#7dd3fc', fontSize: 12, fontVariant: ['tabular-nums'] },
  rundKnappLiten: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
  },
  knappNeutral: { backgroundColor: '#2a3448' },
  knappMutad: { backgroundColor: '#7a2a2a' },
  knappIkonLiten: { fontSize: 18 },
});

function SamtalToast({ text }) {
  if (!text) return null;
  return (
    <View style={st.wrap} pointerEvents="none">
      <View style={st.toast}>
        <Text style={st.text}>📞 {text}</Text>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', top: 70, left: 0, right: 0, alignItems: 'center', zIndex: 600 },
  toast: {
    backgroundColor: '#1a2235', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, elevation: 10,
    borderWidth: 1, borderColor: '#2a3448', maxWidth: '90%',
  },
  text: { color: '#fff', fontSize: 14 },
});

// ─── Beredning: flera kunder på en gång ──────────────────────────────────────
// Kryssa i kunder + vad som ska med, och få ut allt i en körning — utskrift
// eller ett zip-arkiv med en mapp per kund.
//
// Dokumenten byggs INTE här. De ägs av ase60-generatorn (CAD-ritning, kaplista,
// materiallista, glasmått) och hämtas via vår egen server
// (/api/beredning/dokument), som i sin tur pratar med generatorn server-till-
// server. Därför blir innehållet exakt detsamma som när en kund skrivs ut
// enskild i generatorn, och webbläsaren slipper CORS mot en annan tjänst.

const BEREDNING_SEKTIONER = [
  { nyckel: 'cad', etikett: 'CAD-ritning' },
  { nyckel: 'optimering', etikett: 'Kaplista + optimering' },
  { nyckel: 'beredning', etikett: 'Beredning (materiallista)' },
  { nyckel: 'glasmatt', etikett: 'Glasmått' },
];

/**
 * "4 partier · ASS 32" / "5 partier · ASE 60 + ASS 32". Blandade projekt får
 * BÅDA systemen i dokumentet, så båda ska synas i raden — annars ser det ut
 * som att hälften av partierna inte kommer med.
 */
function beredningRadText(info) {
  const antal = info.antalPartier;
  const delar = [];
  if (info.ase60) delar.push(`ASE 60${info.ass32 ? ` ${info.ase60}` : ''}`);
  if (info.ass32) delar.push(`ASS 32${info.ase60 ? ` ${info.ass32}` : ''}`);
  if (!delar.length) delar.push(info.system === 'ass32' ? 'ASS 32' : 'ASE 60');
  return `${antal} parti${antal === 1 ? '' : 'er'} · ${delar.join(' + ')}`;
}

/** Filnamnssäkert kundnamn — blir mappnamnet i zip-arkivet. */
function beredningMappNamn(namn) {
  return (String(namn || 'kund').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()) || 'kund';
}

function BeredningVy({ kunder, ase60Projekt, token, c, mobil }) {
  const [valda, setValda] = useState(() => new Set());
  const [sok, setSok] = useState('');
  const [sektioner, setSektioner] = useState({ cad: true, optimering: true, beredning: true, glasmatt: true });
  const [projektInfo, setProjektInfo] = useState({});
  const [infoLaddad, setInfoLaddad] = useState(false);
  const [generatorNere, setGeneratorNere] = useState(false);
  const [status, setStatus] = useState('');
  const [fel, setFel] = useState([]);
  const [arbetar, setArbetar] = useState(false);

  // Vilka projekt generatorn faktiskt kan bereda (och hur många partier de har).
  // Ett anrop för hela listan i stället för ett per kund.
  useEffect(() => {
    if (!token) return;
    let avbruten = false;
    fetch(`${API}/api/beredning/projekt`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (avbruten) return;
        setProjektInfo(d?.projekt || {});
        setGeneratorNere(!ok);
        setInfoLaddad(true);
      })
      .catch(() => { if (!avbruten) { setGeneratorNere(true); setInfoLaddad(true); } });
    return () => { avbruten = true; };
  }, [token]);

  // Samma kundunion som Kunder-vyn: ASE60-projekten visas som kunder, plus de
  // kunder som bara finns i lagersystemet (manuella/Konfigurator-synkade).
  const lista = React.useMemo(() => {
    const franProjekt = ase60Projekt.map(p => {
      const sparad = kunder.find(k => k.id === p.id || k.ase60ProjectId === p.id);
      return { id: p.id, namn: p.name || p.id, farg: sparad?.farg || p.color || '', projectId: p.id };
    });
    const manuella = kunder
      .filter(k => !ase60Projekt.some(p => p.id === k.ase60ProjectId || p.id === k.id))
      .map(k => ({ id: k.id, namn: k.namn || k.id, farg: k.farg || '', projectId: k.ase60ProjectId || null }));
    return [...franProjekt, ...manuella].sort((a, b) => a.namn.localeCompare(b.namn, 'sv'));
  }, [kunder, ase60Projekt]);

  /** Kan kunden beredas, och om inte — varför? Styr utgråningen. */
  const bedom = (rad) => {
    if (!rad.projectId) return { ok: false, skal: 'Inget ASE60-projekt kopplat' };
    const info = projektInfo[rad.projectId];
    if (!info) {
      return generatorNere
        ? { ok: false, skal: 'ASE60-generatorn kunde inte nås' }
        : { ok: false, skal: 'Projektet finns inte i ASE60-generatorn' };
    }
    if (!info.antalPartier) return { ok: false, skal: 'Projektet har inga partier' };
    return { ok: true, info };
  };

  const synliga = lista.filter(r => !sok.trim() || r.namn.toLowerCase().includes(sok.trim().toLowerCase()));

  const vaxla = (id) => setValda(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // "Markera alla" gäller det man ser (sökfiltret) och bara det som går att bereda.
  const markeraAlla = () => setValda(new Set(synliga.filter(r => bedom(r).ok).map(r => r.id)));
  const rensaVal = () => setValda(new Set());

  const antalValda = lista.filter(r => valda.has(r.id) && bedom(r).ok).length;
  const nagonSektion = Object.values(sektioner).some(Boolean);

  /**
   * Hämtar dokumenten en kund i taget så statusraden kan räkna upp och EN
   * trasig kund inte river hela körningen — den hamnar i fel-listan i stället.
   */
  async function byggAlla() {
    const koa = lista.filter(r => valda.has(r.id) && bedom(r).ok);
    setFel([]);
    if (!koa.length) { setStatus('Välj minst en kund.'); return null; }
    if (!nagonSektion) { setStatus('Kryssa i minst en del att få ut.'); return null; }
    setArbetar(true);
    const klara = [];
    const misslyckade = [];
    for (let i = 0; i < koa.length; i++) {
      const rad = koa[i];
      setStatus(`Bygger ${i + 1}/${koa.length} — ${rad.namn}…`);
      try {
        const res = await fetch(`${API}/api/beredning/dokument`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ projectId: rad.projectId, sections: sektioner }),
        });
        if (!res.ok) {
          let meddelande = `Servern svarade ${res.status}`;
          try { const j = await res.json(); if (j?.error) meddelande = j.error; } catch { /* icke-JSON */ }
          throw new Error(meddelande);
        }
        klara.push({ rad, html: await res.text() });
      } catch (e) {
        misslyckade.push({ namn: rad.namn, meddelande: e?.message || 'Okänt fel' });
      }
    }
    setArbetar(false);
    setFel(misslyckade);
    if (!klara.length) { setStatus('Inget dokument kunde byggas.'); return null; }
    return klara;
  }

  async function skrivUt() {
    const docs = await byggAlla();
    if (!docs) return;
    // Ett fönster per kund — samma vy som en enskild utskrift, så
    // utskriftsdialogen får rätt sidstorlek per dokument.
    let blockerade = 0;
    for (const d of docs) {
      const w = Platform.OS === 'web' ? window.open('', '_blank') : null;
      if (!w) { blockerade++; continue; }
      w.document.open();
      w.document.write(d.html);
      w.document.close();
    }
    setStatus(blockerade
      ? `${docs.length - blockerade} öppnade. ${blockerade} blockerades av webbläsarens popup-spärr — tillåt popup-fönster för sidan.`
      : `${docs.length} kund${docs.length === 1 ? '' : 'er'} öppnade för utskrift.`);
  }

  async function laddaNerZip() {
    const docs = await byggAlla();
    if (!docs) return;
    setArbetar(true);
    setStatus('Paketerar zip…');
    try {
      const datum = new Date().toISOString().slice(0, 10);
      const res = await fetch(`${API}/api/beredning/zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: `beredning-${datum}`,
          files: docs.map(d => ({ path: `${beredningMappNamn(d.rad.namn)}/beredning.html`, content: d.html })),
        }),
      });
      if (!res.ok) throw new Error(`Zip misslyckades (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `beredning-${datum}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`Zip med ${docs.length} kundmapp${docs.length === 1 ? '' : 'ar'} nedladdad.`);
    } catch (e) {
      setStatus(e?.message || 'Zip misslyckades.');
    }
    setArbetar(false);
  }

  const knapp = (etikett, onPress, primar) => (
    <TouchableOpacity onPress={onPress} disabled={arbetar}
      style={{ backgroundColor: arbetar ? c.input : (primar ? '#2563eb' : c.input), borderWidth: primar ? 0 : 1, borderColor: c.inputBorder,
        borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, opacity: arbetar ? 0.6 : 1 }}>
      <Text style={{ color: primar && !arbetar ? '#fff' : c.text, fontWeight: '600', fontSize: 14 }}>{etikett}</Text>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
      <Text style={[styles.kategoriRubrik, { color: c.textRubrik, marginBottom: 6 }]}>📝 Beredning</Text>
      <Text style={{ color: c.textMuted, fontSize: 13, marginBottom: 16 }}>
        Välj kunder och vad som ska med — skriv ut allt på en gång eller ladda ner ett zip-arkiv med en mapp per kund.
      </Text>

      {generatorNere && infoLaddad && (
        <View style={{ backgroundColor: c.varning, borderColor: c.varningBorder, borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <Text style={{ color: c.varningText, fontSize: 13 }}>
            ASE60-generatorn svarar inte. Beredning kan inte hämtas förrän den är igång igen.
          </Text>
        </View>
      )}

      {/* Vad som ska med */}
      <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16 }]}>
        <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14, marginBottom: 10 }}>Ta med</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {BEREDNING_SEKTIONER.map(s => (
            <TouchableOpacity key={s.nyckel}
              onPress={() => setSektioner(p => ({ ...p, [s.nyckel]: !p[s.nyckel] }))}
              style={{ flexDirection: 'row', alignItems: 'center', minWidth: mobil ? '100%' : 220, paddingVertical: 4 }}>
              <View style={{ width: 22, height: 22, borderRadius: 5, borderWidth: 2, marginRight: 10, alignItems: 'center', justifyContent: 'center',
                backgroundColor: sektioner[s.nyckel] ? '#16a34a' : 'transparent', borderColor: sektioner[s.nyckel] ? '#16a34a' : c.inputBorder }}>
                {sektioner[s.nyckel] && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>✓</Text>}
              </View>
              <Text style={{ color: c.text, fontSize: 14 }}>{s.etikett}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {!nagonSektion && <Text style={{ color: c.varningText, fontSize: 12, marginTop: 8 }}>Kryssa i minst en del.</Text>}
      </View>

      {/* Kundval */}
      <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14, flex: 1, minWidth: 120 }}>
            Kunder{antalValda > 0 ? ` · ${antalValda} vald${antalValda === 1 ? '' : 'a'}` : ''}
          </Text>
          <TouchableOpacity onPress={markeraAlla} style={{ backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }}>
            <Text style={{ color: c.text, fontSize: 13 }}>Markera alla</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={rensaVal} style={{ backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }}>
            <Text style={{ color: c.text, fontSize: 13 }}>Rensa</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          value={sok}
          onChangeText={setSok}
          placeholder="Sök kund…"
          placeholderTextColor={c.textMuted}
          style={[styles.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText, marginBottom: 10 }]} />

        {/* Egen scroll: i verkstaden (surfplatta) blir listan lång */}
        <ScrollView style={{ maxHeight: mobil ? 320 : 420 }} nestedScrollEnabled>
          {synliga.length === 0 && (
            <Text style={{ color: c.textMuted, fontSize: 13, padding: 8 }}>
              {infoLaddad ? 'Inga kunder matchar sökningen.' : 'Laddar kunder…'}
            </Text>
          )}
          {synliga.map(rad => {
            const dom = bedom(rad);
            const ikryssad = valda.has(rad.id);
            return (
              <TouchableOpacity key={rad.id}
                onPress={() => dom.ok && vaxla(rad.id)}
                disabled={!dom.ok}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 6, borderRadius: 8,
                  opacity: dom.ok ? 1 : 0.45, backgroundColor: ikryssad ? (c.radJamn) : 'transparent' }}>
                <View style={{ width: 22, height: 22, borderRadius: 5, borderWidth: 2, marginRight: 12, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: ikryssad && dom.ok ? '#16a34a' : 'transparent', borderColor: ikryssad && dom.ok ? '#16a34a' : c.inputBorder }}>
                  {ikryssad && dom.ok && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.textRubrik, fontWeight: '600', fontSize: 15 }}>👤 {rad.namn}</Text>
                  <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>
                    {dom.ok ? beredningRadText(dom.info) : dom.skal}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Utgångar */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        {knapp('🖨️ Skriv ut valda', skrivUt, true)}
        {knapp('⬇️ Ladda ner ZIP', laddaNerZip, false)}
      </View>

      {!!status && (
        <Text style={{ color: arbetar ? c.text : '#15803d', fontSize: 13, marginTop: 14 }}>{status}</Text>
      )}

      {/* Fel per kund — resten av körningen gick igenom ändå */}
      {fel.length > 0 && (
        <View style={{ backgroundColor: c.varning, borderColor: c.varningBorder, borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 12 }}>
          <Text style={{ color: c.varningText, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>
            {fel.length} kund{fel.length === 1 ? '' : 'er'} kunde inte hämtas:
          </Text>
          {fel.map((f, i) => (
            <Text key={i} style={{ color: c.varningText, fontSize: 12, marginTop: 2 }}>• {f.namn}: {f.meddelande}</Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ─── Produkt detaljsida ───────────────────────────────────────────────────────
function ProduktDetalj({ produkt, onTillbaka, onRedigera, inloggad }) {
  const { c } = React.useContext(TemaContext);
  const totalMeter = (produkt.langder || []).reduce((s, l) => s + (l.langd * l.antal), 0);
  const fargSorterad = [...(produkt.farger || [])].sort((a, b) => a.farg.localeCompare(b.farg, 'sv'));
  const artikelBildPng = produkt.artikel ? `${API}/artikel-bilder/${produkt.artikel}.png` : null;
  const artikelBildJpg = produkt.artikel ? `${API}/artikel-bilder/${produkt.artikel}.jpg` : null;
  const [pngFel, setPngFel] = useState(false);
  const [jpgFel, setJpgFel] = useState(false);
  const [bildStorModal, setBildStorModal] = useState(false);
  const artikelBildUrl = !pngFel ? artikelBildPng : (!jpgFel ? artikelBildJpg : null);
  const bildKalla = produkt.bild || artikelBildUrl;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
      <TouchableOpacity onPress={onTillbaka} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
        <Text style={{ color: '#2563eb', fontSize: 15, fontWeight: '600' }}>← Tillbaka</Text>
      </TouchableOpacity>

      <View style={{ flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
        {/* Bild */}
        <View style={{ alignItems: 'center' }}>
          {bildKalla
            ? <TouchableOpacity onPress={() => setBildStorModal(true)} activeOpacity={0.85}>
                <Image source={{ uri: bildKalla }}
                  style={{ width: 220, height: 160, borderRadius: 12, borderWidth: 1, borderColor: c.kortBorder, backgroundColor: '#fff' }}
                  resizeMode="contain"
                  onError={() => { if (!produkt.bild) { if (!pngFel) setPngFel(true); else setJpgFel(true); } }} />
                <Text style={{ color: c.textMuted, fontSize: 11, textAlign: 'center', marginTop: 4 }}>Tryck för att förstora</Text>
              </TouchableOpacity>
            : <View style={{ width: 220, height: 160, borderRadius: 12, backgroundColor: c.input, borderWidth: 1, borderColor: c.kortBorder, justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{ fontSize: 48 }}>📦</Text>
                <Text style={{ color: c.textMuted, marginTop: 8, fontSize: 13 }}>Ingen bild</Text>
              </View>
          }

          {/* Lightbox */}
          <Modal visible={bildStorModal} transparent animationType="fade" onRequestClose={() => setBildStorModal(false)}>
            <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' }}
              activeOpacity={1} onPress={() => setBildStorModal(false)}>
              <Image source={{ uri: bildKalla }}
                style={{ width: '90%', height: '70%' }}
                resizeMode="contain" />
              <Text style={{ color: '#aaa', marginTop: 16, fontSize: 13 }}>Tryck var som helst för att stänga</Text>
            </TouchableOpacity>
          </Modal>
          <TouchableOpacity style={{ marginTop: 12, backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 8 }} onPress={onRedigera}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>📦 Uttag / påfyllning</Text>
          </TouchableOpacity>
        </View>

        {/* Info */}
        <View style={{ flex: 1, minWidth: 200 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: c.textRubrik, marginBottom: 4 }}>{produkt.namn}</Text>
          {produkt.artikel ? <Text style={{ color: c.textMuted, fontSize: 14, marginBottom: 12 }}>Art.nr: {produkt.artikel}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            <View style={{ backgroundColor: '#2563eb22', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ color: '#2563eb', fontWeight: '600', fontSize: 13 }}>{produkt.kategori || 'Osorterat'}</Text>
            </View>
            <View style={{ backgroundColor: produkt.antal <= produkt.minAntal ? '#fee2e2' : '#dcfce7', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ color: produkt.antal <= produkt.minAntal ? '#ef4444' : '#16a34a', fontWeight: '700', fontSize: 13 }}>
                {produkt.antal}{produkt.enhet || 'st'} {produkt.antal <= produkt.minAntal ? '⚠️ Lågt' : '✓ OK'}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Längder (meter-produkter) */}
      {produkt.enhet === 'm' && (produkt.langder || []).length > 0 && (
        <View style={{ marginTop: 24 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.textRubrik, marginBottom: 12 }}>Längder</Text>
          {[...(produkt.langder)].sort((a, b) => b.langd - a.langd).map((l, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.kort, borderRadius: 8, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: c.kortBorder }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.textRubrik, minWidth: 60 }}>{l.langd}m</Text>
              <Text style={{ color: c.textMuted, flex: 1 }}>× {l.antal} st</Text>
              <Text style={{ fontWeight: '700', color: '#2563eb' }}>{(l.langd * l.antal).toFixed(1)}m</Text>
            </View>
          ))}
          <View style={{ backgroundColor: c.tabellHuvud, borderRadius: 8, padding: 12, marginTop: 4 }}>
            <Text style={{ color: c.textRubrik, fontWeight: '700', textAlign: 'right' }}>Totalt: {totalMeter.toFixed(1)}m</Text>
          </View>
        </View>
      )}

      {/* Färger */}
      {fargSorterad.length > 0 && (
        <View style={{ marginTop: 24 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.textRubrik, marginBottom: 12 }}>Färger</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {fargSorterad.map((f, i) => (
              <View key={i} style={{ backgroundColor: c.kort, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: c.kortBorder, minWidth: 100, alignItems: 'center' }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.textRubrik }}>{f.farg}</Text>
                <Text style={{ color: c.textMuted, fontSize: 13, marginTop: 2 }}>
                  {f.antal}st{f.langd ? ` × ${f.langd}m` : ''}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [inloggad, setInloggad] = useState(null);
  const [token, setToken] = useState(null);
  const [kollarSession, setKollarSession] = useState(true);

  // Vyn som adressen pekade ut när sidan laddades — det är omladdnings- och
  // djuplänksfallet. Fliken kan sättas direkt, men kund/produkt/projekt är bara
  // slugs tills listorna hunnit hämtas (se tillampaSlugs nedan).
  const [startVy] = useState(() => (Platform.OS === 'web' ? tolkaVag(window.location.pathname) : { flik: '__stampling__' }));
  const vantandeVagRef = useRef(startVy.kundSlug || startVy.produktSlug || startVy.ase60Slug ? startVy : null);
  const forraVagRef = useRef(null);
  const utanHistorikRef = useRef(false);
  // Vilka listor som faktiskt hunnit hämtas — behövs för att skilja "kunden i
  // adressen finns inte" från "kundlistan är inte laddad ännu".
  const listorLaddadeRef = useRef({ kunder: false, ase60: false });

  const [produkter, setProdukter] = useState([]);
  const [ordrar, setOrdrar] = useState([]);
  const [aktivFlik, setAktivFlik] = useState(startVy.flik);
  const [sok, setSok] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [redigeraProdukt, setRedigeraProdukt] = useState(null);
  const [formRiktning, setFormRiktning] = useState('uttag'); // 'uttag' | 'pafyllning' — bara vid redigering
  const [valdProdukt, setValdProdukt] = useState(null);
  const [formNamn, setFormNamn] = useState('');
  const [formArtikel, setFormArtikel] = useState('');
  const [formAntal, setFormAntal] = useState('');
  const [formKategori, setFormKategori] = useState('');
  const [formMinAntal, setFormMinAntal] = useState('5');
  const [formEnhet, setFormEnhet] = useState('st');
  const [formBild, setFormBild] = useState(null);
  const [formFarger, setFormFarger] = useState([]);
  const [formLangder, setFormLangder] = useState([]);
  const [visaAnvandare, setVisaAnvandare] = useState(false);
  const [visaChat, setVisaChat] = useState(false);
  const [andringslogg, setAndringslogg] = useState([]);
  const [kunder, setKunder] = useState([]);
  const [ecwRuns, setEcwRuns] = useState([]);
  const [valdKund, setValdKund] = useState(null);
  const [aktivKundFlik, setAktivKundFlik] = useState(KUND_FLIKAR[0]);
  const [visaLaggTillKund, setVisaLaggTillKund] = useState(false);
  const [nyKundNamn, setNyKundNamn] = useState('');
  const [nyKundPaket, setNyKundPaket] = useState(null);
  const [kundMaterialSok, setKundMaterialSok] = useState('');
  const [ritningar, setRitningar] = useState(RITNINGAR_FALLBACK);
  const [ase60Projekt, setAse60Projekt] = useState([]);
  const [valdAse60Projekt, setValdAse60Projekt] = useState(null);
  // sokAse60 delas av två ställen som aldrig syns samtidigt: projektväljaren i
  // "Ny kund"-formuläret (Kunder-vyn) och kundsöken i ASE60-vyn. ase60SokOppen
  // styr bara om ASE60-vyns träfflista ligger framme — den behövs som eget
  // state för att en tom sökruta ska kunna visa hela kundlistan.
  const [sokAse60, setSokAse60] = useState('');
  const [ase60SokOppen, setAse60SokOppen] = useState(false);
  const [kundSok, setKundSok] = useState('');
  const [valdaKunderExport, setValdaKunderExport] = useState(() => new Set());
  const [klartRuta, setKlartRuta] = useState(null); // { rader, serier, projekt, laddar, fel }
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
  // ─── Samtal (WebRTC) ───
  const [samtal, setSamtal] = useState(null); // { fas: 'utgående'|'inkommande'|'pågår', motpart, mutad, start }
  const [samtalInfo, setSamtalInfo] = useState(null);
  const samtalRef = useRef(null);
  const pcRef = useRef(null);
  const lokalStromRef = useRef(null);
  const fjarrAudioRef = useRef(null);
  const ringsignalRef = useRef(null);
  const samtalTimeoutRef = useRef(null);
  const samtalInfoTimerRef = useRef(null);
  const inkommandeOfferRef = useRef(null);
  const vantandeIceRef = useRef([]);
  const { width } = useWindowDimensions();
  const mobil = width < 768;

  useEffect(() => { visaChatRef.current = visaChat; }, [visaChat]);

  useEffect(() => {
    if (!token || Platform.OS !== 'web') return;
    fetch(`${API}/api/messages`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setMeddelanden).catch(() => {});
    let avslutad = false;
    let atertimer = null;
    const anslut = () => {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsBase = window.location.pathname.startsWith('/UterumLager') ? '/UterumLager/ws' : '/ws';
      const ws = new WebSocket(`${wsProto}//${window.location.host}${wsBase}?token=${token}`);
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
        if (data.type === 'ecw-run' && data.run) setEcwRuns(prev => [data.run, ...prev]);
        if (typeof data.type === 'string' && data.type.startsWith('call-')) hanteraSamtalsSignal(data);
      };
      ws.onclose = () => {
        if (avslutad) return;
        setOnlineUsers([]);
        atertimer = setTimeout(anslut, 3000);
      };
    };
    anslut();
    return () => { avslutad = true; clearTimeout(atertimer); wsRef.current?.close(); };
  }, [token]);

  useEffect(() => {
    if (visaChat) { setChatBubble(null); setOlastaAntal(0); }
  }, [visaChat]);

  // ─── Samtalslogik ───
  const sattSamtal = (nytt) => { samtalRef.current = nytt; setSamtal(nytt); };

  const visaSamtalInfo = (text) => {
    clearTimeout(samtalInfoTimerRef.current);
    setSamtalInfo(text);
    if (text) samtalInfoTimerRef.current = setTimeout(() => setSamtalInfo(null), 4000);
  };

  const skickaSignal = (obj) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(obj));
  };

  const startaRingsignal = (typ) => {
    stoppaRingsignal();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const tona = (freq, start, langd, volym) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volym, start + 0.02);
      gain.gain.setValueAtTime(volym, Math.max(start + 0.02, start + langd - 0.05));
      gain.gain.linearRampToValueAtTime(0, start + langd);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + langd);
    };
    ringsignalRef.current = { ctx, timer: null };
    const spela = () => {
      const nu = ctx.currentTime + 0.05;
      if (typ === 'inkommande') {
        // Messenger-lik melodisk ringsignal
        tona(880, nu, 0.16, 0.25);
        tona(1108, nu + 0.18, 0.16, 0.25);
        tona(880, nu + 0.36, 0.16, 0.25);
        tona(1318, nu + 0.54, 0.34, 0.28);
        if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
      } else {
        // Svensk rington: 425 Hz, 1 s ton
        tona(425, nu, 1.0, 0.12);
      }
      if (ringsignalRef.current) {
        ringsignalRef.current.timer = setTimeout(spela, typ === 'inkommande' ? 2200 : 5000);
      }
    };
    spela();
  };

  const stoppaRingsignal = () => {
    const r = ringsignalRef.current;
    if (!r) return;
    ringsignalRef.current = null;
    clearTimeout(r.timer);
    r.ctx.close().catch(() => {});
    if (navigator.vibrate) navigator.vibrate(0);
  };

  // Systemnotis för inkommande samtal när fliken ligger i bakgrunden
  const visaSamtalsNotis = async (fran) => {
    try {
      if (typeof document === 'undefined' || !document.hidden) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      const notisBase = window.location.pathname.startsWith('/UterumLager') ? '/UterumLager' : '';
      reg.showNotification(`📞 ${fran.namn} ringer dig`, {
        body: 'Klicka för att öppna och svara',
        icon: notisBase + '/icon-192.png',
        badge: notisBase + '/icon-192.png',
        tag: 'inkommande-samtal',
        vibrate: [300, 150, 300],
        data: { url: notisBase + '/' },
      });
    } catch {}
  };

  const stangSamtalsNotis = async () => {
    try {
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      (await reg.getNotifications({ tag: 'inkommande-samtal' })).forEach(n => n.close());
    } catch {}
  };

  const stadaUppSamtal = (infoText) => {
    stoppaRingsignal();
    stangSamtalsNotis();
    clearTimeout(samtalTimeoutRef.current);
    if (pcRef.current) { try { pcRef.current.close(); } catch {} pcRef.current = null; }
    lokalStromRef.current?.getTracks().forEach(t => t.stop());
    lokalStromRef.current = null;
    if (fjarrAudioRef.current) fjarrAudioRef.current.srcObject = null;
    inkommandeOfferRef.current = null;
    vantandeIceRef.current = [];
    sattSamtal(null);
    if (infoText) visaSamtalInfo(infoText);
  };

  const skapaPeer = (motpartUsername) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.onicecandidate = (e) => {
      if (e.candidate) skickaSignal({ type: 'call-ice', to: motpartUsername, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      if (!fjarrAudioRef.current) {
        fjarrAudioRef.current = new window.Audio();
        fjarrAudioRef.current.autoplay = true;
      }
      fjarrAudioRef.current.srcObject = e.streams[0];
      fjarrAudioRef.current.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') stadaUppSamtal('Samtalet bröts');
    };
    pcRef.current = pc;
    return pc;
  };

  const hamtaMikrofon = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      visaSamtalInfo('Samtal kräver HTTPS och mikrofonstöd');
      return null;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      visaSamtalInfo('Tillåt mikrofonen för att kunna ringa');
      return null;
    }
  };

  const ringUpp = async (motpart) => {
    if (samtalRef.current || motpart.username === inloggad?.username) return;
    const strom = await hamtaMikrofon();
    if (!strom) return;
    lokalStromRef.current = strom;
    sattSamtal({ fas: 'utgående', motpart, mutad: false, start: null });
    const pc = skapaPeer(motpart.username);
    strom.getTracks().forEach(t => pc.addTrack(t, strom));
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch {
      stadaUppSamtal('Kunde inte starta samtalet');
      return;
    }
    skickaSignal({ type: 'call-offer', to: motpart.username, sdp: pc.localDescription });
    startaRingsignal('utgående');
    samtalTimeoutRef.current = setTimeout(() => {
      skickaSignal({ type: 'call-end', to: motpart.username });
      stadaUppSamtal(`${motpart.namn} svarade inte`);
    }, 30000);
  };

  const svaraSamtal = async () => {
    const s = samtalRef.current;
    if (!s || s.fas !== 'inkommande') return;
    clearTimeout(samtalTimeoutRef.current);
    stoppaRingsignal();
    stangSamtalsNotis();
    const strom = await hamtaMikrofon();
    if (!strom) {
      skickaSignal({ type: 'call-decline', to: s.motpart.username });
      stadaUppSamtal(null);
      return;
    }
    lokalStromRef.current = strom;
    const pc = skapaPeer(s.motpart.username);
    strom.getTracks().forEach(t => pc.addTrack(t, strom));
    try {
      await pc.setRemoteDescription(inkommandeOfferRef.current);
      for (const kandidat of vantandeIceRef.current) {
        await pc.addIceCandidate(kandidat).catch(() => {});
      }
      vantandeIceRef.current = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch {
      skickaSignal({ type: 'call-end', to: s.motpart.username });
      stadaUppSamtal('Kunde inte koppla upp samtalet');
      return;
    }
    skickaSignal({ type: 'call-answer', to: s.motpart.username, sdp: pc.localDescription });
    sattSamtal({ ...s, fas: 'pågår', start: Date.now() });
  };

  const avvisaSamtal = () => {
    const s = samtalRef.current;
    if (!s || s.fas !== 'inkommande') return;
    skickaSignal({ type: 'call-decline', to: s.motpart.username });
    stadaUppSamtal(null);
  };

  const laggPaSamtal = () => {
    const s = samtalRef.current;
    if (!s) return;
    skickaSignal({ type: 'call-end', to: s.motpart.username });
    stadaUppSamtal(null);
  };

  const toggleMikrofon = () => {
    const s = samtalRef.current;
    const strom = lokalStromRef.current;
    if (!s || !strom) return;
    const nyMutad = !s.mutad;
    strom.getAudioTracks().forEach(t => { t.enabled = !nyMutad; });
    sattSamtal({ ...s, mutad: nyMutad });
  };

  const hanteraSamtalsSignal = async (data) => {
    const s = samtalRef.current;
    switch (data.type) {
      case 'call-offer': {
        if (s) { skickaSignal({ type: 'call-decline', to: data.from.username, reason: 'upptagen' }); return; }
        inkommandeOfferRef.current = data.sdp;
        vantandeIceRef.current = [];
        sattSamtal({ fas: 'inkommande', motpart: data.from, mutad: false, start: null });
        startaRingsignal('inkommande');
        visaSamtalsNotis(data.from);
        samtalTimeoutRef.current = setTimeout(() => {
          skickaSignal({ type: 'call-decline', to: data.from.username });
          stadaUppSamtal(null);
        }, 30000);
        break;
      }
      case 'call-answer': {
        if (!s || s.fas !== 'utgående' || !pcRef.current) return;
        clearTimeout(samtalTimeoutRef.current);
        stoppaRingsignal();
        try {
          await pcRef.current.setRemoteDescription(data.sdp);
          for (const kandidat of vantandeIceRef.current) {
            await pcRef.current.addIceCandidate(kandidat).catch(() => {});
          }
          vantandeIceRef.current = [];
        } catch {
          skickaSignal({ type: 'call-end', to: s.motpart.username });
          stadaUppSamtal('Kunde inte koppla upp samtalet');
          return;
        }
        sattSamtal({ ...s, fas: 'pågår', start: Date.now() });
        break;
      }
      case 'call-ice': {
        const pc = pcRef.current;
        if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else vantandeIceRef.current.push(data.candidate);
        break;
      }
      case 'call-decline': {
        if (!s || s.fas !== 'utgående') return;
        stadaUppSamtal(data.reason === 'upptagen'
          ? `${s.motpart.namn} är upptagen i ett annat samtal`
          : `${s.motpart.namn} avvisade samtalet`);
        break;
      }
      case 'call-end': {
        if (!s || s.motpart.username !== data.from?.username) return;
        stadaUppSamtal(s.fas === 'pågår' ? 'Samtalet avslutades'
          : s.fas === 'inkommande' ? `Missat samtal från ${s.motpart.namn}` : null);
        break;
      }
      case 'call-taken': {
        // Samma användare svarade/avvisade i en annan flik
        if (s?.fas === 'inkommande') stadaUppSamtal(null);
        break;
      }
      case 'call-unavailable': {
        if (!s || s.fas !== 'utgående') return;
        stadaUppSamtal(`${s.motpart.namn} är inte online — får en notis om missat samtal`);
        break;
      }
    }
  };

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
    if (samtalRef.current) laggPaSamtal();
    try { await fetch(`${API}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
    await AsyncStorage.removeItem(TOKEN_KEY);
    setInloggad(null); setToken(null);
  };

  const laddaProdukter = async () => {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      let lista = data ? JSON.parse(data) : SEED_PRODUKTER;
      if (!data) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(SEED_PRODUKTER));
      const befintligaIds = new Set(lista.map(p => p.id));
      const nya = [
        ...SEED_AWS70HI.filter(p => !befintligaIds.has(p.id)),
        ...SEED_AOC50.filter(p => !befintligaIds.has(p.id)),
        ...SEED_TRABALKAR.filter(p => !befintligaIds.has(p.id)),
        ...SEED_ASE60_82MM_NYA.filter(p => !befintligaIds.has(p.id)),
        // Vårens Schüco-leveranser som saknades i registret (saldo 0, Osorterat)
        // — läggs bara in om id saknas, befintliga produkter rörs aldrig.
        ...LEVERANS_NYA_2026.filter(p => !befintligaIds.has(p.id)),
      ];
      if (nya.length > 0) {
        lista = [...lista, ...nya];
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(lista));
      }
      // Fysisk inventering (U:\schuecco.xlsx) — appliceras EN gång per
      // webbläsare, samma mönster som seed-migreringarna ovan.
      const invKey = `lagersystem_inventering_${INVENTERING_DATUM}`;
      if (!(await AsyncStorage.getItem(invKey))) {
        const resultat = appliceraInventering(lista);
        lista = resultat.lista;
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(lista));
        await AsyncStorage.setItem(invKey, '1');
        console.log(`Inventering ${INVENTERING_DATUM}: ${resultat.uppdaterade} uppdaterade, ${resultat.skapade.length} nya, ${resultat.nollade.length} dubbletter nollade`);
      }
      setProdukter(lista);
      try { const od = await AsyncStorage.getItem(ORDRAR_KEY); setOrdrar(od ? JSON.parse(od) : []); } catch {}
    } catch {}
  };

  const sparaProdukter = async (lista) => {
    try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(lista)); } catch {}
  };
  const sparaOrdrar = async (lista) => {
    try { await AsyncStorage.setItem(ORDRAR_KEY, JSON.stringify(lista)); } catch {}
  };

  // Lägg in en inköpsbeställning: kända artiklar fyller på lagersaldot, nya
  // artiklar skapas som produkter (auto-avläsning mot befintlig katalog).
  const laggInOrder = ({ leverantor, referens, notering, rader, nyckel, bilder }) => {
    const nyProdukter = [...produkter];
    const orderRader = [];
    for (const r of (rader || [])) {
      const art = String(r.artikel || '').trim();
      const antal = parseInt(r.antal) || 0;
      if (!art || antal <= 0) continue;
      const idx = nyProdukter.findIndex(p => String(p.artikel || '').trim().toLowerCase() === art.toLowerCase());
      if (idx >= 0) {
        const p = nyProdukter[idx];
        const nyttSaldo = (parseInt(p.antal) || 0) + antal;
        nyProdukter[idx] = { ...p, antal: nyttSaldo };
        orderRader.push({ artikel: art, namn: p.namn, antal, enhet: p.enhet || 'st', status: 'påfylld', nyttSaldo });
      } else {
        const ny = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
          namn: (r.namn || art).trim(), artikel: art, antal,
          minAntal: 5, kategori: (r.kategori || 'Osorterat').trim(),
          enhet: r.enhet || 'st', dimension: r.dimension || '',
        };
        nyProdukter.push(ny);
        orderRader.push({ artikel: art, namn: ny.namn, antal, enhet: ny.enhet, status: 'ny', nyttSaldo: antal });
      }
    }
    if (orderRader.length === 0 && !(Array.isArray(bilder) && bilder.length)) return;
    setProdukter(nyProdukter);
    sparaProdukter(nyProdukter);
    const order = {
      id: Date.now().toString(),
      tid: new Date().toISOString(),
      av: inloggad?.namn || inloggad?.username || '',
      leverantor: (leverantor || '').trim(),
      referens: (referens || '').trim(),
      notering: (notering || '').trim(),
      nyckel: nyckel || orderNyckel(referens, rader),
      rader: orderRader,
      bilder: Array.isArray(bilder) ? bilder : [],
    };
    const nyOrdrar = [order, ...ordrar];
    setOrdrar(nyOrdrar);
    sparaOrdrar(nyOrdrar);
    // Logga i ändringsloggen (best effort)
    const nya = orderRader.filter(r => r.status === 'ny').length;
    const pa = orderRader.filter(r => r.status === 'påfylld').length;
    fetch(`${API}/api/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        typ: 'order',
        text: `Beställning inlagd${order.leverantor ? ` (${order.leverantor})` : ''}: ${pa} påfylld${pa === 1 ? '' : 'a'}, ${nya} ny${nya === 1 ? '' : 'a'} artiklar`,
        av: order.av,
      }),
    }).catch(() => {});
  };

  // Importera historiska ordrar som LOGG-poster — de hamnar i Ordrar-listan
  // men rör INTE lagersaldot (fysiska inventeringen står kvar som baseline).
  // Finns ordernr redan → UPPDATERAS (så en ny fullständig import ersätter en
  // tidigare tom/ofullständig), annars läggs det till.
  const importeraOrdrar = (lista) => {
    if (!Array.isArray(lista) || !lista.length) return { added: 0, updated: 0 };
    const byNyckel = new Map(ordrar.filter(o => o.nyckel).map(o => [o.nyckel, o]));
    let added = 0, updated = 0;
    const inRecords = [];
    for (const o of lista) {
      const rader = (o.rader || []).map(r => ({
        artikel: String(r.artikel || '').trim(), namn: r.namn || '',
        antal: parseInt(r.antal) || 0, enhet: r.enhet || 'st',
        dimension: r.dimension || '', status: 'logg',
      })).filter(r => r.artikel);
      const nyckel = o.nyckel || orderNyckel(o.referens, rader);
      const rec = {
        id: (String(o.referens || 'ord') + '_' + Math.random().toString(36).slice(2, 8)),
        tid: o.tid || new Date().toISOString(),
        av: o.av || (inloggad?.namn || inloggad?.username || ''),
        leverantor: o.leverantor || 'Schüco',
        referens: o.referens || '', projekt: o.projekt || '', notering: o.notering || '',
        nyckel, rader, bilder: [], endastLogg: true,
      };
      if (nyckel && byNyckel.has(nyckel)) { rec.id = byNyckel.get(nyckel).id; updated++; } else added++;
      inRecords.push(rec);
    }
    const nycklarIn = new Set(inRecords.map(r => r.nyckel).filter(Boolean));
    const behalls = ordrar.filter(o => !(o.nyckel && nycklarIn.has(o.nyckel)));
    const combined = [...inRecords, ...behalls].sort((a, b) => String(b.tid || '').localeCompare(String(a.tid || '')));
    setOrdrar(combined);
    sparaOrdrar(combined);
    return { added, updated };
  };

  // Radera en order ur loggen (rör inte lagersaldot — logg-poster har aldrig
  // påverkat det, och en manuell påfyllnad backas inte automatiskt).
  const taBortOrder = (id) => {
    const ny = ordrar.filter(o => o.id !== id);
    setOrdrar(ny);
    sparaOrdrar(ny);
  };
  const rensaLoggOrdrar = () => {
    const ny = ordrar.filter(o => !o.endastLogg);
    setOrdrar(ny);
    sparaOrdrar(ny);
  };

  const arRitning = ritningar.some(r => r.id === aktivFlik);
  const arAndringslogg = aktivFlik === '__andringar__';
  const arKunder = aktivFlik === '__kunder__';
  const arStampling = aktivFlik === '__stampling__';
  const arAse60 = aktivFlik === '__ase60__';
  const arSimulering = aktivFlik === '__simulering__';
  const arSammanstallning = aktivFlik === '__sammanstallning__';
  const arLagerforslag = aktivFlik === '__lagerforslag__';
  const arOrdrar = aktivFlik === '__ordrar__';
  const arPlanering = aktivFlik === '__planering__';
  const arBeredning = aktivFlik === '__beredning__';

  useEffect(() => {
    if (arKunder && token) {
      fetch(`${API}/api/ecw-runs`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json()).then(setEcwRuns).catch(() => {});
    }
  }, [arKunder, token]);

  useEffect(() => {
    if (arAndringslogg && token && inloggad?.roll === 'admin') {
      fetch(`${API}/api/changes`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json()).then(setAndringslogg).catch(() => {});
    }
  }, [arAndringslogg, token, inloggad]);

  const laddaKunder = () => {
    if (!token) return;
    fetch(`${API}/api/kunder`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { listorLaddadeRef.current.kunder = true; setKunder(d); }).catch(() => {});
  };

  const laddaAse60Projekt = () => {
    if (!token) return;
    fetch(`${API}/api/ase60-projekt`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { listorLaddadeRef.current.ase60 = true; setAse60Projekt(d); }).catch(() => {});
  };

  // token finns med i beroendena: en djuplänk rakt in i en kundvy renderar
  // flikarna innan sessionskollen är klar, och utan token-beroendet skulle
  // hämtningen aldrig göras om när token väl kommer.
  // Adressen /ase60/<projekt>/ behöver också projektlistan för att kunna matchas.
  // ASE60-vyn behöver också listan: kundsöken där letar i projekten, och den
  // ska fungera direkt när man klickar in på fliken — inte bara när adressen
  // råkar innehålla ett projekt (/ase60/<projekt>/).
  useEffect(() => {
    if (arKunder || arSammanstallning || arLagerforslag || arPlanering || arBeredning) { laddaKunder(); laddaAse60Projekt(); }
    else if (arAse60 || vantandeVagRef.current?.ase60Slug) laddaAse60Projekt();
  }, [arKunder, arSammanstallning, arLagerforslag, arPlanering, arBeredning, arAse60, token]);

  // Paket-listan (ASE 60 / ASS 32 / ...) är delad med ase60-generator och
  // Uterum-Konfigurator via GET /api/paket — ingen inloggning krävs, samma
  // som RITNINGAR_FALLBACK alltid varit synlig innan sidan laddade. Faller
  // tillbaka på RITNINGAR_FALLBACK om anropet misslyckas (servern gör
  // samma fallback, så det här är bara ett extra skyddslager).
  useEffect(() => {
    fetch(`${API}/api/paket`)
      .then(r => r.json())
      .then(data => {
        const lista = (data.paket || [])
          .filter(p => RITNING_FIL[p.id])
          .map(p => ({ id: p.id, label: `${p.namn} Ritningar`, fil: RITNING_FIL[p.id], status: p.status }));
        if (lista.length) setRitningar(lista);
      })
      .catch(() => {});
  }, []);

  // ─── Adressraden ───
  // Matchar slugs ur adressen mot laddad data. Returnerar false när något ännu
  // inte gick att matcha OCH listan inte hunnit hämtas — då står försöket kvar
  // och görs om när datan kommer. Hittas kunden aldrig (borttagen) ger vi upp
  // tyst och kundlistan blir kvar på skärmen.
  const tillampaSlugs = (v) => {
    let klar = true;
    if (v.kundSlug) {
      const proj = ase60Projekt.find(p => slugga(p.name) === v.kundSlug);
      const kund = proj
        ? kundFranAse60Projekt(proj, kunder.find(k => k.id === proj.id || k.ase60ProjectId === proj.id))
        : kunder.find(k => slugga(k.namn) === v.kundSlug);
      if (kund) {
        setValdKund(kund);
        setAktivKundFlik(KUND_FLIKAR.find(f => slugga(f) === v.kundFlikSlug) || KUND_FLIKAR[0]);
        setKundMaterialSok('');
      } else if (!listorLaddadeRef.current.kunder || !listorLaddadeRef.current.ase60) klar = false;
    }
    if (v.produktSlug) {
      const p = produkter.find(x => slugga(x.artikel || x.id) === v.produktSlug);
      if (p) setValdProdukt(p);
      else if (!produkter.length) klar = false;
    }
    if (v.ase60Slug) {
      const p = ase60Projekt.find(x => slugga(x.name) === v.ase60Slug);
      if (p) setValdAse60Projekt(p);
      else if (!listorLaddadeRef.current.ase60) klar = false;
    }
    return klar;
  };

  useEffect(() => {
    if (Platform.OS !== 'web' || !vantandeVagRef.current) return;
    if (!tillampaSlugs(vantandeVagRef.current)) return;
    vantandeVagRef.current = null;
    utanHistorikRef.current = true; // vyn hann bara ikapp adressen — ingen ny historikpost
  }, [kunder, ase60Projekt, produkter]);

  const vyState = { aktivFlik, valdKund, aktivKundFlik, valdProdukt, valdAse60Projekt };
  const vag = Platform.OS === 'web' ? vagForVy(vyState) : '';

  // Skriver vyn till adressraden. pushState (inte replaceState) så bakåtknappen
  // stegar tillbaka vy för vy; replaceState används bara när adressen ska
  // städas utan att vyn bytts, t.ex. /UterumLager → /UterumLager/ vid start.
  useEffect(() => {
    if (Platform.OS !== 'web' || kollarSession || !inloggad) return;
    const full = `${BAS}${vag}`;
    const forsta = forraVagRef.current === null;
    // En ny historikpost ska bara skapas när användaren själv bytt vy. Kommer
    // bytet från adressen (bakåt/framåt, eller en djuplänk som just matchats
    // mot färsk data) är adressen redan rätt och ska på sin höjd städas.
    const bytteVy = !forsta && !utanHistorikRef.current && forraVagRef.current !== vag;
    utanHistorikRef.current = false;
    forraVagRef.current = vag;
    // Vyn har rört sig av egen kraft — då är det staten, inte den gamla
    // adressen, som gäller och ett väntande djuplänksförsök ska släppas.
    if (bytteVy) vantandeVagRef.current = null;
    document.title = titelForVy(vyState);
    if (vag === kanoniskVag(window.location.pathname)) return;
    // Adressen pekar djupare än staten hunnit bli (kunden är inte matchad ännu)
    // — skriv inte över länken, vänta in datan.
    if (vantandeVagRef.current) return;
    const mal = full + window.location.search;
    if (bytteVy) window.history.pushState({ vag }, '', mal);
    else window.history.replaceState({ vag }, '', mal);
  }, [vag, inloggad, kollarSession]);

  // Bakåt/framåt: läs adressen på nytt och sätt tillbaka vy-staten. Lyssnaren
  // registreras en gång men går via en ref, annars skulle den se kunder/
  // produkter som de såg ut när den registrerades.
  const tillampaVagRef = useRef(null);
  tillampaVagRef.current = (pathname) => {
    const v = tolkaVag(pathname);
    setAktivFlik(v.flik);
    setSok('');
    setValdProdukt(null);
    setValdKund(null);
    setVisaSidebar(false);
    if (!v.ase60Slug) setValdAse60Projekt(null);
    const behoverData = !!(v.kundSlug || v.produktSlug || v.ase60Slug);
    vantandeVagRef.current = behoverData && !tillampaSlugs(v) ? v : null;
    utanHistorikRef.current = true; // webbläsaren har redan flyttat historikpekaren
  };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const vidPopstate = () => tillampaVagRef.current?.(window.location.pathname);
    window.addEventListener('popstate', vidPopstate);
    return () => window.removeEventListener('popstate', vidPopstate);
  }, []);

  // Planeringstavlan öppnar kundkortet exakt som kundlistan gör — samma
  // kund-objekt och samma state — så att adressen blir /kunder/<kund>/<flik>/,
  // omladdning fungerar och bakåtknappen tar en tillbaka till tavlan.
  // ASE60-projekt utan rad i kunder.json byggs via kundFranAse60Projekt(),
  // annars gick de inte att öppna från tavlan.
  const oppnaKundkort = (rad) => {
    if (!rad) return;
    const proj = ase60Projekt.find(p => p.id === rad.ase60ProjectId || p.id === rad.id);
    const sparad = kunder.find(k => k.id === rad.id || (rad.ase60ProjectId && k.ase60ProjectId === rad.ase60ProjectId));
    const kund = proj ? kundFranAse60Projekt(proj, sparad) : sparad;
    if (!kund) return;
    setAktivFlik('__kunder__');
    setValdProdukt(null);
    setValdKund(kund);
    setAktivKundFlik(KUND_FLIKAR[0]);
    setKundMaterialSok('');
  };

  const laggTillKund = () => {
    if (!nyKundNamn.trim()) return;
    const body = {
      namn: nyKundNamn.trim(),
      farg: valdAse60Projekt?.color || '',
      ase60ProjectId: valdAse60Projekt?.id || null,
      matt: valdAse60Projekt?.units?.map(u => ({ widthMm: u.widthMm, heightMm: u.heightMm, leaves: u.leaves })) || [],
      paket: nyKundPaket,
    };
    fetch(`${API}/api/kunder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then(r => r.json()).then(ny => {
      setKunder(prev => [...prev, ny]);
      setNyKundNamn('');
      setNyKundPaket(null);
      setValdAse60Projekt(null);
      setSokAse60('');
      setVisaLaggTillKund(false);
    }).catch(() => {});
  };

  const taBortKund = (id) => {
    const ok = Platform.OS === 'web' ? window.confirm('Ta bort kund?') : true;
    if (!ok) return;
    fetch(`${API}/api/kunder/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      .then(() => { setKunder(prev => prev.filter(k => k.id !== id)); if (valdKund?.id === id) setValdKund(null); })
      .catch(() => {});
  };

  const uppdateraKund = (uppdaterad) => {
    setKunder(prev => {
      const finns = prev.some(k => k.id === uppdaterad.id);
      return finns ? prev.map(k => k.id === uppdaterad.id ? uppdaterad : k) : [...prev, uppdaterad];
    });
    setValdKund(uppdaterad);
    fetch(`${API}/api/kunder/${uppdaterad.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        namn: uppdaterad.namn,
        farg: uppdaterad.farg || '',
        ase60ProjectId: uppdaterad.ase60ProjectId || null,
        matt: uppdaterad.matt || [],
        material: uppdaterad.material || {},
        klart: uppdaterad.klart || {},
        logg: uppdaterad.logg || [],
        paket: uppdaterad.paket ?? null,
      }),
    }).catch(() => {});
  };

  // Planeringsvyn skickar bara sina egna fält och får hela kundraden tillbaka ur
  // kunder.json — den ersätter (eller lägger till) raden i listan, så inget som
  // kundkortet skrivit går förlorat.
  const kundFranServer = (kund) => {
    if (!kund?.id) return;
    setKunder(prev => prev.some(k => k.id === kund.id) ? prev.map(k => k.id === kund.id ? kund : k) : [...prev, kund]);
    setValdKund(v => (v && (v.id === kund.id || (kund.ase60ProjectId && v.ase60ProjectId === kund.ase60ProjectId))
      ? { ...v, planering: kund.planering } : v));
  };

  const laggTillKundMaterial = (produkt) => {
    const material = { ...(valdKund.material || {}) };
    const lista = [...(material[aktivKundFlik] || [])];
    const idx = lista.findIndex(m => m.produktId === produkt.id);
    if (idx >= 0) lista[idx] = { ...lista[idx], antal: (parseInt(lista[idx].antal) || 0) + 1 };
    else lista.push({ produktId: produkt.id, namn: produkt.namn, artikel: produkt.artikel || '', enhet: produkt.enhet || 'st', antal: 1 });
    material[aktivKundFlik] = lista;
    uppdateraKund({ ...valdKund, material });
    setKundMaterialSok('');
  };

  const andraKundMaterialAntal = (produktId, text) => {
    const material = { ...(valdKund.material || {}) };
    material[aktivKundFlik] = (material[aktivKundFlik] || []).map(m =>
      m.produktId === produktId ? { ...m, antal: text === '' ? '' : (parseInt(text) || 0) } : m);
    uppdateraKund({ ...valdKund, material });
  };

  const taBortKundMaterial = (produktId) => {
    const material = { ...(valdKund.material || {}) };
    material[aktivKundFlik] = (material[aktivKundFlik] || []).filter(m => m.produktId !== produktId);
    uppdateraKund({ ...valdKund, material });
  };

  const loggaKundUttag = (lista, riktning) => {
    if (!token) return;
    lista.forEach(m => {
      const p = produkter.find(x => x.id === m.produktId);
      if (!p) return;
      const antal = parseInt(m.antal) || 0;
      if (antal <= 0) return;
      const nytt = riktning === 'uttag' ? Math.max(0, p.antal - antal) : p.antal + antal;
      fetch(`${API}/api/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          produktId: p.id, produktNamn: p.namn,
          andringar: [{
            falt: riktning === 'uttag' ? 'Uttag' : 'Antal',
            fran: `${p.antal}${p.enhet || 'st'}`,
            till: `${nytt}${p.enhet || 'st'} (${riktning === 'uttag' ? '-' : '+'}${antal} ${valdKund.namn} / ${aktivKundFlik})`,
          }],
        }),
      }).catch(() => {});
    });
  };

  // Klart öppnar en godkännanderuta med all input (manuellt material + för Alufräs
  // auto-ifyllda profiler med rätt längder från ASE60-optimeringen). Inget dras
  // från lagret förrän användaren godkänner.
  const oppnaKlartRuta = async () => {
    const manuella = (valdKund.material?.[aktivKundFlik] || [])
      .filter(m => (parseInt(m.antal) || 0) > 0)
      .map(m => ({ ...m, antal: parseInt(m.antal) || 0, typ: 'manuell' }));
    const hamtaProfiler = (aktivKundFlik === 'Alufräs' || aktivKundFlik === 'Glas') && (valdKund.ase60ProjectId || valdKund.id);
    if (!hamtaProfiler) {
      if (manuella.length === 0) return;
      setKlartRuta({ rader: manuella, serier: [], projekt: '', laddar: false });
      return;
    }
    setKlartRuta({ rader: manuella, serier: [], projekt: '', laddar: true });
    try {
      const projId = valdKund.ase60ProjectId || valdKund.id;
      const r = await fetch(`${API}/api/ase60-optimering/${encodeURIComponent(projId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'fel');
      // Glasraden (artikel "GLAS") hör hemma under egen Glas-flik, inte Alufräs
      // — annars räknas den dubbelt om båda flikarna körs "Klart".
      const radAvGlas = p => String(p.artikel).trim().toUpperCase() === 'GLAS';
      const profilerForFlik = (data.profiler || []).filter(p => aktivKundFlik === 'Glas' ? radAvGlas(p) : !radAvGlas(p));
      const profilRader = profilerForFlik.map(p => {
        // Matcha lagerprodukt: samma artikelnr (ASE60 har ibland bokstavssuffix,
        // t.ex. 487850A = lagrets 487850), helst med rätt längd i dimension-fältet
        const profilArt = String(p.artikel).trim();
        const profilArtNum = profilArt.replace(/[A-Za-z]+$/, '');
        const kandidater = produkter.filter(x => {
          const xa = (x.artikel || '').trim();
          return xa === profilArt || (profilArtNum && xa === profilArtNum);
        });
        const medLangd = kandidater.find(x => (x.dimension || '').replace(/\D/g, '') === String(p.langdMm));
        const prod = medLangd || kandidater[0] || null;
        return {
          produktId: prod?.id || null,
          namn: prod?.namn || p.beskrivning || p.artikel,
          artikel: String(p.artikel),
          langdMm: p.langdMm,
          enhet: prod?.enhet || 'st',
          antal: p.antal,
          typ: 'profil',
        };
      });
      setKlartRuta({ rader: [...profilRader, ...manuella], serier: data.serier || [], projekt: data.projekt || '', laddar: false });
    } catch (e) {
      setKlartRuta({
        rader: manuella, serier: [], projekt: '', laddar: false,
        fel: 'Kunde inte hämta profiloptimeringen från ASE60 — kontrollera att generatorn är igång.',
      });
    }
  };

  const andraKlartRad = (index, antalText) => {
    setKlartRuta(prev => prev && ({
      ...prev,
      rader: prev.rader.map((r, i) => i === index ? { ...r, antal: antalText === '' ? '' : (parseInt(antalText) || 0) } : r),
    }));
  };

  const taBortKlartRad = (index) => {
    setKlartRuta(prev => prev && ({ ...prev, rader: prev.rader.filter((_, i) => i !== index) }));
  };

  const godkannKlart = () => {
    if (!klartRuta) return;
    const rader = klartRuta.rader.filter(r => r.produktId && (parseInt(r.antal) || 0) > 0);
    if (rader.length === 0) return;
    loggaKundUttag(rader, 'uttag');
    const nyProdukter = produkter.map(p => {
      const summa = rader.filter(r => r.produktId === p.id).reduce((s, r) => s + (parseInt(r.antal) || 0), 0);
      if (!summa) return p;
      return { ...p, antal: Math.max(0, p.antal - summa) };
    });
    setProdukter(nyProdukter);
    sparaProdukter(nyProdukter);
    const material = { ...(valdKund.material || {}) };
    material[aktivKundFlik] = klartRuta.rader
      .filter(r => (parseInt(r.antal) || 0) > 0)
      .map(r => ({ produktId: r.produktId, namn: r.namn, artikel: r.artikel || '', enhet: r.enhet || 'st', antal: parseInt(r.antal) || 0, langdMm: r.langdMm }));
    const klart = { ...(valdKund.klart || {}), [aktivKundFlik]: { tid: new Date().toISOString(), av: inloggad?.namn || inloggad?.username || '' } };
    uppdateraKund({ ...valdKund, material, klart });
    setKlartRuta(null);
  };

  const angraKundFlikKlart = () => {
    const lista = (valdKund.material?.[aktivKundFlik] || []).filter(m => (parseInt(m.antal) || 0) > 0);
    const genomfor = () => {
      loggaKundUttag(lista, 'aterlagg');
      const nyProdukter = produkter.map(p => {
        const m = lista.find(x => x.produktId === p.id);
        if (!m) return p;
        return { ...p, antal: p.antal + (parseInt(m.antal) || 0) };
      });
      setProdukter(nyProdukter);
      sparaProdukter(nyProdukter);
      const klart = { ...(valdKund.klart || {}) };
      delete klart[aktivKundFlik];
      uppdateraKund({ ...valdKund, klart });
    };
    const fraga = `Ångra klart för ${aktivKundFlik}?\nMaterialet läggs tillbaka i lagret.`;
    if (Platform.OS === 'web') {
      if (window.confirm(fraga)) genomfor();
    } else {
      Alert.alert('Ångra klart?', fraga, [
        { text: 'Avbryt', style: 'cancel' },
        { text: 'Ångra', onPress: genomfor },
      ]);
    }
  };

  const vaeljBild = () => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => setFormBild(ev.target.result);
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const oppnaLaggTill = () => {
    setRedigeraProdukt(null);
    setFormNamn(''); setFormArtikel(''); setFormAntal('');
    setFormKategori(aktivFlik === 'Alla produkter' || arRitning || arAndringslogg || arStampling || arAse60 || arSimulering || arSammanstallning || arLagerforslag || arPlanering || arBeredning ? '' : aktivFlik);
    setFormMinAntal('5'); setFormEnhet('st');
    setFormBild(null); setFormFarger([]); setFormLangder([]);
    setModalVisible(true);
  };

  const oppnaRedigera = (produkt) => {
    setRedigeraProdukt(produkt);
    setFormRiktning('uttag');
    setFormNamn(produkt.namn);
    setFormArtikel(produkt.artikel || '');
    setFormAntal('');
    setFormKategori(produkt.kategori);
    setFormMinAntal(String(produkt.minAntal));
    setFormEnhet(produkt.enhet || 'st');
    setFormBild(produkt.bild || null);
    setFormFarger([]);
    setFormLangder([]);
    setModalVisible(true);
  };

  const sparaProdukt = () => {
    if (!formNamn.trim()) { Alert.alert('Fel', 'Namn krävs'); return; }
    const fargerMedAntal = formFarger.filter(f => f.farg.trim() && parseInt(f.antal) > 0);
    const antalFranFarger = fargerMedAntal.length > 0
      ? fargerMedAntal.reduce((s, f) => s + (parseInt(f.antal) || 0), 0)
      : null;
    const uttag = antalFranFarger !== null ? antalFranFarger : (parseInt(formAntal) || 0);
    const arPafyllning = formRiktning === 'pafyllning';
    const antal = redigeraProdukt
      ? (arPafyllning
          ? (redigeraProdukt.antal || 0) + uttag
          : Math.max(0, (redigeraProdukt.antal || 0) - uttag))
      : uttag;
    const minAntal = parseInt(formMinAntal) || 5;
    const genomfor = () => {
      const fargerUttag = formFarger.filter(f => f.farg.trim()).map(f => ({ farg: f.farg.trim(), langd: parseFloat(f.langd) || 0, antal: parseInt(f.antal) || 0 }));
      const langder = formLangder.filter(l => l.langd).map(l => ({ langd: parseFloat(l.langd) || 0, antal: parseInt(l.antal) || 0 }));
      let nyLista;
      if (redigeraProdukt) {
        // Uttag: subtrahera angivna färger från lagret. Påfyllning: addera
        // (befintlig färg räknas upp, ny färg läggs till som rad).
        let nyFarger = [...(redigeraProdukt.farger || [])];
        fargerUttag.forEach(u => {
          const idx = nyFarger.findIndex(f => f.farg === u.farg);
          if (arPafyllning) {
            if (idx >= 0) nyFarger[idx] = { ...nyFarger[idx], antal: (nyFarger[idx].antal || 0) + u.antal };
            else if (u.antal > 0) nyFarger.push(u);
          } else if (idx >= 0) {
            nyFarger[idx] = { ...nyFarger[idx], antal: Math.max(0, nyFarger[idx].antal - u.antal) };
          }
        });
        nyFarger = nyFarger.filter(f => f.antal > 0);
        const gammal = redigeraProdukt;
        const andringar = [];
        if (gammal.namn !== formNamn.trim()) andringar.push({ falt: 'Namn', fran: gammal.namn, till: formNamn.trim() });
        if ((gammal.artikel||'') !== formArtikel.trim()) andringar.push({ falt: 'Artikelnr', fran: gammal.artikel||'', till: formArtikel.trim() });
        if (uttag > 0) andringar.push({ falt: arPafyllning ? 'Påfyllning' : 'Uttag', fran: `${gammal.antal}${gammal.enhet||'st'}`, till: `${antal}${formEnhet} (${arPafyllning ? '+' : '-'}${uttag})` });
        if ((gammal.enhet||'st') !== formEnhet) andringar.push({ falt: 'Enhet', fran: gammal.enhet||'st', till: formEnhet });
        if (gammal.kategori !== formKategori.trim()) andringar.push({ falt: 'Kategori', fran: gammal.kategori, till: formKategori.trim() });
        if (gammal.minAntal !== minAntal) andringar.push({ falt: 'Varningsgräns', fran: String(gammal.minAntal), till: String(minAntal) });
        const uppdaterad = { ...redigeraProdukt, namn: formNamn.trim(), artikel: formArtikel.trim(), antal, kategori: formKategori.trim(), minAntal, enhet: formEnhet, bild: formBild, farger: nyFarger, langder };
        nyLista = produkter.map(p => p.id === redigeraProdukt.id ? uppdaterad : p);
        if (valdProdukt?.id === redigeraProdukt.id) setValdProdukt(uppdaterad);
        if (andringar.length > 0 && token) {
          fetch(`${API}/api/changes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ produktId: redigeraProdukt.id, produktNamn: formNamn.trim(), andringar }),
          }).catch(() => {});
        }
      } else {
        nyLista = [...produkter, {
          id: Date.now().toString(),
          namn: formNamn.trim(), artikel: formArtikel.trim(), antal,
          kategori: formKategori.trim(), minAntal, enhet: formEnhet,
          bild: formBild, farger: fargerUttag, langder,
        }];
      }
      setProdukter(nyLista);
      sparaProdukter(nyLista);
      setModalVisible(false);
    };
    if (redigeraProdukt) {
      if (Platform.OS === 'web') {
        if (window.confirm('Spara ändring?')) genomfor();
      } else {
        Alert.alert('Spara ändring?', '', [
          { text: 'Avbryt', style: 'cancel' },
          { text: 'Spara', onPress: genomfor },
        ]);
      }
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

  // Alla kunder (ASE60-projekt + manuellt tillagda) med sina glasmått, för export.
  const alleKunderMedMatt = [
    ...ase60Projekt.map(proj => ({
      id: proj.id, namn: proj.name,
      matt: proj.units?.map(u => ({ widthMm: u.widthMm, heightMm: u.heightMm, leaves: u.leaves })) || [],
    })),
    ...kunder.filter(k => !ase60Projekt.some(p => p.id === k.ase60ProjectId || p.id === k.id)).map(k => ({ id: k.id, namn: k.namn, matt: k.matt || [] })),
  ];

  const vaxlaKundExport = (id) => {
    setValdaKunderExport(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exporteraGlasmatt = async () => {
    try {
      const valda = alleKunderMedMatt
        .filter(k => valdaKunderExport.has(k.id))
        .slice()
        .sort((a, b) => a.namn.localeCompare(b.namn, 'sv'));
      const rader = [];
      valda.forEach(k => {
        (k.matt || []).forEach((m, i) => {
          rader.push({
            Kund: k.namn,
            Enhet: i + 1,
            'Bredd (mm)': m.widthMm,
            'Höjd (mm)': m.heightMm,
            Bågar: m.leaves || '',
          });
        });
      });
      if (rader.length === 0) { Alert.alert('Inget att exportera', 'Inga glasmått hittades för de valda kunderna.'); return; }
      const ws = utils.json_to_sheet(rader);
      ws['!cols'] = [{ wch: 30 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 8 }];
      const wb = utils.book_new();
      utils.book_append_sheet(wb, ws, 'Glasmått');
      const csv = write(wb, { type: 'string', bookType: 'csv' });
      const filePath = FileSystem.documentDirectory + 'glasmatt.csv';
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

  const filtreradeLista = (arRitning || arAse60 || arSimulering || arSammanstallning || arLagerforslag || arPlanering) ? [] : (() => {
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
        {(!mobil || visaSidebar) && <ScrollView style={[styles.sidebar, mobil && styles.sidebarMobil, { backgroundColor: c.sidebar, flexGrow: 0, flexShrink: 0 }]} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={true}>
          <Text style={[styles.sidebarTitel, { color: c.sidebarText }]}>Kategorier</Text>
          {FLIKAR.map(flik => (
            <TouchableOpacity
              key={flik}
              style={[styles.sidebarFlik, aktivFlik === flik && styles.sidebarFlikAktiv]}
              onPress={() => { setAktivFlik(flik); setSok(''); setValdProdukt(null); }}
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
          {ritningar.map(r => (
            <TouchableOpacity
              key={r.id}
              style={[styles.sidebarFlik, aktivFlik === r.id && styles.sidebarFlikAktiv]}
              onPress={() => { setAktivFlik(r.id); setSok(''); setValdProdukt(null); }}
            >
              <Text style={[styles.sidebarFlikText, aktivFlik === r.id && styles.sidebarFlikTextAktiv]}>
                📄 {r.label}
              </Text>
            </TouchableOpacity>
          ))}

          <View style={styles.sidebarDivider} />
          <Text style={styles.sidebarTitel}>Kunder</Text>
          <TouchableOpacity
            style={[styles.sidebarFlik, arKunder && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__kunder__'); setSok(''); setValdProdukt(null); setValdKund(null); setVisaSidebar(false); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arKunder && styles.sidebarFlikTextAktiv]}>
              👥 Kunder
            </Text>
            {kunder.length > 0 && (
              <View style={[styles.sidebarBadge, { backgroundColor: c.sidebarBadge }, arKunder && styles.sidebarBadgeAktiv]}>
                <Text style={[styles.sidebarBadgeText, { color: c.sidebarBadgeText }, arKunder && styles.sidebarBadgeTextAktiv]}>{kunder.length}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sidebarFlik, arBeredning && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__beredning__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); setValdKund(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arBeredning && styles.sidebarFlikTextAktiv]}>
              📝 Beredning
            </Text>
          </TouchableOpacity>

          <View style={styles.sidebarDivider} />
          <TouchableOpacity
            style={[styles.sidebarFlik, arStampling && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__stampling__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arStampling && styles.sidebarFlikTextAktiv]}>
              ⏱️ Stämpling
            </Text>
          </TouchableOpacity>

          <View style={styles.sidebarDivider} />
          <Text style={styles.sidebarTitel}>Alufräs bearbetning</Text>
          {/* Kundsöken börjar stängd varje gång man går in på fliken, precis som
              produktsöket (setSok('')) — annars låg en gammal träfflista och
              skymde generatorn när man kom tillbaka. */}
          <TouchableOpacity
            style={[styles.sidebarFlik, arAse60 && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__ase60__'); setSok(''); setSokAse60(''); setAse60SokOppen(false); setVisaSidebar(false); setValdProdukt(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arAse60 && styles.sidebarFlikTextAktiv]}>
              🪟 Generator
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sidebarFlik, arSimulering && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__simulering__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arSimulering && styles.sidebarFlikTextAktiv]}>
              🎬 Simulering
            </Text>
          </TouchableOpacity>

          <View style={styles.sidebarDivider} />
          <TouchableOpacity
            style={[styles.sidebarFlik, arPlanering && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__planering__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arPlanering && styles.sidebarFlikTextAktiv]}>
              📅 Planering
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sidebarFlik, arSammanstallning && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__sammanstallning__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arSammanstallning && styles.sidebarFlikTextAktiv]}>
              📊 Sammanställning
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sidebarFlik, arLagerforslag && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__lagerforslag__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arLagerforslag && styles.sidebarFlikTextAktiv]}>
              📦 Lagerförslag
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sidebarFlik, arOrdrar && styles.sidebarFlikAktiv]}
            onPress={() => { setAktivFlik('__ordrar__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); }}>
            <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, arOrdrar && styles.sidebarFlikTextAktiv]}>
              🧾 Ordrar
            </Text>
          </TouchableOpacity>

          {inloggad.roll === 'admin' && <>
            <View style={styles.sidebarDivider} />
            <TouchableOpacity
              style={[styles.sidebarFlik, aktivFlik === '__andringar__' && styles.sidebarFlikAktiv]}
              onPress={() => { setAktivFlik('__andringar__'); setSok(''); setVisaSidebar(false); setValdProdukt(null); }}>
              <Text style={[styles.sidebarFlikText, { color: c.sidebarText }, aktivFlik === '__andringar__' && styles.sidebarFlikTextAktiv]}>
                🕐 Ändringslogg
              </Text>
            </TouchableOpacity>
          </>}

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
        </ScrollView>}

        {/* Innehåll */}
        <View style={[styles.innehall, { backgroundColor: c.bg }]}>
          {valdProdukt && (
            <ProduktDetalj
              produkt={valdProdukt}
              inloggad={inloggad}
              onTillbaka={() => setValdProdukt(null)}
              onRedigera={() => oppnaRedigera(valdProdukt)}
            />
          )}

          {!valdProdukt && arAndringslogg && (
            <ScrollView style={{ flex: 1 }}>
              <Text style={[styles.kategoriRubrik, { color: c.textRubrik, marginBottom: 16 }]}>🕐 Ändringslogg</Text>
              {andringslogg.length === 0 && <Text style={{ color: c.textMuted, textAlign: 'center', marginTop: 40 }}>Inga ändringar loggade ännu.</Text>}
              {andringslogg.map(entry => (
                <View key={entry.id} style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 8 }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14 }}>{entry.produktNamn}</Text>
                    <Text style={{ color: c.textMuted, fontSize: 12 }}>{new Date(entry.tid).toLocaleString('sv-SE')}</Text>
                  </View>
                  <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 6 }}>Ändrad av: <Text style={{ color: c.text, fontWeight: '600' }}>{entry.user}</Text></Text>
                  {entry.andringar.map((a, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                      <Text style={{ color: c.textMuted, fontSize: 13, minWidth: 90 }}>{a.falt}:</Text>
                      <Text style={{ color: '#ef4444', fontSize: 13 }}>{a.fran}</Text>
                      <Text style={{ color: c.textMuted, fontSize: 13 }}>→</Text>
                      <Text style={{ color: '#16a34a', fontSize: 13, fontWeight: '600' }}>{a.till}</Text>
                    </View>
                  ))}
                  {entry.andringar.some(a => a.falt === 'Antal' || a.falt === 'Uttag' || a.falt === 'Påfyllning') && (
                    <TouchableOpacity
                      style={{ marginTop: 10, alignSelf: 'flex-start', backgroundColor: '#fef3c7', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 5 }}
                      onPress={() => {
                        const antalAndring = entry.andringar.find(a => a.falt === 'Antal' || a.falt === 'Uttag' || a.falt === 'Påfyllning');
                        if (!antalAndring) return;
                        const gammaltAntal = parseInt(antalAndring.fran) || 0;
                        const bekrafta = () => {
                          const nyLista = produkter.map(p => {
                            if (p.id !== entry.produktId && p.namn !== entry.produktNamn) return p;
                            return { ...p, antal: gammaltAntal };
                          });
                          setProdukter(nyLista);
                          sparaProdukter(nyLista);
                          const matchad = nyLista.find(p => p.id === entry.produktId || p.namn === entry.produktNamn);
                          if (matchad && valdProdukt?.namn === entry.produktNamn) setValdProdukt(matchad);
                          if (token && matchad) {
                            fetch(`${API}/api/changes`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                              body: JSON.stringify({
                                produktId: matchad.id,
                                produktNamn: entry.produktNamn,
                                andringar: [{ falt: 'Återställd', fran: antalAndring.till.split(' ')[0], till: antalAndring.fran }],
                              }),
                            }).then(() => {
                              fetch(`${API}/api/changes`, { headers: { Authorization: `Bearer ${token}` } })
                                .then(r => r.json()).then(setAndringslogg).catch(() => {});
                            }).catch(() => {});
                          }
                        };
                        if (Platform.OS === 'web') {
                          if (window.confirm(`Återställ ${entry.produktNamn} till ${antalAndring.fran}?`)) bekrafta();
                        } else {
                          Alert.alert('Ångra ändring', `Återställ ${entry.produktNamn} till ${antalAndring.fran}?`, [
                            { text: 'Avbryt', style: 'cancel' }, { text: 'Återställ', onPress: bekrafta }
                          ]);
                        }
                      }}>
                      <Text style={{ color: '#92400e', fontSize: 12, fontWeight: '600' }}>↩ Ångra</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </ScrollView>
          )}

          {!valdProdukt && arStampling && (
            <StamplingVy token={token} inloggad={inloggad} />
          )}

          {!valdProdukt && arKunder && (
            <ScrollView style={{ flex: 1 }}>
              {/* Kunddetaljvy */}
              {valdKund ? (
                <View style={{ flex: 1 }}>
                  <TouchableOpacity onPress={() => setValdKund(null)} style={{ marginBottom: 16 }}>
                    <Text style={{ color: '#2563eb', fontSize: 14 }}>← Tillbaka till kunder</Text>
                  </TouchableOpacity>
                  <Text style={[styles.kategoriRubrik, { color: c.textRubrik, marginBottom: 8 }]}>👤 {valdKund.namn}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                    <Text style={{ color: c.textMuted, fontSize: 11 }}>Paket:</Text>
                    {PAKET_OPTIONS.map(p => (
                      <TouchableOpacity key={p} onPress={() => uppdateraKund({ ...valdKund, paket: valdKund.paket === p ? null : p })}
                        style={{ paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6, borderWidth: 1,
                          backgroundColor: valdKund.paket === p ? '#2563eb' : c.input, borderColor: valdKund.paket === p ? '#2563eb' : c.inputBorder }}>
                        <Text style={{ color: valdKund.paket === p ? '#fff' : c.textMuted, fontSize: 11, fontWeight: '600' }}>{p}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {(valdKund.farg || valdKund.matt?.length > 0) && (
                    <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16, padding: 14 }]}>
                      <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>ASE60 PROJEKT</Text>
                      {valdKund.farg ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <View style={{ width: 16, height: 16, borderRadius: 3, backgroundColor: fargTillCSS(valdKund.farg), borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' }} />
                          <Text style={{ color: c.text, fontWeight: '600', fontSize: 14 }}>{valdKund.farg}</Text>
                        </View>
                      ) : null}
                      {valdKund.matt?.map((m, i) => (
                        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                          <Text style={{ color: c.textMuted, fontSize: 12 }}>Enhet {i + 1}:</Text>
                          <Text style={{ color: c.text, fontSize: 13, fontWeight: '500' }}>{m.widthMm} × {m.heightMm} mm</Text>
                          {m.leaves ? <Text style={{ color: c.textMuted, fontSize: 12 }}>· {m.leaves} båge{m.leaves === 1 ? '' : 'ar'}</Text> : null}
                        </View>
                      ))}
                    </View>
                  )}
                  {/* Underfliken */}
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
                    {KUND_FLIKAR.map(flik => {
                      const flikKlar = !!valdKund.klart?.[flik];
                      return (
                        <TouchableOpacity
                          key={flik}
                          onPress={() => { setAktivKundFlik(flik); setKundMaterialSok(''); }}
                          style={{ paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, borderWidth: 1,
                            backgroundColor: aktivKundFlik === flik ? '#2563eb' : (flikKlar ? '#dcfce7' : c.input),
                            borderColor: aktivKundFlik === flik ? '#2563eb' : (flikKlar ? '#16a34a' : c.inputBorder) }}>
                          <Text style={{ color: aktivKundFlik === flik ? '#fff' : (flikKlar ? '#15803d' : c.text), fontWeight: '600', fontSize: 14 }}>
                            {flik}{flikKlar ? ' ✓' : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  {(() => {
                    const flikKlart = valdKund.klart?.[aktivKundFlik];
                    const materialLista = valdKund.material?.[aktivKundFlik] || [];
                    const sokTraff = kundMaterialSok.trim()
                      ? produkter.filter(p =>
                          (p.namn.toLowerCase().includes(kundMaterialSok.toLowerCase()) ||
                           (p.artikel || '').toLowerCase().includes(kundMaterialSok.toLowerCase())) &&
                          !materialLista.some(m => m.produktId === p.id)
                        ).slice(0, 8)
                      : [];
                    return (
                      <View>
                        <KundAktivitet token={token} valdKund={valdKund} aktivKundFlik={aktivKundFlik} inloggad={inloggad} uppdateraKund={uppdateraKund} ecwRuns={ecwRuns} c={c} />
                        {aktivKundFlik === 'Träfräs' && (
                          <>
                            <BtlFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
                            <StepFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
                          </>
                        )}
                        {(aktivKundFlik === 'Alufräs' || aktivKundFlik === 'Beslag') && (
                          <PdfFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
                        )}
                        {aktivKundFlik === 'Alufräs' && (
                          <>
                            <AlufrasFlik ase60ProjectId={valdKund.ase60ProjectId || valdKund.id} token={token} API={API} c={c} roll={inloggad?.roll} />
                            {(() => {
                              const kundRuns = ecwRuns.filter(run =>
                                run.projekt?.toLowerCase() === valdKund.namn?.toLowerCase() ||
                                (run.comNo && run.comNo.toLowerCase() === valdKund.namn?.toLowerCase()));
                              if (kundRuns.length === 0) return null;
                              return (
                                <View style={{ marginBottom: 12 }}>
                                  <Text style={{ color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>ECW-KÖRNINGAR</Text>
                                  {kundRuns.map(run => (
                                    <View key={run.id} style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 8 }]}>
                                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                                        <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 14 }}>✅ {run.projekt}</Text>
                                        <Text style={{ color: c.textMuted, fontSize: 12 }}>{new Date(run.tid).toLocaleString('sv-SE')}</Text>
                                      </View>
                                      {!!run.comNo && run.comNo !== run.projekt && (
                                        <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 4 }}>Märkning: <Text style={{ color: c.text, fontWeight: '600' }}>{run.comNo}</Text></Text>
                                      )}
                                      {!!run.filnamn && (
                                        <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 4 }}>Fil: <Text style={{ color: c.text, fontWeight: '600' }}>{run.filnamn}</Text></Text>
                                      )}
                                      {(run.partier || []).map((p, i) => (
                                        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                                          <Text style={{ color: c.textMuted, fontSize: 13, minWidth: 34, fontWeight: '600' }}>{p.label}</Text>
                                          <Text style={{ color: c.text, fontSize: 13 }}>{p.breddMm} × {p.hoejdMm} mm</Text>
                                          <Text style={{ color: c.textMuted, fontSize: 12 }}>{p.baagar} bågar · {p.serie}-serien</Text>
                                        </View>
                                      ))}
                                    </View>
                                  ))}
                                </View>
                              );
                            })()}
                          </>
                        )}
                        {flikKlart && (
                          <View style={{ backgroundColor: '#dcfce7', borderColor: '#16a34a', borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 16 }}>
                            <Text style={{ color: '#15803d', fontWeight: '700', fontSize: 15 }}>✓ Klart — materialet är bortdraget från lagret</Text>
                            <Text style={{ color: '#166534', fontSize: 12, marginTop: 4 }}>
                              {new Date(flikKlart.tid).toLocaleString('sv-SE')}{flikKlart.av ? ` · av ${flikKlart.av}` : ''}
                            </Text>
                            <TouchableOpacity onPress={angraKundFlikKlart} style={{ marginTop: 10, alignSelf: 'flex-start', backgroundColor: '#fef3c7', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 5 }}>
                              <Text style={{ color: '#92400e', fontSize: 12, fontWeight: '600' }}>↩ Ångra klart (lägg tillbaka material)</Text>
                            </TouchableOpacity>
                          </View>
                        )}

                        {/* Materiallista */}
                        <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 12 }]}>
                          <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 15, marginBottom: 10 }}>Material — {aktivKundFlik}</Text>
                          {materialLista.length === 0 && (
                            <Text style={{ color: c.textMuted, fontSize: 13, marginBottom: 4 }}>Inget material tillagt ännu. Sök nedan för att lägga till från lagret.</Text>
                          )}
                          {materialLista.map(m => {
                            const p = produkter.find(x => x.id === m.produktId);
                            const saldo = p ? p.antal : null;
                            const antal = parseInt(m.antal) || 0;
                            const forLite = !flikKlart && saldo !== null && antal > saldo;
                            return (
                              <View key={m.produktId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.kortBorder }}>
                                <View style={{ flex: 1 }}>
                                  <Text style={{ color: c.text, fontWeight: '600', fontSize: 14 }}>{m.namn}</Text>
                                  <Text style={{ color: forLite ? '#ef4444' : c.textMuted, fontSize: 12 }}>
                                    {m.artikel || '—'}{saldo !== null ? ` · i lager: ${saldo}${m.enhet}` : ' · finns ej i lagret längre'}
                                    {forLite ? ' ⚠️ räcker inte' : ''}
                                  </Text>
                                </View>
                                {flikKlart ? (
                                  <Text style={{ color: c.text, fontWeight: '700', fontSize: 14 }}>{antal}{m.enhet}</Text>
                                ) : (
                                  <>
                                    <TextInput
                                      style={[styles.input, { width: 70, marginBottom: 0, textAlign: 'center', backgroundColor: c.input, borderColor: forLite ? '#ef4444' : c.inputBorder, color: c.inputText }]}
                                      keyboardType="numeric"
                                      value={String(m.antal)}
                                      onChangeText={t => andraKundMaterialAntal(m.produktId, t)} />
                                    <Text style={{ color: c.textMuted, fontSize: 13, width: 26 }}>{m.enhet}</Text>
                                    <TouchableOpacity onPress={() => taBortKundMaterial(m.produktId)} style={{ padding: 6 }}>
                                      <Text style={{ color: '#ef4444', fontSize: 16 }}>✕</Text>
                                    </TouchableOpacity>
                                  </>
                                )}
                              </View>
                            );
                          })}
                        </View>

                        {/* Lägg till material + Klart-knapp */}
                        {!flikKlart && (
                          <>
                            <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 12 }]}>
                              <TextInput
                                style={[styles.input, { marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                                placeholder="Sök produkt eller artikelnr för att lägga till..."
                                placeholderTextColor={c.textMuted}
                                value={kundMaterialSok}
                                onChangeText={setKundMaterialSok} />
                              {sokTraff.map(p => (
                                <TouchableOpacity key={p.id} onPress={() => laggTillKundMaterial(p)}
                                  style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: c.kortBorder }}>
                                  <View style={{ flex: 1 }}>
                                    <Text style={{ color: c.text, fontSize: 14 }}>{p.namn}</Text>
                                    <Text style={{ color: c.textMuted, fontSize: 12 }}>{p.artikel || '—'} · {p.kategori} · i lager: {p.antal}{p.enhet || 'st'}</Text>
                                  </View>
                                  <Text style={{ color: '#16a34a', fontWeight: '700', fontSize: 18 }}>+</Text>
                                </TouchableOpacity>
                              ))}
                              {kundMaterialSok.trim() !== '' && sokTraff.length === 0 && (
                                <Text style={{ color: c.textMuted, fontSize: 13, marginTop: 8 }}>Ingen träff.</Text>
                              )}
                            </View>
                            {(() => {
                              const harManuellt = materialLista.filter(m => (parseInt(m.antal) || 0) > 0).length > 0;
                              const arAlufras = aktivKundFlik === 'Alufräs';
                              const arGlas = aktivKundFlik === 'Glas';
                              const aktiv = harManuellt || arAlufras || arGlas;
                              return (
                                <TouchableOpacity
                                  onPress={oppnaKlartRuta}
                                  disabled={!aktiv}
                                  style={{ backgroundColor: aktiv ? '#16a34a' : '#9ca3af',
                                    borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginBottom: 24 }}>
                                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>
                                    ✓ Klart{arAlufras ? ' — hämta profiler & godkänn uttag' : arGlas ? ' — hämta glas & godkänn uttag' : ' — godkänn uttag från lagret'}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })()}
                          </>
                        )}
                      </View>
                    );
                  })()}
                </View>
              ) : (
                /* Kundlista */
                <View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <Text style={[styles.kategoriRubrik, { color: c.textRubrik }]}>👥 Kunder</Text>
                    {/* Nollställ projektväljaren när formuläret öppnas: valdAse60Projekt
                        och sokAse60 delas med ASE60-vyns kundsök, och en kund man tittat
                        på där ska inte dyka upp förvald i "Ny kund". */}
                    <TouchableOpacity
                      onPress={() => {
                        if (!visaLaggTillKund) { setValdAse60Projekt(null); setSokAse60(''); }
                        setVisaLaggTillKund(v => !v);
                      }}
                      style={{ backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
                      <Text style={{ color: '#fff', fontWeight: '700' }}>+ Lägg till kund</Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={[styles.input, { marginBottom: 12, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                    placeholder="🔍 Sök kund (namn, com-nr, färg, paket)..."
                    placeholderTextColor={c.textMuted}
                    value={kundSok} onChangeText={setKundSok}
                  />
                  {visaLaggTillKund && (
                    <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 16 }]}>
                      <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 15, marginBottom: 12 }}>Ny kund</Text>
                      <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 6 }}>Koppla ASE60-projekt (valfritt)</Text>
                      <TextInput
                        style={[styles.input, { marginBottom: 6, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                        placeholder="Sök projekt..." placeholderTextColor={c.textMuted}
                        value={sokAse60} onChangeText={setSokAse60}
                      />
                      {sokAse60.length > 0 && ase60Projekt
                        .filter(p => p.name.toLowerCase().includes(sokAse60.toLowerCase()) || (p.comNo || '').toLowerCase().includes(sokAse60.toLowerCase()))
                        .slice(0, 5)
                        .map(p => (
                          <TouchableOpacity
                            key={p.id}
                            onPress={() => { setValdAse60Projekt(p); setNyKundNamn(p.name); setSokAse60(''); }}
                            style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, marginBottom: 4,
                              backgroundColor: valdAse60Projekt?.id === p.id ? '#2563eb22' : c.input,
                              borderWidth: 1, borderColor: valdAse60Projekt?.id === p.id ? '#2563eb' : c.inputBorder }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: fargTillCSS(p.color), borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' }} />
                              <Text style={{ color: c.text, fontWeight: '600', flex: 1 }}>{p.name}</Text>
                              {p.comNo ? <Text style={{ color: c.textMuted, fontSize: 11 }}>{p.comNo}</Text> : null}
                            </View>
                            {p.units?.length > 0 && (
                              <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 2 }}>
                                {p.units.map(u => `${u.widthMm}×${u.heightMm}`).join(' · ')} mm{p.color ? ` · ${p.color}` : ''}
                              </Text>
                            )}
                          </TouchableOpacity>
                        ))
                      }
                      {valdAse60Projekt && (
                        <View style={{ marginTop: 4, marginBottom: 10, padding: 10, backgroundColor: '#2563eb11', borderRadius: 6, borderWidth: 1, borderColor: '#2563eb44' }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                            <Text style={{ color: '#2563eb', fontSize: 12, fontWeight: '700' }}>✓ ASE60:</Text>
                            <Text style={{ color: '#2563eb', fontSize: 12 }}>{valdAse60Projekt.name}</Text>
                            <TouchableOpacity onPress={() => { setValdAse60Projekt(null); setNyKundNamn(''); }} style={{ marginLeft: 'auto' }}>
                              <Text style={{ color: '#ef4444', fontSize: 13 }}>✕</Text>
                            </TouchableOpacity>
                          </View>
                          {valdAse60Projekt.color ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: fargTillCSS(valdAse60Projekt.color), borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' }} />
                              <Text style={{ color: c.textMuted, fontSize: 11 }}>{valdAse60Projekt.color}</Text>
                            </View>
                          ) : null}
                          {valdAse60Projekt.units?.map((u, i) => (
                            <Text key={i} style={{ color: c.textMuted, fontSize: 11 }}>Enhet {i + 1}: {u.widthMm} × {u.heightMm} mm · {u.leaves} båge{u.leaves === 1 ? '' : 'ar'}</Text>
                          ))}
                        </View>
                      )}
                      <TextInput
                        style={[styles.input, { marginBottom: 10, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                        placeholder="Kundnamn" placeholderTextColor={c.textMuted}
                        value={nyKundNamn} onChangeText={setNyKundNamn}
                        onSubmitEditing={laggTillKund}
                        autoFocus
                      />
                      <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 6 }}>Paket (styr system i Sammanställningen)</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                        {PAKET_OPTIONS.map(p => (
                          <TouchableOpacity key={p} onPress={() => setNyKundPaket(nyKundPaket === p ? null : p)}
                            style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1,
                              backgroundColor: nyKundPaket === p ? '#2563eb' : c.input, borderColor: nyKundPaket === p ? '#2563eb' : c.inputBorder }}>
                            <Text style={{ color: nyKundPaket === p ? '#fff' : c.text, fontSize: 12, fontWeight: '600' }}>{p}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TouchableOpacity onPress={laggTillKund} style={{ flex: 1, backgroundColor: '#16a34a', borderRadius: 8, paddingVertical: 10, alignItems: 'center' }}>
                          <Text style={{ color: '#fff', fontWeight: '700' }}>Spara</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => { setVisaLaggTillKund(false); setNyKundNamn(''); setNyKundPaket(null); setValdAse60Projekt(null); setSokAse60(''); }} style={{ padding: 10 }}>
                          <Text style={{ color: '#ef4444', fontSize: 18 }}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                  {alleKunderMedMatt.length > 0 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                      <Text style={{ color: c.textMuted, fontSize: 12 }}>
                        {valdaKunderExport.size > 0 ? `${valdaKunderExport.size} kund${valdaKunderExport.size === 1 ? '' : 'er'} vald${valdaKunderExport.size === 1 ? '' : 'a'}` : 'Kryssa i kunder för att exportera glasmått'}
                      </Text>
                      {valdaKunderExport.size > 0 && (
                        <>
                          <TouchableOpacity onPress={exporteraGlasmatt} style={{ backgroundColor: '#16a34a', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 }}>
                            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>📊 Exportera glasmått ({valdaKunderExport.size})</Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => setValdaKunderExport(new Set())} style={{ paddingHorizontal: 8, paddingVertical: 7 }}>
                            <Text style={{ color: c.textMuted, fontSize: 12 }}>Rensa val</Text>
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  )}
                  {ase60Projekt.length === 0 && kunder.length === 0 && !visaLaggTillKund && (
                    <View style={{ alignItems: 'center', marginTop: 60 }}>
                      <Text style={{ color: c.textMuted, fontSize: 15, marginBottom: 12 }}>Inga kunder eller ASE60-projekt hittades.</Text>
                      <TouchableOpacity onPress={laddaAse60Projekt} style={{ backgroundColor: c.input, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
                        <Text style={{ color: c.text }}>Ladda om</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  {/* ASE60-projekt visas direkt som kunder (sparad material/klart-status mergas in) */}
                  {ase60Projekt.filter(p => kundSokTraff(kundSok, p.name, p.comNo, p.color, p.paket,
                    kunder.find(k => k.id === p.id || k.ase60ProjectId === p.id)?.paket)).map(proj => {
                    const sparad = kunder.find(k => k.id === proj.id || k.ase60ProjectId === proj.id);
                    const klartAntal = sparad?.klart ? Object.keys(sparad.klart).length : 0;
                    return (
                      <TouchableOpacity
                        key={proj.id}
                        onPress={() => {
                          setValdKund(kundFranAse60Projekt(proj, sparad));
                          setAktivKundFlik(KUND_FLIKAR[0]);
                          setKundMaterialSok('');
                        }}
                        style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                        <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); vaxlaKundExport(proj.id); }}
                          style={{ width: 22, height: 22, borderRadius: 5, borderWidth: 2, marginRight: 12, alignItems: 'center', justifyContent: 'center',
                            backgroundColor: valdaKunderExport.has(proj.id) ? '#16a34a' : 'transparent', borderColor: valdaKunderExport.has(proj.id) ? '#16a34a' : c.inputBorder }}>
                          {valdaKunderExport.has(proj.id) && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>✓</Text>}
                        </TouchableOpacity>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 16 }}>👤 {proj.name}</Text>
                          {(sparad?.paket || proj.paket) ? (
                            <Text style={{ color: '#2563eb', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
                              {sparad?.paket || proj.paket}{paketTillSystem(sparad?.paket || proj.paket) ? ` · ${paketTillSystem(sparad?.paket || proj.paket)}` : ''}
                            </Text>
                          ) : null}
                          {proj.color ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
                              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: fargTillCSS(proj.color), borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' }} />
                              <Text style={{ color: c.textMuted, fontSize: 12 }}>{proj.color}</Text>
                            </View>
                          ) : null}
                          {proj.units?.length > 0 ? (
                            <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>
                              {proj.units.map(u => `${u.widthMm}×${u.heightMm} mm`).join(' · ')}
                            </Text>
                          ) : null}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                          {klartAntal > 0 && (
                            <Text style={{ color: '#15803d', fontSize: 12, fontWeight: '700' }}>✓ {klartAntal}/3</Text>
                          )}
                          <Text style={{ color: c.textMuted, fontSize: 13 }}>›</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                  {/* Kunder utan koppling till ett riktigt ase60-generator-projekt (ase60Projekt,
                      dess egen SQLite) — manuellt tillagda ELLER synkade från Uterum-Konfigurator
                      (ase60ProjectId pekar då på ett Konfigurator/Supabase-id, inte ett ase60Projekt-id,
                      så en enkel !k.ase60ProjectId-koll dolde tidigare alla Konfigurator-kunder). */}
                  {kunder.filter(k => !ase60Projekt.some(p => p.id === k.ase60ProjectId || p.id === k.id))
                    .filter(k => kundSokTraff(kundSok, k.namn, k.farg, k.paket)).map(kund => (
                    <TouchableOpacity
                      key={kund.id}
                      onPress={() => { setValdKund(kund); setAktivKundFlik(KUND_FLIKAR[0]); setKundMaterialSok(''); }}
                      style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                      <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); vaxlaKundExport(kund.id); }}
                        style={{ width: 22, height: 22, borderRadius: 5, borderWidth: 2, marginRight: 12, alignItems: 'center', justifyContent: 'center',
                          backgroundColor: valdaKunderExport.has(kund.id) ? '#16a34a' : 'transparent', borderColor: valdaKunderExport.has(kund.id) ? '#16a34a' : c.inputBorder }}>
                        {valdaKunderExport.has(kund.id) && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>✓</Text>}
                      </TouchableOpacity>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 16 }}>👤 {kund.namn}</Text>
                        {kund.paket ? (
                          <Text style={{ color: '#2563eb', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
                            {kund.paket}{paketTillSystem(kund.paket) ? ` · ${paketTillSystem(kund.paket)}` : ''}
                          </Text>
                        ) : null}
                        <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>Träfräs · Alufräs · Beslag · Glas</Text>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        {kund.klart && Object.keys(kund.klart).length > 0 && (
                          <Text style={{ color: '#15803d', fontSize: 12, fontWeight: '700' }}>✓ {Object.keys(kund.klart).length}/3</Text>
                        )}
                        <Text style={{ color: c.textMuted, fontSize: 13 }}>›</Text>
                        {inloggad.roll === 'admin' && (
                          <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); taBortKund(kund.id); }} style={{ padding: 6 }}>
                            <Text style={{ color: '#ef4444', fontSize: 16 }}>✕</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </ScrollView>
          )}

          {!valdProdukt && arRitning && !arAndringslogg && Platform.OS === 'web' && (() => {
            const ritning = ritningar.find(r => r.id === aktivFlik);
            return React.createElement('iframe', {
              key: ritning.id,
              src: `${API}/api/pdf/${ritning.fil}?token=${token}`,
              style: { width: '100%', height: '100%', border: 'none', borderRadius: 8 },
              title: ritning.label,
            });
          })()}

          {/* ASE60-generatorn är en egen app i en iframe. Ovanför den ligger en kundsök
              mot generatorns projektlista (/api/ase60-projekt), eftersom generatorn själv
              inte har någon sökning och listan blir oanvändbar när projekten blir många.
              Söket använder kundSokTraff — samma delsträngs-/skiftlägesregler som
              Kunder-vyn, så det känns likadant i hela appen. Träfflistan läggs som ett
              överlägg OVANPÅ iframen i stället för att ersätta den: iframen får aldrig
              avmonteras, för då tappar generatorn allt påbörjat arbete. */}
          {!valdProdukt && arAse60 && Platform.OS === 'web' && (
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <TextInput
                  style={[styles.input, { flex: 1, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                  placeholder="🔍 Sök kund (namn, com-nr, färg, paket)..."
                  placeholderTextColor={c.textMuted}
                  value={sokAse60}
                  onFocus={() => setAse60SokOppen(true)}
                  onChangeText={t => { setSokAse60(t); setAse60SokOppen(true); }}
                />
                {(ase60SokOppen || sokAse60.length > 0) && (
                  <TouchableOpacity
                    onPress={() => { setSokAse60(''); setAse60SokOppen(false); }}
                    style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.input }}>
                    <Text style={{ color: c.textMuted, fontSize: 13, fontWeight: '600' }}>✕ Stäng</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Vald kund. Adressen blir /ase60/<projekt>/ och tål omladdning, men
                  generatorn i iframen går inte att djuplänka in i — därför visar vi
                  projektets egna uppgifter här i stället för att styra iframen. */}
              {valdAse60Projekt && (
                <View style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 8, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 15 }}>👤 {valdAse60Projekt.name}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 3 }}>
                      {valdAse60Projekt.comNo ? <Text style={{ color: c.textMuted, fontSize: 12 }}>{valdAse60Projekt.comNo}</Text> : null}
                      {valdAse60Projekt.paket ? <Text style={{ color: '#2563eb', fontSize: 11, fontWeight: '700' }}>{valdAse60Projekt.paket}</Text> : null}
                      {valdAse60Projekt.color ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: fargTillCSS(valdAse60Projekt.color), borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' }} />
                          <Text style={{ color: c.textMuted, fontSize: 12 }}>{valdAse60Projekt.color}</Text>
                        </View>
                      ) : null}
                      {valdAse60Projekt.units?.length > 0 ? (
                        <Text style={{ color: c.textMuted, fontSize: 12 }}>
                          {valdAse60Projekt.units.map(u => `${u.widthMm}×${u.heightMm} mm`).join(' · ')}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <TouchableOpacity onPress={() => setValdAse60Projekt(null)} style={{ padding: 8 }}>
                    <Text style={{ color: c.textMuted, fontSize: 15 }}>✕</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={{ flex: 1 }}>
                {React.createElement('iframe', {
                  key: 'ase60',
                  src: ASE60_URL,
                  style: { width: '100%', height: '100%', border: 'none', borderRadius: 8 },
                  title: 'ASE60-generator',
                })}
                {ase60SokOppen && (
                  <ScrollView
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.bg }}
                    contentContainerStyle={{ paddingBottom: 20 }}>
                    {(() => {
                      if (ase60Projekt.length === 0) {
                        return (
                          <View style={{ alignItems: 'center', marginTop: 40 }}>
                            <Text style={{ color: c.textMuted, fontSize: 15, marginBottom: 12 }}>Inga ASE60-projekt hittades.</Text>
                            <TouchableOpacity onPress={laddaAse60Projekt} style={{ backgroundColor: c.input, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
                              <Text style={{ color: c.text }}>Ladda om</Text>
                            </TouchableOpacity>
                          </View>
                        );
                      }
                      // description matchas med: där ligger märkning/ordernummer när
                      // com-nr saknas i generatorns projekt.
                      const traffar = ase60Projekt.filter(p =>
                        kundSokTraff(sokAse60, p.name, p.comNo, p.color, p.paket, p.description));
                      if (traffar.length === 0) {
                        return (
                          <Text style={[styles.tomText, { color: c.textMuted }]}>
                            Ingen kund matchar "{sokAse60.trim()}".
                          </Text>
                        );
                      }
                      return traffar.map(proj => (
                        <TouchableOpacity
                          key={proj.id}
                          onPress={() => { setValdAse60Projekt(proj); setSokAse60(''); setAse60SokOppen(false); }}
                          style={[styles.kort, { backgroundColor: c.kort, borderColor: c.kortBorder, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
                            valdAse60Projekt?.id === proj.id && { borderColor: '#2563eb' }]}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: c.textRubrik, fontWeight: '700', fontSize: 16 }}>👤 {proj.name}</Text>
                            {proj.comNo ? <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>{proj.comNo}</Text> : null}
                            {proj.paket ? (
                              <Text style={{ color: '#2563eb', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
                                {proj.paket}{paketTillSystem(proj.paket) ? ` · ${paketTillSystem(proj.paket)}` : ''}
                              </Text>
                            ) : null}
                            {proj.color ? (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
                                <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: fargTillCSS(proj.color), borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' }} />
                                <Text style={{ color: c.textMuted, fontSize: 12 }}>{proj.color}</Text>
                              </View>
                            ) : null}
                            {proj.units?.length > 0 ? (
                              <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>
                                {proj.units.map(u => `${u.widthMm}×${u.heightMm} mm`).join(' · ')}
                              </Text>
                            ) : null}
                          </View>
                          <Text style={{ color: c.textMuted, fontSize: 13 }}>›</Text>
                        </TouchableOpacity>
                      ));
                    })()}
                  </ScrollView>
                )}
              </View>
            </View>
          )}

          {!valdProdukt && arSimulering && Platform.OS === 'web' && React.createElement('iframe', {
            key: 'simulering',
            src: SIMULERING_URL,
            style: { width: '100%', height: '100%', border: 'none', borderRadius: 8 },
            title: 'Alufräs simulering',
          })}

          {!valdProdukt && arPlanering && (
            <PlaneringVy kunder={kunder} ase60Projekt={ase60Projekt} token={token} c={c} mobil={mobil}
              onKundSparad={kundFranServer} onOppnaKund={oppnaKundkort} />
          )}

          {!valdProdukt && arBeredning && (
            <BeredningVy kunder={kunder} ase60Projekt={ase60Projekt} token={token} c={c} mobil={mobil} />
          )}

          {!valdProdukt && arSammanstallning && (
            <SammanstallningVy kunder={kunder} ase60Projekt={ase60Projekt} c={c} />
          )}

          {!valdProdukt && arLagerforslag && (
            <LagerforslagVy kunder={kunder} produkter={produkter} c={c} />
          )}

          {!valdProdukt && arOrdrar && (
            <OrdrarVy ordrar={ordrar} produkter={produkter} onLaggInOrder={laggInOrder} onImporteraOrdrar={importeraOrdrar} onTaBortOrder={taBortOrder} onRensaLogg={rensaLoggOrdrar} inloggad={inloggad} token={token} c={c} />
          )}

          {!valdProdukt && !arRitning && !arAndringslogg && !arKunder && !arStampling && !arAse60 && !arSimulering && !arSammanstallning && !arLagerforslag && !arOrdrar && !arPlanering && !arBeredning && <>
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
                    <TouchableOpacity style={[styles.kort, { backgroundColor: lavt ? c.varning : c.kort, borderColor: lavt ? c.varningBorder : c.kortBorder }]} onPress={() => setValdProdukt(item)} activeOpacity={0.8}>
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
                    </TouchableOpacity>
                );
                }
                return (
                  <TouchableOpacity style={[styles.rad, { backgroundColor: lavt ? c.varning : (index % 2 === 0 ? c.radJamn : c.rad), borderBottomColor: lavt ? c.varningBorder : c.kortBorder }]} onPress={() => setValdProdukt(item)} activeOpacity={0.7}>
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
                  </TouchableOpacity>
                );
              }}
            />
          </>
        </>}
        </View>
      </View>

      {/* Chat floating panel */}
      {visaChat && <ChatPanel user={inloggad} onStang={() => setVisaChat(false)} meddelanden={meddelanden} online={onlineUsers} wsRef={wsRef} onRing={ringUpp} samtalAktivt={!!samtal} />}
      {!visaChat && <ChatBubble senasteMeddelande={chatBubble} antal={olastaAntal} onPress={() => setVisaChat(true)} />}

      {/* Samtal */}
      {samtal && <SamtalOverlay samtal={samtal} onSvara={svaraSamtal} onAvvisa={avvisaSamtal} onLaggPa={laggPaSamtal} onMute={toggleMikrofon} />}
      <SamtalToast text={samtalInfo} />

      {visaProfil && <ProfilModal user={inloggad} token={token} onStang={() => setVisaProfil(false)} onUppdatera={(u) => setInloggad(u)} prenumereraPush={prenumereraPush} />}
      {visaAnvandare && <AnvandarHantering token={token} onStang={() => setVisaAnvandare(false)} />}

      {/* Klart-godkännanderuta: visar all input innan något dras från lagret */}
      <Modal visible={!!klartRuta} animationType="fade" transparent onRequestClose={() => setKlartRuta(null)}>
        <View style={styles.modalBakgrund}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 }}>
            <View style={[styles.modalKort, { backgroundColor: c.modal, width: '100%', maxWidth: 560 }]}>
              <Text style={[styles.modalTitel, { color: c.textRubrik }]}>✓ Klart — {aktivKundFlik} · {valdKund?.namn}</Text>

              {klartRuta?.serier?.length > 0 && (
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
                  {klartRuta.serier.map(s => (
                    <View key={s} style={{ backgroundColor: '#2563eb22', borderColor: '#2563eb', borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 3 }}>
                      <Text style={{ color: '#2563eb', fontSize: 12, fontWeight: '700' }}>Serie {s}</Text>
                    </View>
                  ))}
                </View>
              )}

              {klartRuta?.laddar && (
                <Text style={{ color: c.textMuted, fontSize: 14, marginVertical: 16, textAlign: 'center' }}>Hämtar profiloptimering från ASE60...</Text>
              )}
              {!!klartRuta?.fel && (
                <View style={{ backgroundColor: '#fef2f2', borderColor: '#ef4444', borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  <Text style={{ color: '#b91c1c', fontSize: 13 }}>{klartRuta.fel}</Text>
                </View>
              )}

              {!klartRuta?.laddar && (klartRuta?.rader || []).length === 0 && !klartRuta?.fel && (
                <Text style={{ color: c.textMuted, fontSize: 14, marginVertical: 12, textAlign: 'center' }}>Inget material att dra av.</Text>
              )}

              {!klartRuta?.laddar && (klartRuta?.rader || []).map((rad, i) => {
                const p = rad.produktId ? produkter.find(x => x.id === rad.produktId) : null;
                const antal = parseInt(rad.antal) || 0;
                const saknas = !rad.produktId;
                const forLite = p && antal > p.antal;
                return (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: c.kortBorder }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.text, fontWeight: '600', fontSize: 14 }}>
                        {rad.typ === 'profil' ? '🔩 ' : ''}{rad.namn}
                      </Text>
                      <Text style={{ color: saknas ? '#ef4444' : (forLite ? '#ef4444' : c.textMuted), fontSize: 12 }}>
                        {rad.artikel || '—'}
                        {rad.langdMm ? ` · ${rad.langdMm} mm` : ''}
                        {p ? ` · i lager: ${p.antal}${p.enhet || 'st'}` : ''}
                        {saknas ? ' · ⚠️ finns ej i lagret — dras ej' : (forLite ? ' · ⚠️ räcker inte' : '')}
                      </Text>
                    </View>
                    <TextInput
                      style={[styles.input, { width: 64, marginBottom: 0, textAlign: 'center', backgroundColor: c.input, borderColor: (saknas || forLite) ? '#ef4444' : c.inputBorder, color: c.inputText }]}
                      keyboardType="numeric"
                      value={String(rad.antal)}
                      onChangeText={t => andraKlartRad(i, t)} />
                    <Text style={{ color: c.textMuted, fontSize: 13, width: 24 }}>{rad.enhet || 'st'}</Text>
                    <TouchableOpacity onPress={() => taBortKlartRad(i)} style={{ padding: 5 }}>
                      <Text style={{ color: '#ef4444', fontSize: 16 }}>✕</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
                <TouchableOpacity onPress={() => setKlartRuta(null)} style={{ flex: 1, backgroundColor: c.input, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 8, paddingVertical: 12, alignItems: 'center' }}>
                  <Text style={{ color: c.text, fontWeight: '600' }}>Avbryt</Text>
                </TouchableOpacity>
                {(() => {
                  const giltiga = (klartRuta?.rader || []).filter(r => r.produktId && (parseInt(r.antal) || 0) > 0);
                  const aktiv = !klartRuta?.laddar && giltiga.length > 0;
                  return (
                    <TouchableOpacity
                      onPress={godkannKlart}
                      disabled={!aktiv}
                      style={{ flex: 2, backgroundColor: aktiv ? '#16a34a' : '#9ca3af', borderRadius: 8, paddingVertical: 12, alignItems: 'center' }}>
                      <Text style={{ color: '#fff', fontWeight: '700' }}>✓ Godkänn — dra {giltiga.length} rad{giltiga.length === 1 ? '' : 'er'} från lagret</Text>
                    </TouchableOpacity>
                  );
                })()}
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Produkt modal */}
      <Modal visible={modalVisible} animationType="fade" transparent>
        <View style={styles.modalBakgrund}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 }}>
          <View style={[styles.modalKort, { backgroundColor: c.modal, width: '100%', maxWidth: 480 }]}>
            <Text style={[styles.modalTitel, { color: c.textRubrik }]}>{redigeraProdukt ? (formRiktning === 'pafyllning' ? 'Registrera påfyllning' : 'Registrera uttag') : 'Ny produkt'}</Text>
            {redigeraProdukt && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                {[{ id: 'uttag', label: '➖ Uttag' }, { id: 'pafyllning', label: '➕ Påfyllning' }].map(r => (
                  <TouchableOpacity key={r.id} onPress={() => setFormRiktning(r.id)}
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, alignItems: 'center',
                      backgroundColor: formRiktning === r.id ? (r.id === 'uttag' ? '#dc2626' : '#16a34a') : c.input,
                      borderColor: formRiktning === r.id ? (r.id === 'uttag' ? '#dc2626' : '#16a34a') : c.inputBorder }}>
                    <Text style={{ color: formRiktning === r.id ? '#fff' : c.text, fontWeight: '700', fontSize: 14 }}>{r.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <TextInput style={[styles.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Produktnamn *" placeholderTextColor={c.textMuted}
              value={formNamn} onChangeText={setFormNamn} />
            <TextInput style={[styles.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Artikelnummer" placeholderTextColor={c.textMuted}
              value={formArtikel} onChangeText={setFormArtikel} />

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

            <Text style={[styles.inputLabel, { color: c.textMuted }]}>{redigeraProdukt ? (formRiktning === 'pafyllning' ? `Antal att fylla på (i lager nu: ${redigeraProdukt.antal ?? 0}${redigeraProdukt.enhet || 'st'})` : `Antal att ta ut (i lager nu: ${redigeraProdukt.antal ?? 0}${redigeraProdukt.enhet || 'st'})`) : 'Antal i lager'}</Text>
            {(() => {
              const fargSumma = formFarger.filter(f => f.farg.trim() && parseInt(f.antal) > 0).reduce((s, f) => s + (parseInt(f.antal) || 0), 0);
              const harFargAntal = formFarger.some(f => f.farg.trim() && parseInt(f.antal) > 0);
              return (
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                  {harFargAntal
                    ? <View style={[styles.input, { flex: 1, marginBottom: 0, backgroundColor: c.tabellHuvud, borderColor: c.inputBorder, justifyContent: 'center' }]}>
                        <Text style={{ color: c.textMuted, fontSize: 15 }}>
                          {fargSumma} <Text style={{ fontSize: 12 }}>(summa färger)</Text>
                        </Text>
                      </View>
                    : <TextInput style={[styles.input, { flex: 1, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Antal" placeholderTextColor={c.textMuted}
                        value={formAntal} onChangeText={setFormAntal} keyboardType="numeric" />
                  }
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
              );
            })()}

            {inloggad.roll === 'admin' && (
              <TextInput style={[styles.input, { backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]} placeholder="Varning vid antal (standard 5)" placeholderTextColor={c.textMuted}
                value={formMinAntal} onChangeText={setFormMinAntal} keyboardType="numeric" />
            )}

            {/* Bild */}
            <Text style={[styles.inputLabel, { color: c.textMuted, marginTop: 4 }]}>Produktbild</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {formBild
                ? <Image source={{ uri: formBild }} style={{ width: 80, height: 60, borderRadius: 6, borderWidth: 1, borderColor: c.kortBorder }} resizeMode="cover" />
                : <View style={{ width: 80, height: 60, borderRadius: 6, backgroundColor: c.input, borderWidth: 1, borderColor: c.kortBorder, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={{ fontSize: 22 }}>📦</Text>
                  </View>
              }
              <TouchableOpacity style={[styles.kategoriKnapp, { backgroundColor: c.input }]} onPress={vaeljBild}>
                <Text style={{ color: c.text, fontSize: 13 }}>📷 Välj bild</Text>
              </TouchableOpacity>
              {formBild && <TouchableOpacity onPress={() => setFormBild(null)}><Text style={{ color: '#ef4444' }}>✕ Ta bort</Text></TouchableOpacity>}
            </View>

            {/* Färger */}
            <View style={{ marginBottom: 14 }}>
              <Text style={[styles.inputLabel, { color: c.textMuted }]}>Färger</Text>
              {/* Förinställda färgknappar */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {FORINSTALLDA_FARGER.map(farg => {
                  const finns = formFarger.some(f => f.farg === farg);
                  return (
                    <TouchableOpacity key={farg}
                      style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1,
                        backgroundColor: finns ? '#2563eb' : c.input,
                        borderColor: finns ? '#2563eb' : c.inputBorder }}
                      onPress={() => {
                        if (finns) {
                          setFormFarger(prev => prev.filter(f => f.farg !== farg));
                        } else {
                          setFormFarger(prev => [...prev, { farg, langd: '', antal: '' }]);
                        }
                      }}>
                      <Text style={{ color: finns ? '#fff' : c.textMuted, fontSize: 12 }}>{farg}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {/* Färgrader: Färg | Längd (m) | Antal st | × */}
              {formFarger.map((f, i) => (
                <View key={i} style={{ marginBottom: 8 }}>
                  <TextInput style={[styles.input, { marginBottom: 4, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                    placeholder="Färg" placeholderTextColor={c.textMuted}
                    value={f.farg} onChangeText={v => setFormFarger(prev => prev.map((x, j) => j === i ? { ...x, farg: v } : x))} />
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <TextInput style={[styles.input, { flex: 1, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                      placeholder="Längd (m)" placeholderTextColor={c.textMuted} keyboardType="numeric"
                      value={f.langd} onChangeText={v => setFormFarger(prev => prev.map((x, j) => j === i ? { ...x, langd: v } : x))} />
                    <TextInput style={[styles.input, { flex: 1, marginBottom: 0, backgroundColor: c.input, borderColor: c.inputBorder, color: c.inputText }]}
                      placeholder="Antal st" placeholderTextColor={c.textMuted} keyboardType="numeric"
                      value={f.antal} onChangeText={v => setFormFarger(prev => prev.map((x, j) => j === i ? { ...x, antal: v } : x))} />
                    <TouchableOpacity onPress={() => setFormFarger(prev => prev.filter((_, j) => j !== i))}>
                      <Text style={{ color: '#ef4444', fontSize: 18, paddingHorizontal: 4 }}>✕</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              <TouchableOpacity style={[styles.kategoriKnapp, { backgroundColor: c.input, alignSelf: 'flex-start' }]}
                onPress={() => setFormFarger(prev => [...prev, { farg: '', langd: '', antal: '' }])}>
                <Text style={{ color: '#2563eb', fontWeight: '600' }}>+ Lägg till färg</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.modalKnappar}>
              <TouchableOpacity style={[styles.avbrytKnapp, { backgroundColor: c.input }]} onPress={() => setModalVisible(false)}>
                <Text style={[styles.avbrytText, { color: c.textMuted }]}>Avbryt</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.sparaKnapp} onPress={sparaProdukt}>
                <Text style={styles.sparaText}>Spara</Text>
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
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
