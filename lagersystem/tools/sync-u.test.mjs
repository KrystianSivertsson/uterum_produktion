// node --test tools/sync-u.test.mjs
// U-synken: nyaste versionen per dokument i kundmappen, äldre versioner av
// synkens egna filer bort när den nya ligger på plats (Krystian 2026-09-29).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mappNamn, dokNyckel, nyastePerDokument, gamlaVersioner, NEST_TOLERANS_MS } from './sync-u.mjs';

const ECW = { slug: 'ecw-filer', andelse: '.ECW' };
const BTL = { slug: 'btl-filer', andelse: '.btl' };
const PDF = { slug: 'pdf-filer', andelse: '.pdf' };
const post = (typ, filename, skapad) => ({ typ, f: { filename, skapad }, projektId: 'p' });

test('dokNyckel: versioner och varianter av samma dokument ger samma nyckel', () => {
  const m = 'Miranda Jensen';
  assert.equal(dokNyckel('487850A_ASE60_2_track_outer_frame.ECW', ECW, m), dokNyckel('487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', ECW, m));
  assert.equal(dokNyckel('2d-vyer-2026-08-17T14-56-01.pdf', PDF, m), dokNyckel('2d-vyer-2026-09-29T17-33-08.pdf', PDF, m));
  assert.equal(dokNyckel('uterum-takstolar-2026-08-17T14-56-01.btl', BTL, m), dokNyckel('uterum-takstolar-2026-09-29T17-33-08.btl', BTL, m));
  for (const n of ['Miranda Jensen', 'Miranda Jensen.html', 'Miranda Jensen v2.html', 'Miranda_Jensen_FLIP_SAW.html', 'Miranda Jensen_FLIP_SAW.pdf']) {
    assert.equal(dokNyckel(n, PDF, m), 'pdf-filer:{kund}', n);
  }
  // Olika profiler/dokument hålls isär.
  assert.notEqual(dokNyckel('487850A_ASE60_2_track_outer_frame.ECW', ECW, m), dokNyckel('517340A_ASE60_DLE82_sash_leaf_profile_ny_innerprofil.ECW', ECW, m));
  assert.notEqual(dokNyckel('2d-vyer-2026-09-29T17-33-08.pdf', PDF, m), dokNyckel('glasberedning-2026-09-29T17-33-12.pdf', PDF, m));
  assert.equal(mappNamn('Miranda Jensen v2'), 'Miranda Jensen');
});

test('Miranda Jensen: två kundkort, flera körningar → bara nyaste per dokument', () => {
  const poster = [
    post(ECW, '487850A_ASE60_2_track_outer_frame.ECW', '2026-08-17T14:56:01Z'),
    post(ECW, '487850A_ASE60_2_track_outer_frame.ECW', '2026-09-29T14:09:51Z'),
    post(ECW, '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', '2026-09-29T17:33:12Z'),
    post(PDF, 'Miranda Jensen v2.html', '2026-08-17T14:56:02Z'),
    post(PDF, 'Miranda Jensen.html', '2026-09-29T14:09:52Z'),
    post(PDF, 'Miranda_Jensen_FLIP_SAW.html', '2026-09-29T17:14:51Z'),
    post(PDF, 'Miranda Jensen_FLIP_SAW.html', '2026-09-29T17:33:12Z'),
    post(PDF, '2d-vyer-2026-08-17T14-56-01.pdf', '2026-08-17T14:56:01Z'),
    post(PDF, '2d-vyer-2026-09-29T17-33-08.pdf', '2026-09-29T17:33:08Z'),
  ];
  const akt = nyastePerDokument(poster, 'Miranda Jensen');
  assert.deepEqual([...akt.values()].map((a) => a.namn).sort(), [
    '2d-vyer-2026-09-29T17-33-08.pdf', '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', 'Miranda Jensen_FLIP_SAW.html',
  ]);
  const historik = new Set(poster.map((p) => p.f.filename.replace(/\.html?$/i, '.pdf').toLowerCase()));
  const lokala = [
    '487850A_ASE60_2_track_outer_frame.ECW', '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW',
    'Miranda Jensen v2.pdf', 'Miranda Jensen.pdf', 'Miranda_Jensen_FLIP_SAW.pdf', 'Miranda Jensen_FLIP_SAW.pdf',
    '2d-vyer-2026-08-17T14-56-01.pdf', '2d-vyer-2026-09-29T17-32-54.pdf', '2d-vyer-2026-09-29T17-33-08.pdf',
    'Mina anteckningar.pdf', 'offert-kund.pdf',
  ];
  const bort = gamlaVersioner(lokala, akt, historik, 'Miranda Jensen').map((x) => x.namn).sort();
  assert.deepEqual(bort, [
    '2d-vyer-2026-08-17T14-56-01.pdf', '2d-vyer-2026-09-29T17-32-54.pdf',
    '487850A_ASE60_2_track_outer_frame.ECW',
    'Miranda Jensen v2.pdf', 'Miranda Jensen.pdf', 'Miranda_Jensen_FLIP_SAW.pdf',
  ]);
});

