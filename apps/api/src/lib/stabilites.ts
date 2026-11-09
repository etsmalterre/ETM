// Stabilités of a dyed lot (suivilot stabh_* / stabl_*, the dyer's *_sst and our
// tirelle's *_tirelle): the shrinkage of the square after the wash, in %, height
// and width.
//
// NULL = not measured, 0 is a real measure: an ultra-stable matter (LIVA #1358,
// Laetitia measures 0 / 0 on some lots, decision Vincent 2026-11-09). Until then
// 0 meant « empty » and a 0 / 0 lot stayed « à mesurer » (the tablet even refused
// it); migration 0065 turned every stored 0 / 0 pair into NULL / NULL — what ETM
// already read as « non mesuré ». Same rule as the vrillage (lib/vrillage.ts).
//
// The pair is measured when BOTH sides are given. The *_demandee columns (what
// the client asks, from the fiche) keep 0 = « nothing asked ».

/** Shrinkage a person may type, either way (a typo guard, not a tolerance). */
export const STAB_SAISIE_MAX = 60

export class StabInvalide extends Error {
  constructor(public champ: string, message: string) { super(message) }
}

/** A stored value → number or null (bigint columns may come back as strings). */
export function valeurStab(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/** A typed value → its stored number. Empty = not measured (null). */
export function lireSaisieStab(champ: string, v: unknown, libelle = 'La stabilité'): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(',', '.').replace(/\s*%$/, '')
  if (s === '') return null
  const x = Number(s)
  if (!Number.isFinite(x)) throw new StabInvalide(champ, `${libelle} doit être un nombre.`)
  if (Math.abs(x) > STAB_SAISIE_MAX) throw new StabInvalide(champ, `${libelle} doit être entre −${STAB_SAISIE_MAX} et ${STAB_SAISIE_MAX} %.`)
  // The columns are integers, as the legacy typed them.
  return Math.round(x)
}

/** Both sides of the pair are given (0 included). */
export function stabMesurees(h: unknown, l: unknown): boolean {
  return valeurStab(h) !== null && valeurStab(l) !== null
}
