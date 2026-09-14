// Companion of probe-1156-ecru-perf.ts: INTERLEAVED A/B of the list query
// shapes (3 rounds), so server-load drift between runs cannot fake a winner.
// Read-only.
import { query, closeConnection } from '../lib/hfsql-auto.js'

const COLS = `se.IDstock_ecru, se.IDref_ecru, se.IDcolori_ecru, se.IDmagasin, se.IDordre_fabrication, se.IDref_commande_source, se.IDref_commande_affectation, se.IDligne_commande_client, se.poids, se.metrage, se.lot, se.numero, se.observations, se.visiteur, se.second_choix, se.date_saisie`
const COLS_NO_OBS = COLS.replace(', se.observations', '')
const JOINS = `LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru LEFT JOIN colori_ecru ce ON se.IDcolori_ecru = ce.IDcolori_ecru LEFT JOIN sous_traitant st ON se.IDmagasin = st.IDsous_traitant`
const JCOLS = `, re.reference AS ref_ecru, ce.reference AS coloris_reference, st.nom AS magasin_nom`
const W0 = `se.IDsociete = 1 AND (se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL) AND (se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0) AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)`
const NE = ` AND NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru)`
const ORD = ` ORDER BY se.date_saisie DESC, se.IDstock_ecru DESC`

const shapes: Record<string, () => Promise<number>> = {
  'A full (joins, all cols, NOT EXISTS, ORDER BY) [shipped]': async () => (await query<any>(`SELECT ${COLS}${JCOLS} FROM stock_ecru se ${JOINS} WHERE ${W0}${NE}${ORD}`)).length,
  'B no joins, all cols, NOT EXISTS, ORDER BY': async () => (await query<any>(`SELECT ${COLS} FROM stock_ecru se WHERE ${W0}${NE}${ORD}`)).length,
  'C no joins, all cols, NOT EXISTS, no ORDER BY': async () => (await query<any>(`SELECT ${COLS} FROM stock_ecru se WHERE ${W0}${NE}`)).length,
  'D no joins, no observations, NOT EXISTS': async () => (await query<any>(`SELECT ${COLS_NO_OBS} FROM stock_ecru se WHERE ${W0}${NE}`)).length,
  'E no joins, all cols, NO NOT EXISTS': async () => (await query<any>(`SELECT ${COLS} FROM stock_ecru se WHERE ${W0}`)).length,
  'F joins, all cols, NO NOT EXISTS': async () => (await query<any>(`SELECT ${COLS}${JCOLS} FROM stock_ecru se ${JOINS} WHERE ${W0}`)).length,
  'G ids only, NOT EXISTS': async () => (await query<any>(`SELECT se.IDstock_ecru FROM stock_ecru se WHERE ${W0}${NE}`)).length,
  'H two-step: E then consumed ids IN (...)': async () => {
    const rows = await query<any>(`SELECT ${COLS} FROM stock_ecru se WHERE ${W0}`)
    const ids = rows.map((r: any) => Number(r.IDstock_ecru))
    const consumed = new Set<number>()
    for (let i = 0; i < ids.length; i += 200) {
      for (const r of await query<any>(`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${ids.slice(i, i + 200).join(',')})`)) consumed.add(Number(r.IDstock_ecru))
    }
    return rows.filter((r: any) => !consumed.has(Number(r.IDstock_ecru))).length
  },
}

async function main() {
  const acc: Record<string, number[]> = {}
  for (let round = 1; round <= 3; round++) {
    for (const [label, fn] of Object.entries(shapes)) {
      const t = Date.now()
      const n = await fn()
      const ms = Date.now() - t
      ;(acc[label] ??= []).push(ms)
      console.log(`r${round} ${label.padEnd(60)} ${String(ms).padStart(6)} ms  (${n} rows)`)
    }
  }
  console.log('\nmedian per shape:')
  for (const [label, arr] of Object.entries(acc)) {
    const s = [...arr].sort((a, b) => a - b)
    console.log(`  ${label.padEnd(60)} ${String(s[1]).padStart(6)} ms   [${arr.join(', ')}]`)
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
