// Materialåtgång för n partier ur den live generatorn (samma anrop som lagrets kapavdrag).
// node parti-atgang.mjs <ase60|ass32> <bredd> <höjd> <n> [färg]
const [sys, b, h, n = '4', farg = 'Vit'] = process.argv.slice(2);
const G = 'https://three.nordiska.io/ase60';
const enhet = (i) => sys === 'ass32'
  ? { id: `u${i}`, system: 'ass32', widthMm: +b, heightMm: +h, leaves: 2, opening: 'center-meet', track: 2, weight: 200, sashSeries: '92', innerPanel: 1, hardware: { hinge: 'ASE60-350', lock: 'DLO-276726', handle: 'DHA-inside' }, handleSide: 'inside', comNo: '', description: `P${i}`, positionId: `P${i}`, handedness: 'a' }
  : { id: `u${i}`, system: 'ase60', widthMm: +b, heightMm: +h, leaves: 2, opening: 'center-meet', track: 2, weight: 350, innerPanel: 2, hardware: { hinge: 'ASE60-350', lock: 'DLO-276726', handle: 'DHA-inside' }, handleSide: 'inside', comNo: '', description: `P${i}`, positionId: `P${i}` };
const units = Array.from({ length: +n }, (_, i) => enhet(i + 1));
const post = async (vag, body) => { const r = await fetch(G + vag, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
const ut = { sys, b, h, n: +n };
const at = await post(sys === 'ass32' ? '/api/ass32/lager-atgang' : '/api/lager-atgang', { units, projectColor: farg });
ut.atgang = at;
if (sys !== 'ass32') ut.bom = await post('/api/bom', { units });
console.log(JSON.stringify(ut));