test('gamlaVersioner: handplacerade filer och saknad ny fil rörs aldrig', () => {
  const akt = nyastePerDokument([post(PDF, 'glasberedning-2026-09-29T17-33-12.pdf', '2026-09-29T17:33:12Z')], 'Kund');
  // Ny fil finns inte i mappen än → inget tas bort.
  assert.deepEqual(gamlaVersioner(['glasberedning-2026-08-01T10-00-00.pdf'], akt, new Set(), 'Kund'), []);
  // Handplacerad fil utan tidsstämpel och utanför lagrets historik → rörs inte.
  const akt2 = nyastePerDokument([post(ECW, '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', '2026-09-29T17:33:12Z')], 'Kund');
  assert.deepEqual(gamlaVersioner(['487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', '487850A_ASE60_2_track_outer_frame.ECW'], akt2, new Set(), 'Kund'), []);
});

test('varianter: en fil med sågkap (_SAW) ersätts aldrig av en nyare utan', () => {
  const akt = nyastePerDokument([
    post(ECW, '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', '2026-09-29T17:33:12Z'),
    post(ECW, '487850A_ASE60_2_track_outer_frame.ECW', '2026-09-30T08:00:00Z'),
  ], 'Kund');
  const a = [...akt.values()][0];
  assert.deepEqual(a.behall.map((b) => b.namn), ['487850A_ASE60_2_track_outer_frame.ECW', '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW']);
  const hist = new Set(['487850a_ase60_2_track_outer_frame.ecw', '487850a_ase60_2_track_outer_frame_flip_saw.ecw']);
  assert.deepEqual(gamlaVersioner(['487850A_ASE60_2_track_outer_frame.ECW', '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW'], akt, hist, 'Kund'), []);
});

test('öppen fil (~$-låsfil från eluCad), ofärsk ny fil och handredigerad fil rörs inte', () => {
  const akt = nyastePerDokument([
    post(ECW, '487850A_ASE60_2_track_outer_frame.ECW', '2026-09-29T14:09:51Z'),
    post(ECW, '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', '2026-09-29T17:33:12Z'),
  ], 'Kund');
  const hist = new Set(['487850a_ase60_2_track_outer_frame.ecw', '487850a_ase60_2_track_outer_frame_flip_saw.ecw']);
  const lok = ['487850A_ASE60_2_track_outer_frame.ECW', '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW'];
  assert.equal(gamlaVersioner(lok, akt, hist, 'Kund').length, 1);
  assert.deepEqual(gamlaVersioner([...lok, '~$487850A_ASE60_2_track_outer_frame.ECW'], akt, hist, 'Kund'), []);
  assert.deepEqual(gamlaVersioner(lok, akt, hist, 'Kund', { ofarsk: () => true }), []);
  const mf = { has: () => true };
  assert.deepEqual(gamlaVersioner(lok, akt, hist, 'Kund', { manifest: mf, andrad: () => true }), []);
  assert.equal(gamlaVersioner(lok, akt, hist, 'Kund', { manifest: mf, andrad: () => false }).length, 1);
});

