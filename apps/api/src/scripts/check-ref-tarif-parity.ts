/**
 * Regression check for the Finis > Tarifs simulator pricing
 * (`lib/pricing-ref-tarif.ts`) against the legacy FI_Tarifs screen.
 *
 * The expected values below were read off the legacy WinDev UI on 2026-07-29
 * for two live simulations. They pin the two reverse-engineered rules that the
 * catalog pricer does NOT share:
 *   - the ennoblissement multiplier is `ref_tarif.multiplicateur`, not the
 *     rendement-derived MATEL uplift (522 has rendement 3.78 → MATEL would say
 *     x1.03, and every price below only matches with x1);
 *   - the 30-roll tranche still uses the hardcoded 3% shipping rate even though
 *     the row stores port_pct = 5.
 *
 * Run: npx tsx src/scripts/check-ref-tarif-parity.ts
 * Note this reads the LOCAL dev copy of the database — the two simulations must
 * still exist and be unedited for the check to be meaningful.
 */
import { query, closeConnection, fixEncoding } from '../lib/hfsql-auto.js'
import { calcTarifSimulation, type TarifSimInput } from '../lib/pricing-ref-tarif.js'

interface Expectation {
  IDref_tarif: number
  label: string
  /** Prix de vente au Ml for each of the 9 tranches, as printed by legacy. */
  prix_ml: Array<number | null>
  /** Qté (Ml) column. */
  qte_ml: Array<number | null>
  /** Selected-tranche breakdown, tranche index 0 ("< 1 rlx"). */
  tranche0?: { fil: number; tricotage: number; traitement: number; teinture: number; revient: number; venteKg: number }
}

const EXPECTED: Expectation[] = [
  {
    IDref_tarif: 522,
    label: 'Copie de 081A (simple teinture, tous coloris)',
    prix_ml: [14.78, 11.83, 9.03, 7.56, 6.37, 5.62, 4.79, 3.98, 3.63],
    qte_ml: [76, 76, 151, 227, 303, 378, 757, 1135, 2271],
    tranche0: { fil: 3.51, tricotage: 2.07, traitement: 0.98, teinture: 14.68, revient: 21.24, venteKg: 55.88 },
  },
  {
    IDref_tarif: 514,
    label: '158 ecru+ capsules (sans teinture)',
    // Legacy screenshot only exposes the first rows of the tranche table.
    prix_ml: [18.15, 14.52, 13.2, 10.83, 10.0, 9.22, 8.09, 7.02, 6.42],
    qte_ml: [58, 58, 116, 174, 232, 290, 581, 871, 1742],
    tranche0: { fil: 4.76, tricotage: 2.07, traitement: 13.17, teinture: 0, revient: 0, venteKg: 0 },
  },
]

function money(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}
function num4(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0
}

