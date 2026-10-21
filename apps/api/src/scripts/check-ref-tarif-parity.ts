/**
 * Parity check for Finis › Tarifs (LIVA #1298): a simulation seeded from a
 * client's reference must start at that reference's EXACT catalogue price —
 * the whole comparison (catalogue / client price / simulated, gain per
 * tranche) rests on it.
 *
 * For every (ref_fini × coloris) the catalogue prices, it builds the
 * simulation the route would create (`seedFromRefFini`), prices it with
 * `calcTarifSimulation` and compares the 9 tranches €/Ml and €/Kg with
 * `calcTarifRefFini`. Nothing is written.
 *
 * Until #1298 this script pinned the legacy simulator instead (46/46 on
 * simulations 522 and 514): that simulator ignored the MATEL rendement
 * multiplier, which is precisely the bug the ticket reported — the legacy
 * figures are no longer the reference.
 *
 * Run: npx tsx src/scripts/check-ref-tarif-parity.ts [--limit N] [--ref ID]
 */
import '../load-env.js'
import { closeConnection } from '../lib/hfsql-auto.js'
import { closeMpsPg, mpsPg } from '../lib/mps-pg.js'
import { calcTarifRefFini } from '../lib/pricing-fini-tarif.js'
import { calcTarifSimulation, type TarifSimInput } from '../lib/pricing-ref-tarif.js'
import { seedFromRefFini } from '../lib/tarif-simulation-sources.js'
import { FRAIS_GESTION_FIL_PCT } from '../lib/fil-frais-gestion.js'

function arg(name: string): number | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) || null : null
}

async function main() {
  const sql = mpsPg()
  const limit = arg('--limit')
  const onlyRef = arg('--ref')

  const refs = await sql<{ idref_fini: number; reference: string | null; avec_teinture: number | null; idref_ecru: number }[]>`
    SELECT idref_fini, reference, avec_teinture, idref_ecru FROM ref_fini
     WHERE idref_ecru > 0 AND rendement > 0 ${onlyRef ? sql`AND idref_fini = ${onlyRef}` : sql``}
     ORDER BY idref_fini`
  const teintures = await sql<{ idteinture: number; designation_externe: string | null; prix_gots: number | null }[]>`
    SELECT idteinture, designation_externe, prix_gots FROM teinture`

  let checked = 0
  let failed = 0
  let skipped = 0
  for (const ref of refs) {
    const coloris = Number(ref.avec_teinture) !== 0
      ? await sql<{ id: number }[]>`SELECT idref_fini_colori AS id FROM ref_fini_colori WHERE idref_fini = ${ref.idref_fini} ORDER BY idref_fini_colori`
      : await sql<{ id: number }[]>`SELECT idcolori_ecru AS id FROM colori_ecru WHERE idref_ecru = ${ref.idref_ecru} ORDER BY idcolori_ecru`
    for (const { id: col } of coloris) {
      if (limit && checked >= limit) break
      const catalogue = await calcTarifRefFini(ref.idref_fini, Number(col))
      if (catalogue.tranches.length === 0) { skipped++; continue }
      const seed = await seedFromRefFini(sql, ref.idref_fini, Number(col))
      if (!seed) { skipped++; continue }
      const trt = await sql<{ idtraitement: number; designation: string | null }[]>`
        SELECT idtraitement, designation FROM traitement WHERE idtraitement IN ${sql(seed.traitements.length ? seed.traitements : [0])}`
      const designation = new Map(trt.map((t) => [Number(t.idtraitement), t.designation]))
      const teinture = teintures.find((t) => Number(t.idteinture) === (seed.v.idteinture ?? 0))
      const input: TarifSimInput = {
        IDref_tarif: 0,
        rendement: seed.v.rendement ?? 0,
        poids_rouleau: seed.v.poids_rouleau ?? 0,
        prix_tricotage: seed.v.prix_tricotage ?? 0,
        port_mode: 'pct',
        port_fixe: 0,
        port_pct: 5,
        mult_auto: true,
        multiplicateur: 0,
        ajust_ennoblissement: 0,
        frais_gestion_fil: FRAIS_GESTION_FIL_PCT,
        gots: seed.v.gots === 1,
        IDteinture: seed.v.idteinture ?? 0,
        teinture_label: teinture?.designation_externe ?? null,
        prix_gots: Number(teinture?.prix_gots) || 0,
        fils: seed.fils.map((f, i) => ({
          IDasso_fil_tarif: i, IDref_fil: f.idref_fil, ref_label: null, IDcolori_fil: f.idcolori_fil, colori_label: null,
          pourcentage: f.pourcentage, prix_achat: f.prix_achat,
        })),
        traitements: seed.traitements.map((id, i) => ({ IDasso_traitement_tarif: i, IDtraitement: id, designation: designation.get(id) ?? null })),
      }
      const sim = await calcTarifSimulation(input)
      checked++
      const diffs: string[] = []
      catalogue.tranches.forEach((t, i) => {
        const s = sim.tranches[i]
        if (!s) { diffs.push(`t${i}: absente`); return }
        if (s.moPrixDeVenteAuMl !== t.moPrixDeVenteAuMl || s.moPrixDeVenteAuKg !== t.moPrixDeVenteAuKg) {
          diffs.push(`t${i}: ${t.moPrixDeVenteAuMl}/${t.moPrixDeVenteAuKg} ≠ ${s.moPrixDeVenteAuMl}/${s.moPrixDeVenteAuKg}`)
        }
      })
      if (diffs.length > 0) {
        failed++
        console.log(`✗ ${ref.reference} (ref ${ref.idref_fini}, coloris ${col}): ${diffs.join(' · ')}`)
      }
    }
    if (limit && checked >= limit) break
  }
  console.log(`\n${checked - failed}/${checked} (référence × coloris) identiques au prix catalogue${skipped ? `, ${skipped} sans prix catalogue` : ''}.`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await closeMpsPg(); await closeConnection() })
