// pg-measure-keys: the row keys the HFSQL driver really hands back for
// `SELECT TOP 1 *`, table by table, in column order. Read-only.
//
// Why: on Linux the driver mangles some column names in a SELECT * result
// (accented ones truncated at the accent, `terminé` → `termin`; a few garbled,
// `qtemin` → `qttran`), and the API code reads those keys. The PostgreSQL
// adapter must hand back the same keys (lib/pg-keymap.json), so they are
// measured on the production host rather than guessed
// (windev_migration docs/plan.md § Steps 3–4).
//
//   NODE_ENV=production npx tsx src/scripts/pg-measure-keys.ts tables.json > keys.json
//   tables.json: { "mps": ["client", …], "pointage": ["pointage", …] }
//   output:      { "public.client": ["IDclient", "nom", …], "pointage.pointage": […] }
// An empty table yields no row, hence no keys: it is left out.

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { readFileSync } from 'node:fs'
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { pointageDb } from '../lib/hfsql-pointage.js'

const file = process.argv[2]
if (!file) throw new Error('usage: pg-measure-keys.ts tables.json')
const tables = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>
const SCHEMA: Record<string, string> = { mps: 'public', pointage: 'pointage' }

async function main() {
  const out: Record<string, string[]> = {}
  for (const [db, names] of Object.entries(tables)) {
    const run = db === 'pointage' ? pointageDb.query.bind(pointageDb) : query
    for (const t of names) {
      // Table names come from the HFSQL catalog; refuse anything else.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) { console.error(`skip ${t}`); continue }
      try {
        const rows = await run<Record<string, unknown>>(`SELECT TOP 1 * FROM ${t}`)
        if (rows.length) out[`${SCHEMA[db]}.${t.toLowerCase()}`] = Object.keys(rows[0])
      } catch (e) {
        console.error(`${db}.${t}: ${(e as Error).message.slice(0, 200)}`)
      }
    }
  }
  process.stdout.write(JSON.stringify(out) + '\n')
}

main().finally(async () => {
  await closeConnection().catch(() => {})
  await pointageDb.closeConnection().catch(() => {})
  process.exit(0)
})
