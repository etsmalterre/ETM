// Agent « Factures Ennoblisseur » — what is scored is each LINE of the invoice
// (decision Vincent 2026-10-02: « we don't score whole reports, we are more
// granular »), like the Superviseur scores each point of its report. A line's
// score says whether the agent's verdict on it was the right one; it is given
// on Sous-traitants › Factures by the person who checks the invoice (avis.ts)
// and copied onto the run, never given in Agents IA.
//
//   - « à évaluer »: every real écart the agent raised;
//   - a conforme line counts once scored (confirmed when the invoice is
//     validated, or a missed gap); an écart « non vérifié » counts once a
//     person confirmed it (found fine, it is no score: the agent could not know).
//
// A point's key is the invoice number + the line's position + its lot, so the
// same invoice re-read (retraitement, essai then actif) keeps its scores
// together in the version score. Pure; tests: points.test.ts.

import type { AgentRun, Evaluation } from '../store.js'
import { compter, type BilanPoints, type ScorePoints } from '../superviseur/score.js'
import type { ResultatFacture } from './agent.js'

export interface PointFacture {
  cle: string
  titre: string
  /** Raised by the agent: « à évaluer » until someone scores it. */
  souleve: boolean
}


export const clePoint = (numero: string, index: number, lot: string) => `${numero || '?'}|${index}|${lot}`

/** The scorable points of one run — none for a run that read no invoice. */
export function pointsFacture(run: AgentRun): PointFacture[] {
  const res = run.resultat as Partial<ResultatFacture>
  const v = res.verification
  if (!v) return []
  const numero = res.extraction?.numero_facture ?? ''
  const out: PointFacture[] = []
  v.lignes.forEach((l, i) => {
    if (l.ligne.genre !== 'lot' || l.verdict === 'info') return
    out.push({
      cle: clePoint(numero, i, l.lotEtm),
      titre: `${numero} — ${l.lotEtm || l.ligne.description || `ligne ${i + 1}`}`,
      souleve: l.verdict === 'ecart' && l.nature === 'reel',
    })
  })
  return out
}

type AvisLu = Pick<Evaluation, 'note' | 'le'>

/** The points that count on a run: raised ones, plus any scored. */
const comptes = (run: AgentRun) => pointsFacture(run).filter((p) => p.souleve || run.avisPoints?.[p.cle])

export function bilanFacture(run: AgentRun): BilanPoints | null {
  const res = run.resultat as Partial<ResultatFacture>
  if (!res.verification) return null
  return compter(comptes(run).map((p) => run.avisPoints?.[p.cle]?.note ?? null))
}

/** One version's score: every distinct point, by its latest score. */
export function scoreFactures(runs: AgentRun[]): ScorePoints {
  const dernier = new Map<string, AvisLu | null>()
  for (const r of runs) {
    for (const p of comptes(r)) {
      const a = r.avisPoints?.[p.cle] ?? null
      const d = dernier.get(p.cle)
      if (d === undefined || (a && (!d || a.le > d.le))) dernier.set(p.cle, a)
    }
  }
  const b = compter([...dernier.values()].map((a) => a?.note ?? null))
  return { ...b, precision: b.evalues ? b.reussite / b.evalues : null }
}
