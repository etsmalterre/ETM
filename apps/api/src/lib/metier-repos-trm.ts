// Atelier PWA — what an IDLE métier tells about itself (the « Inactifs » list
// of FEN_Choix_Metier and the poste's « Aucun OF en cours » state).
//
// The legacy tile of a métier with no OF is blank: its emplacement and nothing
// else. Decision (user, 2026-09-15): the tile carries the LAST OF that ran on
// the métier (reference, coloris, when it stopped) and the NEXT one waiting in
// its queue, and the poste lists the last twenty OFs knitted on it. The
// régleur reads the idle list as their work queue — a re-run of the same
// reference is a short setup, a machine idle for a week is a signal — and the
// waiting OF is what they will set up next.
//
// Everything here is pure so routes/atelier.ts can be fed rows and the
// choices tested without a base.

/** A finished OF of a métier, as far as "which one ran last" needs. */
export interface OfTermineRow {
  id: number
  machineId: number
}

/** A waiting OF (est_termine = 0, est_actif = 0) of a métier. */
export interface OfAttenteRow {
  id: number
  machineId: number
  /** Dense 1..n after rerankQueue; 0 on rows the queue never ranked. */
  priorite: number
}

/** The last finished OF per métier = the HIGHEST id among its finished OFs.
 *
 *  Not the latest `arret_prod`: ids are assigned at creation and an OF is
 *  closed in the order it was knitted on its métier, so the highest id is the
 *  one that ran last — the same reading the ERP's « Terminés » tab (id DESC)
 *  and the réglage sheet's « référence précédente » (TOP 20 by id) already
 *  use. It also keeps the read to one GROUP BY on the driver instead of a
 *  DATETIME MAX whose empty-vs-null answer differs between Windows ODBC and
 *  the Linux bridge. */
export function dernierOfParMetier(rows: OfTermineRow[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of rows) {
    if (r.id <= 0 || r.machineId <= 0) continue
    const cur = out.get(r.machineId)
    if (cur === undefined || r.id > cur) out.set(r.machineId, r.id)
  }
  return out
}

/** The head of each métier's waiting queue: lowest priorite first, an
 *  unranked row (priorite 0) after every ranked one, ties on the lowest id —
 *  the order rerankQueue() itself imposes (`priorite ASC, IDordre_fabrication
 *  ASC`), so the phone names the OF the ERP would activate next. */
export function prochainOfParMetier<T extends OfAttenteRow>(rows: T[]): Map<number, T> {
  const out = new Map<number, T>()
  for (const r of rows) {
    if (r.id <= 0 || r.machineId <= 0) continue
    const cur = out.get(r.machineId)
    if (cur === undefined || avant(r, cur)) out.set(r.machineId, r)
  }
  return out
}

function avant(a: OfAttenteRow, b: OfAttenteRow): boolean {
  const pa = a.priorite > 0 ? a.priorite : Number.POSITIVE_INFINITY
  const pb = b.priorite > 0 ? b.priorite : Number.POSITIVE_INFINITY
  if (pa !== pb) return pa < pb
  return a.id < b.id
}

/** When an OF stopped: `arret_prod` (written by every closing path — 3 162 of
 *  the 3 163 finished OFs on the live base carry one, 2026-09-15), else the
 *  end of its last piece, else unknown. The fallback exists for the legacy
 *  Android handover, which flips est_actif and stamps nothing. */
export function finDeOf(arretProdMs: number | null, dernierePieceFinMs: number | null): number | null {
  if (arretProdMs !== null) return arretProdMs
  return dernierePieceFinMs
}

/** How many finished OFs the poste's history lists. */
export const DERNIERS_OF_MAX = 20
