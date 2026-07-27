/**
 * Schema inspection for the "Divers" domain: ref_divers, ref_divers_variation,
 * stock_divers, tarif_divers, ref_divers_expedie.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'

async function dump(table: string, order?: string, limit = 3) {
  console.log(`\n===== ${table} =====`)
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM ${table}${order ? ` ORDER BY ${order}` : ''} LIMIT ${limit}`
    )
    if (rows.length === 0) {
      console.log('(no rows)')
      return
    }
    console.log('Columns:', Object.keys(rows[0]).join(', '))
    rows.forEach((r, i) => {
      console.log(`-- row ${i}`)
      for (const [k, v] of Object.entries(r)) {
        const s = Buffer.isBuffer(v) ? `<buffer ${v.length}>` : JSON.stringify(v)
        console.log(`  ${k}: ${s}`)
      }
    })
    const cnt = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    console.log(`count: ${cnt[0]?.n}`)
  } catch (e) {
    console.log('ERROR:', (e as Error).message)
  }
}

async function main() {
  await dump('ref_divers', 'IDref_divers DESC')
  await dump('ref_divers_variation', 'IDref_divers_variation DESC', 6)
  await dump('stock_divers', 'IDstock_divers DESC', 6)
  await dump('tarif_divers', 'IDtarif_divers DESC', 6)
  await dump('ref_divers_expedie', undefined, 3)
  await closeConnection()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
