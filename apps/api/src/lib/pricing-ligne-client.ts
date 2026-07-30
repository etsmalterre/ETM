// Per-line auto-pricing for client orders (Clients › Commandes "Nouvelle ligne").
//
// Given the reference + coloris + quantity + unit the user is entering, this
// derives:
//   - the suggested unit price (€/Ml or €/Kg), and
//   - the roll-count note shown next to the quantity field (e.g. "10 Rouleaux
//     (480 Ml)" green when the quantity is a whole-roll multiple, "> 10 Rouleaux
//     (480 Ml)" amber when it overshoots a clean roll count).
//
// It is a thin layer over the legacy `PrixDeVenteV4` port:
//   - Fini (type 2) reuses `calcTarifRefFini` (validated exact against the legacy
//     "Gestion ligne de commande" window: ref 040A beige2585, 10 rolls → 10,43 €).
//   - Écru / tombé-de-métier (type 1) is the nType_Ref=1 reduction of the same
//     procedure: prix de revient = fil + tricotage only (no ennoblissement), then
//     ÷ margin ÷ port. Kg-based (écru has no rendement).
//   - Divers (type 3) and non Kg/Ml units are not auto-priced (manual entry).
//
// ⚠️ The grid above is the STANDARD catalogue price. It is only what the client
// pays when the client has no negotiated tarif on that (référence × coloris) —
// so every call carries the client, and `lib/tarif-client.ts` decides:
//   - contrat actif    → the negotiated €/Ml of the matching band, and the
//                        next-tranche nudge only offers bands that contract
//                        actually defines;
//   - contrat expiré   → `blocked` — the reference is not sellable until a new
//                        contract is signed (same rule as Clients › Gestion),
//                        NEVER a silent fall back to the standard grid;
//   - coefficient fixe → the standard engine re-run with the client's margin;
//   - standard         → the grid, unchanged.
// A line outside the client's designation_client catalogue keeps the standard
// grid — it has no negotiated price to honour.
//
// Roll geometry: one roll = `ref_ecru.poids` kg = `poids × rendement` Ml. The
// tariff tranche is the largest band (1,2,3,4,5,10,15,30 rolls) not exceeding the
// floored roll count; below one roll it's the "métrage" band (tranche 0).

import { query } from './hfsql-auto.js'
import {
  calcTarifRefFini,
  computePrixFil,
  COEFFICIENT_V2,
  ROLL_MULT,
} from './pricing-fini-tarif.js'
import {
  resolveLigneTarifMode, contratPrixForTrancheIdx,
  type ContratTarifInfo, type LigneTarifMode,
} from './tarif-client.js'

const TAUX_FRAIS_DE_PORT = 0.05
const TAUX_FRAIS_DE_PORT_30RLX = 0.03 // tranche i=8 (30 rolls)

/** Flag the next-tranche commercial nudge when the extra quantity needed to reach
 *  the next (cheaper) band is ≤ this fraction of the entered quantity. */
const NEAR_NEXT_TRANCHE_PCT = 0.15

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export interface LignePriceResult {
  /** Suggested unit price in the line's unit (€/Ml for unite 3, €/Kg for unite 1),
   *  or null when the line can't be auto-priced. */
  prix: number | null
  unite: number
  /** Quantity that makes up one roll, in the line's unit (Ml or Kg). */
  rollSize: number
  /** Whole rolls the entered quantity covers (floored). */
  nRolls: number
  /** Quantity of `nRolls` whole rolls, in the line's unit. */
  cleanQty: number
  /** True when the entered quantity is an exact whole-roll multiple. */
  exact: boolean
  /** Roll count of the tariff band actually used for the price. */
  trancheRolls: number
  /** Roll count of the NEXT (cheaper) tariff band, 0 if already at the top band. */
  nextTrancheRolls: number
  /** Quantity (line's unit) needed to reach the next band, 0 if none. */
  nextTrancheQty: number
  /** Extra quantity (line's unit) to add to reach the next band, 0 if none. */
  nextTrancheGapQty: number
  /** Unit price at the next band, null if none — lets the UI nudge "order a bit
   *  more to drop to this price". */
  nextTranchePrix: number | null
  /** True when within NEAR_NEXT_TRANCHE_PCT of the next band — show the nudge. */
  nearNextTranche: boolean
  /** False for divers / unsupported units / missing data — UI shows no note. */
  priceable: boolean
  /** Which grid the price came from, for this client on this (ref × coloris). */
  tarif_mode: 'standard' | 'coefficient' | 'contrat'
  /** Client's fixed margin in % when tarif_mode = 'coefficient', else 0. */
  coefficient: number
  /** Contract mode with no contract covering today — the line must be refused. */
  contrat_expire: boolean
  /** YYYYMMDD of the newest contract on the pair ('' when there is none) — what
   *  the UI prints in "Contrat expiré depuis le …". */
  contrat_date_expiration: string
  /** The line cannot be saved as entered. Today that means only an expired
   *  contract; the field exists so the UI has one thing to test. */
  blocked: boolean
  /** French explanation of `blocked`, ready to display. */
  blocked_reason: string | null
}

