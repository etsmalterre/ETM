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

import { apportMesures, type ApportMesures, type Decision, type ModeCompetence, type PointMesure, type StatutPoint } from '../competences.js'
import { noteBinaire, promptsCompetence, type AgentRun, type AgentState, type PromptsCompetence, type VersionInitiale } from '../store.js'
import { saisiesDeCompetence, pointDe, type Saisie } from './saisies.js'
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

/** One point of a Délais / Contrôles run, as the runs list shows it (Agents IA ›
 *  Exécutions, Vincent 2026-11-11: a row is a point, the run is the group). */
export interface PointRun {
  /** Its saisie_agent row. */
  id: number
  /** « Lot MA109579 », « Commande 9132 », or « Mail » for a « rien » on the whole reply. */
  quoi: string
  /** Délais: the article of the order line. */
  detail?: string
  decision: Decision
  statut: StatutPoint
  /** What this point alone brings to the three measures: one token. */
  apport: ApportMesures
}

/** The points of one Délais / Contrôles run, in the order they were recorded.
 *  They are read from saisie_agent, never from what the model read: a value a
 *  person typed that the reading missed (an omission) is a point of the run
 *  too, and the reading knows nothing of it. A point is named by the reading
 *  when it has it (the order and lot numbers as printed), else by its lot
 *  (`lots`: idsuivilot → lot number) or its order. Pure. */
export function pointsDuRun(r: Pick<AgentRun, 'resultat'>, saisies: readonly Saisie[], lots: ReadonlyMap<number, string>): PointRun[] {
  const res = r.resultat as {
    delais?: Array<{ commande: string; article: string; saisieId?: number }>
    controles?: Array<{ lot: string; lotEtm: string | null; saisieId?: number }>
  }
  const lus = new Map<number, { quoi: string; detail?: string }>()
  for (const p of res.delais ?? []) if (p.saisieId) lus.set(p.saisieId, { quoi: `Commande ${p.commande}`, ...(p.article ? { detail: p.article } : {}) })
  for (const c of res.controles ?? []) if (c.saisieId) lus.set(c.saisieId, { quoi: `Lot ${c.lotEtm ?? c.lot}` })
  return saisies.map((s) => ({
    id: s.id,
    ...(lus.get(s.id) ?? {
      quoi: s.idsuivilot > 0 ? `Lot ${lots.get(s.idsuivilot) ?? '?'}` : s.idcommande > 0 ? `Commande ${s.idcommande}` : 'Mail',
    }),
    decision: s.decision,
    statut: s.statut,
    apport: apportMesures([pointDe(s)]),
  }))
}

export const COMPETENCES_FLUX: readonly CompetenceDef[] = [
  {
    cle: 'bl',
    nom: 'BL',
    description: 'Lit les bordereaux de livraison et propose la réception des rouleaux. En supervisé, chaque BL attend sa validation dans Sous-traitants › Ennoblissement : valider, c’est réceptionner.',
    // Supervisé for now: autonomy (Tricobot receiving a BL alone) comes step by step (Vincent, 2026-11-11).
    modes: ['off', 'essai', 'supervise'],
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
