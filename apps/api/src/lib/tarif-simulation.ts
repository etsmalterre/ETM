// Finis › Tarifs — the rules of a price simulation that need no database
// (LIVA #1298), kept apart from the route so they can be tested.

/** Where a simulation comes from. `reference` = the study of a client's
 *  reference (compared with its catalogue and client price), `echantillon` =
 *  the estimate of a sample, `libre` = typed from scratch (every legacy row
 *  and the blank / duplicated ones without a source). */
export type SourceSimulation = 'reference' | 'echantillon' | 'libre'

export function sourceSimulation(r: { idref_fini?: number | null; idref_echantillon?: number | null }): SourceSimulation {
  if ((Number(r.idref_fini) || 0) > 0) return 'reference'
  if ((Number(r.idref_echantillon) || 0) > 0) return 'echantillon'
  return 'libre'
}

/** Rendement (Ml per Kg) of a fabric from its width (cm) and weight (g/m²):
 *  1 Kg covers 1000 / g m², i.e. 1000 / (g × laize/100) metres. 0 when either
 *  measure is missing — the simulation then asks for the rendement. */
export function rendementDepuisMesures(laizeCm: number, poidsM2: number): number {
  const l = Number(laizeCm) || 0
  const p = Number(poidsM2) || 0
  if (!(l > 0) || !(p > 0)) return 0
  return Math.round((100000 / (l * p)) * 10000) / 10000
}

/** Gain of the simulated price over a baseline, in percent of the baseline
 *  (positive = cheaper for the client). null when there is no baseline. */
export function gainPct(baseline: number | null | undefined, simule: number): number | null {
  const b = Number(baseline)
  if (!(b > 0)) return null
  return Math.round(((b - simule) / b) * 1000) / 10
}
