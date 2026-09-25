import { ROLL_MULT } from './pricing-fini-tarif.js'

// Roll geometry shared by the order-line pricer (pricing-ligne-client.ts) and
// the associated-ref band (palier-associe.ts): how many whole rolls a quantity
// is, and which of the 9 tariff bands (<1, 1, 2, 3, 4, 5, 10, 15, 30 rolls)
// that count falls in.

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Largest tranche index (1..8) whose roll band ≤ nRolls; tranche 0 ("métrage")
 *  when below a single roll. */
export function pickTrancheIndex(nRolls: number): number {
  if (nRolls < 1) return 0
  let idx = 1
  for (let i = 1; i < ROLL_MULT.length; i++) {
    if (ROLL_MULT[i] <= nRolls) idx = i
  }
  return idx
}

/** Roll geometry from a quantity and the per-roll size (same unit).
 *  Users type whole Ml/Kg while roll sizes are fractional (poids × rounded
 *  rendement), so "spot on" must tolerate the rounding: any quantity within 1%
 *  of a roll of a clean multiple counts as exact (rounded to the NEAREST roll
 *  count, not floored) — otherwise 171 Ml on 85,7 Ml rolls reads as "> 1
 *  rouleau" with a silly "plus que 0 Ml" nudge instead of a clean 2 rolls. */
export function geom(quantite: number, rollSize: number): { nRolls: number; cleanQty: number; exact: boolean } {
  const rollsFloat = quantite / rollSize
  const nearest = Math.round(rollsFloat)
  if (nearest >= 1 && Math.abs(quantite - nearest * rollSize) <= rollSize * 0.01) {
    return { nRolls: nearest, cleanQty: round2(nearest * rollSize), exact: true }
  }
  const nRolls = Math.floor(rollsFloat + 1e-6)
  return { nRolls, cleanQty: round2(nRolls * rollSize), exact: false }
}

/** Size of one roll in the line's unit: Kg (1) = the écru roll weight, Ml (3) =
 *  weight × rendement. `rendement` is rounded to 2 dp first — HFSQL stores it as
 *  a noisy float32 (2.4000000953…), which would make 1440 Ml read as 29.99
 *  rolls. 0 when it can't be sized. */
export function rollSizeFor(unite: number, poids: number, rendement: number): number {
  const rdt = Math.round(rendement * 100) / 100
  if (unite === 3) return rdt > 0 && poids > 0 ? poids * rdt : 0
  if (unite === 1) return poids > 0 ? poids : 0
  return 0
}
