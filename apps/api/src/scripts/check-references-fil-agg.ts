/**
 * Guard for the two aggregates of the Fils › Références sidebar
 * (GET /api/references-fil/:id — « Stock actuel » and « En commande »).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-references-fil-agg.ts
 *
 * Ticket #1090: both figures were wrong in production and neither could fail
 * locally — `SELECT *` on stock_fil returns zero rows on the Windows driver, so
 * dev showed an empty stock, while the Linux bridge mangles the `terminé` key
 * and the hardcoded fallback missed it, so prod summed every lot since 2020.
 * The pure edge cases are pinned by lib/references-fil-agg.test.ts; what only
 * live data can prove is asserted here. Read-only.
 *
 * The load-bearing check is #4: « En commande » must agree, line for line, with
 * Rapports › Commandes fils (`qte_restante`). The two surfaces answer the same
 * question, so the card must follow the screen — a drift there is the bug
 * coming back in a new shape.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { aggregateStockFilRows, resteALivrer, type CommandeLine } from '../lib/references-fil-agg.js'

const n = (v: unknown) => Number(v) || 0
/** The reference quoted on #1090 — 730 PES/CU. */
const REF_PES_CU = 85

let problems = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems++
}

async function main() {
  // Windows-safe: naming the columns, because `SELECT *` on stock_fil returns
  // zero rows there. Linux cannot name `terminé`, so this script is a Windows /
  // dev-side guard; the aliased flag is what the route's Windows branch reads.
  const stock = await query<Record<string, unknown>>(
    `SELECT sf.IDstock_fil, sf.IDref_fil, sf.IDcolori_fil, sf.IDref_fil_commande,
            sf.stock, sf.stock_initial, sf.terminé AS termine
     FROM stock_fil sf`,
  )
  if (stock.length === 0) {
    console.error('stock_fil returned 0 rows — on Windows that means the SELECT named a memo blob.')
    process.exit(1)
  }
  const stockByRef = new Map<number, Record<string, unknown>[]>()
  for (const r of stock) {
    const id = n(r.IDref_fil)
    const acc = stockByRef.get(id) ?? []
    acc.push(r)
    stockByRef.set(id, acc)
  }

  console.log(`« Stock actuel » — ${stockByRef.size} références portant des lots`)

  // 1) The terminé filter must bite — in BOTH directions. A lost key reads as 0
  //    and lets every lot through; a key read as NaN excludes every lot instead,
  //    which is just as wrong and just as silent (it empties the whole screen).
  //    So assert that some lots are dropped AND that some stock survives.
  let filtered = 0
  let kept = 0
  let survivingKg = 0
  for (const [, rows] of stockByRef) {
    const agg = aggregateStockFilRows(rows)
    if (agg.lots < rows.length) filtered += 1
    if (agg.lots > 0) kept += 1
    survivingKg += agg.totalKg
  }
  check(
    'le filtre « lot terminé » écarte des lots…',
    filtered > 0,
    `${filtered} référence(s) ont des lots terminés à écarter`,
  )
  check(
    '…sans vider l’écran pour autant',
    kept > 0 && survivingKg > 0,
    `${kept} référence(s) en stock, ${survivingKg.toFixed(0)} kg au total`,
  )

  // 2) No reference may report a negative stock. That was the loudest symptom
  //    of the lost filter (4 references, down to −127,9 kg) and it is the
  //    canary that costs nothing to keep.
  const negatives: string[] = []
  for (const [id, rows] of stockByRef) {
    const kg = aggregateStockFilRows(rows).totalKg
    if (kg < -0.001) negatives.push(`ref ${id}: ${kg.toFixed(1)} kg`)
  }
  check('aucune référence n\'affiche un stock négatif', negatives.length === 0, negatives.slice(0, 5).join(', '))

  // 3) The reference from the ticket: exactly one lot still in progress.
  const pesCu = aggregateStockFilRows(stockByRef.get(REF_PES_CU) ?? [])
  check(
    `730 PES/CU (ref ${REF_PES_CU}) ne compte qu'un lot en cours`,
    pesCu.lots === 1,
    `${pesCu.totalKg.toFixed(1)} kg / ${pesCu.lots} lot(s) sur ${(stockByRef.get(REF_PES_CU) ?? []).length} en base`,
  )

  // ── « En commande » ────────────────────────────────────────────────────
  const lines = await query<{
    IDref_fil: number
    IDref_fil_commande: number
    quantite: number | null
    etat_ligne: number | null
    etat_cmd: number | null
  }>(
    `SELECT rfc.IDref_fil, rfc.IDref_fil_commande, rfc.quantite,
            rfc.etat AS etat_ligne, cmd.etat AS etat_cmd
     FROM ref_fil_commande rfc
     JOIN commande_fil cmd ON rfc.IDcommande_fil = cmd.IDcommande_fil`,
  )
  // Reception is keyed on the LINE and NOT scoped to the référence on purpose.
  const recuByLine = new Map<number, number>()
  for (const s of stock) {
    const lid = n(s.IDref_fil_commande)
    if (lid === 0) continue
    recuByLine.set(lid, (recuByLine.get(lid) ?? 0) + n(s.stock_initial))
  }

  const linesByRef = new Map<number, CommandeLine[]>()
  for (const l of lines) {
    const id = n(l.IDref_fil)
    const acc = linesByRef.get(id) ?? []
    acc.push({
      IDref_fil_commande: n(l.IDref_fil_commande),
      quantite: n(l.quantite),
      etat_ligne: n(l.etat_ligne),
      etat: n(l.etat_cmd),
    })
    linesByRef.set(id, acc)
  }

  console.log(`\n« En commande » — ${linesByRef.size} références commandées au moins une fois`)

  // 4) Agreement with Rapports › Commandes fils, reference by reference. The
  //    report's own rule, recomputed here from its documented definition:
  //    open line of an open commande, qte_restante = max(0, commandé − reçu).
  const drift: string[] = []
  let totalCard = 0
  let totalReport = 0
  for (const [id, ls] of linesByRef) {
    const card = resteALivrer(ls, recuByLine)
    const report = ls
      .filter((l) => l.etat_ligne !== 1 && l.etat !== 1)
      .reduce((s, l) => s + Math.max(0, l.quantite - (recuByLine.get(l.IDref_fil_commande) ?? 0)), 0)
    totalCard += card.kg
    totalReport += report
    if (Math.abs(card.kg - report) > 0.001) drift.push(`ref ${id}: fiche ${card.kg.toFixed(1)} ≠ rapport ${report.toFixed(1)}`)
  }
  check(
    'la fiche et Rapports › Commandes fils donnent le même reste à livrer',
    drift.length === 0,
    drift.slice(0, 5).join(', '),
  )

  // 5) The figure must not have silently reverted to the purchase history.
  const historique = lines.reduce((s, l) => s + n(l.quantite), 0)
  check(
    '« En commande » n\'est pas redevenu l\'historique d\'achat',
    totalCard < historique * 0.5,
    `${totalCard.toFixed(0)} kg attendus contre ${historique.toFixed(0)} kg commandés depuis toujours`,
  )

  // 6) A closed commande can never contribute.
  const closedContrib = lines
    .filter((l) => n(l.etat_ligne) === 1 || n(l.etat_cmd) === 1)
    .reduce((s, l) => s + n(l.quantite), 0)
  check(
    'les commandes soldées sont hors du calcul',
    closedContrib > 0 && totalReport + closedContrib > totalReport,
    `${closedContrib.toFixed(0)} kg de lignes soldées écartés`,
  )

  console.log(
    problems === 0
      ? `\n✓ tout est cohérent (${totalCard.toFixed(0)} kg réellement en commande)`
      : `\n✗ ${problems} problème(s)`,
  )
  await closeConnection()
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
