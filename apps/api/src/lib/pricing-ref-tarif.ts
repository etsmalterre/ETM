// Tarif SIMULATOR pricing — the engine behind Finis › Tarifs (legacy
// `FI_Tarifs.wdw`). Where `calcTarifRefFini` prices a real `ref_fini`
// (everything read from the catalog), this module prices a **`ref_tarif` row**:
// a what-if record whose composition, treatments and every physical parameter
// are typed by the user, plus the levers of a price study (#1298).
//
// Since LIVA #1298 there is ONE set of maths: this module only gathers the
// simulation's inputs and hands them to `assembleTarifFini` /
// `priceTrancheLibre` (pricing-fini-tarif.ts) with `leviers` set. A simulation
// copied from a reference therefore starts at the reference's exact catalogue
// price — `check-ref-tarif-parity.ts` pins it over every reference. Until then
// the simulator had its own copy of the formulas and had drifted: no MATEL
// rendement multiplier (Isabelle's ticket), no GOTS supplement.
//
// The levers a simulation adds on top of the catalogue rules:
//   • each yarn's PURCHASE price (`asso_fil_tarif.prix_achat`) and the
//     frais de gestion rate on yarn (lib/fil-frais-gestion.ts, 5 % by default);
//   • the knitting price (`prix_tricotage`, typed — a sample has no écru);
//   • the ennoblissement: MATEL's grid (`mult_auto = 1`) or a manual ratio
//     (`multiplicateur`, the legacy field), plus an adjustment in percent on
//     every dyer price, plus GOTS;
//   • shipping: percentage (30-roll tranche at 3 %) or flat €/Kg.

import { query } from './hfsql-auto.js'
import {
  assembleTarifFini,
  priceTrancheLibre,
  type BandRow,
  type TarifDetailLine,
  type TarifLibreOptions,
  type TarifTranche,
} from './pricing-fini-tarif.js'
import { prixAvecGestion } from './fil-frais-gestion.js'

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function eur(v: number): string {
  return v.toFixed(2).replace('.', ',')
}

// ── Public shapes ─────────────────────────────────────────

/** How shipping is charged. Derived from the stored columns rather than a flag:
 *  `port_pct > 0` → percentage of the sale price, otherwise a flat €/Kg from
 *  `port_fixe`. Writes zero the unused column so the round-trip is stable. */
export type PortMode = 'pct' | 'kg'

/** One yarn line of a simulation's composition (`asso_fil_tarif`). The price is
 *  a per-simulation snapshot the user can override — never a live read of
 *  `ref_fil` / `colori_fil`. */
export interface TarifSimFil {
  IDasso_fil_tarif: number
  IDref_fil: number
  ref_label: string | null
  IDcolori_fil: number
  colori_label: string | null
  pourcentage: number
  /** Purchase €/Kg, without the frais de gestion. */
  prix_achat: number
}

/** One applied treatment (`asso_traitement_tarif`). The same treatment may
 *  appear several times — legacy simulation 514 carries Chardonnage ×4. */
export interface TarifSimTraitement {
  IDasso_traitement_tarif: number
  IDtraitement: number
  designation: string | null
}

/** Everything the engine needs. Assembled by the route from the three tables. */
export interface TarifSimInput {
  IDref_tarif: number
  rendement: number
  poids_rouleau: number
  prix_tricotage: number
  port_mode: PortMode
  port_fixe: number
  /** Percentage points, e.g. 5 for 5%. */
  port_pct: number
  /** true = MATEL's rendement grid; false = `multiplicateur` below. */
  mult_auto: boolean
  /** Ratio, e.g. 0.05 for +5%. Used only when `mult_auto` is false. */
  multiplicateur: number
  /** Percent on every ennoblissement price, e.g. -10. */
  ajust_ennoblissement: number
  /** Percent of frais de gestion on the yarn purchase price, e.g. 5. */
  frais_gestion_fil: number
  /** GOTS dye supplement (`teinture.prix_gots`) applies. */
  gots: boolean
  IDteinture: number
  teinture_label: string | null
  prix_gots: number
  fils: TarifSimFil[]
  traitements: TarifSimTraitement[]
}

/** Same tranche shape as the catalogue pricer, so the screens share rendering. */
export type TarifSimTranche = TarifTranche

export interface TarifSimResult {
  IDref_tarif: number
  rendement: number
  /** Rounded rendement actually used for the Kg → Ml conversion (legacy rounds
   *  to 2 decimals before dividing; prices only match with the rounded value). */
  rendement_calcul: number
  tranches: TarifSimTranche[]
  /** Present only when the caller asked for a free simulation. */
  libre: TarifSimTranche | null
  /** Blockers that made `tranches` empty, so the UI can explain itself. */
  blockers: string[]
}

