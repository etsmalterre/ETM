// Agent « Superviseur » — its score is the score of its POINTS, not of its
// reports (decision 2026-09-23: a report is the morning's batch, the point is
// the unit of work). Two pure readings of the stored runs:
//   - bilanRun(): one report — how many points it raised, how many are scored
//     and how; drives the report's « à évaluer » state in the list and the KPI
//     strip of the dialog;
//   - scorePoints(): one prompt version — every distinct finding it ever
//     raised first, scored by its latest avis, a point closed without a
//     correction counting as réussite; « précision » = réussites over what was
//     scored (réussites + échecs). The figure that says whether
//     a prompt version is better than the last.
// A point scored on an earlier report (ConstatRun.avis, carried by avis.ts)
// counts as scored: Isabelle does not re-score an open point every morning.

import { type AgentRun, type Evaluation, type Note, noteBinaire } from '../store.js'
import type { ResultatSuperviseur } from './superviseur.js'
import type { ConstatRun } from './constats.js'

export interface BilanPoints {
  /** Points the report lists (écartés not included). */
  points: number
  evalues: number
  reussite: number
  echec: number
  aEvaluer: number
}

export interface ScorePoints extends BilanPoints {
  /** réussites / évalués, 0..1 — null while nothing is scored. */
  precision: number | null
}

type AvisLu = Pick<Evaluation, 'note' | 'le'>

const vide = (): BilanPoints => ({ points: 0, evalues: 0, reussite: 0, echec: 0, aEvaluer: 0 })

/** Shared with the other agents scored point by point (factures-sst/points.ts).
 *  A score stored under the old three-level scale (« partielle », carried on a
 *  report's points) reads as échec: évalués = réussites + échecs, always. */
export function compter(notes: Array<Note | string | null | undefined>): BilanPoints {
  const b = vide()
  b.points = notes.length
  for (const n of notes) {
    if (n == null) b.aEvaluer++
    else { b.evalues++; b[noteBinaire(n)]++ }
  }
  return b
}

/** The score of one point on one report: given there, or carried from an earlier one. */
function avisDuPoint(c: ConstatRun, avisPoints: Record<string, AvisLu> | undefined): AvisLu | null {
  return avisPoints?.[c.cle] ?? c.avis ?? null
}

/** How the points of one report stand. Null for a run that is not a report
 *  (an erreur run has no findings). */
export function bilanRun(run: AgentRun): BilanPoints | null {
  const sup = run.resultat as Partial<ResultatSuperviseur>
  if (!sup.constats) return null
  // A point marked résolu on this report is dealt with: it is counted only if
  // someone also scored it, never left « à évaluer ».
  const aCompter = sup.constats.filter((c) => !run.resolutionsPoints?.[c.cle] || avisDuPoint(c, run.avisPoints))
  return compter(aCompter.map((c) => avisDuPoint(c, run.avisPoints)?.note ?? null))
}

/** The scores a report's points would be filtered on: each note present, and
 *  `a_evaluer` while some point has none. */
export function notesDuBilan(b: BilanPoints | null): Set<string> {
  const s = new Set<string>()
  if (!b) return s
  if (b.reussite) s.add('reussite')
  if (b.echec) s.add('echec')
  if (b.aEvaluer) s.add('a_evaluer')
  return s
}

/** Every distinct finding the version raised, scored by its latest avis. A
 *  point set aside (écarté) was raised too: it counts, as the false alarm it is.
 *  Two rules (decision Vincent 2026-10-07, from v2's first two weeks):
 *  - silence = réussite: a point that closed (the agent saw it settled, or a
 *    person marked it résolu) with nobody saying « fausse alerte » before is a
 *    réussite. Isabelle scores only what she wants to correct, and a closed
 *    point leaves the widget: left « à évaluer », it never got a score;
 *  - a version is judged on the points it raised FIRST (`depuis` from its
 *    first run on): a point still open from the previous version, scored on
 *    that version's report, stays that version's. */
export function scorePoints(runs: AgentRun[]): ScorePoints {
  const ordre = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const debut = ordre[0]?.createdAt
  const aCetteVersion = (depuis: string | undefined) => !debut || !depuis || depuis >= debut
  const dernier = new Map<string, AvisLu | null>()
  const clos = new Set<string>()
  for (const r of ordre) {
    const sup = r.resultat as Partial<ResultatSuperviseur>
    const resolus = new Set((sup.resolus ?? []).map((c) => c.cle))
    for (const c of [...(sup.constats ?? []), ...(sup.ecartes ?? []), ...(sup.resolus ?? [])]) {
      if (!aCetteVersion(c.depuis)) continue
      const a = avisDuPoint(c, r.avisPoints)
      const d = dernier.get(c.cle)
      if (d === undefined || (a && (!d || a.le > d.le))) dernier.set(c.cle, a)
      // Found again: open, unless a person marked it résolu.
      if (resolus.has(c.cle) || r.resolutionsPoints?.[c.cle]) clos.add(c.cle)
      else clos.delete(c.cle)
    }
    // A manual preview never updates the memory: its « fermés » are not settled.
    if (sup.memoireMiseAJour === false) continue
    for (const f of sup.fermes ?? []) {
      if (!aCetteVersion(f.depuis)) continue
      if (!dernier.has(f.cle)) dernier.set(f.cle, null)
      clos.add(f.cle)
    }
  }
  const b = compter([...dernier].map(([cle, a]) => a?.note ?? (clos.has(cle) ? 'reussite' : null)))
  return { ...b, precision: b.evalues ? b.reussite / b.evalues : null }
}
