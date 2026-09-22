// PG migration review 2026-09-22 (windev_migration docs/plan.md § Review log):
// stock_ecru / stock_fini.date_saisie hold 256 impossible dates written
// YEAR-DAY-MONTH by a 2018-2021 stock import (« 2020-20-05 » = 20/05/2020).
// Every one of them becomes a valid date once day and month are swapped, and
// the rows around them carry the import's placeholder dates (01/01/2020), so
// the swap restores what was meant. Today the API reads them as « 20202005 »
// (roughly the right year), the labels print them wrong, WinDev shows an
// invalid date, and PostgreSQL refuses them. After the swap every reader agrees.
//
// Only rows whose month is > 12 AND whose swap is a real date are touched;
// a swapped date that happens to be valid (day <= 12) is undetectable and is
// left alone. Written with the same 'YYYYMMDD' literal the API's own INSERTs use.
//
//   npx tsx src/scripts/pg-fix-swapped-dates.ts           # dry run: list, change nothing
//   npx tsx src/scripts/pg-fix-swapped-dates.ts --write   # apply (prod: NODE_ENV=production, on the API host)

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, closeConnection } from '../lib/hfsql-auto.js'

const WRITE = process.argv.includes('--write')
/** Refuse to write more than this: the review measured 256 on 2026-09-22. */
const MAX_ROWS = 300

const TARGETS = [
  { table: 'stock_ecru', id: 'IDstock_ecru' },
  { table: 'stock_fini', id: 'IDstock_fini' },
] as const

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 8)

function isRealDate(ymd: string): boolean {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8)
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate()
}

interface Fix { table: string; id: string; key: number; raw: string; fixed: string }

async function findFixes(): Promise<Fix[]> {
  const out: Fix[] = []
  for (const t of TARGETS) {
    const rows = await query<Record<string, unknown>>(`SELECT ${t.id} AS k, date_saisie AS d FROM ${t.table}`)
    for (const r of rows) {
      const ymd = digits(r.d)
      if (ymd.length !== 8 || ymd === '00000000' || isRealDate(ymd)) continue
      const swapped = ymd.slice(0, 4) + ymd.slice(6, 8) + ymd.slice(4, 6)
      if (+ymd.slice(4, 6) > 12 && isRealDate(swapped)) {
        out.push({ table: t.table, id: t.id, key: Number(r.k), raw: String(r.d), fixed: swapped })
      }
    }
  }
  return out
}

async function main() {
  const fixes = await findFixes()
  const by = (t: string) => fixes.filter(f => f.table === t).length
  console.log(`${fixes.length} impossible date(s) fixable by swapping day and month: ` +
    TARGETS.map(t => `${t.table} ${by(t.table)}`).join(', '))
  for (const f of fixes.slice(0, 10)) console.log(`  ${f.table} ${f.key}: ${f.raw} -> ${f.fixed}`)
  if (fixes.length > 10) console.log(`  … ${fixes.length - 10} more`)
  if (!WRITE) { console.log('\ndry run: nothing written (pass --write)'); return }
  if (fixes.length > MAX_ROWS) throw new Error(`${fixes.length} rows > MAX_ROWS ${MAX_ROWS}: look before writing`)

  let done = 0
  for (const f of fixes) {
    await query(`UPDATE ${f.table} SET date_saisie = '${f.fixed}' WHERE ${f.id} = ${f.key}`)
    done++
  }
  const left = await findFixes()
  console.log(`\nwritten: ${done}; impossible dates left: ${left.length}`)
  if (left.length) process.exitCode = 1
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection().catch(() => {}).then(() => process.exit()))