async function buildInput(id: number): Promise<TarifSimInput | null> {
  const rows = await query<any>(
    `SELECT IDref_tarif, rendement, poids_rouleau, prix_tricotage, port_fixe, port_pct,
            multiplicateur, IDteinture
       FROM ref_tarif WHERE IDref_tarif = ${id}`,
  )
  if (rows.length === 0) return null
  const r = rows[0]

  const filRows = await query<any>(
    `SELECT IDasso_fil_tarif, IDref_fil, IDcolori_fil, pourcentage, prix
       FROM asso_fil_tarif WHERE IDref_tarif = ${id} ORDER BY IDasso_fil_tarif`,
  )
  const filIds = Array.from(new Set(filRows.map((f: any) => Number(f.IDref_fil)).filter((n: number) => n > 0)))
  const labels = new Map<number, string | null>()
  if (filIds.length > 0) {
    const refs = await query<any>(`SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${filIds.join(',')})`)
    const fixed = (await fixEncoding(refs, 'ref_fil', 'IDref_fil', ['reference'])) as any[]
    for (const f of fixed) labels.set(Number(f.IDref_fil), f.reference ?? null)
  }

  const trtRows = await query<any>(
    `SELECT IDasso_traitement_tarif, IDtraitement FROM asso_traitement_tarif WHERE IDref_tarif = ${id}`,
  )
  const trtIds = Array.from(new Set(trtRows.map((t: any) => Number(t.IDtraitement)).filter((n: number) => n > 0)))
  const trtLabels = new Map<number, string | null>()
  if (trtIds.length > 0) {
    const trt = await query<any>(`SELECT IDtraitement, designation FROM traitement WHERE IDtraitement IN (${trtIds.join(',')})`)
    const fixed = (await fixEncoding(trt, 'traitement', 'IDtraitement', ['designation'])) as any[]
    for (const t of fixed) trtLabels.set(Number(t.IDtraitement), t.designation ?? null)
  }

  const IDteinture = Number(r.IDteinture) || 0
  let teintureLabel: string | null = null
  if (IDteinture > 0) {
    const t = await query<any>(`SELECT IDteinture, designation_externe FROM teinture WHERE IDteinture = ${IDteinture}`)
    const fixed = (await fixEncoding(t, 'teinture', 'IDteinture', ['designation_externe'])) as any[]
    teintureLabel = fixed[0]?.designation_externe ?? null
  }

  return {
    IDref_tarif: id,
    rendement: num4(r.rendement),
    poids_rouleau: num4(r.poids_rouleau),
    prix_tricotage: money(r.prix_tricotage),
    port_mode: Number(r.port_pct) > 0 ? 'pct' : 'kg',
    port_fixe: money(r.port_fixe),
    port_pct: num4(r.port_pct),
    multiplicateur: num4(r.multiplicateur),
    IDteinture,
    teinture_label: teintureLabel,
    fils: filRows.map((f: any) => ({
      IDasso_fil_tarif: Number(f.IDasso_fil_tarif),
      IDref_fil: Number(f.IDref_fil),
      ref_label: labels.get(Number(f.IDref_fil)) ?? null,
      IDcolori_fil: Number(f.IDcolori_fil),
      colori_label: null,
      pourcentage: num4(f.pourcentage),
      prix: money(f.prix),
    })),
    traitements: trtRows.map((t: any) => ({
      IDasso_traitement_tarif: Number(t.IDasso_traitement_tarif),
      IDtraitement: Number(t.IDtraitement),
      designation: trtLabels.get(Number(t.IDtraitement)) ?? null,
    })),
  }
}

async function main() {
  let failures = 0
  let checks = 0

  for (const exp of EXPECTED) {
    console.log(`\n=== ${exp.label} (IDref_tarif ${exp.IDref_tarif}) ===`)
    const input = await buildInput(exp.IDref_tarif)
    if (!input) {
      console.log('  SKIP — simulation absente de cette base')
      continue
    }
    const result = await calcTarifSimulation(input)
    if (result.tranches.length === 0) {
      console.log(`  FAIL — aucun tarif calculé (blockers: ${result.blockers.join(', ')})`)
      failures++
      continue
    }

    for (let i = 0; i < result.tranches.length; i++) {
      const t = result.tranches[i]
      const rowLabel = i === 0 ? '< 1' : String(t.rolls)

      const expMl = exp.qte_ml[i]
      if (expMl != null) {
        checks++
        const ok = t.qte_ml === expMl
        if (!ok) failures++
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${rowLabel.padStart(3)} rlx  Qté Ml  attendu ${expMl}  obtenu ${t.qte_ml}`)
      }

      const expPrix = exp.prix_ml[i]
      if (expPrix != null) {
        checks++
        const ok = Math.abs(t.moPrixDeVenteAuMl - expPrix) < 0.005
        if (!ok) failures++
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${rowLabel.padStart(3)} rlx  €/Ml    attendu ${expPrix.toFixed(2)}  obtenu ${t.moPrixDeVenteAuMl.toFixed(2)}`)
      }
    }

    if (exp.tranche0) {
      const t = result.tranches[0]
      const parts: Array<[string, number, number]> = [
        ['fil', exp.tranche0.fil, t.moFil],
        ['tricotage', exp.tranche0.tricotage, t.moTricotage],
        ['traitement', exp.tranche0.traitement, t.moTraitements],
        ['teinture', exp.tranche0.teinture, t.moTeinte],
      ]
      if (exp.tranche0.revient > 0) parts.push(['revient', exp.tranche0.revient, t.moRevient])
      if (exp.tranche0.venteKg > 0) parts.push(['vente €/Kg', exp.tranche0.venteKg, t.moPrixDeVenteAuKg])
      for (const [name, want, got] of parts) {
        checks++
        const ok = Math.abs(got - want) < 0.005
        if (!ok) failures++
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} tranche <1  ${name.padEnd(11)} attendu ${want.toFixed(2)}  obtenu ${got.toFixed(2)}`)
      }
    }
  }

  console.log(`\n${checks - failures}/${checks} contrôles OK`)
  await closeConnection()
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
