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
  countSecondChoixHidden,
  countAffecteesHidden,
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

  // ── 6. LIVA #1119 — 2e choix hidden by default, switchable, counted ────
  // Use the magasin holding the most unshipped 2nd-choix écru (the factory in
  // practice: 125 of 886 on the dev copy) so the case is never vacuous.
  console.log('\n— #1119 · 2e choix —')
  const scRows = await query<any>(
    `SELECT IDmagasin AS m, COUNT(*) AS n FROM stock_ecru ` +
      `WHERE second_choix = 1 AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0) GROUP BY IDmagasin`,
  )
  const scMag = scRows.map((r: any) => ({ m: Number(r.m) || 0, n: Number(r.n) || 0 })).sort((a: any, b: any) => b.n - a.n)[0]
  if (!scMag || scMag.n === 0) {
    console.log('… aucun écru 2e choix non expédié — contrôle #1119 ignoré')
  } else {
    const hiddenList = await loadAvailableEcru(scMag.m, NONE, false)
    const shownList = await loadAvailableEcru(scMag.m, NONE, true)
    const legacyList = await loadAvailableEcru(scMag.m, NONE)
    if (hiddenList.some((r) => r.second_choix)) fail('par défaut (showSecondChoix=false) la liste contient encore du 2e choix')
    else ok(`magasin ${scMag.m} : ${hiddenList.length} rouleaux sans 2e choix par défaut`)
    if (legacyList.length !== shownList.length) fail('le 3e paramètre omis ne vaut pas true — les anciens appels changeraient de comportement')
    else ok('paramètre omis = 2e choix affiché (compat des anciens appels)')
    const hidden = await countSecondChoixHidden(scMag.m, NONE)
    if (hidden.ecru !== scMag.n) fail(`countSecondChoixHidden.ecru = ${hidden.ecru}, COUNT direct = ${scMag.n}`)
    else ok(`${hidden.ecru} écru 2e choix comptés masqués (= COUNT direct)`)
    // THE case: the user types the number of a 2e choix roll.
    const target = shownList.find((r) => r.second_choix && r.numero.trim().length > 0)
    if (!target) {
      console.log('… aucun 2e choix dans la fenêtre des 200 plus récents — recherche par numéro ignorée')
    } else {
      const crit: SearchCriteria = { terms: [], chips: [{ field: 'numero', value: target.numero }] }
      const byNumHidden = await loadAvailableEcru(scMag.m, crit, false)
      const byNumShown = await loadAvailableEcru(scMag.m, crit, true)
      const byNumCount = await countSecondChoixHidden(scMag.m, crit)
      if (byNumHidden.some((r) => r.stock_id === target.stock_id)) fail(`le 2e choix ${target.numero} apparaît alors que le switch est off`)
      else if (byNumCount.ecru < 1) fail(`le 2e choix ${target.numero} est masqué mais non compté — l'écran dirait "aucun résultat" sans explication`)
      else if (!byNumShown.some((r) => r.stock_id === target.stock_id)) fail(`le 2e choix ${target.numero} n'apparaît pas une fois le switch on`)
      else ok(`n° ${target.numero} : masqué + compté (${byNumCount.ecru}) + visible avec le switch`)
    }
  }

  // ── 7. LIVA #1121 — consumed écru gone, affectation rule, fini état 3 ──
  console.log('\n— #1121 · affectation & écru consommé —')
  {
    // (a) no écru with a stock_fini child in any pool — take the busiest dyer.
    const dyerRows = await query<any>(
      `SELECT IDmagasin AS m, COUNT(*) AS n FROM stock_ecru WHERE IDmagasin > 0 AND IDsociete = 1 ` +
        `AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0) GROUP BY IDmagasin`,
    )
    const dyer = dyerRows.map((r: any) => ({ m: Number(r.m), n: Number(r.n) })).sort((a: any, b: any) => b.n - a.n)[0]?.m ?? 0
    const pool = await loadAvailableEcru(dyer, NONE, true, { destId: 0, showAffectees: true })
    const ids = pool.map((r) => r.stock_id)
    let children = 0
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await query<any>(`SELECT COUNT(*) AS n FROM stock_fini WHERE IDstock_ecru IN (${ids.slice(i, i + 200).join(',')})`)
      children += Number(rows[0]?.n) || 0
    }
    if (children > 0) fail(`magasin ${dyer} : ${children} écru déjà teints (enfant stock_fini) encore proposés`)
    else ok(`magasin ${dyer} : ${pool.length} écru proposés, aucun n'a d'enfant stock_fini`)

    // (b) the return case: dest = usine (0), pieces affected to the dyer hidden, counted, switchable.
    const hiddenList = await loadAvailableEcru(dyer, NONE, true, { destId: 0, showAffectees: false })
    const leak = hiddenList.filter((r) => r.affectation && r.affectation.sst !== 0)
    if (leak.length > 0) fail(`retour vers l'usine : ${leak.length} pièces affectées à ${leak[0].affectation?.sst_nom} encore proposées`)
    else ok(`retour vers l'usine : aucune pièce affectée à un autre ennoblisseur proposée par défaut`)
    const hiddenN = await countAffecteesHidden(dyer, NONE, { showSecondChoix: true, destId: 0, showAffectees: false })
    const shownAff = pool.filter((r) => r.affectee_ailleurs)
    if (hiddenN === 0 && shownAff.length > 0) fail('des pièces affectées ailleurs existent mais le compteur dit 0')
    else ok(`${hiddenN} pièces affectées ailleurs comptées masquées (${shownAff.length} dans la fenêtre des 200 avec le switch)`)
    if (pool.length > 0 && !pool.some((r) => r.affectation)) console.log('… aucune affectation dans la fenêtre — libellé non vérifié')
    else if (pool.some((r) => r.affectation && !r.affectation.sst_nom)) fail('une affectation sans nom de sous-traitant')
    else ok('chaque pièce affectée porte sa commande et son ennoblisseur')

    // (c) the outbound case: dest = the dyer itself, its affected pieces stay visible.
    const outbound = await loadAvailableEcru(0, NONE, true, { destId: dyer, showAffectees: false })
    const toDyer = outbound.filter((r) => r.affectation?.sst === dyer)
    const toOther = outbound.filter((r) => r.affectee_ailleurs)
    if (toOther.length > 0) fail(`usine → ${dyer} : ${toOther.length} pièces affectées à un AUTRE ennoblisseur proposées`)
    else ok(`usine → magasin ${dyer} : ${toDyer.length} pièces affectées à cet ennoblisseur visibles, aucune affectée ailleurs`)

    // (d) fini pool = état 3 (Validé), no donation — legacy's own predicate.
    const finiPool = await loadAvailableFini(0, NONE)
    const fIds = finiPool.map((r) => r.stock_id)
    let bad = 0
    for (let i = 0; i < fIds.length; i += 200) {
      const rows = await query<any>(`SELECT COUNT(*) AS n FROM stock_fini WHERE IDstock_fini IN (${fIds.slice(i, i + 200).join(',')}) AND (IDetat_stock_fini <> 3 OR IDcommande_donation > 0)`)
      bad += Number(rows[0]?.n) || 0
    }
    if (bad > 0) fail(`fini : ${bad} rouleaux hors état Validé ou en donation proposés`)
    else ok(`fini : ${finiPool.length} rouleaux proposés à l'usine, tous Validé et hors donation`)
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
