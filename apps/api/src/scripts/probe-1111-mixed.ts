/** #1111 follow-up: how often do an expedition's rolls span >1 magasin, and
 *  do the sous-traitants used as magasins carry an adresse row? Read-only. */
import { query, closeConnection } from '../lib/hfsql-auto.js'

async function main() {
  const lines = await query<any>(
    `SELECT le.IDligne_expedition, le.IDexpedition FROM ligne_expedition le`,
  )
  const leToExp = new Map<number, number>(
    lines.map((l: any) => [Number(l.IDligne_expedition), Number(l.IDexpedition)]),
  )
  // ETM expeditions only
  const heads = await query<any>(`SELECT IDexpedition FROM expedition WHERE IDsociete = 1`)
  const etm = new Set(heads.map((h: any) => Number(h.IDexpedition)))

  const [fini, ecru] = await Promise.all([
    query<any>(`SELECT IDstock_fini, IDligne_expedition, IDmagasin FROM stock_fini WHERE IDligne_expedition > 0`),
    query<any>(`SELECT IDstock_ecru, IDligne_expedition_ETM, IDmagasin FROM stock_ecru WHERE IDligne_expedition_ETM > 0`),
  ])
  const byExp = new Map<number, Set<number>>()
  const add = (le: number, mag: number) => {
    const exp = leToExp.get(le)
    if (!exp || !etm.has(exp)) return
    if (!byExp.has(exp)) byExp.set(exp, new Set())
    byExp.get(exp)!.add(mag)
  }
  for (const r of fini) add(Number(r.IDligne_expedition), Number(r.IDmagasin) || 0)
  for (const r of ecru) add(Number(r.IDligne_expedition_ETM), Number(r.IDmagasin) || 0)

  let single0 = 0, singleN = 0, mixed = 0
  const magUse = new Map<number, number>()
  for (const [, mags] of byExp) {
    if (mags.size > 1) mixed++
    else if (mags.has(0)) single0++
    else singleN++
    for (const m of mags) magUse.set(m, (magUse.get(m) || 0) + 1)
  }
  console.log(`ETM expeditions with rolls: ${byExp.size}`)
  console.log(`  single magasin = Ets Malterre : ${single0}`)
  console.log(`  single magasin ≠ 0            : ${singleN}`)
  console.log(`  MIXED (several magasins)      : ${mixed}`)

  // Which sous-traitants serve as magasins, and do they have an adresse row?
  const magIds = [...magUse.keys()].filter((m) => m > 0)
  if (magIds.length) {
    const sst = await query<any>(`SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${magIds.join(',')})`)
    const adr = await query<any>(
      `SELECT IDadresse, IDsous_traitant, nom, adresse1, cp, ville, est_defaut FROM adresse WHERE IDsous_traitant IN (${magIds.join(',')})`,
    )
    for (const s of sst) {
      const rows = adr.filter((a: any) => Number(a.IDsous_traitant) === Number(s.IDsous_traitant))
      console.log(`magasin ${s.IDsous_traitant} ${s.nom}: used by ${magUse.get(Number(s.IDsous_traitant))} exp, ${rows.length} adresse(s)` +
        (rows.length ? ` — ex: ${rows[0].nom ?? ''} ${rows[0].adresse1 ?? ''} ${rows[0].cp ?? ''} ${rows[0].ville ?? ''} (defaut=${rows[0].est_defaut})` : '  ⚠ NO ADDRESS'))
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => closeConnection())