test('dokNyckel: kundprefix med ordernummer/v2 och nästad karm (_NEST) som eget dokument', () => {
  assert.equal(dokNyckel('1054209_Fredrik_Eriksson_v2_ASS32.ECW', ECW, 'Fredrik Eriksson'), dokNyckel('Fredrik_Eriksson_ASS32.ECW', ECW, 'Fredrik Eriksson'));
  assert.equal(dokNyckel('Miranda Jensen P1.pdf', PDF, 'Miranda Jensen'), 'pdf-filer:{kund} p1');
  const vanlig = dokNyckel('487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', ECW, 'K');
  const nest = dokNyckel('487850A_ASE60_2_track_outer_frame_NEST_FLIP_SAW.ECW', ECW, 'K');
  assert.notEqual(vanlig, nest);
  assert.equal(nest, dokNyckel('487850A_ASE60_2_track_outer_frame_NEST.ECW', ECW, 'K'));
});

// Generatorns outerFrameNest 'extra' (Krystian 2026-09-29, B1/B2): AKTIVERA ger
// BÅDE den vanliga ytterkarmen och den nästade (_NEST före variantsuffixen).
// NEST får aldrig in i VARIANT-regexen så länge filen är 'extra' — då delar
// filerna nyckel och synken raderar den ena ur U:\kund.
test('NEST (extra): vanlig och nästad ytterkarm behålls båda; NEST-nyckeln stabil över _FLIP/_SAW', () => {
  const NEST_NYCKEL = 'ecw-filer:487850a ase60 2 track outer frame nest';
  for (const v of ['', '_FLIP', '_SAW', '_FLIP_SAW', '_REF_FLIP_SAW_FR']) {
    assert.equal(dokNyckel(`487850A_ASE60_2_track_outer_frame_NEST${v}.ECW`, ECW, 'Miranda Jensen'), NEST_NYCKEL, v);
  }
  assert.equal(dokNyckel('487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW', ECW, 'Miranda Jensen'), 'ecw-filer:487850a ase60 2 track outer frame');

  const vanlig = '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW';
  const nest = '487850A_ASE60_2_track_outer_frame_NEST_FLIP_SAW.ECW';
  const hist = new Set([vanlig, nest].map((x) => x.toLowerCase()));
  // Samma export pushar båda — oavsett vilken som är nyast finns båda kvar.
  for (const [tv, tn] of [['2026-09-29T20:00:00Z', '2026-09-29T20:00:01Z'], ['2026-09-29T20:00:01Z', '2026-09-29T20:00:00Z']]) {
    const akt = nyastePerDokument([post(ECW, vanlig, tv), post(ECW, nest, tn)], 'Miranda Jensen');
    assert.deepEqual([...akt.values()].map((a) => a.namn).sort(), [vanlig, nest].sort());
    assert.deepEqual(gamlaVersioner([vanlig, nest], akt, hist, 'Miranda Jensen'), []);
  }

  // Egen livscykel: en äldre NEST-variant ersätts av den nya NEST-filen, den
  // vanliga karmen rörs inte (och tvärtom).
  const gammalNest = '487850A_ASE60_2_track_outer_frame_NEST_SAW.ECW';
  const gammalVanlig = '487850A_ASE60_2_track_outer_frame_SAW.ECW';
  const akt = nyastePerDokument([
    post(ECW, gammalNest, '2026-09-28T10:00:00Z'), post(ECW, gammalVanlig, '2026-09-28T10:00:00Z'),
    post(ECW, vanlig, '2026-09-29T20:00:00Z'), post(ECW, nest, '2026-09-29T20:00:00Z'),
  ], 'Miranda Jensen');
  const hist2 = new Set([vanlig, nest, gammalNest, gammalVanlig].map((x) => x.toLowerCase()));
  const bort = gamlaVersioner([vanlig, nest, gammalNest, gammalVanlig], akt, hist2, 'Miranda Jensen');
  assert.deepEqual(bort.map((b) => [b.namn, b.ersattAv]).sort(), [
    [gammalNest, nest],
    [gammalVanlig, vanlig],
  ].sort());
});

