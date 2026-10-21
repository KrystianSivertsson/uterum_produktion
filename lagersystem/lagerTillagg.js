// Produkter som Krystian bett om att få inlagda med RÄKNAT saldo (inte 0 som
// leveranslistan). Appliceras EN gång per webbläsare och post i App.js
// laddaProdukter, SIST i kedjan (efter nollningen), så att även en ny
// webbläsare landar på det räknade saldot. Lägg nya poster med nytt id, så
// körs de i webbläsare som redan har de gamla.
//
// ersatter = namn på inventeringens textposter (artikel ''), alltså samma vara
// inlagd utan artikelnummer 2026-08-06. Posten tar över den, så det inte blir
// två produkter.

export const LAGER_TILLAGG = [
  // Krystian 2026-10-21: "lägg till denna i osorterat 59 st" (Schüco Connect 298900)
  { id: 'tillagg_298900', namn: 'Seal. cmpd Schüco Flex 2 Bk', artikel: '298900', antal: 59, enhet: 'st', kategori: 'Osorterat', minAntal: 5, ersatter: ['FLEX 2'] },
  // Krystian 2026-10-21: "lägg till denna 1st" (Schüco Connect 298736, säljs per Pack)
  { id: 'tillagg_298736', namn: 'Metal adhesive 2-comp. PUR Gr', artikel: '298736', antal: 1, enhet: 'st', kategori: 'Osorterat', minAntal: 5, ersatter: ['METALLKLEBER (LIM)'] },
];

/**
 * Lägger in en post. Finns artikeln redan (eller inventeringens textpost för
 * samma vara) tar den produkten över: namn, artikelnr, kategori och saldo sätts.
 * Övriga textposter för varan tas bort. Muterar inte input.
 */
export function appliceraTillagg(produkter, t) {
  const lista = produkter.map(p => ({ ...p }));
  const arArtikel = p => String(p.artikel || '').trim() === t.artikel;
  const arTextpost = p => !String(p.artikel || '').trim() && (t.ersatter || []).includes(String(p.namn || '').trim());
  const huvud = lista.find(arArtikel) || lista.find(arTextpost);
  const { ersatter, ...ny } = t;
  if (!huvud) return [...lista, { ...ny, dimension: '' }];
  Object.assign(huvud, { namn: t.namn, artikel: t.artikel, antal: t.antal, enhet: t.enhet, kategori: t.kategori });
  return lista.filter(p => p === huvud || !arTextpost(p));
}
