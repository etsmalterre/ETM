// Finished-reference cost-price ("Tarif") calculation — a faithful port of the
// legacy WLanguage `PrixDeVenteV4` procedure (case nType_Ref = 2, "Ref Fini")
// and its internal helpers PoidsRefParTranche / CalculPrixDeVente / PrixFil /
// PrixTraitement / PrixTeinture.
//
// For a finished reference + a chosen coloris it builds, for nine order-quantity
// tranches (<1, 1, 2, 3, 4, 5, 10, 15, 30 rolls), the full cost breakdown:
//   fil (yarn) + tricotage (knitting) + traitement (finishing, +5%) +
//   teinture (dyeing, +5%) = prix de revient → ÷ margin → prix de vente Kg/Ml.
//
// All ennoblissement prices are read from `tranche_tarif_ennoblissement` rows
// with `IDsous_traitant = 0` — the company's own copied-from-MATEL tariff, NOT a
// real supplier (so there is no supplier picker). The rendement-based MATEL
// multiplier still applies, reusing `multiplicateurMatel` from pricing-sst.ts.
//
// HFSQL/bridge safety: every text column used for a label (yarn / coloris /
// treatment / dye names) is repaired with `fixEncoding`; the legacy single
// JOINed query is split into flat queries + a JS merge (a JOIN + CONVERT
// collapses the result set on the Linux bridge — see CLAUDE.md).

import { query, fixEncoding } from './hfsql-auto.js'
import { multiplicateurMatel } from './pricing-sst.js'

/** Per-tranche margin — legacy `CoefficientV2(i)`. Index = tranche i (0..8).
 *  Small quantities carry a higher margin; bulk a lower one. Exported so the
 *  client-line pricer can reuse the same bands for the écru path. */
export const COEFFICIENT_V2 = [0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.27, 0.22, 0.17]

/** Roll count used to size each tranche's weight. Tranche 0 ("métrage", the
 *  sub-roll row) shares tranche 1's weight; they differ only by CoefficientV2.
 *  Index 0 = "< 1 roll" (métrage); indices 1..8 = 1,2,3,4,5,10,15,30 rolls. */
export const ROLL_MULT = [1, 1, 2, 3, 4, 5, 10, 15, 30]

/** Roll count shown in the table (tranche 0 is rendered as "< 1"). */
const ROLL_LABEL = [1, 1, 2, 3, 4, 5, 10, 15, 30]

/** Treatments that get the MATEL rendement multiplier (Lavage 285, BNO/PAT 302,
 *  and 298) — legacy `reqTrt.IDtraitement in (298,285,302)`. */
const MATEL_MULT_TRAITEMENTS = new Set([298, 285, 302])

/** 5% of the final sale price is shipping ("frais de port inclus"), except the
 *  30-roll tranche which uses 3%. */
const TAUX_FRAIS_DE_PORT = 0.05
const TAUX_FRAIS_DE_PORT_30RLX = 0.03

/** The "+5% (carton, plastiques ...)" packaging majoration on every treatment
 *  and dye line. */
const MAJORATION_CONDITIONNEMENT = 1.05

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Format a number as a 2-decimal French-style amount ("3,47") for the embedded
 *  "à X €" text inside detail labels. */
function eur(v: number): string {
  return v.toFixed(2).replace('.', ',')
}

