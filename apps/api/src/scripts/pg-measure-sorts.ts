// pg-measure-sorts: how HFSQL sorts each text column. Read-only.
//
// HFSQL sorts a text column by the options of its index — byte by byte
// (sous_traitant.nom: « BUGIS » before « Barata »), ignoring case
// (competence.reference), or ignoring case, spaces and punctuation too
// (client.nom, ref_ecru.reference: « 128/1 < 128/101 < 128/13 < 128/2 < 128 blanc »).
// ODBC does not expose those options, so the order is measured here on the
// production host and matched against PostgreSQL collations
// (windev_migration docs/plan.md, R14; the result is apps/api/src/lib/pg-sortrules.json).
//
//   NODE_ENV=production npx tsx src/scripts/pg-measure-sorts.ts cols.json > sorts.json
//   cols.json: [{ "schema": "public", "table": "client", "col": "nom" }, …]
//   output:    { "public.client.nom": ["1083", "2CA", …] }  (the first 3000 values, as
//              stored: one char per byte, decode cp1252 / UTF-8 on the reading side)

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { readFileSync } from 'node:fs'
import { queryB64Text, closeConnection } from '../lib/hfsql-auto.js'
import { pointageDb } from '../lib/hfsql-pointage.js'

const TOP = 3000
const file = process.argv[2]
if (!file) throw new Error('usage: pg-measure-sorts.ts cols.json')
const cols = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; table: string; col: string }[]

async function main() {
  const out: Record<string, unknown[]> = {}
  for (const { schema, table, col } of cols) {
    // Names come from the migration catalog (SQLColumns); refuse anything else.
    if (![table, col].every((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x))) { console.error(`skip ${table}.${col}`); continue }
    const run = schema === 'pointage' ? pointageDb.queryB64Text.bind(pointageDb) : queryB64Text
    try {
      const rows = await run<Record<string, unknown>>(`SELECT TOP ${TOP} ${col} AS v FROM ${table} ORDER BY ${col}`)
      out[`${schema}.${table}.${col}`] = rows.map((r) => r.v ?? r.V ?? null)
    } catch (e) {
      console.error(`${table}.${col}: ${(e as Error).message.slice(0, 200)}`)
    }
  }
  process.stdout.write(JSON.stringify(out) + '\n')
}

main().finally(async () => {
  await closeConnection().catch(() => {})
  await pointageDb.closeConnection().catch(() => {})
  process.exit(0)
})
