// LIVA #1175 — fini rolls received before the #1158 fix carry IDColoris = 0
// when their ref is wash-only (ref_fini.avec_teinture = 0): the ennoblisseur
// line had no coloris (the picker offered « Aucun »), the reception inherited
// the line's 0, and a cut copied it. Finis › Stock then shows « — ».
// Repairs the rolls AND the ennoblisseur lines that fed them (a later
// reception on the line inherits the line's coloris again).
//
//   tsx --env-file=.env.development src/scripts/repair-1175-coloris-fini.ts                 # dry run, since 20260701
//   node --env-file=.env --import tsx src/scripts/repair-1175-coloris-fini.ts --since=20260101 --write
//
// Rule: the coloris of a wash-only fini is a colori_ecru of its écru
// (ref_fini.IDref_ecru). The roll takes its source écru piece's IDcolori_ecru
// when it belongs to that écru, else the écru's single colori_ecru when there is
// exactly one. Dyed refs (avec_teinture 1/2) and ambiguous cases are listed and
// skipped — a guess there would be a wrong coloris, not a missing one.
import { query, closeConnection } from '../lib/hfsql-auto.js'

interface Roll { id: number; numero: string; etat: number; IDref_fini: number; IDstock_ecru: number; src: number; ds: string }

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const since = (args.find((a) => a.startsWith('--since='))?.slice(8) ?? '20260701').replace(/\D/g, '')
  if (!/^\d{8}$/.test(since)) throw new Error('--since=YYYYMMDD')

  const rolls = await query<Roll>(
    `SELECT IDstock_fini AS id, numero, IDetat_stock_fini AS etat, IDref_fini, IDstock_ecru, IDref_commande_source AS src, date_saisie AS ds
       FROM stock_fini WHERE IDColoris = 0 AND date_saisie >= '${since}' ORDER BY IDstock_fini`,
  )
  console.log(`${rolls.length} fini roll(s) since ${since} with IDColoris = 0 (${write ? 'WRITE' : 'dry run'})`)
  if (rolls.length === 0) { await closeConnection(); return }

  const refIds = Array.from(new Set(rolls.map((r) => Number(r.IDref_fini)).filter((x) => x > 0)))
  const refs = await query<{ IDref_fini: number; reference: string; avec_teinture: number; IDref_ecru: number }>(
    `SELECT IDref_fini, reference, avec_teinture, IDref_ecru FROM ref_fini WHERE IDref_fini IN (${refIds.join(',')})`,
  )
  const refById = new Map(refs.map((r) => [Number(r.IDref_fini), r]))
  const ecruIds = Array.from(new Set(refs.map((r) => Number(r.IDref_ecru)).filter((x) => x > 0)))
  const coloris = ecruIds.length
    ? await query<{ IDcolori_ecru: number; IDref_ecru: number; reference: string }>(
        `SELECT IDcolori_ecru, IDref_ecru, reference FROM colori_ecru WHERE IDref_ecru IN (${ecruIds.join(',')})`,
      )
    : []
  const colorisByEcru = new Map<number, { id: number; reference: string }[]>()
  for (const c of coloris) {
    const k = Number(c.IDref_ecru)
    if (!colorisByEcru.has(k)) colorisByEcru.set(k, [])
    colorisByEcru.get(k)!.push({ id: Number(c.IDcolori_ecru), reference: String(c.reference ?? '').trim() })
  }
  const pieceIds = Array.from(new Set(rolls.map((r) => Number(r.IDstock_ecru)).filter((x) => x > 0)))
  const pieces = pieceIds.length
    ? await query<{ IDstock_ecru: number; IDcolori_ecru: number }>(
        `SELECT IDstock_ecru, IDcolori_ecru FROM stock_ecru WHERE IDstock_ecru IN (${pieceIds.join(',')})`,
      )
    : []
  const pieceColoris = new Map(pieces.map((p) => [Number(p.IDstock_ecru), Number(p.IDcolori_ecru) || 0]))

  const rollFix = new Map<number, { id: number; reference: string }>()
  const lineFix = new Map<number, { id: number; reference: string }>()
  let skipped = 0
  for (const r of rolls) {
    const ref = refById.get(Number(r.IDref_fini))
    const tag = `  roll ${r.id} ${r.numero} (${ref?.reference ?? '?'} état ${r.etat} ${String(r.ds).slice(0, 10)})`
    if (!ref) { skipped++; console.log(`${tag}: unknown ref — skipped`); continue }
    if (Number(ref.avec_teinture) !== 0) { skipped++; console.log(`${tag}: dyed ref, coloris cannot be guessed — skipped`); continue }
    const options = colorisByEcru.get(Number(ref.IDref_ecru)) ?? []
    const fromPiece = pieceColoris.get(Number(r.IDstock_ecru)) || 0
    const pick = options.find((o) => o.id === fromPiece) ?? (options.length === 1 ? options[0] : undefined)
    if (!pick) { skipped++; console.log(`${tag}: ${options.length} colori_ecru on écru ${ref.IDref_ecru}, none matching the source piece — skipped`); continue }
    rollFix.set(Number(r.id), pick)
    console.log(`${tag} → IDColoris ${pick.id} « ${pick.reference} »${fromPiece === pick.id ? ' (source piece)' : ' (single coloris of the écru)'}`)
    const src = Number(r.src) || 0
    if (src > 0 && !lineFix.has(src)) {
      const line = await query<{ IDColoris: number; type: number; IDreference: number }>(
        `SELECT IDColoris, type, IDreference FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${src}`,
      )
      const l = line[0]
      if (l && Number(l.IDColoris) === 0 && Number(l.type) === 2 && Number(l.IDreference) === Number(ref.IDref_fini)) {
        lineFix.set(src, pick)
        console.log(`    sst line ${src} (type 2, ${ref.reference}) has IDColoris 0 → ${pick.id}`)
      }
    }
  }
  if (write) {
    for (const [id, pick] of rollFix) await query(`UPDATE stock_fini SET IDColoris = ${pick.id} WHERE IDstock_fini = ${id} AND IDColoris = 0`)
    for (const [id, pick] of lineFix) await query(`UPDATE ligne_commande_sous_traitant SET IDColoris = ${pick.id} WHERE IDligne_commande_sous_traitant = ${id} AND IDColoris = 0`)
    console.log(`${rollFix.size} roll(s) + ${lineFix.size} line(s) updated, ${skipped} skipped`)
  } else {
    console.log(`${rollFix.size} roll(s) + ${lineFix.size} line(s) would be updated, ${skipped} skipped — re-run with --write`)
  }
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
