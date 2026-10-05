// Sous-traitant ennoblisseur auto-pricing — port of the legacy WLanguage
// `CalculTarifSST` procedure. Reads the per-sous-traitant tariff catalog
// (`tranche_tarif_ennoblissement`) and combines the dye-only base price,
// any matching treatment combination, and individual treatment add-ons to
// produce a final €/Kg price. Two hardcoded suppliers (MATEL, ESAT Tissu)
// get a rendement-based multiplier on certain rows.
//
// The full algorithm + business rules are documented in the user's project
// memory file `project_pricing_calcultarifsst.md`.
//
// Module is route-agnostic so the future Sous-traitants Gestion screen can
// reuse the same functions (and ideally edit the constants below once they
// move to a config table).

import { query } from './hfsql-auto.js'

/** MATEL — sous_traitant.IDsous_traitant = 9. The largest ennoblisseur
 *  partner; gets a rendement-based multiplier on dye-only base prices and
 *  on Lavage / BNO-PAT treatment add-ons. */
export const MATEL_IDSOUS_TRAITANT = 9

/** ESAT Tissu — sous_traitant.IDsous_traitant = 89. Same multiplier as
 *  MATEL but ONLY on the Lavage / BNO-PAT treatment add-ons, not on the
 *  base dye-only price. */
export const ESAT_IDSOUS_TRAITANT = 89

/** "Lavage" treatment — traitement.IDtraitement = 285. */
export const LAVAGE_IDTRAITEMENT = 285

/** "BNO/PAT" treatment — traitement.IDtraitement = 302. */
export const BNO_PAT_IDTRAITEMENT = 302

/** « Coloration Simple Teinture » (« Tous Coloris ») — teinture.IDteinture = 7,
 *  the « ST » of MATEL's invoices. The base of a wash-only fini whose
 *  treatments cost nothing (see _calcCore). */
export const SIMPLE_TEINTURE_IDTEINTURE = 7

// Bands for MultiplicateurMatel. Sorted by threshold ASC. A `null` threshold
// sentinel matches "everything above the last numeric threshold" (the legacy
// `cas > 8` branch). Linear scan picks the FIRST entry whose threshold
// satisfies `rendement <= threshold` (the legacy `selon … cas <= n`).
const MATEL_BANDS: Array<{ threshold: number | null; multiplier: number }> = [
  { threshold: 3,    multiplier: 1.00 },
  { threshold: 3.5,  multiplier: 1.02 },
  { threshold: 4,    multiplier: 1.03 },
  { threshold: 4.5,  multiplier: 1.04 },
  { threshold: 5,    multiplier: 1.05 },
  { threshold: 5.5,  multiplier: 1.11 },
  { threshold: 6,    multiplier: 1.17 },
  { threshold: 6.5,  multiplier: 1.24 },
  { threshold: 7,    multiplier: 1.32 },
  { threshold: 7.5,  multiplier: 1.41 },
  { threshold: 8,    multiplier: 1.50 },
  { threshold: null, multiplier: 2.00 },
]

/** Map `ref_fini.rendement` (Ml/kg) → MATEL/ESAT price multiplier.
 *  Pure, synchronous, side-effect-free. Mirrors the legacy
 *  `MultiplicateurMatel` WLanguage procedure exactly. */
export function multiplicateurMatel(rendement: number): number {
  for (const band of MATEL_BANDS) {
    if (band.threshold === null) return band.multiplier
    if (rendement <= band.threshold) return band.multiplier
  }
  // Unreachable — the null-threshold sentinel always matches.
  return 1
}

/** The rendement band of MATEL's grid a fabric falls in — (de, a], de = null
 *  for the first band, a = null for the last — and its multiplier. Shown to
 *  explain the « × 1,03 » (Sous-traitants › Factures, ETM price tooltip). */
export function bandeMatel(rendement: number): { de: number | null; a: number | null; multiplicateur: number } {
  let de: number | null = null
  for (const band of MATEL_BANDS) {
    if (band.threshold === null || rendement <= band.threshold) return { de, a: band.threshold, multiplicateur: band.multiplier }
    de = band.threshold
  }
  return { de, a: null, multiplicateur: 1 }
}

// Internal shape of a tranche_tarif_ennoblissement row after we've narrowed
// it via the catalog SELECT. The legacy table has more columns but these are
// all we need for the algorithm.
interface TrancheRow {
  IDtranche_tarif_ennoblissement: number
  IDtraitement: number
  IDteinture: number
  ListeTraitements: string
  prix: number
}

/** Split a `ListeTraitements` CSV ("287,285,291") into a `Set<number>`.
 *  The legacy uses `Contient(string, id)` substring matching which has
 *  false-positive traps (e.g. "85" contains in "285"). We avoid the trap
 *  by parsing properly — same end-result for the live data (all IDs are
 *  3 digits, no false positives observed) but safe against future 2-digit
 *  ids. */