const BASE: LignePriceResult = {
  prix: null, unite: 0, rollSize: 0, nRolls: 0, cleanQty: 0,
  exact: false, trancheRolls: 0,
  nextTrancheRolls: 0, nextTrancheQty: 0, nextTrancheGapQty: 0, nextTranchePrix: null,
  nearNextTranche: false,
  priceable: false,
  tarif_mode: 'standard', coefficient: 0,
  contrat_expire: false, contrat_date_expiration: '',
  blocked: false, blocked_reason: null,
}

/** DD/MM/YYYY from a YYYYMMDD HFSQL date, '' when malformed. */
function frDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : ''
}

export function expiredContractMessage(mode: LigneTarifMode): string {
  const since = frDate(mode.dernier_contrat?.date_expiration ?? '')
  return `Contrat expiré${since ? ` depuis le ${since}` : ''} — cette référence n’est plus disponible `
    + `tant qu’un nouveau contrat n’a pas été établi.`
}

/** Per-tranche price function of an ACTIVE contract, in the line's unit.
 *  `prix_saisi` is negotiated in €/Ml, so a Kg line converts through the
 *  rendement (1 kg = rendement Ml — the same relation the engine uses to derive
 *  its own €/Ml from €/Kg). Returns null when the contract prices nothing, or
 *  when a Kg line has no rendement to convert with: in that case the line falls
 *  through to manual entry rather than silently billing the standard grid. */
function contratPriceFn(
  contrat: ContratTarifInfo, unite: number, rendement: number,
): ((j: number) => number) | null {
  if (contratPrixForTrancheIdx(contrat, 8) == null) return null
  if (unite === 1 && !(rendement > 0)) return null
  return (j: number) => {
    const ml = contratPrixForTrancheIdx(contrat, j) ?? 0
    return round2(unite === 3 ? ml : ml * rendement)
  }
}

/** The tarif-mode fields of the result, derived from the resolved mode. */
function modeFields(mode: LigneTarifMode | null): Pick<
  LignePriceResult, 'tarif_mode' | 'coefficient' | 'contrat_expire' | 'contrat_date_expiration' | 'blocked' | 'blocked_reason'
> {
  if (!mode) return { ...BASE }
  return {
    tarif_mode: mode.tarif_mode,
    coefficient: mode.coefficient,
    contrat_expire: mode.contrat_expire,
    contrat_date_expiration: mode.dernier_contrat?.date_expiration ?? '',
    blocked: mode.contrat_expire,
    blocked_reason: mode.contrat_expire ? expiredContractMessage(mode) : null,
  }
}

/** Largest tranche index (1..8) whose roll band ≤ nRolls; tranche 0 ("métrage")
 *  when below a single roll. */
function pickTrancheIndex(nRolls: number): number {
  if (nRolls < 1) return 0
  let idx = 1
  for (let i = 1; i < ROLL_MULT.length; i++) {
    if (ROLL_MULT[i] <= nRolls) idx = i
  }
  return idx
}

