// The skills of « Flux Ennoblisseur » (ex-BL Ennoblisseur, slug kept) and how
// each one's measures are read (claude_doc/agents_autonomie.md §7).
//
//   bl   the delivery notes — measures re-read from the runs: « à vérifier » =
//        an aide, judged by the pilot's score on the run (was asking right?);
//        « écrit » = a saisie judged at the réception. Its prompt is the agent's.
//
// « Délais » and « Contrôles » (a dyer's reply to our Point, read in observation
// only) were removed on 2026-11-27: the dyers type their délais and their
// measures themselves in the espace partenaire. Their stored runs and points
// (`competence` 'delais' / 'controles') are ignored everywhere, never an error
// (`runsDesCompetences`).

import type { ModeCompetence, PointMesure } from '../competences.js'
import { noteBinaire, type AgentRun } from '../store.js'
import { saisiesDeCompetence, pointDe } from './saisies.js'

export interface CompetenceDef {
  cle: string
  nom: string
  description: string
  /** The modes a pilot may choose, in order. */
  modes: readonly ModeCompetence[]
  /** The mode before a pilot sets one. */
  defaut: ModeCompetence
  /** Every point of a version of the skill (null = every version), as the measures read them. */
  points(runs: readonly AgentRun[], slug: string, version: number | null): Promise<PointMesure[]>
}

/** The « skill » of a mail that went to none (Vincent 2026-11-11): no PDF to read. It is
 *  the agent's, shown with its mails (mails.ts), never among the BL's runs. */
export const SANS_COMPETENCE = 'aucune'

/** A run belongs to the skill it names. A run naming none is the BL's (every BL run, and
 *  all of them before 2026-11-05), unless it read no file at all: then no skill had it. A
 *  PDF the BL looked at and set aside (« Pas un BL ») stays the BL's: that was its call. */
export const competenceDuRun = (r: Pick<AgentRun, 'competence' | 'statut' | 'fichiers'>) =>
  r.competence ?? (r.statut === 'ignore' && r.fichiers.length === 0 ? SANS_COMPETENCE : 'bl')

/** The runs of an agent with skills, without those of a skill it no longer has (`cles`: its
 *  skills today). A stored run of a removed skill is ignored, never an error. */
export const runsDesCompetences = <R extends Pick<AgentRun, 'competence' | 'statut' | 'fichiers'>>(runs: readonly R[], cles: readonly string[]): R[] =>
  runs.filter((r) => { const c = competenceDuRun(r); return c === SANS_COMPETENCE || cles.includes(c) })

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

/** What a BL run is about, in a word, for the « Référence » column of the runs
 *  list (Vincent 2026-11-11): its lot once resolved, else the bordereau as
 *  printed, else nothing (an error, a PDF that was no BL). Pure. */
export function referenceBl(r: Pick<AgentRun, 'resultat'>): string | null {
  const res = r.resultat as { resolution?: { lot?: string } | null; extraction?: { numero_bordereau?: string } | null }
  const lot = res.resolution?.lot?.trim()
  if (lot) return `Lot ${lot}`
  const bl = res.extraction?.numero_bordereau?.trim()
  return bl ? `BL ${bl}` : null
}

export const COMPETENCES_FLUX: readonly CompetenceDef[] = [
  {
    cle: 'bl',
    nom: 'BL',
    description: 'Lit les bordereaux de livraison et propose la réception des rouleaux. En supervisé, chaque BL attend sa validation dans Sous-traitants › Ennoblissement : valider, c’est réceptionner. En autonome, un BL tiré au sort et sans aucun contrôle levé est réceptionné seul.',
    // Autonomy since v5 (2026-11-27), step by step (Vincent, 2026-11-11): a BL
    // drawn « alone » is received by Tricobot only when it raised not a single
    // check (reception-bl.ts `seulPossible`).
    modes: ['off', 'essai', 'supervise', 'autonomie'],
    defaut: 'supervise',
    // Since 2026-11-11 a BL leaves a point in saisie_agent (reception-bl.ts);
    // the runs before it are still read from the history.
    points: async (runs, slug, v) => {
      const saisies = await saisiesDeCompetence(slug, 'bl', v ?? undefined)
      const avecPoint = new Set(saisies.map((s) => s.runId))
      const anciens = runs.filter((r) => !avecPoint.has(r.id) && (v === null || r.version === v))
      return [...pointsBl(anciens), ...saisies.map(pointDe)]
    },
  },
]
