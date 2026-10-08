// Agent « Superviseur » — the points as Isabelle's work queue.
//
// Decision 2026-09-28: the reports are the agent's log (Agents IA, the admin
// side); what a person handles is the POINT, from the day it appears until it
// is dealt with. The queue lives in the tableau de bord Notifications widget
// (ETM-only subscription, lib/abonnements-etm.ts). LIVA #1272 (2026-10-08)
// split SETTLING a point from TEACHING Tricobot, which the first version tied
// together:
//   - « Traité » settles it → réussite, with an optional word on how it was
//     handled (a résolu carrying that word);
//   - « Former Tricobot » teaches, at any time, on an open or a closed point:
//       « Ce point n'aurait pas dû remonter » → échec, why required, and the
//         point leaves the queue (a false alarm, set aside while unchanged);
//       « Tu pouvais aller chercher plus loin » → a lesson: no score, the point stays;
//   - doing nothing is fine: the agent closes the point when its check stops
//     returning it, and a lesson can still be given afterwards.
// Scores and résolus are written where the report view writes them (the run's
// avisPoints / resolutionsPoints + the avis.ts indexes), so the precision
// figure, the Retours tab and the next reports read one set of data.
//
// The queue = the points of the latest SCHEDULED report (a « Lancer
// maintenant » is a preview) not handled since — on that report or after.

import { lireEtat, lireRuns, modifierRun, type AgentRun, type Auteur, type Evaluation, type Note } from '../store.js'
import { enregistrerAvis, enregistrerResolution, lireAvis, lireResolutions, type IndexAvis, type IndexResolutions } from './avis.js'
import type { ConstatRun } from './constats.js'
import { idPoint, journaliserLecon, journaliserTraitement, lireEntree, nombreLecons, type Issue, type Lecon, type Traitement } from './historique.js'
import { SUPERVISEUR_SLUG, SUPERVISEUR_VERSION_INITIALE, type ResultatSuperviseur } from './superviseur.js'

export interface PointATraiter extends ConstatRun {
  /** The report it is read from — where its handling is recorded. */
  runId: string
  /** Lessons already given to Tricobot on this occurrence. */
  lecons: number
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
  const [avis, resolutions, lecons] = await Promise.all([lireAvis(), lireResolutions(), nombreLecons()])
  return (constatsDe(run) ?? [])
    .filter((c) => !estTraite(c, run, avis, resolutions))
    .map((c) => ({ ...c, runId: run.id, lecons: lecons.get(idPoint(c.cle, c.depuis)) ?? 0 }))
}

export class TraitementInvalide extends Error {}

/** The score a handling gives the point. Throws when a why is missing. */
export function noteDuTraitement(issue: Issue, commentaire: string): Note {
  if (issue === 'traite') return 'reussite'
  if (!commentaire.trim()) {
    throw new TraitementInvalide('Dites pourquoi ce point n’aurait pas dû remonter : c’est ce qui sert à former Tricobot.')
  }
  return 'echec'
}

/** Handle one point of a report (or undo it, issue null). Returns the entry
 *  written, null for an undo. 404-worthy cases return undefined. `runId`
 *  null = the current report (an undo from the history). */
export async function traiterPoint(
  runId: string | null,
  cle: string,
  issue: Issue | null,
  commentaire: string,
  par: Auteur,
): Promise<Traitement | null | undefined> {
  const texte = issue ? commentaire.trim() : ''
  const note = issue ? noteDuTraitement(issue, texte) : null
  const runs = await lireRuns(SUPERVISEUR_SLUG)
  const run = runId ? runs.find((r) => r.id === runId) : rapportCourant(runs)
  const point = run && (constatsDe(run) ?? []).find((c) => c.cle === cle)
  if (!run || !point) return undefined

  const le = new Date().toISOString()
  // A « traité » word says how it was handled, not what Tricobot got wrong: it
  // goes on the résolu only, the score stays a silent réussite.
  const avis: Evaluation | null = note ? { note, commentaire: issue === 'traite' ? '' : texte, par, le } : null
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

// ── « Former Tricobot » ──────────────────────────────────

export type FormationType = 'pas_a_remonter' | 'a_savoir'

/** The report a point occurrence (`cle` + `depuis`) is recorded on: the
 *  current one while it is still detected there, else the latest report that
 *  carried that very occurrence. */
function rapportDuPoint(runs: AgentRun[], cle: string, depuis: string): { run: AgentRun; point: ConstatRun } | null {
  const courant = rapportCourant(runs)
  const dans = (r: AgentRun) => (constatsDe(r) ?? []).find((c) => c.cle === cle && c.depuis === depuis)
  const p = courant && dans(courant)
  if (courant && p) return { run: courant, point: p }
  let best: { run: AgentRun; point: ConstatRun } | null = null
  for (const r of runs) {
    if (r.statut === 'erreur') continue
    const x = dans(r)
    if (x && (!best || r.createdAt > best.run.createdAt)) best = { run: r, point: x }
  }
  return best
}

/** Teach Tricobot about one point occurrence, open or closed. Returns false
 *  when the point is unknown (404). */
export async function formerTricobot(
  cle: string,
  depuis: string,
  type: FormationType,
  commentaire: string,
  par: Auteur,
): Promise<boolean> {
  const texte = commentaire.trim()
  if (!texte) {
    throw new TraitementInvalide(type === 'pas_a_remonter'
      ? 'Dites pourquoi ce point n’aurait pas dû remonter : c’est ce qui sert à former Tricobot.'
      : 'Dites où il fallait regarder : c’est ce qui sert à former Tricobot.')
  }
  const trouve = rapportDuPoint(await lireRuns(SUPERVISEUR_SLUG), cle, depuis)
  if (!trouve) return false
  const { run, point } = trouve
  const le = new Date().toISOString()

  if (type === 'a_savoir') {
    const lecon: Lecon = { commentaire: texte, par, le }
    await modifierRun(SUPERVISEUR_SLUG, run.id, (x) => {
      const l = { ...(x.leconsPoints ?? {}) }
      l[cle] = [...(l[cle] ?? []), lecon]
      x.leconsPoints = l
    })
    await journaliserLecon(point, lecon)
    return true
  }

  // « N'aurait pas dû remonter » on a point still open = the false alarm the
  // queue knows (set aside while unchanged). On a closed one only the score
  // and the journal: the indexes would set aside a later, different problem.
  const entree = await lireEntree(idPoint(cle, depuis))
  if (!entree?.fermeLe) return (await traiterPoint(run.id, cle, 'fausse_alerte', texte, par)) !== undefined
  const avis: Evaluation = { note: 'echec', commentaire: texte, par, le }
  await modifierRun(SUPERVISEUR_SLUG, run.id, (x) => {
    x.avisPoints = { ...(x.avisPoints ?? {}), [cle]: avis }
    const r = { ...(x.resolutionsPoints ?? {}) }
    delete r[cle]
    x.resolutionsPoints = r
  })
  await journaliserTraitement(point, { issue: 'fausse_alerte', note: 'echec', commentaire: texte, par, le })
  return true
}