/** Describe the next (cheaper) tariff band above tranche `idx`, given a per-tranche
 *  price function. Returns zeros when already at the top band or when the next
 *  band isn't strictly cheaper (defensive — bands are monotonically cheaper). */
function nextTranche(
  idx: number,
  rollSize: number,
  quantite: number,
  priceAt: (j: number) => number,
  currentPrix: number,
): {
  nextTrancheRolls: number
  nextTrancheQty: number
  nextTrancheGapQty: number
  nextTranchePrix: number | null
  nearNextTranche: boolean
} {
  const none = { nextTrancheRolls: 0, nextTrancheQty: 0, nextTrancheGapQty: 0, nextTranchePrix: null, nearNextTranche: false }
  const nIdx = idx + 1
  if (nIdx >= ROLL_MULT.length) return none
  const nextPrix = priceAt(nIdx)
  if (!(nextPrix < currentPrix)) return none
  const nextQty = round2(ROLL_MULT[nIdx] * rollSize)
  const gap = round2(nextQty - quantite)
  return {
    nextTrancheRolls: ROLL_MULT[nIdx],
    nextTrancheQty: nextQty,
    nextTrancheGapQty: gap,
    nextTranchePrix: nextPrix,
    nearNextTranche: gap > 0 && gap <= quantite * NEAR_NEXT_TRANCHE_PCT,
  }
}

/** Roll geometry from a quantity and the per-roll size (same unit).
 *  Users type whole Ml/Kg while roll sizes are fractional (poids × rounded
 *  rendement), so "spot on" must tolerate the rounding: any quantity within 1%
 *  of a roll of a clean multiple counts as exact (rounded to the NEAREST roll
 *  count, not floored) — otherwise 171 Ml on 85,7 Ml rolls reads as "> 1
 *  rouleau" with a silly "plus que 0 Ml" nudge instead of a clean 2 rolls. */
function geom(quantite: number, rollSize: number): { nRolls: number; cleanQty: number; exact: boolean } {
  const rollsFloat = quantite / rollSize
  const nearest = Math.round(rollsFloat)
  if (nearest >= 1 && Math.abs(quantite - nearest * rollSize) <= rollSize * 0.01) {
    return { nRolls: nearest, cleanQty: round2(nearest * rollSize), exact: true }
  }
  const nRolls = Math.floor(rollsFloat + 1e-6)
  return { nRolls, cleanQty: round2(nRolls * rollSize), exact: false }
}

