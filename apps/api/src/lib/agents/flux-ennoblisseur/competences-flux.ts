// The skills of « Flux Ennoblisseur » (ex-BL Ennoblisseur, slug kept) and how
// each one's measures are read (claude_doc/agents_autonomie.md §7).
//
//   bl         the delivery notes — measures re-read from the runs: « à
//              vérifier » = an aide, « écrit » = a saisie judged at the réception;
//   delais     the délais of a reply to the Point — PG saisie_agent;
//   controles  §2 of the same reply — essai only for now (no measures yet).

import type { ModeCompetence, PointMesure } from '../competences.js'
import { noteBinaire, type AgentRun } from '../store.js'
import { saisiesDeCompetence, pointDe } from './saisies.js'
import { CONTROLES_VERSION, DELAIS_VERSION } from './delais.js'

export interface CompetenceDef {
  cle: string
  nom: string
  description: string
  /** The modes a pilot may choose, in order. */
  modes: readonly ModeCompetence[]
  /** The mode before a pilot sets one. */
  defaut: ModeCompetence
  /** The behaviour version its measures cover. Null = the agent's active prompt version. */
  version: number | null
  /** Every point of the version, as the measures read them. */
  points(runs: readonly AgentRun[], slug: string, versionAgent: number): Promise<PointMesure[]>
}

/** A run belongs to the skill it names; a run naming none is the BL's (before 2026-11-05). */
export const competenceDuRun = (r: Pick<AgentRun, 'competence'>) => r.competence ?? 'bl'

/** BL: one point per document read. « à vérifier » (or checked since) = an
 *  aide; written = a saisie, judged by the réception (silence = validée, a
 *  correction = corrigée). Errors, ignored mails, essai runs are no decision. */
export function pointsBl(runs: readonly AgentRun[]): PointMesure[] {
  const out: PointMesure[] = []
  for (const r of runs) {
    if (competenceDuRun(r) !== 'bl' || r.mode !== 'actif' || r.source === 'essai_manuel') continue
    const aide = r.statut === 'a_verifier' || (r.statut === 'verifie' && r.verification?.statutAvant === 'a_verifier')
    if (aide) { out.push({ decision: 'aide', statut: r.statut === 'verifie' ? 'resolue' : 'a_revoir', le: r.createdAt, proposition: null }); continue }
    if (r.statut !== 'ecrit') continue
    const note = r.evaluation ? noteBinaire(r.evaluation.note) : null
    out.push({ decision: 'saisie', statut: note === 'reussite' ? 'validee' : note === 'echec' ? 'corrigee' : 'a_revoir', le: r.createdAt })
  }
  return out
}

export const COMPETENCES_FLUX: readonly CompetenceDef[] = [
  {
    cle: 'bl',
    nom: 'BL',
    description: 'Lit les bordereaux de livraison et pré-remplit la réception. La réception, faite par une personne, valide le pré-remplissage : pas d’autonomie au-delà.',
    modes: ['off', 'essai', 'supervise'],
    defaut: 'supervise',
    version: null,
    points: async (runs, _slug, v) => pointsBl(runs.filter((r) => r.version === v)),
  },
  {
    cle: 'delais',
    nom: 'Délais',
    description: 'Lit les délais que l’ennoblisseur donne en réponse au « Point du JJ/MM » (section 5) et les saisit sur les lignes. En supervisé, chaque délai attend sa validation dans Sous-traitants › Ennoblissement.',
    modes: ['off', 'essai', 'supervise', 'autonomie'],
    // Shipped in essai: a pilot switches it to supervisé (doctrine §1).
    defaut: 'essai',
    version: DELAIS_VERSION,
    points: async (_runs, slug) => (await saisiesDeCompetence(slug, 'delais', DELAIS_VERSION)).map(pointDe),
  },
  {
    cle: 'controles',
    nom: 'Contrôles',
    description: 'Lit les mesures de l’ennoblisseur (laize, poids, stabilités, vrillage) en section 2 de la réponse au Point et les reporte sur le lot, côté ennoblisseur. En supervisé, chaque lot attend sa validation dans Qualité › Suivi lots.',
    modes: ['off', 'essai', 'supervise', 'autonomie'],
    // Shipped in essai: a pilot switches it to supervisé (doctrine §1).
    defaut: 'essai',
    version: CONTROLES_VERSION,
    points: async (_runs, slug) => (await saisiesDeCompetence(slug, 'controles', CONTROLES_VERSION)).map(pointDe),
  },
]

export const competenceFlux = (cle: string) => COMPETENCES_FLUX.find((c) => c.cle === cle)
