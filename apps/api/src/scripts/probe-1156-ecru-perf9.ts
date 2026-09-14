// Companion of probe-1156-ecru-perf.ts: FINAL A/B — the list pipeline as
// shipped before the audit (JOIN select + one-IN defects with per-row
// fixEncoding) vs the reworked one (flat select + memo-where-present + label
// lookups + chunked/batched defects), interleaved 3 rounds so server-load
// drift hits both sides equally. Read-only.
import { query, fixEncoding, closeConnection } from '../lib/hfsql-auto.js'
import { repairAliased } from '../routes/stock-fini.js'
import { fetchDefectsByEcru, resolveClientReservations } from '../routes/stock-ecru.js'

const W = `WHERE se.IDsociete = 1 AND (se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL) AND NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru) AND (se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0) AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)`
const ORD = ` ORDER BY se.date_saisie DESC, se.IDstock_ecru DESC`
const BASE = `se.IDstock_ecru, se.IDref_ecru, se.IDcolori_ecru, se.IDmagasin, se.IDordre_fabrication, se.IDref_commande_source, se.IDref_commande_affectation, se.IDligne_commande_client, se.poids, se.metrage, se.lot, se.numero, se.visiteur, se.second_choix, se.date_saisie`
const REPAIR = { numero: 'numero', lot: 'lot', observations: 'observations', visiteur: 'visiteur' }

async function oldPipeline(): Promise<number> {
  const rows = await query<any>(`SELECT ${BASE}, se.observations, re.reference AS ref_ecru, ce.reference AS coloris_reference, st.nom AS magasin_nom FROM stock_ecru se LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru LEFT JOIN colori_ecru ce ON se.IDcolori_ecru = ce.IDcolori_ecru LEFT JOIN sous_traitant st ON se.IDmagasin = st.IDsous_traitant ${W}${ORD}`)
  let fixed = await repairAliased(rows, 'stock_ecru', 'IDstock_ecru', REPAIR)
  fixed = await repairAliased(fixed, 'ref_ecru', 'IDref_ecru', { ref_ecru: 'reference' })
  fixed = await repairAliased(fixed, 'colori_ecru', 'IDcolori_ecru', { coloris_reference: 'reference' })
  fixed = await repairAliased(fixed, 'sous_traitant', 'IDmagasin', { magasin_nom: 'nom' }, 'IDsous_traitant')
  await resolveClientReservations(fixed.map((r: any) => Number(r.IDligne_commande_client) || 0))
  const ids = fixed.map((r: any) => Number(r.IDstock_ecru)).filter((x: number) => x > 0)
  const def = await query<any>(`SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm, nombre FROM defaut_qualite WHERE Type_Reference = 2 AND reference IN (${ids.map((x: number) => `'${x}'`).join(',')})`)
  await fixEncoding(def, 'defaut_qualite', 'IDdefaut_qualite', ['description', 'type_defaut'])
  return fixed.length
}

async function newPipeline(): Promise<number> {
  const rows = await query<any>(`SELECT ${BASE} FROM stock_ecru se ${W}${ORD}`)
  const obs = await query<any>(`SELECT se.IDstock_ecru, se.observations FROM stock_ecru se ${W} AND se.observations <> ''`)
  const m = new Map(obs.map((o: any) => [Number(o.IDstock_ecru), o.observations]))
  for (const r of rows) r.observations = m.get(Number(r.IDstock_ecru)) ?? null
  const fixed = await repairAliased(rows, 'stock_ecru', 'IDstock_ecru', REPAIR)
  const distinct = (k: string) => Array.from(new Set(fixed.map((r: any) => Number(r[k]) || 0).filter((x: number) => x > 0)))
  await Promise.all([
    query<any>(`SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${distinct('IDref_ecru').join(',')})`).then((r) => repairAliased(r, 'ref_ecru', 'IDref_ecru', { reference: 'reference' })),
    query<any>(`SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${distinct('IDcolori_ecru').join(',')})`).then((r) => repairAliased(r, 'colori_ecru', 'IDcolori_ecru', { reference: 'reference' })),
    query<any>(`SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${distinct('IDmagasin').join(',')})`).then((r) => repairAliased(r, 'sous_traitant', 'IDsous_traitant', { nom: 'nom' })),
  ])
  await resolveClientReservations(fixed.map((r: any) => Number(r.IDligne_commande_client) || 0))
  await fetchDefectsByEcru(fixed.map((r: any) => Number(r.IDstock_ecru)))
  return fixed.length
}

async function main() {
  const acc: Record<string, number[]> = { old: [], new: [] }
  for (let round = 1; round <= 3; round++) {
    for (const [label, fn] of [['old', oldPipeline], ['new', newPipeline]] as const) {
      const t = Date.now()
      const n = await fn()
      const ms = Date.now() - t
      acc[label].push(ms)
      console.log(`r${round} ${label} pipeline: ${ms} ms (${n} rows)`)
    }
  }
  for (const k of ['old', 'new']) { const s = [...acc[k]].sort((a, b) => a - b); console.log(`${k} median ${s[1]} ms  [${acc[k].join(', ')}]`) }
}
main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
