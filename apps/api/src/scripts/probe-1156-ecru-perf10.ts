// Companion of probe-1156-ecru-perf.ts: in the server's SLOW state the column
// cost no longer dominates — which clause does? Interleaved 3 rounds. Read-only.
import { query, closeConnection } from '../lib/hfsql-auto.js'
const BASE = `se.IDstock_ecru, se.IDref_ecru, se.IDcolori_ecru, se.IDmagasin, se.IDordre_fabrication, se.IDref_commande_source, se.IDref_commande_affectation, se.IDligne_commande_client, se.poids, se.metrage, se.lot, se.numero, se.visiteur, se.second_choix, se.date_saisie`
const JOINS = `LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru LEFT JOIN colori_ecru ce ON se.IDcolori_ecru = ce.IDcolori_ecru LEFT JOIN sous_traitant st ON se.IDmagasin = st.IDsous_traitant`
const W0 = `se.IDsociete = 1 AND (se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL) AND (se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0) AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)`
const NE = ` AND NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru)`
const ORD = ` ORDER BY se.date_saisie DESC, se.IDstock_ecru DESC`
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))
async function consumed(ids: number[]): Promise<Set<number>> {
  const out = new Set<number>()
  for (const part of chunk(ids, 200)) for (const r of await query<any>(`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${part.join(',')})`)) out.add(Number(r.IDstock_ecru))
  return out
}
const shapes: Record<string, () => Promise<number>> = {
  'S1 shipped: joins, all cols+obs, NOT EXISTS, ORDER BY': async () => (await query<any>(`SELECT ${BASE}, se.observations, re.reference AS a, ce.reference AS b, st.nom AS c FROM stock_ecru se ${JOINS} WHERE ${W0}${NE}${ORD}`)).length,
  'S2 ids only, NOT EXISTS': async () => (await query<any>(`SELECT se.IDstock_ecru FROM stock_ecru se WHERE ${W0}${NE}`)).length,
  'S3 ids only, no NOT EXISTS': async () => (await query<any>(`SELECT se.IDstock_ecru FROM stock_ecru se WHERE ${W0}`)).length,
  'S4 all cols+obs, no joins, NOT EXISTS, ORDER BY': async () => (await query<any>(`SELECT ${BASE}, se.observations FROM stock_ecru se WHERE ${W0}${NE}${ORD}`)).length,
  'S5 all cols+obs, no joins, no NOT EXISTS, ORDER BY': async () => (await query<any>(`SELECT ${BASE}, se.observations FROM stock_ecru se WHERE ${W0}${ORD}`)).length,
  'S6 all cols (no obs), no NOT EXISTS + consumed IN check': async () => {
    const rows = await query<any>(`SELECT ${BASE} FROM stock_ecru se WHERE ${W0}${ORD}`)
    const c = await consumed(rows.map((r: any) => Number(r.IDstock_ecru)))
    return rows.filter((r: any) => !c.has(Number(r.IDstock_ecru))).length
  },
  'S7 S6 + observations by PK IN chunks (<> \'\')': async () => {
    const rows = await query<any>(`SELECT ${BASE} FROM stock_ecru se WHERE ${W0}${ORD}`)
    const ids = rows.map((r: any) => Number(r.IDstock_ecru))
    const c = await consumed(ids)
    let n = 0
    for (const part of chunk(ids, 200)) n += (await query<any>(`SELECT IDstock_ecru, observations FROM stock_ecru WHERE IDstock_ecru IN (${part.join(',')}) AND observations <> ''`)).length
    return rows.filter((r: any) => !c.has(Number(r.IDstock_ecru))).length + n * 0
  },
  'S8 all cols+obs, no joins, no NOT EXISTS + consumed IN check': async () => {
    const rows = await query<any>(`SELECT ${BASE}, se.observations FROM stock_ecru se WHERE ${W0}${ORD}`)
    const c = await consumed(rows.map((r: any) => Number(r.IDstock_ecru)))
    return rows.filter((r: any) => !c.has(Number(r.IDstock_ecru))).length
  },
}
async function main() {
  const acc: Record<string, number[]> = {}
  for (let round = 1; round <= 3; round++) for (const [label, fn] of Object.entries(shapes)) {
    const t = Date.now(); const n = await fn(); const ms = Date.now() - t
    ;(acc[label] ??= []).push(ms); console.log(`r${round} ${label.padEnd(62)} ${String(ms).padStart(6)} ms (${n})`)
  }
  console.log('\nmedians:')
  for (const [l, a] of Object.entries(acc)) { const s = [...a].sort((x, y) => x - y); console.log(`  ${l.padEnd(62)} ${String(s[1]).padStart(6)} ms  [${a.join(', ')}]`) }
}
main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