// Granskning 2026-09-29: en senare export utan NEST (klämvarning/X-gräns/utan
// sågkap) får inte lämna den gamla NEST-filen (gamla mått) bredvid den nya
// vanliga filen i U:\kund.
test('NEST inaktuell: vanlig fil från en senare export → NEST hämtas inte och tas bort ur mappen', () => {
  const vanlig = '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW';
  const nest = '487850A_ASE60_2_track_outer_frame_NEST_FLIP_SAW.ECW';
  const hist = new Set([vanlig, nest].map((x) => x.toLowerCase()));
  // AKTIVERA 1 (3442) gav båda; AKTIVERA 2 (3150) gav bara den vanliga (lagret har
  // en post per filnamn → vanlig = ny, NEST = gammal).
  const akt = nyastePerDokument([post(ECW, vanlig, '2026-09-29T21:00:00Z'), post(ECW, nest, '2026-09-29T20:00:00Z')], 'Miranda Jensen');
  assert.deepEqual([...akt.values()].map((a) => a.namn), [vanlig]);
  assert.deepEqual(gamlaVersioner([vanlig, nest], akt, hist, 'Miranda Jensen'), [{ namn: nest, ersattAv: vanlig }]);
  // Samma skydd som andra versioner: ny vanlig fil ej färsk, NEST öppen i eluCad,
  // eller handredigerad → rörs inte.
  assert.deepEqual(gamlaVersioner([vanlig, nest], akt, hist, 'Miranda Jensen', { ofarsk: () => true }), []);
  assert.deepEqual(gamlaVersioner([vanlig, nest, `~$${nest}`], akt, hist, 'Miranda Jensen'), []);
  assert.deepEqual(gamlaVersioner([vanlig, nest], akt, hist, 'Miranda Jensen', { manifest: { has: () => true }, andrad: () => true }), []);
  // Inom toleransen (samma export, pushade sekunder isär) behålls båda.
  const t0 = Date.parse('2026-09-29T20:00:00Z');
  const samma = nyastePerDokument([
    post(ECW, vanlig, new Date(t0 + NEST_TOLERANS_MS - 1000).toISOString()), post(ECW, nest, new Date(t0).toISOString()),
  ], 'Miranda Jensen');
  assert.deepEqual([...samma.values()].map((a) => a.namn).sort(), [vanlig, nest].sort());
});

test('NEST struken ur lagret: synkens egen NEST-fil tas bort, en handplacerad rörs inte', () => {
  const vanlig = '487850A_ASE60_2_track_outer_frame_FLIP_SAW.ECW';
  const nest = '487850A_ASE60_2_track_outer_frame_NEST_FLIP_SAW.ECW';
  const akt = nyastePerDokument([post(ECW, vanlig, '2026-09-29T21:00:00Z')], 'Kund');
  // Synken skrev NEST-filen (manifestet, oförändrad) → bort.
  assert.deepEqual(gamlaVersioner([vanlig, nest], akt, new Set([vanlig.toLowerCase()]), 'Kund', {
    manifest: { has: (n) => n === nest.toLowerCase() }, andrad: () => false,
  }), [{ namn: nest, ersattAv: vanlig }]);
  // Varken i manifestet eller lagrets historik → handplacerad, rörs inte.
  assert.deepEqual(gamlaVersioner([vanlig, nest], akt, new Set([vanlig.toLowerCase()]), 'Kund'), []);
});
