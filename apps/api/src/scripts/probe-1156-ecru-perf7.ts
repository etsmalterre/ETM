// Companion of probe-1156-ecru-perf.ts: can `observations` (the expensive
// memo column) be fetched only for the rows that carry one? Read-only.
import { query, closeConnection } from '../lib/hfsql-auto.js'

const W = `se.IDsociete = 1 AND (se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL) AND (se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0) AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0) AND NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru)`

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now()
  const r = await fn()
  console.log(`${label.padEnd(62)} ${String(Date.now() - t).padStart(6)} ms`)
  return r
}

async function main() {
  const all = await timed('id + observations (all rows)', () => query<any>(`SELECT se.IDstock_ecru, se.observations FROM stock_ecru se WHERE ${W}`))
  const withObs = all.filter((r: any) => typeof r.observations === 'string' && r.observations.trim().length > 0)
  console.log(`   rows ${all.length}, with a non-empty observation: ${withObs.length}`)
  const r1 = await timed(`id + observations WHERE observations <> ''`, () => query<any>(`SELECT se.IDstock_ecru, se.observations FROM stock_ecru se WHERE ${W} AND se.observations <> ''`))
  console.log(`   rows ${r1.length}`)
  const r2 = await timed(`id + observations WHERE LENGTH(observations) > 0`, () => query<any>(`SELECT se.IDstock_ecru, se.observations FROM stock_ecru se WHERE ${W} AND LENGTH(se.observations) > 0`).catch((e) => { console.log('   err', String(e).slice(0, 120)); return [] as any[] }))
  console.log(`   rows ${r2.length}`)
  const ids = withObs.map((r: any) => Number(r.IDstock_ecru))
  await timed(`id + observations WHERE IDstock_ecru IN (${ids.length} known)`, () => query<any>(`SELECT se.IDstock_ecru, se.observations FROM stock_ecru se WHERE se.IDstock_ecru IN (${ids.join(',')})`))
  // The whole "tous" population, observations only.
  const W2 = W.replace(' AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)', '')
  const t = await timed(`tous: id + observations (all rows)`, () => query<any>(`SELECT se.IDstock_ecru, se.observations FROM stock_ecru se WHERE ${W2}`))
  console.log(`   rows ${t.length}, with observation: ${t.filter((r: any) => typeof r.observations === 'string' && r.observations.trim().length > 0).length}`)
  await timed(`tous: id only`, () => query<any>(`SELECT se.IDstock_ecru FROM stock_ecru se WHERE ${W2}`))
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