export type TarifSimLibreOptions = TarifLibreOptions

/** The fil detail lines of a simulation: each line's €/Kg is its purchase
 *  price plus the gestion lever; values rounded per line like the catalogue
 *  (`moFil` is the sum of the rounded lines there too). */
export function detailFilSimulation(fils: TarifSimFil[], fraisGestionPct: number): TarifDetailLine[] {
  return fils.map((f) => {
    const pourcentage = Number(f.pourcentage) || 0
    const achat = Number(f.prix_achat) || 0
    const prixKg = prixAvecGestion(achat, fraisGestionPct)
    const colSuffix = f.colori_label ? ` - ${f.colori_label}` : ''
    const valueKg = round2((prixKg * pourcentage) / 100)
    return {
      label: `${pourcentage}% de ${f.ref_label ?? ''}${colSuffix} à ${eur(prixKg)} €`,
      valueKg,
      gestionKg: round2(valueKg - (achat * pourcentage) / 100),
    }
  })
}

/**
 * Price a simulation. Never throws: a simulation with no rendement (or no roll
 * weight) comes back with `tranches: []` and a populated `blockers` array so
 * the screen can tell the user what is missing.
 */
export async function calcTarifSimulation(
  input: TarifSimInput,
  libreOpts?: TarifSimLibreOptions,
): Promise<TarifSimResult> {
  const rendement = Number(input.rendement) || 0
  const poidsUnRlx = Number(input.poids_rouleau) || 0

  const blockers: string[] = []
  if (!(rendement > 0)) blockers.push('rendement')
  if (!(poidsUnRlx > 0)) blockers.push('poids_rouleau')

  const result: TarifSimResult = {
    IDref_tarif: input.IDref_tarif,
    rendement,
    rendement_calcul: Math.round(rendement * 100) / 100,
    tranches: [],
    libre: null,
    blockers,
  }
  if (blockers.length > 0) return result

  // ── Tariff bands (IDsous_traitant 0), fetched once ──
  const treatmentIds = Array.from(
    new Set(input.traitements.map((t) => Number(t.IDtraitement)).filter((n) => n > 0)),
  )
  const treatmentBands = treatmentIds.length > 0
    ? await query<BandRow>(
      `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
         FROM tranche_tarif_ennoblissement
        WHERE IDsous_traitant = 0 AND IDtraitement IN (${treatmentIds.join(',')})`,
    )
    : []
  const bandsByTreatment = new Map<number, BandRow[]>()
  for (const b of treatmentBands) {
    const k = Number(b.IDtraitement) || 0
    const arr = bandsByTreatment.get(k) ?? []
    arr.push(b)
    bandsByTreatment.set(k, arr)
  }

  const IDteinture = Number(input.IDteinture) || 0
  const dyeBands = IDteinture > 0
    ? await query<BandRow>(
      `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
         FROM tranche_tarif_ennoblissement
        WHERE IDsous_traitant = 0 AND IDteinture = ${IDteinture}`,
    )
    : []

  const inputs = {
    IDref_fini: 0,
    IDcoloris: 0,
    avecTeinture: IDteinture > 0 ? 1 : 0,
    rendement,
    ref_ecru: { IDref_ecru: 0, reference: null, poids: poidsUnRlx, prix: Number(input.prix_tricotage) || 0 },
    detailFil: detailFilSimulation(input.fils, input.frais_gestion_fil),
    // Treatments in the order the route loaded them (process order); a
    // repeated treatment is a repeated line.
    treatments: input.traitements.map((t) => ({ IDtraitement: Number(t.IDtraitement) || 0, designation: t.designation })),
    bandsByTreatment,
    dye: IDteinture > 0
      ? { IDteinture, label: input.teinture_label, gots: input.gots, prixGots: Number(input.prix_gots) || 0, bands: dyeBands }
      : null,
    leviers: {
      multiplicateurManuel: input.mult_auto ? null : Number(input.multiplicateur) || 0,
      ajustEnnoblissementPct: Number(input.ajust_ennoblissement) || 0,
      port: { mode: input.port_mode, pct: Number(input.port_pct) || 0, fixe: Number(input.port_fixe) || 0 },
      tricotageLabel: 'Tricotage',
    },
  }

  result.tranches = assembleTarifFini(inputs).tranches
  if (libreOpts && libreOpts.poids > 0) result.libre = priceTrancheLibre(inputs, libreOpts)
  return result
}