/** Format the MATEL multiplier for the " X{n}" suffix (1 → "1", 1.05 → "1.05"). */
function mult(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** One sub-line of a cost component: a human label + its €/Kg contribution. */
export interface TarifDetailLine {
  label: string
  valueKg: number
}

/** A single order-quantity tranche — mirrors the legacy `STPrixDétaillé`. */
export interface TarifTranche {
  /** Display roll count (tranche 0 is the "< 1 roll" métrage row). */
  rolls: number
  /** True for tranche 0 — the table renders its quantity prefixed with "< ". */
  isMetrage: boolean
  /** Display quantity in meters (0 when the écru has no rendement). */
  qte_ml: number
  /** Display quantity in kg — the unit a tombé de métier is sold in. */
  qte_kg: number
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

export interface TarifResult {
  /** Which engine produced the tranches: 'fini' (PrixDeVenteV4 nType_Ref = 2)
   *  or 'ecru' (nType_Ref = 1 — tombé de métier, sold by the Kg). */
  kind: 'fini' | 'ecru'
  IDref_fini: number
  /** Set by the écru engine (0 on a fini result — the écru behind a fini is `ref_ecru`). */
  IDref_ecru: number
  IDcoloris: number
  avec_teinture: number
  rendement: number
  ref_ecru: { IDref_ecru: number; reference: string | null; poids: number; prix: number } | null
  tranches: TarifTranche[]
}

interface BandRow {
  IDtraitement: number
  IDteinture: number
  quantite_mini: number
  quantite_maxi: number
  prix: number
}

/** Pick the tariff-band price for a given weight (mini ≤ poids ≤ maxi). Returns
 *  0 when no band covers the weight (treatment/dye effectively unpriced). */
function bandPrix(bands: BandRow[], poids: number): number {
  for (const b of bands) {
    if (Number(b.quantite_mini) <= poids && Number(b.quantite_maxi) >= poids) {
      return Number(b.prix) || 0
    }
  }
  return 0
}

/**
 * Compute the full per-tranche tarif breakdown for a finished reference and one
 * coloris. Returns `tranches: []` (never throws) when the inputs can't produce a
 * price — missing ref/écru, rendement 0, or no coloris — so the UI shows an
 * empty state rather than an error.
 *
 * `opts.coefficient` (0..1 ratio) replaces the degressive per-tranche
 * COEFFICIENT_V2 margin with a fixed one for every tranche — the legacy
 * "coefficient fixe" client tarif mode (a single `tranche_tarifaire` row with
 * `coefficient` %, e.g. 20 → 0.20).
 */
export async function calcTarifRefFini(
  IDref_fini: number,
  IDcoloris: number,
  opts?: { coefficient?: number },
): Promise<TarifResult> {
  const empty: TarifResult = {
    kind: 'fini',
    IDref_fini,
    IDref_ecru: 0,
    IDcoloris,
    avec_teinture: 0,
    rendement: 0,
    ref_ecru: null,
    tranches: [],
  }
  if (!(IDref_fini > 0)) return empty

  // ── Context ────────────────────────────────────────────────
  // ref_fini: only ASCII columns named (the accented ones storm the bridge).
  const refRows = await query<{
    avec_teinture: number
    rendement: number | null
    IDref_ecru: number
    IDcolori_ecru: number
  }>(
    `SELECT avec_teinture, rendement, IDref_ecru, IDcolori_ecru FROM ref_fini WHERE IDref_fini = ${IDref_fini}`,
  )
  if (refRows.length === 0) return empty
  const avecTeinture = Number(refRows[0].avec_teinture) || 0
  const rendement = Number(refRows[0].rendement) || 0
  const IDref_ecru = Number(refRows[0].IDref_ecru) || 0
  const refColoriEcru = Number(refRows[0].IDcolori_ecru) || 0

  // Legacy guards: a fini needs a rendement and a coloris.
  if (!(rendement > 0)) return { ...empty, avec_teinture: avecTeinture, rendement: 0 }
  if (!(IDcoloris > 0)) return { ...empty, avec_teinture: avecTeinture, rendement }
  if (!(IDref_ecru > 0)) return { ...empty, avec_teinture: avecTeinture, rendement }

  // ref_ecru: roll weight (poids), knitting price (prix), reference (label).
  // IDref_ecru is selected so fixEncoding can key its repair on it (omitting it
  // would build WHERE IDref_ecru = NaN — a bridge storm; see project memory).
  const ecruRows = await query<{ IDref_ecru: number; reference: string | null; poids: number | null; prix: number | null }>(
    `SELECT IDref_ecru, reference, poids, prix FROM ref_ecru WHERE IDref_ecru = ${IDref_ecru}`,
  )
  if (ecruRows.length === 0) return { ...empty, avec_teinture: avecTeinture, rendement }
  const ecruFixed = await fixEncoding(ecruRows as any[], 'ref_ecru', 'IDref_ecru', ['reference'])
  const ecruReference = (ecruFixed[0]?.reference ?? null) as string | null
  const poidsUnRlx = Number(ecruRows[0].poids) || 0
  const prixTricotage = Number(ecruRows[0].prix) || 0
  if (!(poidsUnRlx > 0)) return { ...empty, avec_teinture: avecTeinture, rendement }

  const ref_ecru = { IDref_ecru, reference: ecruReference, poids: poidsUnRlx, prix: prixTricotage }

  // Dye context (avec_teinture ≠ 0): the coloris is a ref_fini_colori → IDteinture.
  let IDteinture = 0
  let gots = false
  let teintureLabel: string | null = null
  let prixGots = 0
  let colorisEcruForFil = refColoriEcru
  if (avecTeinture !== 0) {
    const cr = await query<{ IDteinture: number | null; gots: number | null }>(
      `SELECT IDteinture, gots FROM ref_fini_colori WHERE IDref_fini_colori = ${IDcoloris}`,
    )
    if (cr.length === 0) return { ...empty, avec_teinture: avecTeinture, rendement, ref_ecru }
    IDteinture = Number(cr[0].IDteinture) || 0
    gots = Number(cr[0].gots) === 1
    if (IDteinture > 0) {
      const tr = await query<{ IDteinture: number; designation_externe: string | null; prix_gots: number | null }>(
        `SELECT IDteinture, designation_externe, prix_gots FROM teinture WHERE IDteinture = ${IDteinture}`,
      )
      if (tr.length > 0) {
        const trFixed = await fixEncoding(tr as any[], 'teinture', 'IDteinture', ['designation_externe'])
        teintureLabel = (trFixed[0]?.designation_externe ?? null) as string | null
        prixGots = Number(tr[0].prix_gots) || 0
      }
    }
  } else {
    // Wash-only: the coloris IS a colori_ecru id, used for fil composition.
    colorisEcruForFil = IDcoloris
  }

  // ── Fil (quantity-independent) — computed once ──────────────
  const detailFil = await computePrixFil(IDref_ecru, colorisEcruForFil)
  const moFil = round2(detailFil.reduce((s, d) => s + d.valueKg, 0))

  // ── Treatments on the ref + all their tariff bands (IDsous_traitant 0) ──
  const trtRows = await query<{ IDtraitement: number; designation: string | null }>(
    `SELECT t.IDtraitement, t.designation
       FROM traitement_ref_fini trf
       JOIN traitement t ON t.IDtraitement = trf.IDtraitement
      WHERE trf.IDref_fini = ${IDref_fini}
      ORDER BY t.ordre`,
  )
  const trtFixed = (await fixEncoding(trtRows as any[], 'traitement', 'IDtraitement', ['designation'])) as Array<{
    IDtraitement: number
    designation: string | null
  }>
  const treatments = trtFixed.map((t) => ({
    IDtraitement: Number(t.IDtraitement) || 0,
    designation: (t.designation ?? null) as string | null,
  }))

  let treatmentBands: BandRow[] = []
  if (treatments.length > 0) {
    const ids = treatments.map((t) => t.IDtraitement).filter((n) => n > 0)
    if (ids.length > 0) {
      treatmentBands = await query<BandRow>(
        `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
           FROM tranche_tarif_ennoblissement
          WHERE IDsous_traitant = 0 AND IDtraitement IN (${ids.join(',')})`,
      )
    }
  }
  const bandsByTreatment = new Map<number, BandRow[]>()
  for (const b of treatmentBands) {
    const k = Number(b.IDtraitement) || 0
    const arr = bandsByTreatment.get(k) ?? []
    arr.push(b)
    bandsByTreatment.set(k, arr)
  }

  // ── Dye tariff bands (IDsous_traitant 0, this teinture) ─────
  let dyeBands: BandRow[] = []
  if (avecTeinture !== 0 && IDteinture > 0) {
    dyeBands = await query<BandRow>(
      `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
         FROM tranche_tarif_ennoblissement
        WHERE IDsous_traitant = 0 AND IDteinture = ${IDteinture}`,
    )
  }

  const matelMult = multiplicateurMatel(rendement)
  const rdt2 = Math.round(rendement * 100) / 100

  // ── Per-tranche assembly ───────────────────────────────────
  const tranches: TarifTranche[] = []
  for (let i = 0; i < ROLL_MULT.length; i++) {
    const poidsRef = poidsUnRlx * ROLL_MULT[i] + 1

    // Tricotage — base price, with the 15-/30-roll rebates.
    let moTricotage = prixTricotage
    let tricSuffix = ''
    if (i === 7) {
      moTricotage = 0.95 * moTricotage
      tricSuffix = ' -5%'
    } else if (i === 8) {
      moTricotage = 0.9 * moTricotage
      tricSuffix = ' -10%'
    }
    const detailTricotage: TarifDetailLine = {
      label: `Ref tombé de métier ${ecruReference ?? ''} à ${eur(prixTricotage)} €${tricSuffix}`,
      valueKg: round2(moTricotage),
    }

    // Treatments — each priced at this tranche's band, +5% packaging, plus the
    // MATEL multiplier for the Lavage / BNO-PAT / 298 set.
    const detailTraitement: TarifDetailLine[] = []
    let moTraitements = 0
    for (const t of treatments) {
      const prix = bandPrix(bandsByTreatment.get(t.IDtraitement) ?? [], poidsRef)
      const m = MATEL_MULT_TRAITEMENTS.has(t.IDtraitement) ? matelMult : 1
      const add = prix * m * MAJORATION_CONDITIONNEMENT
      moTraitements += add
      const xPart = m !== 1 ? ` X${mult(m)}` : ''
      detailTraitement.push({
        label: `${poidsRef} Kgs de ${t.designation ?? ''} à ${eur(prix)} €${xPart} / majoré de 5% (carton, plastiques ...)`,
        valueKg: round2(add),
      })
    }

    // Teinture — dye band at this tranche, ×MATEL multiplier, +5%, +GOTS.
    let moTeinte = 0
    let detailTeinture: TarifDetailLine | null = null
    if (avecTeinture !== 0 && IDteinture > 0) {
      const prix = bandPrix(dyeBands, poidsRef)
      let add = prix * matelMult * MAJORATION_CONDITIONNEMENT
      let gotsPart = ''
      if (gots && prixGots > 0) {
        add += prixGots
        gotsPart = ` / Supplément GOTS à ${eur(prixGots)} €`
      }
      moTeinte = add
      detailTeinture = {
        label: `${poidsRef} Kgs de ${teintureLabel ?? ''} à ${eur(prix)} € X${mult(matelMult)}${gotsPart} / majoré de 5% (carton, plastiques ...)`,
        valueKg: round2(add),
      }
    }

    const moRevient = moFil + moTricotage + moTraitements + moTeinte

    const tauxPort = i === 8 ? TAUX_FRAIS_DE_PORT_30RLX : TAUX_FRAIS_DE_PORT
    const rCoeff =
      opts?.coefficient !== undefined && opts.coefficient > 0 && opts.coefficient < 1
        ? opts.coefficient
        : COEFFICIENT_V2[i]

    // CalculPrixDeVente (type-fini branch).
    const venteAvantPortKg = moRevient / (1 - rCoeff)
    const moPrixDeVenteAuKg = round2(venteAvantPortKg / (1 - tauxPort))
    const venteAvantPortMl = rdt2 > 0 ? venteAvantPortKg / rdt2 : 0
    const moPrixDeVenteAuMl = round2(venteAvantPortMl / (1 - tauxPort))

    const moPortAuKg = round2(moPrixDeVenteAuKg * tauxPort)
    const moPortAuMl = round2(moPrixDeVenteAuMl * tauxPort)

    tranches.push({
      rolls: ROLL_LABEL[i],
      isMetrage: i === 0,
      // Display quantity uses the UNROUNDED rendement — legacy's Fiche Tarif
      // prints 355 Ml for 4 rolls of 124A where the 2dp-rounded rendement
      // gives 354. Prices keep rdt2 (they match legacy with the rounding).
      qte_ml: Math.round(ROLL_MULT[i] * poidsUnRlx * rendement),
      qte_kg: round2(ROLL_MULT[i] * poidsUnRlx),
      poids_ref: poidsRef,
      moFil,
      detailFil,
      moTricotage: round2(moTricotage),
      detailTricotage,
      moTraitements: round2(moTraitements),
      detailTraitement,
      moTeinte: round2(moTeinte),
      detailTeinture,
      moRevient: round2(moRevient),
      rCoeff,
      tauxFraisDePort: tauxPort,
      moPortAuKg,
      moPortAuMl,
      moPrixDeVenteAuKg,
      moPrixDeVenteAuMl,
    })
  }

  return { kind: 'fini', IDref_fini, IDref_ecru: 0, IDcoloris, avec_teinture: avecTeinture, rendement, ref_ecru, tranches }
}

/**
 * Écru / tombé-de-métier tariff — the nType_Ref = 1 reduction of the same
 * `PrixDeVenteV4`: prix de revient = fil + tricotage only (no treatment, no
 * dye), then ÷ margin ÷ port, on the same nine tranches. A tombé de métier is
 * always sold by the Kg (Vincent, 2026-09-10 — LIVA #1144), so `moPrixDeVenteAuKg`
 * is the figure that matters; the Ml figure is derived through `ref_ecru.rendement`
 * when the écru has one and stays 0 otherwise. Shares `TarifResult` with the
 * fini engine so the client fiche's tariff dialog, the tarif-mode editor and
 * the line pricer render both kinds from one shape.
 *
 * `IDcolori_ecru` picks the yarn composition (falls back to the base
 * composition when the coloris has none of its own — see `computePrixFil`).
 * `opts.coefficient` is the "coefficient fixe" margin, as for the fini engine.
 */
export async function calcTarifRefEcru(
  IDref_ecru: number,
  IDcolori_ecru: number,
  opts?: { coefficient?: number },
): Promise<TarifResult> {
  const empty: TarifResult = {
    kind: 'ecru',
    IDref_fini: 0,
    IDref_ecru,
    IDcoloris: IDcolori_ecru,
    avec_teinture: 0,
    rendement: 0,
    ref_ecru: null,
    tranches: [],
  }
  if (!(IDref_ecru > 0)) return empty

  const ecruRows = await query<{ IDref_ecru: number; reference: string | null; poids: number | null; prix: number | null; rendement: number | null }>(
    `SELECT IDref_ecru, reference, poids, prix, rendement FROM ref_ecru WHERE IDref_ecru = ${IDref_ecru}`,
  )
  if (ecruRows.length === 0) return empty
  const ecruFixed = await fixEncoding(ecruRows as any[], 'ref_ecru', 'IDref_ecru', ['reference'])
  const ecruReference = (ecruFixed[0]?.reference ?? null) as string | null
  const poidsUnRlx = Number(ecruRows[0].poids) || 0
  const prixTricotage = Number(ecruRows[0].prix) || 0
  const rendement = Number(ecruRows[0].rendement) || 0
  const ref_ecru = { IDref_ecru, reference: ecruReference, poids: poidsUnRlx, prix: prixTricotage }
  if (!(poidsUnRlx > 0)) return { ...empty, rendement, ref_ecru }

  const detailFil = await computePrixFil(IDref_ecru, IDcolori_ecru)
  const moFil = round2(detailFil.reduce((s, d) => s + d.valueKg, 0))
  const rdt2 = Math.round(rendement * 100) / 100

  const tranches: TarifTranche[] = []
  for (let i = 0; i < ROLL_MULT.length; i++) {
    const poidsRef = poidsUnRlx * ROLL_MULT[i] + 1
    let moTricotage = prixTricotage
    let tricSuffix = ''
    if (i === 7) {
      moTricotage = 0.95 * moTricotage
      tricSuffix = ' -5%'
    } else if (i === 8) {
      moTricotage = 0.9 * moTricotage
      tricSuffix = ' -10%'
    }
    const detailTricotage: TarifDetailLine = {
      label: `Ref tombé de métier ${ecruReference ?? ''} à ${eur(prixTricotage)} €${tricSuffix}`,
      valueKg: round2(moTricotage),
    }
    const moRevient = moFil + moTricotage
    const tauxPort = i === 8 ? TAUX_FRAIS_DE_PORT_30RLX : TAUX_FRAIS_DE_PORT
    const rCoeff =
      opts?.coefficient !== undefined && opts.coefficient > 0 && opts.coefficient < 1
        ? opts.coefficient
        : COEFFICIENT_V2[i]
    const venteAvantPortKg = moRevient / (1 - rCoeff)
    const moPrixDeVenteAuKg = round2(venteAvantPortKg / (1 - tauxPort))
    const moPrixDeVenteAuMl = rdt2 > 0 ? round2(venteAvantPortKg / rdt2 / (1 - tauxPort)) : 0
    tranches.push({
      rolls: ROLL_LABEL[i],
      isMetrage: i === 0,
      qte_ml: rendement > 0 ? Math.round(ROLL_MULT[i] * poidsUnRlx * rendement) : 0,
      qte_kg: round2(ROLL_MULT[i] * poidsUnRlx),
      poids_ref: poidsRef,
      moFil,
      detailFil,
      moTricotage: round2(moTricotage),
      detailTricotage,
      moTraitements: 0,
      detailTraitement: [],
      moTeinte: 0,
      detailTeinture: null,
      moRevient: round2(moRevient),
      rCoeff,
      tauxFraisDePort: tauxPort,
      moPortAuKg: round2(moPrixDeVenteAuKg * tauxPort),
      moPortAuMl: round2(moPrixDeVenteAuMl * tauxPort),
      moPrixDeVenteAuKg,
      moPrixDeVenteAuMl,
    })
  }
  return { ...empty, rendement, ref_ecru, tranches }
}

/** Legacy `PrixFil()` — Σ(pourcentage × yarn €/Kg)/100 over the écru's
 *  composition, preferring the colori_fil price when set. Bridge-safe: flat
 *  queries + JS merge + `fixEncoding` (no JOIN+CONVERT). Falls back to the base
 *  composition (IDcolori_ecru = 0) when the chosen coloris has none of its own.
 *  Exported so the client-line pricer (pricing-ligne-client.ts) can reuse it for
 *  the écru (nType_Ref = 1) path. */
export async function computePrixFil(
  IDref_ecru: number,
  IDcolori_ecru: number,
): Promise<TarifDetailLine[]> {
  let comp = await query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
    `SELECT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
      WHERE IDref_ecru = ${IDref_ecru} AND IDcolori_ecru = ${IDcolori_ecru}`,
  )
  if (comp.length === 0 && IDcolori_ecru !== 0) {
    comp = await query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
      `SELECT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
        WHERE IDref_ecru = ${IDref_ecru} AND IDcolori_ecru = 0`,
    )
  }
  if (comp.length === 0) return []

  const filIds = Array.from(new Set(comp.map((c) => Number(c.IDref_fil)).filter((n) => n > 0)))
  const colIds = Array.from(new Set(comp.map((c) => Number(c.IDcolori_fil)).filter((n) => n > 0)))

  const yarnById = new Map<number, { reference: string | null; prix_kg: number }>()
  if (filIds.length > 0) {
    const yarns = await query<{ IDref_fil: number; reference: string | null; prix_kg: number | null }>(
      `SELECT IDref_fil, reference, prix_kg FROM ref_fil WHERE IDref_fil IN (${filIds.join(',')})`,
    )
    const yarnsFixed = (await fixEncoding(yarns as any[], 'ref_fil', 'IDref_fil', ['reference'])) as Array<{
      IDref_fil: number
      reference: string | null
      prix_kg: number | null
    }>
    for (const y of yarnsFixed) {
      yarnById.set(Number(y.IDref_fil), { reference: y.reference ?? null, prix_kg: Number(y.prix_kg) || 0 })
    }
  }

  const colById = new Map<number, { reference: string | null; prix_kg: number }>()
  if (colIds.length > 0) {
    const cols = await query<{ IDcolori_fil: number; reference: string | null; prix_kg: number | null }>(
      `SELECT IDcolori_fil, reference, prix_kg FROM colori_fil WHERE IDcolori_fil IN (${colIds.join(',')})`,
    )
    const colsFixed = (await fixEncoding(cols as any[], 'colori_fil', 'IDcolori_fil', ['reference'])) as Array<{
      IDcolori_fil: number
      reference: string | null
      prix_kg: number | null
    }>
    for (const c of colsFixed) {
      colById.set(Number(c.IDcolori_fil), { reference: c.reference ?? null, prix_kg: Number(c.prix_kg) || 0 })
    }
  }

  const lines: TarifDetailLine[] = []
  for (const c of comp) {
    const pourcentage = Number(c.pourcentage) || 0
    const yarn = yarnById.get(Number(c.IDref_fil))
    const col = colById.get(Number(c.IDcolori_fil))
    const prixKg = col && col.prix_kg !== 0 ? col.prix_kg : (yarn?.prix_kg ?? 0)
    const prixCompo = (prixKg * pourcentage) / 100
    const colSuffix = col?.reference ? ` - ${col.reference}` : ''
    lines.push({
      label: `${pourcentage}% de ${yarn?.reference ?? ''}${colSuffix} à ${eur(prixKg)} €`,
      valueKg: round2(prixCompo),
    })
  }
  return lines
}
