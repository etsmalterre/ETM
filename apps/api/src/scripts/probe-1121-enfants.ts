// #1121 follow-up: écru pieces at a dyer that already have a stock_fini child (dyed) —
// does the transfer picker offer them, and did legacy returns move them?
import { query, closeConnection } from '../lib/hfsql-auto.js'
const num = (v: any) => Number(v) || 0
async function main() {
  // Picker pool at MATEL (id 9): écru unshipped, no expedition
  const pool = await query<any>(`SELECT se.IDstock_ecru AS id, se.IDref_commande_affectation AS aff FROM stock_ecru se WHERE se.IDmagasin = 9 AND (se.IDligne_expedition_ETM IS NULL OR se.IDligne_expedition_ETM = 0) AND se.IDsociete = 1`)
  const ids = pool.map((r: any) => num(r.id))
  const withChild = new Set<number>()
  for (let i = 0; i < ids.length; i += 400) {
    for (const r of await query<any>(`SELECT DISTINCT IDstock_ecru AS e FROM stock_fini WHERE IDstock_ecru IN (${ids.slice(i, i + 400).join(',')})`)) withChild.add(num(r.e))
  }
  const affected = pool.filter((r: any) => num(r.aff) > 0)
  console.log(`écru chez MATEL offerts par le picker : ${pool.length} · affectés ${affected.length} · avec enfant stock_fini (déjà teints) ${withChild.size} · affectés ET sans enfant (vraiment en attente de teinture) ${affected.filter((r: any) => !withChild.has(num(r.id))).length}`)
  // Legacy returns MATEL → Ets Malterre of affected écru: dyed or not?
  const rows = await query<any>(`SELECT pt.IDpiece_ecru AS e, bt.DATE AS d FROM bon_transfert bt JOIN piece_transfert pt ON pt.IDbon_transfert = bt.IDbon_transfert WHERE bt.IDmagasin_source = 9 AND bt.IDmagasin_destination = 0 AND pt.IDpiece_ecru > 0 AND bt.DATE >= '20250101'`)
  const rid = [...new Set(rows.map((r: any) => num(r.e)))]
  const child = new Set<number>()
  for (let i = 0; i < rid.length; i += 400) for (const r of await query<any>(`SELECT DISTINCT IDstock_ecru AS e FROM stock_fini WHERE IDstock_ecru IN (${rid.slice(i, i + 400).join(',')})`)) child.add(num(r.e))
  console.log(`retours écru MATEL → Ets Malterre depuis 2025 : ${rid.length} pièces · dont avec enfant fini ${child.size}`)
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
