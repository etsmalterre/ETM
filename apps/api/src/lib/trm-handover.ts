// The handover stamp a TRM roll receives when TRM ships it (LIVA #1172).
//
// Until 2026-09-18 two programs wrote this stamp: the MPS API (stampShippedPieces
// in expeditions-trm.ts) and the legacy WinDev « Expédier » still running on one
// PC. The legacy wrote one more column than the API — `IDref_commande_source`,
// the ETM sst line the roll was knitted for (the TRM line's IDligne_commande_ETM
// back-pointer) — and also reset `IDmagasin = 0`, which is what sent three rolls
// already transferred to MATEL back to the factory (#1172, stock_ecru journal:
// PC-PIERROT / MPS.exe, 17/09 09:15). The legacy is retired; the API now writes
// the source line itself and NEVER touches IDmagasin: the magasin is ETM's
// ledger, moved by Transferts only.
//
// Read by: Sous-traitants › Commandes tricoteur line « Affecté » (#1138, sums
// `stock_ecru.IDref_commande_source = line`), the roll's provenance drawer,
// the sst bon de commande kg tally, valorisation-stock.

export interface HandoverOpts {
  /** The TRM avis the rolls leave on — `lot` becomes `trm<expId>`. */
  expId: number
  /** The ligne_expedition the rolls hang off. */
  leId: number
  /** The avis' client is Ets Malterre → the roll changes owner (IDsociete 2 → 1). */
  toEtm: boolean
  /** `ligne_commande_client.IDligne_commande_ETM` of the shipped TRM line: the
   *  ETM sst line this knitting mirrors, 0 on a TRM-native line. */
  etmLineId: number
}

/** The SET fragments of the handover UPDATE, in a fixed order. */
export function handoverSets(o: HandoverOpts): string[] {
  const sets = [`IDligne_expedition_TRM = ${o.leId}`, `lot = 'trm${o.expId}'`]
  if (o.toEtm) sets.push('IDsociete = 1')
  // A mirror line's rolls were knitted FOR an ETM sst line: stamp it, as the
  // legacy did. A TRM-native line has no ETM line — leave 0, never guess.
  if (o.etmLineId > 0) sets.push(`IDref_commande_source = ${o.etmLineId}`)
  return sets
}

/** The reverse, for « retirer » / deleting an avis: unshipped, TRM's again,
 *  and no longer knitted "for" anything on ETM's side. */
export function releaseSets(): string[] {
  return ['IDligne_expedition_TRM = 0', "lot = ''", 'IDsociete = 2', 'IDref_commande_source = 0']
}
