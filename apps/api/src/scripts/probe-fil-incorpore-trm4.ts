// READ-ONLY probe #4 — last two questions.
//   I  The FULL column list of fil_incorpore (is there a date / a moment /
//      a per-piece link anywhere?), straight from a SELECT *.
//   J  The shop floor's own words on the 34 OFs that carry an incorporation:
//      ordre_fabrication.observations (the consigne au bonnetier) and
//      message_of — do they say WHEN to feed it?
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0

async function main() {
  console.log('\n═══ I · colonnes réelles de fil_incorpore ═══')
  const sample = await query<any>(`SELECT * FROM fil_incorpore LIMIT 3`)
  console.log('colonnes :', sample.length ? Object.keys(sample[0]) : '(aucune ligne)')
  console.log(sample)

  console.log('\n═══ J · consignes des OF portant une incorporation ═══')
  const inc = await query<any>(
    `SELECT IDordre_fabrication, IDstock_fil, poids FROM fil_incorpore ORDER BY IDfil_incorpore`,
  )
  const ofIds = Array.from(new Set(inc.map((r) => n(r.IDordre_fabrication))))
  const ofs = await query<any>(
    `SELECT IDordre_fabrication, observations FROM ordre_fabrication WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
  )
  const obsByOf = new Map<number, string>()
  for (const o of ofs) obsByOf.set(n(o.IDordre_fabrication), String(o.observations ?? '').trim())
  const msgs = await query<any>(
    `SELECT IDordre_fabrication, observation FROM message_of WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
  )
  const msgByOf = new Map<number, string[]>()
  for (const m of msgs) {
    const id = n(m.IDordre_fabrication)
    const t = String(m.observation ?? '').trim()
    if (!t) continue
    if (!msgByOf.has(id)) msgByOf.set(id, [])
    msgByOf.get(id)!.push(t)
  }
  let withText = 0
  for (const r of inc) {
    const id = n(r.IDordre_fabrication)
    const o = obsByOf.get(id) ?? ''
    const m = msgByOf.get(id) ?? []
    if (!o && m.length === 0) continue
    withText++
    console.log(`\nOF ${id} · ${Number(r.poids)} Kg incorporés (lot ${r.IDstock_fil})`)
    if (o) console.log(`  consigne : ${o.replace(/\s+/g, ' ').slice(0, 300)}`)
    for (const t of m) console.log(`  message  : ${t.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
  console.log(`\n  ${withText} / ${inc.length} incorporations portent une consigne ou un message`)

  // Same words, but looked for across the WHOLE ledger — the vocabulary of
  // incorporation may be written on OFs that never got a fil_incorpore row.
  console.log('\n═══ J bis · le mot "incorpor" ailleurs dans les consignes ═══')
  for (const [table, col, idCol] of [
    ['ordre_fabrication', 'observations', 'IDordre_fabrication'],
    ['message_of', 'observation', 'IDordre_fabrication'],
  ] as const) {
    try {
      const hits = await query<any>(
        `SELECT ${idCol}, ${col} FROM ${table} WHERE ${col} LIKE '%ncorpor%'`,
      )
      console.log(`  ${table}.${col} : ${hits.length} ligne(s)`)
      for (const h of hits.slice(0, 25)) {
        console.log(`    OF ${h[idCol]} · ${String(h[col] ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
      }
    } catch (e: any) {
      console.log(`  ${table}.${col} : ERREUR ${e.message ?? e}`)
    }
  }

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
