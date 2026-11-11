// The skills of « Flux Ennoblisseur » (ex-BL Ennoblisseur, slug kept) and how
// each one's measures are read (claude_doc/agents_autonomie.md §7).
//
//   bl         the delivery notes — measures re-read from the runs: « à
//              vérifier » = an aide, judged by the pilot's score on the run (was
//              asking right?); « écrit » = a saisie judged at the réception;
//   delais     the délais of a reply to the Point — PG saisie_agent;
//   controles  the dyer's measures in the same reply — PG saisie_agent.
// Délais and Contrôles have their own prompt versions (lecture.ts, doctrine
// §0 « le modèle lit, le code vérifie »); the BL's prompt is the agent's.

import type { ModeCompetence, PointMesure } from '../competences.js'
import { noteBinaire, promptsCompetence, type AgentRun, type AgentState, type PromptsCompetence, type VersionInitiale } from '../store.js'
import { saisiesDeCompetence, pointDe } from './saisies.js'
import { CONTROLES_VERSIONS_LIVREES, DELAIS_VERSIONS_LIVREES } from './lecture.js'

export interface CompetenceDef {
  cle: string
  nom: string
  description: string
  /** The modes a pilot may choose, in order. */
  modes: readonly ModeCompetence[]
  /** The mode before a pilot sets one. */
  defaut: ModeCompetence
  /** Its own prompt versions, as shipped (AgentState.promptsCompetences once
   *  stored). Absent = the skill runs on the agent's prompt (the BL). */
  versionsLivrees?: readonly VersionInitiale[]
  /** Every point of a version of the skill (null = every version), as the measures read them. */
  points(runs: readonly AgentRun[], slug: string, version: number | null): Promise<PointMesure[]>
}

/** The « skill » of a mail that went to none (Vincent 2026-11-11): no PDF to read, nothing
 *  for Délais nor Contrôles, or held until a person has reacted. It is the agent's, shown
 *  with its mails (mails.ts), never among the BL's runs. */
export const SANS_COMPETENCE = 'aucune'

/** A run belongs to the skill it names. A run naming none is the BL's (every BL run, and
 *  all of them before 2026-11-05), unless it read no file at all: then no skill had it. A
 *  PDF the BL looked at and set aside (« Pas un BL ») stays the BL's: that was its call. */
export const competenceDuRun = (r: Pick<AgentRun, 'competence' | 'statut' | 'fichiers'>) =>
  r.competence ?? (r.statut === 'ignore' && r.fichiers.length === 0 ? SANS_COMPETENCE : 'bl')

/** BL: one point per document read. Written = a saisie, judged by the réception
 *  (silence = validée, a correction = corrigée): its score is the Fiabilité.
 *  « à vérifier » (or checked since) = an aide: the score a pilot gives that run
 *  in Agents IA answers « was it right to ask? », the Discernement (Vincent
 *  2026-11-11: réussite = the block was justified, échec = it could decide alone).
 *  Not scored yet = still waiting for a person, whether or not the run was marked
 *  « vérifié » (handling the BL by hand is not judging the request). In
 *  observation (essai) the same points, judged by the rolls received
 *  (bl-observation.ts). Errors, ignored mails, PDF tests are no decision. */
export function pointsBl(runs: readonly AgentRun[]): PointMesure[] {
  const out: PointMesure[] = []
  for (const r of runs) {
    // Observation (essai, 2026-11-05): a BL read and not pre-filled, judged against the réception (bl-observation.ts).
    if (competenceDuRun(r) === 'bl' && r.mode === 'essai' && r.source !== 'essai_manuel' && (r.statut === 'simule' || r.statut === 'a_verifier')) {
      const aide = r.statut === 'a_verifier'
      out.push({
        decision: aide ? 'aide' : 'saisie',
        statut: r.observation?.statut ?? 'observation',
        douteJustifie: r.observation?.douteJustifie ?? null,
        le: r.createdAt,
        proposition: null,
        observation: true,
      })
      continue
    }
    if (competenceDuRun(r) !== 'bl' || r.mode !== 'actif' || r.source === 'essai_manuel') continue
    const aide = r.statut === 'a_verifier' || (r.statut === 'verifie' && r.verification?.statutAvant === 'a_verifier')
    const note = r.evaluation ? noteBinaire(r.evaluation.note) : null
    if (aide) {
      out.push({ decision: 'aide', statut: note ? 'resolue' : 'a_revoir', douteJustifie: note ? note === 'reussite' : null, le: r.createdAt, proposition: null })
      continue
    }
    if (r.statut !== 'ecrit') continue
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
    points: async (runs, _slug, v) => pointsBl(v === null ? runs : runs.filter((r) => r.version === v)),
  },
  {
    cle: 'delais',
    nom: 'Délais',
    description: 'Lit les délais que l’ennoblisseur donne en réponse au « Point du JJ/MM », quelle que soit sa façon d’écrire, et les saisit sur les lignes. En supervisé, chaque délai attend sa validation dans Sous-traitants › Ennoblissement.',
    modes: ['off', 'essai', 'supervise', 'autonomie'],
    // Shipped in essai: a pilot switches it to supervisé (doctrine §1).
    defaut: 'essai',
    versionsLivrees: DELAIS_VERSIONS_LIVREES,
    points: async (_runs, slug, v) => (await saisiesDeCompetence(slug, 'delais', v ?? undefined)).map(pointDe),
  },
  {
    cle: 'controles',
    nom: 'Contrôles',
    description: 'Lit les mesures de l’ennoblisseur (laize, poids, stabilités, vrillage) dans sa réponse au Point et les reporte sur le lot, côté ennoblisseur. En supervisé, chaque lot attend sa validation dans Qualité › Suivi lots.',
    modes: ['off', 'essai', 'supervise', 'autonomie'],
    // Shipped in essai: a pilot switches it to supervisé (doctrine §1).
    defaut: 'essai',
    versionsLivrees: CONTROLES_VERSIONS_LIVREES,
    points: async (_runs, slug, v) => (await saisiesDeCompetence(slug, 'controles', v ?? undefined)).map(pointDe),
  },
]

export const competenceFlux = (cle: string) => COMPETENCES_FLUX.find((c) => c.cle === cle)

/** A skill's prompt versions: its own, or the agent's for a skill without (the BL). */
export function versionsDeCompetence(c: Pick<CompetenceDef, 'cle' | 'versionsLivrees'>, s: AgentState): PromptsCompetence {
  return c.versionsLivrees ? promptsCompetence(s, c.cle, c.versionsLivrees) : { activeVersion: s.activeVersion, versions: s.versions }
}
