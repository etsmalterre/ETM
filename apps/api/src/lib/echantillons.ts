// Tombé Métier › Échantillons — the rules of a sample's life, kept apart from
// the route so they can be tested without a database.
//
// A sample (`ref_echantillon`) is a trial écru fabric knitted before it is a
// reference: its own tables, its own cycle (claude_doc/echantillons_plan.md —
// separate tables on purpose, so no list of `ref_ecru` ever has to exclude
// samples). The cycle ends in one of two ways: archived, or turned into a
// `ref_ecru` (`idref_ecru` > 0, once — then it is closed for good).

export type StatutEchantillon = 'en_cours' | 'reference' | 'archive'

/** « Devenu référence » wins over the archive flag: a passage archives the
 *  sample too, but what the user needs to know is which reference it became. */
export function statutEchantillon(e: { archive: number | null; idref_ecru: number | null }): StatutEchantillon {
  if ((Number(e.idref_ecru) || 0) > 0) return 'reference'
  if (Number(e.archive)) return 'archive'
  return 'en_cours'
}

/** The sample's display number: « E055 ». It has no name of its own — the
 *  legacy shows the bare id; the E keeps it apart from a reference number. */
export function numeroEchantillon(id: number): string {
  return `E${String(id).padStart(3, '0')}`
}

/** `fil_ref_echantillon.pourcentage` is a FRACTION (0..1) while
 *  `composition_ecru.pourcentage` is a percentage (0..100). The API speaks
 *  percentages only; these two are the only crossings. */
export function fractionVersPourcent(f: number | null | undefined): number {
  return Math.round((Number(f) || 0) * 100 * 1000) / 1000
}
export function pourcentVersFraction(p: number): number {
  return Math.round((Number(p) || 0) * 1000) / 100000
}

/** A composition is valid empty (not entered yet) or totalling 100 %. */
export function compositionComplete(pourcents: number[]): boolean {
  if (pourcents.length === 0) return true
  const total = pourcents.reduce((s, p) => s + (Number(p) || 0), 0)
  return Math.abs(total - 100) < 0.01
}

/** `ref_echantillon.lfa1..4` are numbers, `ref_ecru.lfa_tour_1..4` text written
 *  « 7.50 » by the legacy; 0 / empty stays empty. */
export function lfaTexte(v: number | null | undefined): string {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : ''
}

/** Jauge / diamètre are 1-based ordinals of the legacy combos on both tables
 *  (2..5 / 2..3); the legacy left 65535 (and -1) on unset rows. Keep only a
 *  real choice, 0 otherwise. */
export function ordinalValide(v: number | null | undefined, max: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= max ? n : 0
}
export const JAUGE_ORD_MAX = 5
export const DIAMETRE_ORD_MAX = 3

/** Why a sample cannot become a reference, or null when it can. */
export function refusCreationReference(
  e: { archive: number | null; idref_ecru: number | null },
  pourcents: number[],
): 'deja_reference' | 'archive' | 'composition_incomplete' | null {
  const statut = statutEchantillon(e)
  if (statut === 'reference') return 'deja_reference'
  if (statut === 'archive') return 'archive'
  if (!compositionComplete(pourcents)) return 'composition_incomplete'
  return null
}
