// The lab's shelf of tirelles: 48 boxes, rows A to F, numbers 1 to 8 (LIVA
// #1380, Vincent 2026-11-18). Mirror of the API's lib/tirelle-boites.ts, which
// decides; the lab tablet has the same (apps/tirelle/src/lib/boites.ts).

export const RANGEES = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export const NUMEROS = [1, 2, 3, 4, 5, 6, 7, 8] as const

/** A stored location as a box (« b 3 » → « B3 »), null when it is not one
 *  (« Carton », « 0 »: what was typed before the boxes). */
export function lireBoite(v: string | null | undefined): string | null {
  const s = (v ?? '').replace(/\s+/g, '').toUpperCase()
  return /^[A-F][1-8]$/.test(s) ? s : null
}

export interface EtatBoite {
  boite: string
  /** Tirelles stored in it. */
  n: number
  /** Reception of its oldest and of its most recent lot (ISO). */
  du: string | null
  au: string | null
}
