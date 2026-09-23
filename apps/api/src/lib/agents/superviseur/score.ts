// Agent « Superviseur » — its score is the score of its POINTS, not of its
// reports (decision 2026-09-23: a report is the morning's batch, the point is
// the unit of work). Two pure readings of the stored runs:
//   - bilanRun(): one report — how many points it raised, how many are scored
//     and how; drives the report's « à évaluer » state in the list and the KPI
//     strip of the dialog;
//   - scorePoints(): one prompt version — every distinct finding it ever
//     raised, scored by its latest avis; « précision » = what was worth raising
//     (réussite + partielle) over what was scored. The figure that says whether
//     a prompt version is better than the last.
// A point scored on an earlier report (ConstatRun.avis, carried by avis.ts)
// counts as scored: Isabelle does not re-score an open point every morning.

import type { AgentRun, Evaluation, Note } from '../store.js'
import type { ResultatSuperviseur } from './superviseur.js'
import type { ConstatRun } from './constats.js'

export interface BilanPoints {
  /** Points the report lists (écartés not included). */
  points: number
  evalues: number
  reussite: number
  partielle: number
  echec: number
  aEvaluer: number
}

export interface ScorePoints extends BilanPoints {
  /** (réussite + partielle) / évalués, 0..1 — null while nothing is scored. */
  precision: number | null
}

type AvisLu = Pick<Evaluation, 'note' | 'le'>

const vide = (): BilanPoints => ({ points: 0, evalues: 0, reussite: 0, partielle: 0, echec: 0, aEvaluer: 0 })

function compter(notes: Array<Note | null>): BilanPoints {
  const b = vide()
  b.points = notes.length
  for (const n of notes) {
    if (n === null) b.aEvaluer++
    else { b.evalues++; b[n]++ }
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
  return compter(sup.constats.map((c) => avisDuPoint(c, run.avisPoints)?.note ?? null))
}

/** The scores a report's points would be filtered on: each note present, and
 *  `a_evaluer` while some point has none. */
export function notesDuBilan(b: BilanPoints | null): Set<string> {
  const s = new Set<string>()
  if (!b) return s
  if (b.reussite) s.add('reussite')
  if (b.partielle) s.add('partielle')
  if (b.echec) s.add('echec')
  if (b.aEvaluer) s.add('a_evaluer')
  return s
}

/** Every distinct finding the runs raised, scored by its latest avis. A point
 *  set aside (écarté) was raised too: it counts, as the false alarm it is. */
export function scorePoints(runs: AgentRun[]): ScorePoints {
  const dernier = new Map<string, AvisLu | null>()
  for (const r of runs) {
    const sup = r.resultat as Partial<ResultatSuperviseur>
    for (const c of [...(sup.constats ?? []), ...(sup.ecartes ?? [])]) {
      const a = avisDuPoint(c, r.avisPoints)
      const d = dernier.get(c.cle)
      if (d === undefined || (a && (!d || a.le > d.le))) dernier.set(c.cle, a)
    }
  }
  const b = compter([...dernier.values()].map((a) => a?.note ?? null))
  return { ...b, precision: b.evalues ? (b.reussite + b.partielle) / b.evalues : null }
}
