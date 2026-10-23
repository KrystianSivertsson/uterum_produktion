// node --test tools/auf-auto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projektFor, arEgenAuf } from './auf-auto.mjs';

const ecwTyp = { slug: 'ecw-filer' }, pdfTyp = { slug: 'pdf-filer' };

test('projektFor: kortet som har ECW:n (nyaste), annars mappens nyaste kort', () => {
  const poster = [
    { typ: ecwTyp, f: { filename: '133720A_ASS32.ECW', skapad: '2026-10-12T08:00:00Z' }, projektId: 'gammal' },
    { typ: ecwTyp, f: { filename: '133720A_ASS32.ECW', skapad: '2026-10-21T08:00:00Z' }, projektId: 'v2' },
    { typ: pdfTyp, f: { filename: 'ritning.pdf', skapad: '2026-10-22T08:00:00Z' }, projektId: 'v3' },
  ];
  assert.equal(projektFor('133720a_ass32.ecw', poster), 'v2');
  assert.equal(projektFor('handgjord.ECW', poster), 'v3');
  assert.equal(projektFor('x.ECW', []), null);
});

test('arEgenAuf: tom plats, orörd egen, Onyx-sidovagn — aldrig en främmande AUF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auf-auto-'));
  try {
    const auf = path.join(dir, 'A.auf');
    assert.equal(arEgenAuf(auf, null), true);                       // inget att skriva över
    fs.writeFileSync(auf, 'x');
    assert.equal(arEgenAuf(auf, null), false);                      // främmande (ingen sidovagn)
    fs.writeFileSync(path.join(dir, 'A.txt'), '﻿AUF: A.auf\r\nSkapad av Onyx — inte skickad till maskinen.\r\n');
    assert.equal(arEgenAuf(auf, null), true);                       // Onyx-jobbets egen
    const st = fs.statSync(auf);
    assert.equal(arEgenAuf(auf, { aufSize: st.size, aufMtimeMs: st.mtimeMs }), true);
    assert.equal(arEgenAuf(auf, { aufSize: st.size + 1, aufMtimeMs: st.mtimeMs }), false);   // handändrad sedan
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