function parseListeTraitements(s: string): Set<number> {
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const n = Number(part.trim())
    if (Number.isFinite(n) && n > 0) out.add(n)
  }
  return out
}

/** Round to 2 decimals — mirrors the legacy `Arrondi(moPrix, 2)` semantics.
 *  Note that JS `Math.round` is half-away-from-zero for positive numbers,
 *  which matches HFSQL `Arrondi` for the value range we deal with (prices
 *  are always positive). */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** A structured trace of every component that went into a calculated
 *  unit price. Returned alongside the final number by
 *  `calcTarifSSTBreakdown` so the UI can render an explanatory tooltip. */
export interface PrixBreakdown {
  IDsous_traitant: number
  xPoids: number
  rendement: number
  /** ref_fini.avec_teinture — the gate that decides whether the dye id
   *  is looked up at all. */
  avec_teinture: number
  /** The dye id resolved for this line (0 if no dye applies). */
  IDteinture: number
  /** Multiplier that applies to MATEL base prices and to MATEL/ESAT
   *  Lavage / BNO-PAT treatment add-ons. 1 means "no multiplier". */
  matel_multiplier: number
  /** The base entry of the price — either a combination row (covers
   *  multiple treatments at once) or a dye-only row, or absent. */
  base:
    | { kind: 'combination'; IDtranche: number; covered: number[]; raw_prix: number; applied_prix: number }
    | { kind: 'dye-only'; IDtranche: number; IDteinture: number; raw_prix: number; applied_prix: number }
    | null
  /** Each "remaining" treatment that got added on top of the base. */
  treatments: Array<{
    IDtraitement: number
    IDtranche: number
    raw_prix: number
    applied_prix: number
    /** True iff the MATEL/ESAT multiplier was applied to this entry
     *  (i.e. it's Lavage or BNO-PAT on MATEL or ESAT). */
    matel_applied: boolean
  }>
  /** The treatments on the ref that didn't get priced — neither covered
   *  by the base combination nor by any single-treatment tariff row. */
  unpriced_treatments: number[]
  /** The final rounded price, identical to `calcTarifSST(...)`. */
  total: number
}

/** Shared internal: runs the algorithm and returns both the final price
 *  and a structured breakdown. The two public exports below are thin
 *  wrappers around this. */
