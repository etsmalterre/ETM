// READ-ONLY probe — LIVA #1186: runtime `SELECT *` column order of ref_fini (the
// duplicate's positional INSERT follows it), and a source/copy comparison.
//   npx tsx src/scripts/probe-ref-fini-columns.ts            → column order
//   npx tsx src/scripts/probe-ref-fini-columns.ts <src> <copy> → field-by-field diff
import 'dotenv/config'
import { query, queryRaw } from '../lib/hfsql-auto.js'

const [a, b] = process.argv.slice(2).map(Number)
if (!a) {
  const rows = await queryRaw(`SELECT * FROM ref_fini WHERE IDref_fini IN (SELECT MAX(IDref_fini) FROM ref_fini)`)
  Object.entries(rows[0] as Record<string, unknown>).forEach(([k, v], i) => console.log(i, JSON.stringify(k), typeof v, String(v).slice(0, 60)))
  const cand = await query<{ IDref_fini: number; n: number }>(
    `SELECT IDref_fini, COUNT(*) AS n FROM traitement_ref_fini GROUP BY IDref_fini ORDER BY n DESC`)
  console.log('refs with most treatments:', cand.slice(0, 3))
} else {
  const [s] = await queryRaw(`SELECT * FROM ref_fini WHERE IDref_fini = ${a}`) as Record<string, unknown>[]
  const [c] = await queryRaw(`SELECT * FROM ref_fini WHERE IDref_fini = ${b}`) as Record<string, unknown>[]
  for (const k of Object.keys(s)) {
    const same = String(s[k]) === String(c[k])
    console.log(same ? '  ' : '≠ ', k.padEnd(26), String(s[k]).slice(0, 40).padEnd(42), same ? '' : String(c[k]).slice(0, 40))
  }
  for (const id of [a, b]) {
    const t = await query<{ IDtraitement: number }>(`SELECT IDtraitement FROM traitement_ref_fini WHERE IDref_fini = ${id} ORDER BY IDtraitement`)
    console.log(id, 'traitements', t.map((r) => Number(r.IDtraitement)).join(','))
  }
}
process.exit(0)
