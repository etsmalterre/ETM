// Tarif SIMULATOR pricing — the engine behind Finis › Tarifs (legacy
// `FI_Tarifs.wdw`). Where `pricing-fini-tarif.ts` prices a real `ref_fini`
// (everything read from the catalog), this module prices a **`ref_tarif` row**:
// a standalone what-if record whose composition, treatments and every physical
// parameter are typed by the user. Same maths, different source of truth.
//
// For nine order-quantity tranches (<1, 1, 2, 3, 4, 5, 10, 15, 30 rolls) it
// builds the full cost breakdown:
//   fil (yarn) + tricotage (knitting) + traitement (finishing, +5%) +
//   teinture (dyeing, +5%) = prix de revient → ÷ margin → prix de vente Kg/Ml.
// It also prices a **free simulation** at an arbitrary weight, either from a
// given margin or backwards from a target €/Ml.
//
// Ennoblissement prices come from `tranche_tarif_ennoblissement` rows with
// `IDsous_traitant = 0` — the company's own copied-from-MATEL tariff.
//
// ── Two deliberate differences from `pricing-fini-tarif.ts` ────────────────
//
// 1. **The ennoblissement multiplier is `ref_tarif.multiplicateur`, not the
//    rendement-derived MATEL one.** The simulator exposes a manual
//    "Multiplicateur Ennoblissement" field precisely so the user can override
//    the automatic uplift. Reverse-engineered from the live data: simulation
//    522 ("Copie de 081A", rendement 3.78 → MATEL would give ×1.03) prints
//    "X1" on its dye line and its nine tranche prices reproduce EXACTLY (9,03 /
//    7,56 / 6,37 / 5,62 / 4,79 / 3,98 / 3,63 €) only when the multiplier is 1.
//    `check-ref-tarif-parity.ts` pins that.
// 2. **Knitting price is `ref_tarif.prix_tricotage`**, typed by the user,
//    instead of `ref_ecru.prix` — there is no écru reference behind a
//    simulation.
//
// Everything else is shared with the catalog pricer: the same COEFFICIENT_V2
// margin bands, the same `poids = rolls × poids_rouleau + 1` band lookup, the
// same +5% packaging majoration, the same −5%/−10% knitting rebates at 15/30
// rolls, and the same 3% (instead of 5%) shipping rate on the 30-roll tranche.

import { query } from './hfsql-auto.js'
import { COEFFICIENT_V2, ROLL_MULT, type TarifDetailLine } from './pricing-fini-tarif.js'

/** Roll count shown in the table (tranche 0 renders as "< 1"). */
const ROLL_LABEL = [1, 1, 2, 3, 4, 5, 10, 15, 30]

/** The "+5% (carton, plastiques ...)" packaging majoration on every treatment
 *  and dye line. */
const MAJORATION_CONDITIONNEMENT = 1.05

/** Shipping rate on the 30-roll tranche — legacy hardcodes 3% there whatever
 *  `ref_tarif.port_pct` says (validated on simulation 522: 3,63 €/Ml only comes
 *  out with 3%, not with the row's own 5%). */
const TAUX_FRAIS_DE_PORT_30RLX = 0.03

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Format a number as a 2-decimal French-style amount ("3,47") for the embedded
 *  "à X €" text inside detail labels. */
function eur(v: number): string {
  return v.toFixed(2).replace('.', ',')
}

