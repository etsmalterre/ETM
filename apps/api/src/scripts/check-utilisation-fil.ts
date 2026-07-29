/**
 * Guard for the "Utilisation fil" widget (GET /references-fil/:id/utilisation).
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-utilisation-fil.ts
 *
 * Pins the reverse lookup to the legacy FI_Utilisation_fil.wdw screen captured
 * for 1/28 COTON PEIGNE BIO Z: 28 écru references, 23 once the "ecru" yarn
 * coloris is selected, and every reference visible in the screenshots present
 * in both lists. Read-only.
 */
import { query, fixEncoding, closeConnection } from '../lib/hfsql-auto.js'

const FIL_REFERENCE = '1/28 COTON PEIGNE BIO Z'
const EXPECT_ALL = 28
const EXPECT_ECRU = 23
/** The rows legible in the legacy screenshots (the list scrolls past these). */
const SHOT_ALL = ['329', '171', '129', '218', 'LTP02', '128', '184', '027', '128 blanc', '128/2', '302', '128/1', '170']
const SHOT_ECRU = ['329', '129', '218', '027', '128', '184', '128/2', '302', '128/1', '170', '2785', '171', '186']

async function main() {
  let problems = 0
  const fail = (m: string) => { console.log(`✗ ${m}`); problems++ }

  const fils = await query<any>(`SELECT IDref_fil, reference FROM ref_fil`)
  const filsFixed = (await fixEncoding(fils, 'ref_fil', 'IDref_fil', ['reference'])) as any[]
  const fil = filsFixed.find((f) => String(f.reference ?? '').trim() === FIL_REFERENCE)
  if (!fil) {
    fail(`ref_fil "${FIL_REFERENCE}" not found — the fixture yarn was renamed or deleted`)
    await closeConnection(); process.exit(1)
  }
  const filId = Number(fil.IDref_fil)
  console.log(`fil "${FIL_REFERENCE}" → IDref_fil ${filId}`)

  const comps = await query<{ IDref_ecru: number; IDcolori_fil: number }>(
    `SELECT IDref_ecru, IDcolori_fil FROM composition_ecru WHERE IDref_fil = ${filId}`,
  )
  const refIds = (ids: number[]) => new Set(ids)

  const allRefIds = refIds(comps.map((c) => Number(c.IDref_ecru)))
  console.log(`all coloris     : ${allRefIds.size} refs (expected ${EXPECT_ALL})`)
  if (allRefIds.size !== EXPECT_ALL) fail(`expected ${EXPECT_ALL} refs, got ${allRefIds.size}`)

  // "ecru" is carried by several colori_fil ids; the endpoint groups by NAME,
  // so the guard must too or it would silently check a different thing.
  const coloriIds = Array.from(new Set(comps.map((c) => Number(c.IDcolori_fil)).filter((x) => x > 0)))
  const cRows = await query<any>(
    `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloriIds.join(',')})`,
  )
  const cFixed = (await fixEncoding(cRows, 'colori_fil', 'IDcolori_fil', ['reference'])) as any[]
  const ecruIds = new Set(
    cFixed.filter((c) => String(c.reference ?? '').trim() === 'ecru').map((c) => Number(c.IDcolori_fil)),
  )
  const ecruRefIds = refIds(comps.filter((c) => ecruIds.has(Number(c.IDcolori_fil))).map((c) => Number(c.IDref_ecru)))
  console.log(`coloris "ecru"  : ${ecruRefIds.size} refs (expected ${EXPECT_ECRU}), from ${ecruIds.size} colori_fil id(s)`)
  if (ecruRefIds.size !== EXPECT_ECRU) fail(`expected ${EXPECT_ECRU} refs for "ecru", got ${ecruRefIds.size}`)

  // Resolve references so the screenshot rows can be checked by name.
  const eRows = await query<Record<string, unknown>>(
    `SELECT * FROM ref_ecru WHERE IDref_ecru IN (${[...allRefIds].join(',')})`,
  )
  const shaped = eRows.map((r) => ({ IDref_ecru: Number(r.IDref_ecru), reference: (r.reference ?? '') as string }))
  const eFixed = (await fixEncoding(shaped, 'ref_ecru', 'IDref_ecru', ['reference'])) as any[]
  const nameById = new Map(eFixed.map((r) => [Number(r.IDref_ecru), String(r.reference ?? '').trim()]))
  const namesOf = (s: Set<number>) => new Set([...s].map((id) => nameById.get(id) ?? ''))

  const allNames = namesOf(allRefIds)
  const ecruNames = namesOf(ecruRefIds)
  for (const want of SHOT_ALL) {
    if (!allNames.has(want)) fail(`"${want}" is in the legacy screenshot but missing from the unfiltered list`)
  }
  for (const want of SHOT_ECRU) {
    if (!ecruNames.has(want)) fail(`"${want}" is in the legacy "ecru" screenshot but missing from the filtered list`)
  }
  if (problems === 0) console.log(`✓ all ${SHOT_ALL.length + SHOT_ECRU.length} screenshot rows present in the right lists`)

  await closeConnection()
  console.log(problems === 0 ? '\n✓ all checks passed' : `\n✗ ${problems} problem(s)`)
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
