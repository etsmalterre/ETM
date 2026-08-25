/**
 * Ad-hoc, read-only: is the margin drop matched by a physical build-up of
 * inventory that the compte de résultat never neutralises?
 *
 *   NODE_ENV=production node --import tsx src/scripts/analyse-stock.ts
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })
const { query, closeConnection } = await import('../lib/hfsql-auto.js')

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const eur = (v: number) => Math.round(v).toLocaleString('fr-FR') + ' €'
const kg = (v: number) => Math.round(v).toLocaleString('fr-FR') + ' kg'
const yr = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 4)

async function main() {
  // ── 1. The stock-variation account, read with its real PK this time.
  const cls = await query<Record<string, unknown>>(
    `SELECT IDcompte_compta, numero, libelle FROM compte_compta WHERE id_societe = 1`,
  )
  const variation = cls.filter((c) => /^(603|713|71)/.test(String(n(c.numero))))
  console.log('Comptes de variation de stock (603x / 71x) au plan comptable ETM :')
  for (const c of variation) console.log(`  ${n(c.numero)}  ${String(c.libelle ?? '').trim()}`)
  for (const c of variation) {
    const rows = await query<Record<string, unknown>>(
      `SELECT DATE, debit, credit FROM releve_compta WHERE IDcompte_compta = ${n(c.IDcompte_compta)}`,
    )
    const byY = new Map<string, { d: string; v: number }>()
    for (const r of rows) {
      const d = String(r.DATE ?? '').replace(/\D/g, '')
      if (!/^\d{8}$/.test(d)) continue
      const y = d.slice(0, 4)
      const cur = byY.get(y)
      if (!cur || d > cur.d) byY.set(y, { d, v: n(r.debit) - n(r.credit) })
    }
    console.log(`\n  ${n(c.numero)} — dernier solde de chaque année (${rows.length} lignes de relevé) :`)
    for (const [y, o] of [...byY.entries()].sort()) console.log(`    ${y}  (arrêté ${o.d})  ${eur(o.v)}`)
    // and specifically the two July anchors
    for (const d of ['20250728', '20260728']) {
      const hit = rows.find((r) => String(r.DATE ?? '').replace(/\D/g, '') === d)
      console.log(`    ${d}  ${hit ? eur(n(hit.debit) - n(hit.credit)) : '(aucune ligne de relevé)'}`)
    }
  }

  // ── 2. Yarn: what is in the building, and what came in per year
  console.log('\n' + '═'.repeat(78) + '\nFIL')
  const fil = await query<Record<string, unknown>>(
    `SELECT IDstock_fil, IDref_fil, stock, stock_initial, date_entree FROM stock_fil`,
  )
  const enStock = fil.filter((r) => n(r.stock) > 0)
  console.log(`  En stock aujourd'hui : ${enStock.length} lots, ${kg(enStock.reduce((t, r) => t + n(r.stock), 0))}`)
  const refs = await query<Record<string, unknown>>(`SELECT IDref_fil, prix_kg FROM ref_fil`)
  const prix = new Map<number, number>()
  for (const r of refs) prix.set(n(r.IDref_fil), n(r.prix_kg))
  const valo = enStock.reduce((t, r) => t + n(r.stock) * (prix.get(n(r.IDref_fil)) ?? 0), 0)
  console.log(`  Valorisation (stock × prix_kg catalogue) : ${eur(valo)}`)
  const entreesParAn = new Map<string, { lots: number; kg: number }>()
  for (const r of fil) {
    const y = yr(r.date_entree)
    if (!/^\d{4}$/.test(y)) continue
    const e = entreesParAn.get(y) ?? { lots: 0, kg: 0 }
    e.lots++; e.kg += n(r.stock_initial)
    entreesParAn.set(y, e)
  }
  console.log('  Entrées de fil par année (stock_initial) :')
  for (const [y, e] of [...entreesParAn.entries()].sort().slice(-6)) console.log(`    ${y}  ${String(e.lots).padStart(5)} lots  ${kg(e.kg).padStart(14)}`)
  // reste en stock, par annee d'entree — le vieillissement du stock
  const resteParAn = new Map<string, number>()
  for (const r of enStock) {
    const y = yr(r.date_entree)
    if (!/^\d{4}$/.test(y)) continue
    resteParAn.set(y, (resteParAn.get(y) ?? 0) + n(r.stock))
  }
  console.log("  Dont ENCORE en stock aujourd'hui, par année d'entrée :")
  for (const [y, v] of [...resteParAn.entries()].sort().slice(-6)) console.log(`    ${y}  ${kg(v).padStart(14)}`)

  // ── 3. Écru (tombé de métier) still in stock, by year of production
  console.log('\n' + '═'.repeat(78) + '\nÉCRU (tombé de métier) ETM — encore en stock aujourd\'hui')
  const ecru = await query<Record<string, unknown>>(
    `SELECT IDstock_ecru, poids, date_saisie FROM stock_ecru
     WHERE IDsociete = 1 AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)`,
  )
  const finiChild = await query<Record<string, unknown>>(`SELECT IDstock_ecru FROM stock_fini`)
  const consumed = new Set<number>(finiChild.map((r) => n(r.IDstock_ecru)).filter((x) => x > 0))
  const ecruLibre = ecru.filter((r) => !consumed.has(n(r.IDstock_ecru)))
  const ecruParAn = new Map<string, { c: number; kg: number }>()
  for (const r of ecruLibre) {
    const y = yr(r.date_saisie); if (!/^\d{4}$/.test(y)) continue
    const e = ecruParAn.get(y) ?? { c: 0, kg: 0 }; e.c++; e.kg += n(r.poids); ecruParAn.set(y, e)
  }
  for (const [y, e] of [...ecruParAn.entries()].sort().slice(-6)) console.log(`    ${y}  ${String(e.c).padStart(5)} pièces  ${kg(e.kg).padStart(14)}`)

  // ── 4. Fini still in stock, by year
  console.log('\n' + '═'.repeat(78) + '\nROULEAUX FINIS — encore en stock aujourd\'hui (non expédiés)')
  const fini = await query<Record<string, unknown>>(
    `SELECT IDstock_fini, poids, date_saisie FROM stock_fini
     WHERE (IDligne_expedition IS NULL OR IDligne_expedition = 0)`,
  )
  const finiParAn = new Map<string, { c: number; kg: number }>()
  for (const r of fini) {
    const y = yr(r.date_saisie); if (!/^\d{4}$/.test(y)) continue
    const e = finiParAn.get(y) ?? { c: 0, kg: 0 }; e.c++; e.kg += n(r.poids); finiParAn.set(y, e)
  }
  for (const [y, e] of [...finiParAn.entries()].sort().slice(-6)) console.log(`    ${y}  ${String(e.c).padStart(5)} rouleaux  ${kg(e.kg).padStart(14)}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
