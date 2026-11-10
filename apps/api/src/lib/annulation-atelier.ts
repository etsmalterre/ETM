// « Supprimer ma dernière action » on the atelier poste (Vincent 2026-11-10).
// The legacy had it (FEN_Action_Machine, IMG_Annuler: « Voulez-vous vraiment
// supprimer votre dernière action ? »), for a Défaut or a Nettoyage of the
// current piece, by its author — but after a deletion the new last action
// became deletable in turn. Here, per métier:
//   - the métier's LAST action (anyone's: a colleague acting on top closes it),
//   - by the person asking,
//   - a Défaut or a Nettoyage (a fin de pièce opens the next piece and sends
//     the closed one to visitage; terminer / lancer re-rank the OF queue —
//     the régleur or the ERP fixes those),
//   - on the piece on the machine (still open),
//   - and NOT at or under the ids the piece held at its last deletion: that is
//     what makes it « only the last », never a chain.
// Writes in routes/atelier.ts (`DELETE /of/:id/derniere-action`); trace table
// `atelier_annulation` (migration 0073).

export type SourceAction = 'evenement' | 'defaut'

export interface ActionCandidate {
  source: SourceAction
  ref_id: number
  evenement: string
  IDbonnetier: number
}

export interface DerniereAnnulation {
  max_evenement: number
  max_defaut: number
}

export function typeAnnulable(a: Pick<ActionCandidate, 'source' | 'evenement'>): boolean {
  return a.source === 'defaut' || (a.source === 'evenement' && a.evenement === 'Nettoyage')
}

/** Who may delete this last action (its author), or null. */
export function annulablePar(
  a: ActionCandidate | null,
  pieceOuverte: boolean,
  derniere: DerniereAnnulation | null,
): number | null {
  if (!a || !pieceOuverte || a.IDbonnetier <= 0 || !typeAnnulable(a)) return null
  if (derniere) {
    const plafond = a.source === 'defaut' ? derniere.max_defaut : derniere.max_evenement
    if (a.ref_id <= plafond) return null
  }
  return a.IDbonnetier
}
