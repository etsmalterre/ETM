// Agent « Factures Ennoblisseur » — what the person who checks an invoice on
// Sous-traitants › Factures decides on each line, and the score that decision
// gives the agent (decision Vincent 2026-10-02: Agents IA is never where an
// agent is scored; the people who do the work score it while doing it).
//
// A line is « conforme » or « écart » (controle.ts); an écart is « réel »
// (something wrong) or « non vérifié » (the agent could not check it).
//
//   agent's verdict        person's action            final    score
//   conforme               (validates the invoice)    conforme réussite
//   conforme               « Signaler un écart »      écart    échec      missed gap
//   écart réel             (keeps it, closing)        écart    réussite
//   écart réel             « C'est conforme »         conforme échec      false alarm
//   écart réel             Tricobot icon (« pas tout à fait »)  écart  échec  right gap, wrong cause/amount
//   écart non vérifié      (kept, closing)            écart    réussite   worth raising
//   écart non vérifié      pill « C'est conforme »    conforme none       the agent could not know
//   écart non vérifié      Tricobot icon              écart    échec      wrong reason
//
// Contradicting the agent always takes a comment (why). Every écart — real
// or not verified — gets the same two gestures on screen (decision Vincent
// 2026-10-05: « C'est conforme / Écart confirmé » was too confusing): the
// verdict pill to say it is no gap, the Tricobot icon to say its reason is
// wrong; closing the invoice (Réclamer / Valider malgré les écarts) confirms
// the rest. Pure; tests: avis.test.ts.

import type { Note } from '../store.js'
import type { Nature, Verdict } from './controle.js'

export type VerdictFinal = 'conforme' | 'ecart'
export type ActionLigne = 'conforme' | 'ecart' | 'corriger'

export interface DecisionLigne {
  verdictFinal: VerdictFinal
  /** null: no score (an écart the agent could not check, found conforme). */
  note: Note | null
  commentaireRequis: boolean
}

export class ActionInvalide extends Error {}

/** The final verdict and score a person's action on a line gives. */
export function decider(v: Verdict, nature: Nature | null, action: ActionLigne): DecisionLigne {
  if (v === 'info') throw new ActionInvalide('Cette ligne ne facture aucun lot : rien à décider.')
  if (v === 'conforme') {
    if (action === 'corriger') throw new ActionInvalide('Seul un écart peut être corrigé.')
    return action === 'conforme'
      ? { verdictFinal: 'conforme', note: 'reussite', commentaireRequis: false }
      : { verdictFinal: 'ecart', note: 'echec', commentaireRequis: true }
  }
  if (nature === 'non_verifie') {
    // The agent raised what it could not check: a real problem was worth
    // raising; found fine, it is no mistake of the agent's.
    if (action === 'conforme') return { verdictFinal: 'conforme', note: null, commentaireRequis: true }
    if (action === 'corriger') return { verdictFinal: 'ecart', note: 'echec', commentaireRequis: true }
    return { verdictFinal: 'ecart', note: 'reussite', commentaireRequis: false }
  }
  // Binary scale (2026-10-02): the gap is real but Tricobot's reason or amount was wrong — not right.
  if (action === 'corriger') return { verdictFinal: 'ecart', note: 'echec', commentaireRequis: true }
  return action === 'ecart'
    ? { verdictFinal: 'ecart', note: 'reussite', commentaireRequis: false }
    : { verdictFinal: 'conforme', note: 'echec', commentaireRequis: true }
}

/** The final verdict of a line nobody touched, when the invoice is closed:
 *  the agent's (an écart « non vérifié » included — closing confirms it). */
export function parDefaut(v: Verdict, _nature: Nature | null): DecisionLigne | 'sans_objet' {
  if (v === 'info') return 'sans_objet'
  if (v === 'conforme') return { verdictFinal: 'conforme', note: 'reussite', commentaireRequis: false }
  return { verdictFinal: 'ecart', note: 'reussite', commentaireRequis: false }
}
