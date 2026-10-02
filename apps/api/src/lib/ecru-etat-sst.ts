import { isLineDone } from './sst-shared.js'

// État of an écru ("tombé métier") roll sitting at a sous-traitant's site
// (Sous-traitants › Gestion, « Rouleaux présents sur le site » — LIVA #1256).
// stock_ecru has no état of its own, so the column read « — » and the pieces
// looked idle while they were being dyed. The état is derived from the sst line
// the roll is affected to (`stock_ecru.IDref_commande_affectation`):
// - « En traitement »: an open line of an order placed with THIS sous-traitant
// - « En stock »: anything else (no line, line done, order at another sst) —
//   the piece is stored there. Deliberately neutral, not an alert: MATEL is
//   also an écru depot (~400 pieces with no dye order in 2026 alone).
// « traitement », not « teinture »: a dyer also does wash-only finishing.

export const ECRU_EN_TRAITEMENT = 'En traitement'
export const ECRU_EN_STOCK = 'En stock'

export interface SstLineInfo {
  IDcommande_sous_traitant: number
  sstatut: string | null
}

export function etatEcruChezSst(
  sousTraitantId: number,
  line: SstLineInfo | undefined,
  orderSousTraitantId: number | undefined,
): { etat_libelle: string; commande_sst: number | null } {
  if (line && !isLineDone(line.sstatut) && orderSousTraitantId === sousTraitantId) {
    return { etat_libelle: ECRU_EN_TRAITEMENT, commande_sst: line.IDcommande_sous_traitant }
  }
  return { etat_libelle: ECRU_EN_STOCK, commande_sst: null }
}