async function _calcCore(input: {
  xPoids: number
  IDsous_traitant: number
  IDref_fini: number
  IDref_fini_colori: number
}): Promise<{ prix: number; breakdown: PrixBreakdown | null }> {
  const { xPoids, IDsous_traitant, IDref_fini, IDref_fini_colori } = input

  // 1) Empty-weight guard — legacy returns 0 immediately.
  if (!(xPoids > 0)) return { prix: 0, breakdown: null }
  if (!(IDsous_traitant > 0) || !(IDref_fini > 0)) return { prix: 0, breakdown: null }

  // 2) Context: ref_fini metadata + coloris dye + ref's treatment list.
  const refFiniRows = await query<{ avec_teinture: number; rendement: number }>(
    `SELECT avec_teinture, rendement FROM ref_fini WHERE IDref_fini = ${IDref_fini}`,
  )
  if (refFiniRows.length === 0) return { prix: 0, breakdown: null }
  const avecTeinture = Number(refFiniRows[0].avec_teinture) || 0
  const rendement = Number(refFiniRows[0].rendement) || 0

  let nIDTeinture = 0
  if (avecTeinture !== 0 && IDref_fini_colori > 0) {
    const colRows = await query<{ IDteinture: number | null }>(
      `SELECT IDteinture FROM ref_fini_colori WHERE IDref_fini_colori = ${IDref_fini_colori}`,
    )
    nIDTeinture = Number(colRows[0]?.IDteinture) || 0
  }

  const trtRows = await query<{ IDtraitement: number }>(
    `SELECT IDtraitement FROM traitement_ref_fini WHERE IDref_fini = ${IDref_fini}`,
  )
  const refTreatments = new Set<number>()
  for (const r of trtRows) {
    const n = Number(r.IDtraitement)
    if (n > 0) refTreatments.add(n)
  }

  // 3) Single SELECT for all relevant tariff rows for this sst + weight
  //    band; partition in JS.
  const allBands = await query<TrancheRow>(
    `SELECT IDtranche_tarif_ennoblissement, IDtraitement, IDteinture, ListeTraitements, quantite_mini, quantite_maxi, prix
     FROM tranche_tarif_ennoblissement
     WHERE IDsous_traitant = ${IDsous_traitant}
       AND quantite_mini <= ${xPoids}
       AND quantite_maxi >= ${xPoids}`,
  )

  const combinations: TrancheRow[] = []
  let dyeOnly: TrancheRow | null = null
  let simpleTeinture: TrancheRow | null = null
  const singleByTrt = new Map<number, TrancheRow>()
  for (const r of allBands) {
    const list = (r.ListeTraitements ?? '').trim()
    if (list !== '') {
      combinations.push({ ...r, ListeTraitements: list })
    } else if (Number(r.IDteinture) > 0 && Number(r.IDtraitement) === 0) {
      if (Number(r.IDteinture) === nIDTeinture) dyeOnly = r
      if (Number(r.IDteinture) === SIMPLE_TEINTURE_IDTEINTURE) simpleTeinture = r
    } else if (Number(r.IDtraitement) > 0) {
      singleByTrt.set(Number(r.IDtraitement), r)
    }
  }

  // 4) Best-fitting combination (covers the most of refTreatments).
  let bestCombo: TrancheRow | null = null
  let bestComboCovered: number[] = []
  let tabTrtRestant = new Set(refTreatments)
  for (const row of combinations) {
    if (Number(row.IDteinture) !== nIDTeinture) continue
    const covered = parseListeTraitements(row.ListeTraitements)
    const uncovered = new Set<number>()
    for (const t of refTreatments) if (!covered.has(t)) uncovered.add(t)
    if (uncovered.size < tabTrtRestant.size) {
      bestCombo = row
      bestComboCovered = Array.from(covered).filter((t) => refTreatments.has(t))
      tabTrtRestant = uncovered
    }
  }

  // 5) Base price + MATEL multiplier (dye-only branch only).
  const matelMultiplier =
    IDsous_traitant === MATEL_IDSOUS_TRAITANT || IDsous_traitant === ESAT_IDSOUS_TRAITANT
      ? multiplicateurMatel(rendement)
      : 1

  let moPrix = 0
  let baseEntry: PrixBreakdown['base'] = null
  if (bestCombo === null) {
    const rawBase = Number(dyeOnly?.prix) || 0
    let applied = rawBase
    if (IDsous_traitant === MATEL_IDSOUS_TRAITANT && rawBase > 0) {
      applied = rawBase * matelMultiplier
    }
    moPrix = applied
    if (dyeOnly) {
      baseEntry = {
        kind: 'dye-only',
        IDtranche: Number(dyeOnly.IDtranche_tarif_ennoblissement),
        IDteinture: Number(dyeOnly.IDteinture),
        raw_prix: rawBase,
        applied_prix: applied,
      }
    }
  } else {
    const rawBase = Number(bestCombo.prix) || 0
    moPrix = rawBase
    baseEntry = {
      kind: 'combination',
      IDtranche: Number(bestCombo.IDtranche_tarif_ennoblissement),
      covered: bestComboCovered,
      raw_prix: rawBase,
      applied_prix: rawBase,
    }
  }

  // 6) Remaining single treatments, with the MATEL/ESAT Lavage / BNO-PAT
  //    multiplier carve-out.
  const treatmentTrace: PrixBreakdown['treatments'] = []
  const unpriced: number[] = []
  for (const trt of tabTrtRestant) {
    const row = singleByTrt.get(trt)
    if (!row) {
      unpriced.push(trt)
      continue
    }
    const rawP = Number(row.prix) || 0
    const matelApplies =
      (trt === LAVAGE_IDTRAITEMENT || trt === BNO_PAT_IDTRAITEMENT)
      && (IDsous_traitant === MATEL_IDSOUS_TRAITANT || IDsous_traitant === ESAT_IDSOUS_TRAITANT)
    const appliedP = matelApplies ? rawP * matelMultiplier : rawP
    moPrix += appliedP
    treatmentTrace.push({
      IDtraitement: trt,
      IDtranche: Number(row.IDtranche_tarif_ennoblissement),
      raw_prix: rawP,
      applied_prix: appliedP,
      matel_applied: matelApplies,
    })
  }

  // A wash-only fini (no dye) whose treatments all cost 0 € — e.g. 027B
  // écru, Rame + Vaporisage at 0 € — is billed by MATEL as « ST »: Coloration
  // Simple Teinture, by weight band (5,30 at 244–252 kg, 13,98 at 21,5 kg on
  // its 2026 invoices, exactly this tariff). The legacy priced it 0 €, which
  // also left the agent Factures Ennoblisseur nothing to check (decision
  // Vincent 2026-10-02). Only when nothing else carries a price: a wash-only
  // ref whose Lavage is priced (029B, 284B) keeps its treatments alone.
  if (avecTeinture === 0 && baseEntry === null && moPrix === 0 && simpleTeinture) {
    const st: TrancheRow = simpleTeinture
    const rawBase = Number(st.prix) || 0
    const applied = IDsous_traitant === MATEL_IDSOUS_TRAITANT ? rawBase * matelMultiplier : rawBase
    moPrix = applied
    baseEntry = { kind: 'dye-only', IDtranche: Number(st.IDtranche_tarif_ennoblissement), IDteinture: SIMPLE_TEINTURE_IDTEINTURE, raw_prix: rawBase, applied_prix: applied }
  }

  const total = round2(moPrix)
  const breakdown: PrixBreakdown = {
    IDsous_traitant,
    xPoids,
    rendement,
    avec_teinture: avecTeinture,
    IDteinture: nIDTeinture,
    matel_multiplier: matelMultiplier,
    base: baseEntry,
    treatments: treatmentTrace,
    unpriced_treatments: unpriced,
    total,
  }
  return { prix: total, breakdown }
}