/** Format a 0..1 ratio as a percentage for the multiplier suffix. */
function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`
}

// ── Public shapes ─────────────────────────────────────────

/** How shipping is charged. Derived from the stored columns rather than a flag:
 *  `port_pct > 0` → percentage of the sale price, otherwise a flat €/Kg from
 *  `port_fixe`. Writes zero the unused column so the round-trip is stable. */
export type PortMode = 'pct' | 'kg'

/** One yarn line of a simulation's composition (`asso_fil_tarif`). The price is
 *  a per-simulation snapshot the user can override — it is NOT read live from
 *  `ref_fil` / `colori_fil`. */
export interface TarifSimFil {
  IDasso_fil_tarif: number
  IDref_fil: number
  ref_label: string | null
  IDcolori_fil: number
  colori_label: string | null
  pourcentage: number
  prix: number
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
  /** Ratio, e.g. 0.05 for +5%. 0 means no uplift. */
  multiplicateur: number
  IDteinture: number
  teinture_label: string | null
  fils: TarifSimFil[]
  traitements: TarifSimTraitement[]
}

/** A single priced quantity tranche — same shape as the catalog pricer's so the
 *  two screens can share breakdown rendering. */
export interface TarifSimTranche {
  /** Display roll count (tranche 0 is the "< 1 roll" métrage row). */
  rolls: number
  /** True for tranche 0 — the table renders its quantity prefixed with "< ". */
  isMetrage: boolean
  qte_ml: number
  /** Weight (kg) used to pick the tariff band for this tranche. */
  poids_ref: number
  moFil: number
  detailFil: TarifDetailLine[]
  moTricotage: number
  detailTricotage: TarifDetailLine | null
  moTraitements: number
  detailTraitement: TarifDetailLine[]
  moTeinte: number
  detailTeinture: TarifDetailLine | null
  moRevient: number
  /** Margin as a 0..1 ratio (×100 for the "Coefficient" display). */
  rCoeff: number
  tauxFraisDePort: number
  moPortAuKg: number
  moPortAuMl: number
  moPrixDeVenteAuKg: number
  moPrixDeVenteAuMl: number
}

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

interface BandRow {
  IDtraitement: number
  IDteinture: number
  quantite_mini: number
  quantite_maxi: number
  prix: number
}

/** Pick the tariff-band price for a given weight (mini ≤ poids ≤ maxi). Returns
 *  0 when no band covers the weight — the treatment is then effectively free,
 *  which is what legacy does (several treatments are genuinely priced at 0). */
function bandPrix(bands: BandRow[], poids: number): number {
  for (const b of bands) {
    if (Number(b.quantite_mini) <= poids && Number(b.quantite_maxi) >= poids) {
      return Number(b.prix) || 0
    }
  }
  return 0
}

/** Options for the extra "simulation libre" tranche.
 *  `coefficient` wins over `prix_cible_ml` when both are supplied. */
export interface TarifSimLibreOptions {
  /** Weight to treat, in kg. Drives the ennoblissement band lookup. */
  poids: number
  /** Margin as a 0..1 ratio. */
  coefficient?: number
  /** Target sale price in €/Ml — the margin is solved backwards from it. */
  prix_cible_ml?: number
}

/**
 * Price a simulation. Never throws: a simulation with no rendement (or no yarn)
 * comes back with `tranches: []` and a populated `blockers` array so the screen
 * can tell the user what is missing.
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

  const empty: TarifSimResult = {
    IDref_tarif: input.IDref_tarif,
    rendement,
    rendement_calcul: Math.round(rendement * 100) / 100,
    tranches: [],
    libre: null,
    blockers,
  }
  if (blockers.length > 0) return empty

  // ── Tariff bands, fetched once for every treatment + the dye ──
  const treatmentIds = Array.from(
    new Set(input.traitements.map((t) => Number(t.IDtraitement)).filter((n) => n > 0)),
  )
  let treatmentBands: BandRow[] = []
  if (treatmentIds.length > 0) {
    treatmentBands = await query<BandRow>(
      `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
         FROM tranche_tarif_ennoblissement
        WHERE IDsous_traitant = 0 AND IDtraitement IN (${treatmentIds.join(',')})`,
    )
  }
  const bandsByTreatment = new Map<number, BandRow[]>()
  for (const b of treatmentBands) {
    const k = Number(b.IDtraitement) || 0
    const arr = bandsByTreatment.get(k) ?? []
    arr.push(b)
    bandsByTreatment.set(k, arr)
  }

  const IDteinture = Number(input.IDteinture) || 0
  let dyeBands: BandRow[] = []
  if (IDteinture > 0) {
    dyeBands = await query<BandRow>(
      `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
         FROM tranche_tarif_ennoblissement
        WHERE IDsous_traitant = 0 AND IDteinture = ${IDteinture}`,
    )
  }

  // ── Fil (quantity-independent) — computed once ──────────────
  // Each line is round2'd for display but the TOTAL is round2(Σ unrounded),
  // which is what legacy prints: 0,36 + 3,16 shows as 3,51 (not 3,52).
  const detailFil: TarifDetailLine[] = input.fils.map((f) => {
    const pourcentage = Number(f.pourcentage) || 0
    const prixKg = Number(f.prix) || 0
    const colSuffix = f.colori_label ? ` - ${f.colori_label}` : ''
    return {
      label: `${pourcentage}% de ${f.ref_label ?? ''}${colSuffix} à ${eur(prixKg)} €`,
      valueKg: round2((prixKg * pourcentage) / 100),
    }
  })
  const moFil = round2(
    input.fils.reduce((s, f) => s + ((Number(f.prix) || 0) * (Number(f.pourcentage) || 0)) / 100, 0),
  )

  const prixTricotage = Number(input.prix_tricotage) || 0
  const multiplicateur = Number(input.multiplicateur) || 0
  const multFactor = 1 + multiplicateur
  const rdt2 = Math.round(rendement * 100) / 100
  const portFixe = Number(input.port_fixe) || 0
  const portPct = Number(input.port_pct) || 0

  /** Build one tranche. `poidsRef` picks the tariff band, `rCoeff` is the
   *  margin, `tauxPort` the shipping rate (0 in flat-€/Kg mode). */
  function buildTranche(args: {
    rolls: number
    isMetrage: boolean
    qteMl: number
    poidsRef: number
    rCoeff: number
    tauxPort: number
    tricotageRebate: number
    tricotageSuffix: string
  }): TarifSimTranche {
    const moTricotage = prixTricotage * args.tricotageRebate
    const detailTricotage: TarifDetailLine = {
      label: `Tricotage à ${eur(prixTricotage)} €${args.tricotageSuffix}`,
      valueKg: round2(moTricotage),
    }

    const multSuffix = multiplicateur !== 0 ? ` / multiplicateur de ${pct(multiplicateur)}` : ''

    const detailTraitement: TarifDetailLine[] = []
    let moTraitements = 0
    for (const t of input.traitements) {
      const prix = bandPrix(bandsByTreatment.get(Number(t.IDtraitement)) ?? [], args.poidsRef)
      const add = prix * multFactor * MAJORATION_CONDITIONNEMENT
      moTraitements += add
      detailTraitement.push({
        label: `${args.poidsRef} Kgs de ${t.designation ?? ''} à ${eur(prix)} € / majoré de 5% (carton, plastiques ...)${multSuffix}`,
        valueKg: round2(add),
      })
    }

    let moTeinte = 0
    let detailTeinture: TarifDetailLine | null = null
    if (IDteinture > 0) {
      const prix = bandPrix(dyeBands, args.poidsRef)
      moTeinte = prix * multFactor * MAJORATION_CONDITIONNEMENT
      detailTeinture = {
        label: `${args.poidsRef} Kgs de ${input.teinture_label ?? ''} à ${eur(prix)} € / majoré de 5% (carton, plastiques ...)${multSuffix}`,
        valueKg: round2(moTeinte),
      }
    }

    const moRevient = moFil + moTricotage + moTraitements + moTeinte

    // CalculPrixDeVente: margin first, then shipping grossed up (pct mode) or
    // added flat (kg mode).
    const venteAvantPortKg = args.rCoeff < 1 ? moRevient / (1 - args.rCoeff) : 0
    const venteAvantPortMl = rdt2 > 0 ? venteAvantPortKg / rdt2 : 0

    let moPrixDeVenteAuKg: number
    let moPrixDeVenteAuMl: number
    let moPortAuKg: number
    let moPortAuMl: number
    if (input.port_mode === 'kg') {
      moPortAuKg = round2(portFixe)
      moPortAuMl = round2(rdt2 > 0 ? portFixe / rdt2 : 0)
      moPrixDeVenteAuKg = round2(venteAvantPortKg + portFixe)
      moPrixDeVenteAuMl = round2(venteAvantPortMl + (rdt2 > 0 ? portFixe / rdt2 : 0))
    } else {
      moPrixDeVenteAuKg = round2(venteAvantPortKg / (1 - args.tauxPort))
      moPrixDeVenteAuMl = round2(venteAvantPortMl / (1 - args.tauxPort))
      moPortAuKg = round2(moPrixDeVenteAuKg * args.tauxPort)
      moPortAuMl = round2(moPrixDeVenteAuMl * args.tauxPort)
    }

    return {
      rolls: args.rolls,
      isMetrage: args.isMetrage,
      qte_ml: args.qteMl,
      poids_ref: args.poidsRef,
      moFil,
      detailFil,
      moTricotage: round2(moTricotage),
      detailTricotage,
      moTraitements: round2(moTraitements),
      detailTraitement,
      moTeinte: round2(moTeinte),
      detailTeinture,
      moRevient: round2(moRevient),
      rCoeff: args.rCoeff,
      tauxFraisDePort: input.port_mode === 'kg' ? 0 : args.tauxPort,
      moPortAuKg,
      moPortAuMl,
      moPrixDeVenteAuKg,
      moPrixDeVenteAuMl,
    }
  }

  // ── The nine standard tranches ──────────────────────────────
  const tranches: TarifSimTranche[] = []
  for (let i = 0; i < ROLL_MULT.length; i++) {
    tranches.push(
      buildTranche({
        rolls: ROLL_LABEL[i],
        isMetrage: i === 0,
        // Display quantity uses the UNROUNDED rendement (matches legacy's
        // 2 271 Ml at 30 rolls, which the 2dp-rounded value would print as
        // 2 268). Prices keep rdt2.
        qteMl: Math.round(ROLL_MULT[i] * poidsUnRlx * rendement),
        poidsRef: poidsUnRlx * ROLL_MULT[i] + 1,
        rCoeff: COEFFICIENT_V2[i],
        tauxPort: i === 8 ? TAUX_FRAIS_DE_PORT_30RLX : portPct / 100,
        tricotageRebate: i === 7 ? 0.95 : i === 8 ? 0.9 : 1,
        tricotageSuffix: i === 7 ? ' -5%' : i === 8 ? ' -10%' : '',
      }),
    )
  }

  // ── Optional free simulation at an arbitrary weight ─────────
  let libre: TarifSimTranche | null = null
  if (libreOpts && libreOpts.poids > 0) {
    const poidsRef = Math.round(libreOpts.poids)
    const tauxPort = portPct / 100

    let rCoeff: number
    if (libreOpts.coefficient !== undefined && libreOpts.coefficient > 0 && libreOpts.coefficient < 1) {
      rCoeff = libreOpts.coefficient
    } else if (libreOpts.prix_cible_ml !== undefined && libreOpts.prix_cible_ml > 0) {
      // Solve the margin backwards from a target €/Ml. Price a probe tranche at
      // a known margin to read this weight's prix de revient, then invert.
      const probe = buildTranche({
        rolls: 0, isMetrage: false, qteMl: 0, poidsRef,
        rCoeff: 0, tauxPort, tricotageRebate: 1, tricotageSuffix: '',
      })
      const venteAvantPortKg =
        input.port_mode === 'kg'
          ? (libreOpts.prix_cible_ml - (rdt2 > 0 ? portFixe / rdt2 : 0)) * rdt2
          : libreOpts.prix_cible_ml * (1 - tauxPort) * rdt2
      // Below cost the margin is negative; clamp at 0 rather than emit nonsense.
      rCoeff = venteAvantPortKg > 0 ? Math.max(0, 1 - probe.moRevient / venteAvantPortKg) : 0
    } else {
      rCoeff = COEFFICIENT_V2[0]
    }

    libre = buildTranche({
      rolls: poidsUnRlx > 0 ? Math.round((poidsRef / poidsUnRlx) * 10) / 10 : 0,
      isMetrage: false,
      qteMl: Math.round(libreOpts.poids * rendement),
      poidsRef,
      rCoeff,
      tauxPort,
      tricotageRebate: 1,
      tricotageSuffix: '',
    })
  }

  return {
    IDref_tarif: input.IDref_tarif,
    rendement,
    rendement_calcul: rdt2,
    tranches,
    libre,
    blockers,
  }
}
