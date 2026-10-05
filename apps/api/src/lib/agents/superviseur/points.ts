// Agent « Superviseur » — the points as Isabelle's work queue.
//
// Decision 2026-09-28: the reports are the agent's log (Agents IA, the admin
// side); what a person handles is the POINT, from the day it appears until it
// is dealt with. The queue lives in the tableau de bord Notifications widget
// (ETM-only subscription, lib/abonnements-etm.ts) and each point ends one of
// two ways:
//   - « Traité »        → réussite, no comment. Ticking « Le point pouvait
//                         être mieux » makes it a partielle and requires a
//                         comment (only what can be improved is written);
//   - « Fausse alerte » → échec, comment required.
// Both are written where the report view writes its scores and résolus (the
// run's avisPoints / resolutionsPoints + the avis.ts indexes), so the precision
// figure, the Retours tab and the next reports read one set of data whichever
// screen it came from. A « traité » is a résolu with an empty explanation.
//
// The queue = the points of the latest SCHEDULED report (a « Lancer
// maintenant » is a preview) not handled since — on that report or after.

import { lireEtat, lireRuns, modifierRun, type AgentRun, type Auteur, type Evaluation, type Note } from '../store.js'
import { enregistrerAvis, enregistrerResolution, lireAvis, lireResolutions, type IndexAvis, type IndexResolutions } from './avis.js'
import type { ConstatRun } from './constats.js'
import { journaliserTraitement, type Issue, type Traitement } from './historique.js'
import { SUPERVISEUR_SLUG, SUPERVISEUR_VERSION_INITIALE, type ResultatSuperviseur } from './superviseur.js'

export interface PointATraiter extends ConstatRun {
  /** The report it is read from — where its handling is recorded. */
  runId: string
}

const constatsDe = (r: AgentRun) => (r.resultat as Partial<ResultatSuperviseur>).constats

/** The report the queue is read from: the latest scheduled one, or — before
 *  any scheduled run exists (dev, seed script) — the latest report at all. */
export function rapportCourant(runs: AgentRun[]): AgentRun | null {
  const rapports = runs.filter((r) => r.statut !== 'erreur' && constatsDe(r))
  const planifies = rapports.filter((r) => r.source === 'planifie')
  const pool = planifies.length ? planifies : rapports
  return pool.reduce<AgentRun | null>((m, r) => (!m || r.createdAt > m.createdAt ? r : m), null)
}

const valable = (s: { empreinte?: string } | undefined, c: ConstatRun) =>
  !!s && (s.empreinte === undefined || c.empreinte === undefined || s.empreinte === c.empreinte)

/** Handled = marked traité / résolu, or set aside as a false alarm. Pure. */
export function estTraite(c: ConstatRun, run: AgentRun, avis: IndexAvis, resolutions: IndexResolutions): boolean {
  if (run.resolutionsPoints?.[c.cle] || run.avisPoints?.[c.cle]?.note === 'echec') return true
  if (valable(resolutions[c.cle], c)) return true
  return valable(avis[c.cle], c) && avis[c.cle].note === 'echec'
}

/** The points still to handle, new first (the report's own order). */
export async function pointsATraiter(): Promise<PointATraiter[]> {
  const etat = await lireEtat(SUPERVISEUR_SLUG, SUPERVISEUR_VERSION_INITIALE)
  if (etat.mode === 'off') return []
  const run = rapportCourant(await lireRuns(SUPERVISEUR_SLUG))
  if (!run) return []
  const [avis, resolutions] = await Promise.all([lireAvis(), lireResolutions()])
  return (constatsDe(run) ?? [])
    .filter((c) => !estTraite(c, run, avis, resolutions))
    .map((c) => ({ ...c, runId: run.id }))
}

export class TraitementInvalide extends Error {}

/** The score a handling gives the point. Throws when a comment is missing. */
export function noteDuTraitement(issue: Issue, aAmeliorer: boolean, commentaire: string): Note {
  // Binary since 2026-10-02: a point that « pouvait être mieux » was not right.
  const note: Note = issue === 'fausse_alerte' || aAmeliorer ? 'echec' : 'reussite'
  if (note !== 'reussite' && !commentaire.trim()) {
    throw new TraitementInvalide(issue === 'fausse_alerte'
      ? 'Dites pourquoi c’est une fausse alerte : c’est ce qui sert à améliorer l’agent.'
      : 'Dites ce qui pouvait être mieux : c’est ce qui sert à améliorer l’agent.')
  }
  return note
}

/** Handle one point of a report (or undo it, issue null). Returns the entry
 *  written, null for an undo. 404-worthy cases return undefined. `runId`
 *  null = the current report (an undo from the history). */
export async function traiterPoint(
  runId: string | null,
  cle: string,
  issue: Issue | null,
  aAmeliorer: boolean,
  commentaire: string,
  par: Auteur,
): Promise<Traitement | null | undefined> {
  const texte = issue === 'traite' && !aAmeliorer ? '' : commentaire.trim()
  const note = issue ? noteDuTraitement(issue, aAmeliorer, texte) : null
  const runs = await lireRuns(SUPERVISEUR_SLUG)
  const run = runId ? runs.find((r) => r.id === runId) : rapportCourant(runs)
  const point = run && (constatsDe(run) ?? []).find((c) => c.cle === cle)
  if (!run || !point) return undefined

  const le = new Date().toISOString()
  const avis: Evaluation | null = note ? { note, commentaire: texte, par, le } : null
  const resolution = issue === 'traite' ? { commentaire: texte, par, le } : null
  await modifierRun(SUPERVISEUR_SLUG, run.id, (x) => {
    const a = { ...(x.avisPoints ?? {}) }
    const r = { ...(x.resolutionsPoints ?? {}) }
    if (avis) a[cle] = avis; else delete a[cle]
    if (resolution) r[cle] = resolution; else delete r[cle]
    x.avisPoints = a
    x.resolutionsPoints = r
  })
  const suivi = { runId: run.id, titre: point.titre, empreinte: point.empreinte }
  // Undoing on this report must not wipe what a newer report recorded.
  const [ia, ir] = await Promise.all([lireAvis(), lireResolutions()])
  if (avis) await enregistrerAvis(cle, { ...avis, ...suivi })
  else if (!ia[cle] || ia[cle].runId === run.id) await enregistrerAvis(cle, null)
  if (resolution) await enregistrerResolution(cle, { ...resolution, ...suivi })
  else if (!ir[cle] || ir[cle].runId === run.id) await enregistrerResolution(cle, null)

  const traitement: Traitement | null = issue && note ? { issue, note, commentaire: texte, par, le } : null
  await journaliserTraitement(point, traitement)
  return traitement
}