/** Core algorithm — returns just the final per-kg price. */
export async function calcTarifSST(input: {
  xPoids: number
  IDsous_traitant: number
  IDref_fini: number
  IDref_fini_colori: number
}): Promise<number> {
  return (await _calcCore(input)).prix
}

/** Same algorithm but also returns the structured breakdown. Null when
 *  the algorithm short-circuited (no weight, missing IDs). */
export async function calcTarifSSTBreakdown(input: {
  xPoids: number
  IDsous_traitant: number
  IDref_fini: number
  IDref_fini_colori: number
}): Promise<PrixBreakdown | null> {
  return (await _calcCore(input)).breakdown
}

/** True when the sous-traitant has at least one row in
 *  `tranche_tarif_ennoblissement`. When false, the algorithm has no data
 *  to compute from and `recalcLignePrix` will leave the manually-entered
 *  prix alone. Also drives the frontend's read-only lock on the prix
 *  input — out-of-catalog suppliers (e.g. FRANCE TEINTURE) keep manual
 *  entry. Cheap query — single COUNT against an indexed FK. */
export async function hasTariffData(IDsous_traitant: number): Promise<boolean> {
  if (!(IDsous_traitant > 0)) return false
  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tranche_tarif_ennoblissement WHERE IDsous_traitant = ${IDsous_traitant}`,
  )
  return Number(r[0]?.n) > 0
}

/** Resolve context for a sous-traitant line, run `calcTarifSST`, and
 *  persist the result. Returns the new prix (or the existing prix when
 *  the line isn't priced by this algorithm). */
export async function recalcLignePrix(ligneId: number): Promise<number> {
  if (!(ligneId > 0)) return 0

  // The reserved-word column `type` on ligne_commande_sous_traitant must
  // be aliased — without that, the result key comes back uppercased (see
  // CLAUDE.md HFSQL rules).
  const lineRows = await query<{
    IDcommande_sous_traitant: number
    IDreference: number
    IDColoris: number
    type_kind: number
    prix: number | null
  }>(
    `SELECT IDcommande_sous_traitant, IDreference, IDColoris, type AS type_kind, prix
     FROM ligne_commande_sous_traitant
     WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  if (lineRows.length === 0) return 0
  const line = lineRows[0]
  const currentPrix = Number(line.prix) || 0

  // Phase 1 auto-pricing is ennoblisseur-only (type=2). Other line types
  // keep whatever prix is on file — no-op.
  if (Number(line.type_kind) !== 2) return currentPrix

  const cmdRows = await query<{ IDsous_traitant: number }>(
    `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${Number(line.IDcommande_sous_traitant)}`,
  )
  const IDsous_traitant = Number(cmdRows[0]?.IDsous_traitant) || 0

  // Skip ssts that have no rows in `tranche_tarif_ennoblissement` — the
  // algorithm has no opinion, so we MUST NOT overwrite a manually-entered
  // prix with 0. The frontend disables the prix input only when this
  // returns true; here we just enforce it server-side as a safety net.
  if (!(await hasTariffData(IDsous_traitant))) return currentPrix

  // Total kg of attached écru rolls. SUM() can return null when the line
  // has no rolls — coalesce to 0.
  const poidsRows = await query<{ total: number | null }>(
    `SELECT SUM(poids) AS total FROM stock_ecru WHERE IDref_commande_affectation = ${ligneId}`,
  )
  const xPoids = Number(poidsRows[0]?.total) || 0

  const newPrix = await calcTarifSST({
    xPoids,
    IDsous_traitant,
    IDref_fini: Number(line.IDreference) || 0,
    IDref_fini_colori: Number(line.IDColoris) || 0,
  })

  await query(
    `UPDATE ligne_commande_sous_traitant SET prix = ${newPrix} WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  return newPrix
}
