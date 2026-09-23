// PG migration review 2026-09-23 (windev_migration docs/plan.md § Review log, R13):
// five dossiers qualité point at an écru piece by a reference that does not
// spell the piece number the way the piece does.
//
//   dossier 124 says « 2574 »       for the piece « 257/4 »
//   dossier 140 says « 2676 »       for « 267/6 »
//   dossier 150 says « 2823 »       for « 282/3 »
//   dossier 172 says « 3153 »       for « 315/3 »
//   dossier  80 says « B897/1/166 » for « B8971166 »   (the other way round)
//
// It never showed, because HFSQL compares text ignoring spaces and punctuation:
// « 2574 » finds « 257/4 » today. PostgreSQL compares literally (R13: accepted
// on purpose — search stays case-insensitive, punctuation must be typed), so
// after the cutover those five traceability tabs would come up empty. The
// dossier's other link, `IDreference`, is dead: 0 on all five and set on only
// 2 of the 86 dossiers of this type, so the text IS the link.
//
// The piece is the physical object and owns its numbering, so the dossier is
// what gets corrected — including dossier 80, where the correction REMOVES
// slashes. Writing it now changes nothing for today's users: HFSQL already
// resolves both spellings. It only decides whether the page still works after
// the cutover.
//
// Safety: only a dossier whose reference matches EXACTLY ONE écru piece once
// punctuation is ignored, and which matches none exactly today, is touched —
// re-checked at write time, not trusted from this comment. Anything ambiguous
// is reported and skipped.
//
//   npx tsx src/scripts/pg-fix-dossier-refs.ts           # dry run: list, change nothing
//   npx tsx src/scripts/pg-fix-dossier-refs.ts --write   # apply (prod: NODE_ENV=production, on the API host)

import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { esc } from '../lib/sst-shared.js'

const WRITE = process.argv.includes('--write')
/** Refuse to write more than this: the review measured 5 on 2026-09-23. */
const MAX_ROWS = 10

/** « 257/4 » → « 2574 »: what HFSQL effectively compares. */
const loose = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()

interface Fix { id: number; from: string; to: string }

async function findFixes(): Promise<{ fixes: Fix[]; ambiguous: string[] }> {
  // type_reference '1' = numéro de pièce écru (routes/dossiers-qualite.ts).
  const dossiers = await query<{ id: unknown; ref: unknown }>(
    `SELECT IDdossier_qualite AS id, reference AS ref FROM dossier_qualite WHERE type_reference = '1'`,
  )
  const pieces = await query<{ numero: unknown }>(`SELECT numero FROM stock_ecru`)

  // Every piece number, grouped by its punctuation-free form.
  const byLoose = new Map<string, Set<string>>()
  const exact = new Set<string>()
  for (const p of pieces) {
    const n = String(p.numero ?? '').trim()
    if (!n) continue
    exact.add(n)
    const k = loose(n)
    if (!k) continue
    if (!byLoose.has(k)) byLoose.set(k, new Set())
    byLoose.get(k)!.add(n)
  }

  const fixes: Fix[] = []
  const ambiguous: string[] = []
  for (const d of dossiers) {
    const ref = String(d.ref ?? '').trim()
    const id = Number(d.id)
    if (!ref || !Number.isFinite(id)) continue
    if (exact.has(ref)) continue                    // already spelled like its piece
    const candidates = byLoose.get(loose(ref))
    if (!candidates || candidates.size === 0) continue  // points at nothing, punctuation or not
    if (candidates.size > 1) {
      ambiguous.push(`dossier ${id}: « ${ref} » matches ${[...candidates].join(', ')}`)
      continue
    }
    const to = [...candidates][0]
    if (to !== ref) fixes.push({ id, from: ref, to })
  }
  return { fixes, ambiguous }
}

async function main() {
  const { fixes, ambiguous } = await findFixes()
  console.log(`${fixes.length} dossier(s) qualité whose reference does not spell its piece the way the piece does`)
  for (const f of fixes) console.log(`  dossier ${f.id}: « ${f.from} » -> « ${f.to} »`)
  for (const a of ambiguous) console.log(`  SKIPPED (ambiguous) ${a}`)

  if (!fixes.length) { console.log('\nnothing to correct'); return }
  if (!WRITE) { console.log('\ndry run: nothing written (pass --write)'); return }
  if (fixes.length > MAX_ROWS) throw new Error(`${fixes.length} rows > MAX_ROWS ${MAX_ROWS}: look before writing`)

  let done = 0
  for (const f of fixes) {
    // Pure ASCII (digits, letters, '/'), so a plain quoted literal is right;
    // esc() still doubles any quote. Column names verified against the HFSQL
    // catalog 2026-09-23 — naming a column it does not have takes the server
    // down on Linux (CLAUDE.md § HFSQL).
    await query(`UPDATE dossier_qualite SET reference = '${esc(f.to)}' WHERE IDdossier_qualite = ${f.id}`)
    done++
  }
  const left = await findFixes()
  console.log(`\nwritten: ${done}; still mismatched: ${left.fixes.length}`)
  if (left.fixes.length) process.exitCode = 1
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection().catch(() => {}).then(() => process.exit()))