export async function calcLignePriceClient(p: {
  type: number
  IDreference: number
  IDcolori: number
  quantite: number
  unite: number
  /** Owner of the commande — decides which tarif grid applies. Omitted only by
   *  callers that genuinely have no client (none today). */
  IDclient?: number
}): Promise<LignePriceResult> {
  // The client's tarif mode is resolved FIRST and independently of the quantity:
  // an expired contract must show (and block) as soon as the coloris is picked,
  // before anything is typed in the quantity field.
  const mode = await resolveLigneTarifMode({
    IDclient: p.IDclient ?? 0, type: p.type, IDreference: p.IDreference, IDcolori: p.IDcolori,
  })
  const base = { ...BASE, unite: p.unite, ...modeFields(mode) }
  // Contract lapsed: the negotiated prices are gone and the reference is simply
  // not sellable — the standard grid is NOT a fallback (Clients › Gestion says
  // exactly this on the fiche, and the two must agree).
  if (mode?.contrat_expire) return base
  const contrat = mode?.tarif_mode === 'contrat' ? mode.contrat_actif : null
  const coefOpt = mode?.tarif_mode === 'coefficient' && mode.coefficient > 0
    ? { coefficient: mode.coefficient / 100 }
    : undefined

  // Only Kg (1) and Ml (3) lines have a roll-based tariff; divers / U / m² are manual.
  if (p.type === 3) return base
  if (!(p.IDreference > 0) || !(p.quantite > 0)) return base
  if (p.unite !== 1 && p.unite !== 3) return base

  // ── Fini (type 2) ──────────────────────────────────────────
  if (p.type === 2) {
    const tarif = await calcTarifRefFini(p.IDreference, p.IDcolori, coefOpt)
    if (!tarif.ref_ecru || tarif.tranches.length === 0) return base
    const poids = tarif.ref_ecru.poids
    // Round rendement to 2 dp before sizing a roll — HFSQL stores it as a noisy
    // float32 (e.g. 2.4000000953...), which would make a clean 1440 Ml read as
    // 29.99 rolls. This mirrors the engine's own `rdt2` rounding.
    const rendement = Math.round(tarif.rendement * 100) / 100
    const rollSize = p.unite === 3 ? (rendement > 0 ? poids * rendement : 0) : poids
    if (!(rollSize > 0)) return base
    const { nRolls, cleanQty, exact } = geom(p.quantite, rollSize)
    const idx = pickTrancheIndex(nRolls)
    const standardAt = (j: number) => (p.unite === 3 ? tarif.tranches[j].moPrixDeVenteAuMl : tarif.tranches[j].moPrixDeVenteAuKg)
    // An active contract replaces the grid entirely — including the next-tranche
    // nudge, which may only offer bands that contract actually negotiated.
    const contratAt = contrat ? contratPriceFn(contrat, p.unite, rendement) : null
    if (contrat && !contratAt) return { ...base, rollSize, nRolls, cleanQty, exact }
    const priceAt = contratAt ?? standardAt
    const prix = priceAt(idx)
    const next = nextTranche(idx, rollSize, p.quantite, priceAt, prix)
    return {
      ...base,
      prix, unite: p.unite, rollSize, nRolls, cleanQty, exact, trancheRolls: tarif.tranches[idx].rolls,
      ...next, priceable: true,
    }
  }

  // ── Écru / tombé de métier (type 1) — prix de revient = fil + tricotage ──
  if (p.type === 1) {
    const ecruRows = await query<{ poids: number | null; prix: number | null; rendement: number | null }>(
      `SELECT poids, prix, rendement FROM ref_ecru WHERE IDref_ecru = ${p.IDreference}`,
    )
    if (ecruRows.length === 0) return base
    const poids = Number(ecruRows[0].poids) || 0
    const prixTricotage = Number(ecruRows[0].prix) || 0
    const rendement = Math.round((Number(ecruRows[0].rendement) || 0) * 100) / 100
    if (!(poids > 0)) return base
    // One roll = poids kg = poids × rendement Ml. Ml lines need a rendement.
    const rollSize = p.unite === 3 ? (rendement > 0 ? poids * rendement : 0) : poids
    if (!(rollSize > 0)) return base
    const { nRolls, cleanQty, exact } = geom(p.quantite, rollSize)
    const idx = pickTrancheIndex(nRolls)

    const fil = await computePrixFil(p.IDreference, p.IDcolori)
    const moFil = round2(fil.reduce((s, d) => s + d.valueKg, 0))

    const standardAt = (j: number) => {
      let tric = prixTricotage
      if (j === 7) tric *= 0.95
      else if (j === 8) tric *= 0.9
      // A "coefficient fixe" client trades the degressive margin for its own,
      // flat across every tranche — same substitution calcTarifRefFini makes.
      const marge = coefOpt ? coefOpt.coefficient : COEFFICIENT_V2[j]
      const venteKg = (moFil + tric) / (1 - marge)
      const port = j === 8 ? TAUX_FRAIS_DE_PORT_30RLX : TAUX_FRAIS_DE_PORT
      return p.unite === 3 ? round2(venteKg / rendement / (1 - port)) : round2(venteKg / (1 - port))
    }
    const contratAt = contrat ? contratPriceFn(contrat, p.unite, rendement) : null
    if (contrat && !contratAt) return { ...base, rollSize, nRolls, cleanQty, exact }
    const priceAt = contratAt ?? standardAt
    const prix = priceAt(idx)
    const next = nextTranche(idx, rollSize, p.quantite, priceAt, prix)

    return {
      ...base,
      prix, unite: p.unite, rollSize, nRolls, cleanQty, exact, trancheRolls: ROLL_MULT[idx],
      ...next, priceable: true,
    }
  }

  return base
}
