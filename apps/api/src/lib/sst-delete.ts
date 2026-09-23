// Pure rules for deleting a sous-traitant order that carries a TRM mirror
// (`commande_client.IDcommande_ETM = <sst id>`, Tricotage Malterre only).
//
// The mirror header is written the moment the sst order is created — before
// any line exists — so "a mirror exists" says nothing about TRM having
// started work. What does: an OF on a mirror line, a roll knitted or
// reserved against one, or the mirror already soldée on the TRM side. Only
// those block the delete; an untouched mirror is deleted with the order.
// LIVA #1184 — an empty order to Tricotage Malterre could not be deleted.

export interface TrmMirrorActivity {
  /** `commande_client.est_soldee` of the mirror header. */
  est_soldee: number
  /** `ordre_fabrication` rows on any mirror line. */
  ofCount: number
  /** `stock_ecru` rows with `IDLigne_Commande_TRM` on any mirror line. */
  rollCount: number
}

export interface DeleteBlocker {
  error: 'trm_production_started' | 'trm_soldee'
  message: string
}

/** Why the delete must be refused, or null when the mirror is untouched. */
export function sstDeleteBlocker(mirror: TrmMirrorActivity | null): DeleteBlocker | null {
  if (mirror === null) return null
  if (mirror.est_soldee === 1) {
    return {
      error: 'trm_soldee',
      message: 'Cette commande ne peut pas être supprimée : Tricotage Malterre l\'a déjà soldée.',
    }
  }
  if (mirror.ofCount > 0) {
    return {
      error: 'trm_production_started',
      message: 'Cette commande ne peut pas être supprimée : Tricotage Malterre a déjà lancé un OF dessus.',
    }
  }
  if (mirror.rollCount > 0) {
    return {
      error: 'trm_production_started',
      message: 'Cette commande ne peut pas être supprimée : Tricotage Malterre a déjà tricoté des pièces dessus.',
    }
  }
  return null
}
