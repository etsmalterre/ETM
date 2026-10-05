// « Tricobot » feedback — the one way an agent learns how it did (decision
// Vincent 2026-10-02). Users only ever see Tricobot; each item an agent
// produced carries its feedback back to that agent's run:
//   - silence when a person handled the item = réussite (recorded at the
//     moment of the human action that proves review: an invoice validated,
//     rolls received, a point marked « Traité »);
//   - a correction (an edit of what Tricobot wrote, or the Tricobot icon) =
//     échec, with why — what the next prompt version is written from.
// Never given in Agents IA (the admin side only shows it).
//
// Storage stays on the run (`evaluation` for an agent scored per run, BL;
// `avisPoints[cle]` for one scored per item) until the agent stores move to
// PostgreSQL. Factures writes its line scores through its own table
// (factures-sst/suivi.ts) and the Superviseur through its widget route —
// both land in the same fields.

import { modifierRun, type Auteur, type Evaluation } from './store.js'

export interface Retour {
  slug: string
  runId: string
  /** The item within the run, or null for an agent scored per run. */
  cle: string | null
  /** true = silence (nobody had anything to correct). */
  juste: boolean
  /** Required when not juste: why. */
  commentaire: string
  par: Auteur
  /** An échec already recorded stays: a later silent pass over the same item
   *  (a second partial réception of the same BL) must not erase a correction. */
  garderEchec?: boolean
}

/** Record one feedback on a run. Returns false when the run no longer exists. */
export async function enregistrerRetour(r: Retour): Promise<boolean> {
  if (!r.juste && !r.commentaire.trim()) throw new Error('Une correction de Tricobot se donne avec un pourquoi.')
  const e: Evaluation = r.juste
    ? { note: 'reussite', commentaire: '', par: r.par, le: new Date().toISOString() }
    : { note: 'echec', commentaire: r.commentaire.trim(), par: r.par, le: new Date().toISOString() }
  const run = await modifierRun(r.slug, r.runId, (x) => {
    const avant = r.cle ? x.avisPoints?.[r.cle] : x.evaluation
    if (r.garderEchec && r.juste && avant?.note === 'echec') return
    if (r.cle) x.avisPoints = { ...(x.avisPoints ?? {}), [r.cle]: e }
    else x.evaluation = e
  })
  return run !== null
}
