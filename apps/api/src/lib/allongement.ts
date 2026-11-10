// Allongement of a dyed lot, height and width (Vincent 2026-11-10).
//
// Laetitia's control on a few references (1731, 1732, EDF85/55): she cuts a
// 10 cm strip of the tirelle, stretches it beside a ruler and notes how far it
// goes, as a percentage (19 cm = 90 %), both ways. Malterre side only, before
// the wash. Asked when the reference's switch « Allongement » is on
// (ref_fini.controle_malterre_allongement, OFF by default, lib/controles-lot.ts).
//
// Stored in suivilot.allongementh_tirelle / allongementl_tirelle. NULL = not
// measured, 0 is a measure (a matter that does not stretch), like the vrillage
// and the stabilités. The pair is measured when BOTH sides are given.
//
// The tolerance is the fiche's « Allongement H / L » min · max (ref_fini
// allongementh_min…), as Vincent decided on 2026-11-10 — knowing those legacy
// figures may come from another method and will be revised.

import { horsBornes } from './analyse-qualite.js'

/** Highest value a person may type (a typo guard, not a tolerance). */
export const ALLONGEMENT_SAISIE_MAX = 500

export const CHAMPS_ALLONGEMENT = ['allongementh_tirelle', 'allongementl_tirelle'] as const
export type ChampAllongement = (typeof CHAMPS_ALLONGEMENT)[number]

export class AllongementInvalide extends Error {
  constructor(public champ: string, message: string) { super(message) }
}

/** A stored value → number or null. */
export function valeurAllongement(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/** A typed value (« 90 », « 90,5 », « 90 % ») → its stored number. Empty = not measured. */
export function lireSaisieAllongement(champ: string, v: unknown, libelle = 'L’allongement'): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(',', '.').replace(/\s*%$/, '')
  if (s === '') return null
  const x = Number(s)
  if (!Number.isFinite(x)) throw new AllongementInvalide(champ, `${libelle} doit être un nombre.`)
  if (x < 0) throw new AllongementInvalide(champ, `${libelle} ne peut pas être négatif.`)
  if (x > ALLONGEMENT_SAISIE_MAX) throw new AllongementInvalide(champ, `${libelle} ne peut pas dépasser ${ALLONGEMENT_SAISIE_MAX} %.`)
  return Math.round(x * 10) / 10
}

/** Both sides of the pair are given (0 included). */
export function allongementMesure(h: unknown, l: unknown): boolean {
  return valeurAllongement(h) !== null && valeurAllongement(l) !== null
}

/** Outside the fiche's min · max? null = not measured, or no bound on the fiche. */
export function allongementHors(v: number | null, min: unknown, max: unknown): boolean | null {
  return horsBornes(v, Number(min) || 0, Number(max) || 0)
}
