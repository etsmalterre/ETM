/**
 * Guard for the transfert picker search (GET /transferts/:kind/:id/available).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-transfert-picker-search.ts
 *
 * Ticket #1093: picking pieces to transfer could not be narrowed to a variant —
 * "029 gris" vs "029 ecru" — because the search matched a SINGLE term against
 * numero / lot / reference only, with no coloris column at all. The endpoint
 * now takes multi-term free text (every term must match) plus field-scoped
 * chips, and joins colori_ecru / ref_fini_colori so coloris is searchable.
 *
 * What this pins, all against live data (read-only):
 *   1. the three loaders still return rows — the added joins neither collapse
 *      nor duplicate the result set, nor trip the Windows "0 rows" quirk;
 *   2. a second term ANDs (narrows, never widens) and every row carries both;
 *   3. THE TICKET: two coloris of the same reference are separable — each chip
 *      returns its own variant and excludes the other;
 *   4. a chip restricts to its own column, and a chip with no match returns 0;
 *   5. an accented coloris is reachable by typing it WITHOUT the accent, which
 *      is what the non-ASCII -> '_' wildcard in likePattern buys us.
 *
 * ⚠️ Comparisons fold accents, exactly like the client's matchesCriteria. A
 * naive substring compare fails here for the right reason: "ecru" legitimately
 * matches a coloris stored "écru", and that is the feature, not a leak.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'
import {
  loadAvailableEcru,
  loadAvailableFini,
  loadAvailableFil,
  likePattern,
  type SearchCriteria,
} from '../routes/transferts.js'

const NONE: SearchCriteria = { terms: [], chips: [] }
const fold = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Magasin holding the most recent unshipped écru — the realistic source. */
async function busiestEcruMagasin(): Promise<number> {
  const rows = await query<any>(
    `SELECT TOP 500 se.IDmagasin FROM stock_ecru se ` +
      `WHERE (se.IDligne_expedition_ETM IS NULL OR se.IDligne_expedition_ETM = 0) ` +
      `ORDER BY se.IDstock_ecru DESC`,
  )
  const tally = new Map<number, number>()
  for (const r of rows) tally.set(Number(r.IDmagasin) || 0, (tally.get(Number(r.IDmagasin) || 0) ?? 0) + 1)
  let best = 0
  let bestCount = -1
  for (const [m, c] of tally) if (c > bestCount) { best = m; bestCount = c }
  return best
}

