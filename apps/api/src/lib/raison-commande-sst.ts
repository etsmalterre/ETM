// Sous-traitants › Ennoblissement / › Tricotage: what to do on a red / amber
// order card, in a few words (mps_designer §41: a coloured card always prints
// the Malterre action, like Clients › Commandes).
//
// ONE rule, here, since 2026-11-18: the list returns it as `raison` and the
// card prints it; the notification centre reads the same text for its red
// tasks (routes/commandes-sous-traitant.ts commandesSstRouges). It lived in the
// browser before (pages/SousTraitantsCommandes.tsx `raisonCarte`), where the
// API could not reach it.
//
// Read from the same facts as the colour: Tricobot waiting, the order's step
// and its chase date (lib/cycle-ennoblissement.ts, lib/sst-tricotage.ts).
// Pure, pinned by raison-commande-sst.test.ts.

export interface FaitsRaisonSst {
  /** The order's computed step (the list's `phase`). */
  phase: string
  /** Whose move it is (Ennoblissement only): 'client' while a coloris answer is waited. */
  main?: string | null
  /** The chase date, 'YYYY-MM-DD' or YYYYMMDD (Ennoblissement only). */
  relance?: string | null
  /** Earliest délai of the lines still to deliver, YYYYMMDD. */
  earliestDelivery?: string | null
  /** An urgency asked of the sous-traitant (lib/urgence-sst.ts). */
  urgenceDemandee?: 'attente' | 'a_relancer' | null
  /** A knitter's order (Tricotage), else a dyer's. */
  tricoteur: boolean
}

/** What Tricobot proposed or asked on the order (lib/agents/flux-ennoblisseur/saisies.ts compteursParCommande). */
export interface CompteurTricobotSst { aValider: number; aide: number }

/** Tricobot waits for a person on the order: a Malterre action now, red. */
export const tricobotAttend = (c: CompteurTricobotSst | undefined | null): c is CompteurTricobotSst =>
  !!c && c.aValider + c.aide > 0

const jjmm = (v: string | null | undefined): string => {
  if (!v) return ''
  const d = v.replace(/-/g, '')
  return /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}` : ''
}

/** The card's reason, null when the card is neutral. `urgence` is the card's colour
 *  ('late' red, 'soon' amber), Tricobot's wait already counted as 'late' by the caller. */
export function raisonCommandeSst(f: FaitsRaisonSst, urgence: 'late' | 'soon' | null, tricobot?: CompteurTricobotSst | null): string | null {
  if (tricobotAttend(tricobot)) {
    if (tricobot.aide > 0 && tricobot.aValider === 0) return 'Tricobot demande ton avis'
    // His points are delivery notes: a réception to validate.
    return 'Tricobot : réception à valider'
  }
  // An urgency asked of the sous-traitant whose answer did not come (lib/urgence-sst.ts).
  if (f.urgenceDemandee === 'a_relancer') return `Urgence demandée : relancer ${f.tricoteur ? 'le tricoteur' : 'l’ennoblisseur'}`
  if (!urgence) return null
  const tard = urgence === 'late'
  switch (f.phase) {
    case 'attente_delai':
      return tard ? 'Délai à relancer' : 'Délai à relancer demain'
    case 'non_envoye':
      return 'Bon de commande à envoyer'
    case 'a_cloturer':
      return 'Commande à clôturer'
    case 'fil_a_affecter':
      return 'Fil à affecter'
    case 'a_lancer':
      return tard ? 'À lancer' : 'À lancer bientôt'
    default: {
      // En traitement / en tricotage / solde en contrôle: the délai of the line.
      // The client holds the hand (a coloris soumission): it is the one to chase.
      if (f.main === 'client') return tard ? 'Réponse coloris : relancer le client' : 'Réponse coloris : dernier jour demain'
      const d = jjmm(f.relance) || jjmm(f.earliestDelivery)
      // No « : relancer » after it (Vincent 2026-11-16): a past délai says it by itself.
      if (tard) return d ? `Délai du ${d} dépassé` : 'Sans délai : le demander'
      return d ? `Délai le ${d} : s’assurer du départ` : null
    }
  }
}
