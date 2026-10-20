// Received lots of a dyer order that the « Soumettre au client » flow cannot
// offer, and why (LIVA #1302).
//
// A lot is soumissible only through its fini rolls' CLIENT reservation
// (`stock_fini.IDligne_commande_client`): the soumission is addressed for one
// client order. When the rolls carry none, the picker used to say nothing and
// the button jumped straight to another lot's email — Pierrot sent MA109373's
// sheet again while looking for MA109374, whose 11 rolls he had himself taken
// off the client line half an hour earlier (19/10/2026). The picker now lists
// these lots greyed out with the reason and the fix.

export type RaisonLotBloque =
  /** No roll of the lot is reserved to a client order line. */
  | 'non_reserve'
  /** Rolls reserved, but the client asks no soumission for this reference
   *  (no `designation_client` with `soumettre = 1`, or archived). */
  | 'sans_soumission'

export interface CommandeClientRef {
  numero: number
  client_nom: string
}

export interface LotBloque {
  lot: string
  raison: RaisonLotBloque
  nb_rolls: number
  total_metrage: number
  /** non_reserve: the client order the lot's écru pieces are reserved to.
   *  Once dyed the fini owns the reservation and the écru pointer is history
   *  (#1188) — a fact to quote (where to reaffect), not a cause. */
  reservation_ecru: CommandeClientRef | null
  /** sans_soumission: the client order the rolls are reserved to. */
  commande_client: CommandeClientRef | null
}

export interface RouleauFini {
  lot: string | null
  /** stock_fini.IDligne_commande_client (0 = free). */
  lcc: number
  /** stock_fini.IDcommande_donation (> 0 = given away, out of the picture). */
  donation: number
  metrage: number
  /** stock_ecru.IDligne_commande_client of the roll's source écru (0 = none). */
  lccEcru: number
}

/**
 * Lots received on the order that no soumission candidate covers.
 *
 * `lotsEligibles` = the lot strings the picker already offers; a lot listed
 * there is never reported, even if some of its rolls are free (a partial
 * reservation still submits). `commandeDeLigne` resolves a client line to its
 * order (numero + client) for the messages; an unknown line reads as none.
 */
export function lotsNonSoumissibles(
  rouleaux: RouleauFini[],
  lotsEligibles: Set<string>,
  commandeDeLigne: (lcc: number) => CommandeClientRef | null,
): LotBloque[] {
  const parLot = new Map<string, RouleauFini[]>()
  for (const r of rouleaux) {
    const lot = (r.lot ?? '').trim()
    if (!lot || r.donation > 0 || lotsEligibles.has(lot)) continue
    const liste = parLot.get(lot) ?? []
    liste.push(r)
    parLot.set(lot, liste)
  }

  const out: LotBloque[] = []
  for (const [lot, liste] of parLot) {
    const nb_rolls = liste.length
    const total_metrage = Math.round(liste.reduce((s, r) => s + (Number(r.metrage) || 0), 0) * 10) / 10
    const reserve = liste.find((r) => r.lcc > 0)
    if (reserve) {
      out.push({
        lot, raison: 'sans_soumission', nb_rolls, total_metrage,
        reservation_ecru: null,
        commande_client: commandeDeLigne(reserve.lcc),
      })
      continue
    }
    const ecru = liste.find((r) => r.lccEcru > 0)
    out.push({
      lot, raison: 'non_reserve', nb_rolls, total_metrage,
      reservation_ecru: ecru ? commandeDeLigne(ecru.lccEcru) : null,
      commande_client: null,
    })
  }
  return out.sort((a, b) => a.lot.localeCompare(b.lot))
}