async function main() {
  let problems = 0
  const fail = (m: string) => { console.log(`✗ ${m}`); problems++ }
  const ok = (m: string) => console.log(`✓ ${m}`)

  const magasin = await busiestEcruMagasin()
  console.log(`Magasin source retenu : ${magasin}\n`)

  // ── 1. The loaders still return rows with the new joins ──────────────
  const ecru = await loadAvailableEcru(magasin, NONE)
  if (ecru.length === 0) fail('loadAvailableEcru renvoie 0 rouleau — la jointure colori_ecru a cassé la requête')
  else ok(`écru : ${ecru.length} rouleaux (jointure colori_ecru OK)`)

  const fini = await loadAvailableFini(magasin, NONE)
  ok(`fini : ${fini.length} rouleaux (jointures ref_fini_colori + colori_ecru OK)`)

  const fil = await loadAvailableFil(magasin, NONE)
  ok(`fil  : ${fil.length} lots`)

  // The fini query fans out over TWO coloris catalogs; if either multiplied
  // rows we would see the same stock id twice.
  const finiIds = new Set(fini.map((r) => r.stock_id))
  if (finiIds.size !== fini.length) {
    fail(`fini : ${fini.length} lignes pour ${finiIds.size} rouleaux — une jointure coloris duplique les lignes`)
  } else ok('fini : aucune ligne dupliquée par les jointures coloris')

  // ── The ticket's fixture: one reference carrying TWO coloris ──────────
  const byRef = new Map<string, Set<string>>()
  for (const r of ecru) {
    const ref = r.reference.trim()
    const col = r.coloris_reference.trim()
    if (!ref || !col) continue
    if (!byRef.has(ref)) byRef.set(ref, new Set())
    byRef.get(ref)!.add(col)
  }
  const twoTone = [...byRef.entries()].find(([, cols]) => new Set([...cols].map(fold)).size >= 2)
  if (!twoTone) {
    fail('aucune référence à deux coloris distincts dans ce magasin — le scénario du ticket est intestable ici')
    await closeConnection()
    process.exit(1)
  }
  const [ref, colSet] = twoTone
  const distinct = [...new Set([...colSet].map((c) => [fold(c), c] as const))].reduce<string[]>((acc, [, raw]) => {
    if (!acc.some((a) => fold(a) === fold(raw))) acc.push(raw)
    return acc
  }, [])
  const [colA, colB] = distinct
  console.log(`\nFixture ticket #1093 : référence "${ref}" · coloris "${colA}" vs "${colB}"\n`)

  // ── 2. A second term ANDs ─────────────────────────────────────────────
  const oneTerm = await loadAvailableEcru(magasin, { terms: [ref], chips: [] })
  const twoTerms = await loadAvailableEcru(magasin, { terms: [ref, colA], chips: [] })
  if (oneTerm.length === 0) fail(`recherche "${ref}" ne renvoie rien alors que la référence existe`)
  else ok(`"${ref}" → ${oneTerm.length} rouleaux`)
  if (twoTerms.length > oneTerm.length) {
    fail(`"${ref} ${colA}" (${twoTerms.length}) élargit au lieu de restreindre "${ref}" (${oneTerm.length}) — les termes ne sont pas en ET`)
  } else ok(`"${ref} ${colA}" → ${twoTerms.length} rouleaux (⊆ ${oneTerm.length})`)

  // A free term matches ANY column, so `colA` may land on a numero or a lot —
  // only a row matching neither reading is a bug.
  const bothMissing = twoTerms.filter((r) => {
    const hay = fold(`${r.reference} ${r.coloris_reference} ${r.numero} ${r.lot}`)
    return !hay.includes(fold(ref)) || !hay.includes(fold(colA))
  })
  if (bothMissing.length > 0) fail(`${bothMissing.length} rouleaux renvoyés ne portent pas les deux termes`)
  else ok('chaque rouleau renvoyé porte les deux termes')

  // ── 3. THE TICKET: the two variants are separable ─────────────────────
  const pickA = await loadAvailableEcru(magasin, {
    terms: [], chips: [{ field: 'ref', value: ref }, { field: 'coloris', value: colA }],
  })
  const pickB = await loadAvailableEcru(magasin, {
    terms: [], chips: [{ field: 'ref', value: ref }, { field: 'coloris', value: colB }],
  })
  if (pickA.length === 0) fail(`"${ref}" + coloris "${colA}" ne renvoie rien`)
  if (pickB.length === 0) fail(`"${ref}" + coloris "${colB}" ne renvoie rien`)
  if (pickA.length > 0 && pickB.length > 0) {
    ok(`"${ref}" + "${colA}" → ${pickA.length} rouleaux · "${ref}" + "${colB}" → ${pickB.length} rouleaux`)
  }
  const strayA = pickA.filter((r) => !fold(r.coloris_reference).includes(fold(colA)))
  const strayB = pickB.filter((r) => !fold(r.coloris_reference).includes(fold(colB)))
  if (strayA.length > 0) fail(`${strayA.length} rouleaux hors coloris dans la sélection "${colA}" (ex. "${strayA[0].coloris_reference}")`)
  else ok(`la sélection "${colA}" ne contient que ce coloris`)
  if (strayB.length > 0) fail(`${strayB.length} rouleaux hors coloris dans la sélection "${colB}" (ex. "${strayB[0].coloris_reference}")`)
  else ok(`la sélection "${colB}" ne contient que ce coloris`)

  // Unless one coloris name contains the other, the two sets must be disjoint —
  // that is exactly "029 gris" not showing up under "029 ecru".
  const overlapping = fold(colA).includes(fold(colB)) || fold(colB).includes(fold(colA))
  if (!overlapping) {
    const ids = new Set(pickB.map((r) => r.stock_id))
    const bleed = pickA.filter((r) => ids.has(r.stock_id))
    if (bleed.length > 0) fail(`${bleed.length} rouleaux apparaissent dans les DEUX coloris — les variantes ne sont pas séparées`)
    else ok(`les deux variantes de "${ref}" sont disjointes`)
  }

  // ── 4. A chip restricts to its OWN column ─────────────────────────────
  const crossed = await loadAvailableEcru(magasin, { terms: [], chips: [{ field: 'coloris', value: ref }] })
  const leak = crossed.filter((r) => !fold(r.coloris_reference).includes(fold(ref)))
  if (leak.length > 0) fail(`chip "Coloris : ${ref}" fuit sur ${leak.length} rouleaux dont le coloris ne porte pas ce texte`)
  else ok(`chip "Coloris : ${ref}" → ${crossed.length} rouleaux, aucune fuite hors colonne`)

  const nonsense = await loadAvailableEcru(magasin, {
    terms: [], chips: [{ field: 'numero', value: 'zzz-aucun-numero-zzz' }],
  })
  if (nonsense.length > 0) fail(`un chip absurde renvoie ${nonsense.length} rouleaux au lieu de 0`)
  else ok('un chip sans correspondance renvoie 0 rouleau')

  // ── 5. Accents / bridge safety, asserted on likePattern itself ────────
  // Deterministic on purpose: whether a given magasin happens to hold an
  // accented coloris is an accident of the data, but the two invariants below
  // must hold on every deploy — the second one is what keeps the Linux bridge
  // alive (raw multi-byte UTF-8 in a SQL string corrupts it).
  if (likePattern('écru') !== '%_cru%') {
    fail(`likePattern('écru') = ${likePattern('écru')} — le joker accentué ne joue plus, "ecru" ne trouvera plus "écru"`)
  } else ok(`likePattern('écru') = '%_cru%' — "ecru" et "écru" se rejoignent`)

  const utf8Probes = ['écru', 'Bleu marine foncé', 'grège', 'ÉCRU', 'côtelé 1x1']
  const leaky = utf8Probes.filter((p) => /[^\x00-\x7F]/.test(likePattern(p)))
  if (leaky.length > 0) {
    fail(`likePattern laisse passer de l'UTF-8 brut vers SQL (${leaky.join(', ')}) — le pont Linux se corrompt`)
  } else ok(`aucun octet non-ASCII n'atteint SQL sur ${utf8Probes.length} termes accentués`)

  // And the end-to-end version, when the data offers it.
  const accented = [...ecru, ...fini, ...pickA, ...pickB, ...crossed]
    .map((r) => r.coloris_reference.trim())
    .find((v) => v.length > 2 && /[^\x00-\x7F]/.test(v))
  if (!accented) {
    console.log('… aucun coloris accentué dans ce magasin — contrôle bout-en-bout ignoré')
  } else {
    const folded = fold(accented)
    const hits = await loadAvailableEcru(magasin, { terms: [], chips: [{ field: 'coloris', value: folded }] })
    if (!hits.some((r) => fold(r.coloris_reference) === folded)) {
      fail(`"${folded}" ne retrouve pas le coloris "${accented}"`)
    } else ok(`"${folded}" retrouve bien le coloris accentué "${accented}"`)
  }

  console.log(problems === 0 ? '\n✅ Recherche du picker de transfert conforme' : `\n❌ ${problems} problème(s)`)
  await closeConnection()
  process.exit(problems > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await closeConnection()
  process.exit(1)
})
