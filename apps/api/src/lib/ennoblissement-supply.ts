// Clients › Commandes › Ennoblissement tab — pure rules behind the
// « Disponible » / « Affecté » columns and the « Affecter le stock » dialog.
//
// LIVA #1188 (2026-09-23, order 3762 Le Slip Français): the tab counted every
// écru roll carrying `stock_ecru.IDref_commande_affectation = <dyer line>`,
// but that pointer (and `IDligne_commande_client`) survives the dyeing — the
// roll comes back as a `stock_fini` and the écru row is never cleared. So a
// dyed roll was counted once as écru « affecté » on the Ennoblissement tab
// and once as a fini roll on the Affectation tab, while the line's gauge
// (`lineReservationAggregates`) already replaced the écru by its fini child.
// Line 12851 read « Affecté 4 298,9 » on the gauge and 1 666,7 + 3 503,7 on
// the tab: the 871,5 Ml gap was 12 rolls of order 8970 already dyed and
// shipped against another line.
//
// Rule: an écru roll that has been consumed into a fini (own child OR
// component of a merged roll, `consumedEcruIds()` in fini-sources.ts) is
// out of the Ennoblissement tab altogether — neither disponible nor affecté,
// never offered by the link dialog, refused by the link route. What remains
// is exactly « still at the dyer », and per line: Σ tab « Affecté » + fini
// rolls on the Affectation tab = the gauge.

export interface EnnoEcruRow {
  /** stock_ecru.IDstock_ecru */
  id: number
  /** stock_ecru.IDref_commande_affectation — the ennoblisseur sst line */
  lid: number
  /** stock_ecru.IDligne_commande_client (0 = free) */
  lcc: number
  /** stock_ecru.IDcommande_donation (0 = none) */
  don: number
  poids: number
}

export interface EnnoSupplyBuckets {
  /** kg reserved to THE client line, per sst line id */
  affKg: Map<number, number>
  /** kg free (no client line, no donation), per sst line id */
  dispoKg: Map<number, number>
  /** rolls left out because already dyed */
  consumedRolls: number
}

/** Split the écru rolls affected to ennoblisseur lines into the two columns of
 *  the tab for ONE client line. A roll reserved to another client line or to a
 *  donation counts in neither column (spoken for elsewhere); a consumed roll
 *  counts nowhere (it is a fini roll now). */
export function ennoSupplyBuckets(rows: readonly EnnoEcruRow[], ligneId: number, consumed: ReadonlySet<number>): EnnoSupplyBuckets {
  const affKg = new Map<number, number>()
  const dispoKg = new Map<number, number>()
  let consumedRolls = 0
  for (const r of rows) {
    if (consumed.has(r.id)) { consumedRolls += 1; continue }
    const p = Number(r.poids) || 0
    if (r.lcc === ligneId) affKg.set(r.lid, (affKg.get(r.lid) ?? 0) + p)
    else if (!(r.lcc > 0) && !(r.don > 0)) dispoKg.set(r.lid, (dispoKg.get(r.lid) ?? 0) + p)
  }
  return { affKg, dispoKg, consumedRolls }
}

/** Keep only the écru rolls that are still écru. Used by the link dialog on
 *  both its lists (linked to the line / available on the sst line). */
export function liveEcruRolls<T extends { IDstock_ecru: number | string }>(rows: readonly T[], consumed: ReadonlySet<number>): T[] {
  return rows.filter((r) => !consumed.has(Number(r.IDstock_ecru)))
}

export const ECRU_CONSUMED_ERROR = {
  error: 'piece_teinte',
  message: 'Cette pièce a déjà été teinte : c’est le rouleau fini qui s’affecte, sur l’onglet Affectation.',
} as const
