// Where the tirelles are stored, and how to find one again (LIVA #1380,
// Isabelle for Laetitia, decisions Vincent 2026-11-18).
//
// Once a lot's controls are done, its square and tirelle go into a BOX of the
// lab's shelf: 48 boxes, rows A to F, numbers 1 to 8 (« A1 », « B3 »…). The box
// is `suivilot.emplacement_tirelle`, the very field the tablet's « Contrôles
// terminés » has always written (lib/tirelle-labo.ts).
//
//   - Search: by lot, reference or coloris, over EVERY lot (the lab's queue
//     only shows what is left to do), to find the box of a tirelle when samples
//     are needed and the lot's data is not at hand.
//   - Empty a box: when the shelf is full she throws away the content of the
//     oldest box (end of archiving). No date to type: the box's lots simply
//     lose their location. Each one gets a line in its Journal.
//
// ⚠️ We start from zero (Vincent 2026-11-18): what was typed before the boxes
// (« Carton », « Etagère », « 0 ») is not a box. A lot without a box is not
// found by the search at all: if it is not on the shelf, it is not there.
// Nothing is migrated.
//
// This file is the pure part (the shelf, the matching); the reads and the
// write are in lib/tirelle-rangement.ts.

// ── The shelf (pure) ─────────────────────────────────────

export const RANGEES = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export const NUMEROS = [1, 2, 3, 4, 5, 6, 7, 8] as const

/** Every box, shelf order: A1 … A8, B1 … F8. */
export const BOITES: string[] = RANGEES.flatMap((r) => NUMEROS.map((n) => `${r}${n}`))

const BOITE_RE = new RegExp(`^[${RANGEES[0]}-${RANGEES[RANGEES.length - 1]}][${NUMEROS[0]}-${NUMEROS[NUMEROS.length - 1]}]$`)

/** A typed location as a box (« b 3 » → « B3 »), null when it is not one. */
export function lireBoite(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, '').toUpperCase()
  return BOITE_RE.test(s) ? s : null
}

/** Lowercase, accents and case ignored: « Écru » matches « ecru ». */
export function plier(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** The words of a search, folded. */
export function termesRecherche(q: string): string[] {
  return plier(q).split(/\s+/).filter(Boolean)
}

/** Every word must be found in the lot, the reference or the coloris
 *  (« 027a noir » = reference 027A, a coloris holding « noir »). */
export function correspond(l: { lot: string; reference: string; coloris: string }, termes: string[]): boolean {
  if (termes.length === 0) return false
  const champs = [plier(l.lot), plier(l.reference), plier(l.coloris)]
  return termes.every((t) => champs.some((c) => c.includes(t)))
}

/** Shortest search worth running (one letter matches half the lots). */
export const RECHERCHE_MIN = 2
/** Lots returned at most; `total` says how many matched. */
export const RECHERCHE_MAX = 60

// ── The boxes' content (pure) ────────────────────────────

export interface EtatBoite {
  boite: string
  /** Tirelles stored in it. */
  n: number
  /** Reception of its oldest and of its most recent lot (ISO), null when empty. */
  du: string | null
  au: string | null
}

/** How far back the shelf goes: the reception (ISO) of the oldest lot still in
 *  a box, null while the shelf is empty. The tablet shows it as an age (« 9 mois
 *  d'archives »): the one figure worth reading there (Vincent 2026-11-18). */
export function debutArchive(boites: EtatBoite[]): string | null {
  let debut: string | null = null
  for (const b of boites) {
    if (b.n === 0 || !b.du) continue
    if (!debut || b.du < debut) debut = b.du
  }
  return debut
}
