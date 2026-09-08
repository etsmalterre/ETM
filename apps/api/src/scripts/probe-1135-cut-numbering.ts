/**
 * Probe for ticket #1135 — « mauvaise numérotation des coupes ».
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/probe-1135-cut-numbering.ts [numero]
 *
 * Shows, for a roll numero (default 3204/14, the ticket's example), the
 * siblings the suffix rule sees on both stock tables and the index the next
 * cut would get — i.e. what `GET /stock/{fini,ecru}/:id/cut/preview` answers.
 * Read-only: exercises the `LIKE '<base>-%'` scan on the real driver.
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { cutBase, nextCutIndex } from '../lib/roll-cut.js'

async function main() {
  const numero = process.argv[2] ?? '3204/14'
  for (const table of ['stock_fini', 'stock_ecru'] as const) {
    const all = await query<{ numero: string | null }>(
      `SELECT numero FROM ${table} WHERE numero LIKE '${cutBase(numero)}%'`,
    )
    console.log(`${table}: rows sharing the prefix →`, all.map((r) => (r.numero ?? '').trim()))
    for (const n of [numero, `${cutBase(numero)}-2`]) {
      const base = cutBase(n)
      const siblings = await query<{ numero: string | null }>(
        `SELECT numero FROM ${table} WHERE numero LIKE '${base}-%'`,
      )
      const next = nextCutIndex(base, siblings.map((r) => r.numero ?? ''))
      console.log(`  cutting ${n}: base=${base} siblings=${JSON.stringify(siblings.map((r) => r.numero))} → next suffix -${next}`)
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => closeConnection())
