// Barème de la prime TRM (Production › Prime) — the €/Kg rates paid on the
// visitage output, and the ONLY place they are defined.
//
// Lives in lib/ rather than in routes/prime-trm.ts so it can be unit-tested
// without loading the HFSQL driver, and next to lib/pricing-trm.ts, which is
// where TRM's other pricing rules already live.

/** A barème (€/Kg) and the date it takes effect. */
export interface BaremePrime {
  /** Semester `debut` from which this barème applies, inclusive. */
  from: string
  premierChoix: number
  secondChoix: number
  retourClient: number
}

/**
 * Date-effective barèmes, oldest first.
 *
 * ⚠️ These used to be three module constants applied to EVERY browsable period,
 * so revising them silently recomputed the whole history and the screen showed
 * primes that were never paid. That is why a revision ships as a dated entry
 * here instead of an edit to the numbers above it: **never change a past row.**
 *
 * `from` MUST be a semester boundary (15/06 or 15/12) — see `baremePour`. The
 * prime is one sum over the whole period × one rate, so a barème starting
 * mid-semester cannot be priced without splitting every kg sum at the changeover
 * date (sumPoids, the déclassement montants, and the donut). If the atelier ever
 * wants a mid-semester change, that split is the work — not a new row here.
 */
export const BAREMES_PRIME: readonly BaremePrime[] = [
  // The legacy barème, in force for every semester up to and including S1 2026.
  { from: '0000-01-01', premierChoix: 0.05, secondChoix: -0.2, retourClient: -0.6 },
  // Révision décidée avec l'atelier (2026-08-26), applicable dès le semestre en
  // cours S2 2026. `retourClient` ne bouge pas : la tuile est morte (toujours 0).
  { from: '2026-06-15', premierChoix: 0.055, secondChoix: -0.4, retourClient: -0.6 },
]

/** The barème in force for the semester starting at `debutSemestre`. */
export function baremePour(debutSemestre: string): BaremePrime {
  let chosen = BAREMES_PRIME[0]
  for (const b of BAREMES_PRIME) {
    if (b.from <= debutSemestre) chosen = b
    else break
  }
  return chosen
}
