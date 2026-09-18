// LIVA #1172 backfill: rolls TRM shipped through the MPS API before 2026-09-18
// carry no `IDref_commande_source` — only the legacy « Expédier » stamped it.
// On a mirror line the source is the TRM line's IDligne_commande_ETM; a
// TRM-native line has none and is left alone. Dry run by default.
//   node --env-file=.env --import tsx src/scripts/repair-1172-source-line.ts [--write]
import { query, closeConnection } from '../lib/hfsql-auto.js'
const write = process.argv.includes('--write')
const num = (v: any) => Number(v) || 0
async function main() {
  const rolls = await query<any>(
    `SELECT IDstock_ecru AS id, numero, IDLigne_Commande_TRM AS lct FROM stock_ecru
     WHERE IDordre_fabrication > 0 AND IDligne_expedition_TRM > 0 AND IDsociete = 1
       AND (IDref_commande_source IS NULL OR IDref_commande_source = 0)`,
  )
  const lcts = [...new Set(rolls.map((r: any) => num(r.lct)).filter((x: number) => x > 0))]
  const link = new Map<number, number>()
  for (let i = 0; i < lcts.length; i += 200) {
    for (const l of await query<any>(`SELECT IDligne_commande_client AS trm, IDligne_commande_ETM AS etm FROM ligne_commande_client WHERE IDligne_commande_client IN (${lcts.slice(i, i + 200).join(',')})`)) {
      if (num(l.etm) > 0) link.set(num(l.trm), num(l.etm))
    }
  }
  const byEtm = new Map<number, number[]>()
  for (const r of rolls) { const etm = link.get(num(r.lct)); if (etm) byEtm.set(etm, [...(byEtm.get(etm) ?? []), num(r.id)]) }
  const total = [...byEtm.values()].reduce((a, b) => a + b.length, 0)
  console.log(`${rolls.length} shipped rolls without source line; ${total} on a mirror line → ${byEtm.size} ETM sst lines; ${rolls.length - total} TRM-native, untouched`)
  for (const [etm, ids] of byEtm) console.log(`  ETM line ${etm}: ${ids.length} rolls`)
  if (!write) { console.log('dry run — pass --write'); await closeConnection(); return }
  let done = 0
  for (const [etm, ids] of byEtm) {
    for (let i = 0; i < ids.length; i += 200) {
      await query(`UPDATE stock_ecru SET IDref_commande_source = ${etm} WHERE IDstock_ecru IN (${ids.slice(i, i + 200).join(',')}) AND (IDref_commande_source IS NULL OR IDref_commande_source = 0)`)
      done += ids.slice(i, i + 200).length
    }
  }
  console.log(`written: ${done}`)
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
