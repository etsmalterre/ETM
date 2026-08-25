/**
 * Ad-hoc, read-only. Two point-in-time reconstructions at comparable dates:
 *
 *   1. STOCK — écru pieces and finished rolls physically held at date D
 *      (produced on or before D, not yet shipped as of D, écru not yet dyed
 *      into a roll as of D). Answers "did inventory build up?" like-for-like,
 *      which a "still in stock today, by year" tally cannot: recent goods
 *      always dominate that one simply because they have had less time to ship.
 *
 *   2. EXPÉDIÉ NON FACTURÉ — shipments made on or before D carrying no invoice
 *      line. Revenue earned but not yet recognised.
 *
 *   NODE_ENV=production node --import tsx src/scripts/analyse-encours.ts
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })
const { query, closeConnection } = await import('../lib/hfsql-auto.js')

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(0, 8)
const kg = (v: number) => Math.round(v).toLocaleString('fr-FR') + ' kg'
const DATES = ['20250728', '20260728']

async function main() {
  // ── expedition dates, by ligne_expedition
  const exps = await query<Record<string, unknown>>(`SELECT IDexpedition, DATE AS dexp FROM expedition`)
  const expDate = new Map<number, string>()
  for (const e of exps) expDate.set(n(e.IDexpedition), d8(e.dexp))
  const lignes = await query<Record<string, unknown>>(
    `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition`,
  )
  const leDate = new Map<number, string>()
  for (const l of lignes) {
    const d = expDate.get(n(l.IDexpedition))
    if (d) leDate.set(n(l.IDligne_expedition), d)
  }

  // ── écru: production date, shipment date, and the date it became a roll
  const ecru = await query<Record<string, unknown>>(
    `SELECT IDstock_ecru, poids, date_saisie, IDligne_expedition_ETM FROM stock_ecru WHERE IDsociete = 1`,
  )
  const fini = await query<Record<string, unknown>>(
    `SELECT IDstock_fini, IDstock_ecru, poids, date_saisie, IDligne_expedition FROM stock_fini`,
  )
  const dyedOn = new Map<number, string>() // IDstock_ecru -> date the roll was created
  for (const f of fini) {
    const src = n(f.IDstock_ecru)
    if (src > 0) dyedOn.set(src, d8(f.date_saisie))
  }

  const before = (d: string, ref: string) => !!d && d <= ref
  console.log('STOCK PHYSIQUE RECONSTITUÉ À DATE (société 1)\n')
  for (const D of DATES) {
    let ec = 0, ekg = 0, fc = 0, fkg = 0
    for (const r of ecru) {
      const made = d8(r.date_saisie)
      if (!before(made, D)) continue
      const shipped = leDate.get(n(r.IDligne_expedition_ETM))
      if (shipped && before(shipped, D)) continue
      const dyed = dyedOn.get(n(r.IDstock_ecru))
      if (dyed && before(dyed, D)) continue
      ec++; ekg += n(r.poids)
    }
    for (const r of fini) {
      const made = d8(r.date_saisie)
      if (!before(made, D)) continue
      const shipped = leDate.get(n(r.IDligne_expedition))
      if (shipped && before(shipped, D)) continue
      fc++; fkg += n(r.poids)
    }
    console.log(`  ${D}`)
    console.log(`    écru en stock  : ${String(ec).padStart(5)} pièces   ${kg(ekg).padStart(12)}`)
    console.log(`    finis en stock : ${String(fc).padStart(5)} rouleaux  ${kg(fkg).padStart(12)}`)
    console.log(`    TOTAL          : ${String(ec + fc).padStart(5)} unités    ${kg(ekg + fkg).padStart(12)}`)
  }

  // ── expédié non facturé
  console.log('\n' + '═'.repeat(70) + '\nEXPÉDIÉ NON FACTURÉ (marchandise partie, produit non comptabilisé)\n')
  const lf = await query<Record<string, unknown>>(
    `SELECT IDligne_expedition, IDfacture FROM ligne_facture`,
  )
  const invoicedLe = new Set<number>()
  for (const r of lf) { const id = n(r.IDligne_expedition); if (id > 0 && n(r.IDfacture) > 0) invoicedLe.add(id) }

  // weight shipped per ligne_expedition, from the rolls that carry it
  const poidsLe = new Map<number, number>()
  for (const f of fini) {
    const le = n(f.IDligne_expedition)
    if (le > 0) poidsLe.set(le, (poidsLe.get(le) ?? 0) + n(f.poids))
  }
  for (const r of ecru) {
    const le = n(r.IDligne_expedition_ETM)
    if (le > 0) poidsLe.set(le, (poidsLe.get(le) ?? 0) + n(r.poids))
  }

  for (const D of DATES) {
    let cnt = 0, wkg = 0, exSet = new Set<number>()
    for (const l of lignes) {
      const le = n(l.IDligne_expedition)
      const d = leDate.get(le)
      if (!d || !before(d, D)) continue
      if (invoicedLe.has(le)) continue
      cnt++; wkg += poidsLe.get(le) ?? 0; exSet.add(n(l.IDexpedition))
    }
    // restrict to the 12 months preceding D, so ancient un-invoiced junk doesn't drown the signal
    const from = String(Number(D.slice(0, 4)) - 1) + D.slice(4)
    let rc = 0, rkg = 0
    const rex = new Set<number>()
    for (const l of lignes) {
      const le = n(l.IDligne_expedition)
      const d = leDate.get(le)
      if (!d || !before(d, D) || d < from) continue
      if (invoicedLe.has(le)) continue
      rc++; rkg += poidsLe.get(le) ?? 0; rex.add(n(l.IDexpedition))
    }
    console.log(`  au ${D}`)
    console.log(`    toutes périodes    : ${String(cnt).padStart(5)} lignes / ${String(exSet.size).padStart(4)} expéditions  ${kg(wkg).padStart(12)}`)
    console.log(`    12 mois précédents : ${String(rc).padStart(5)} lignes / ${String(rex.size).padStart(4)} expéditions  ${kg(rkg).padStart(12)}`)
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
