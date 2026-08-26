// Guard for the « hors réf » marker (of-trm GET /:id → composition[].hors_ref):
// a yarn the OF knits that the reference's own composition_ecru does not list.
// Read-only; runs the API's exact predicate over the whole ledger and prints
// what the badge will show, so a regression is visible without opening a screen.
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0

async function main() {
  const ofs = await query<any>(
    `SELECT IDordre_fabrication, IDref_ecru, date_creation FROM ordre_fabrication`,
  )
  const asso = await query<any>(
    `SELECT IDordre_fabrication, IDref_fil, IDcolori_fil FROM asso_fil_of`,
  )
  const compo = await query<any>(`SELECT IDref_ecru, IDref_fil, IDcolori_fil FROM composition_ecru`)

  const refOf = new Map<number, number>()
  const dateOf = new Map<number, string>()
  for (const o of ofs) {
    refOf.set(n(o.IDordre_fabrication), n(o.IDref_ecru))
    dateOf.set(n(o.IDordre_fabrication), String(o.date_creation ?? ''))
  }
  const pairsByRef = new Map<number, Set<string>>()
  for (const c of compo) {
    const r = n(c.IDref_ecru)
    if (!pairsByRef.has(r)) pairsByRef.set(r, new Set())
    pairsByRef.get(r)!.add(`${n(c.IDref_fil)}:${n(c.IDcolori_fil)}`)
  }

  let flagged = 0
  let noCompo = 0
  const ofsFlagged = new Set<number>()
  const byYear = new Map<string, Set<number>>()
  for (const a of asso) {
    const ofId = n(a.IDordre_fabrication)
    const refPairs = pairsByRef.get(refOf.get(ofId) ?? 0)
    // API rule: false, never null, when the reference declares no composition
    // at all — "everything is off-sheet" is noise, not information.
    if (!refPairs || refPairs.size === 0) { noCompo++; continue }
    if (refPairs.has(`${n(a.IDref_fil)}:${n(a.IDcolori_fil)}`)) continue
    flagged++
    ofsFlagged.add(ofId)
    const y = String(dateOf.get(ofId) ?? '').slice(0, 4) || '????'
    if (!byYear.has(y)) byYear.set(y, new Set())
    byYear.get(y)!.add(ofId)
  }

  console.log(`lignes asso_fil_of            : ${asso.length}`)
  console.log(`  marquées « hors réf »       : ${flagged}`)
  console.log(`  sur des OF sans composition : ${noCompo} (jamais marquées, par règle)`)
  console.log(`OF concernés : ${ofsFlagged.size} / ${ofs.length}`)
  console.log('\npar année de création de l’OF :')
  for (const y of Array.from(byYear.keys()).sort()) {
    const total = ofs.filter((o) => String(o.date_creation ?? '').startsWith(y)).length
    console.log(`  ${y} : ${String(byYear.get(y)!.size).padStart(4)} / ${String(total).padStart(4)}  (${((byYear.get(y)!.size / Math.max(1, total)) * 100).toFixed(1)} %)`)
  }
  const ok = flagged > 0 && ofsFlagged.size < ofs.length * 0.5
  console.log(ok
    ? '\n✓ Le marqueur discrimine (ni vide, ni allumé sur la moitié du registre).'
    : '\n⚠ Marqueur suspect — vide, ou allumé partout : vérifier le prédicat.')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
