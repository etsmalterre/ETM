// « Agents IA » — the catalog. An agent is code (what it reads, how it
// decides, what it writes) plus a stored state (mode, prompt versions — see
// store.ts). Adding an agent = one entry here + its pipeline module.

import { isChatModel } from '../mistral.js'
import {
  BL_ENNOBLISSEUR_BOITE,
  BL_ENNOBLISSEUR_EXPEDITEURS,
  BL_ENNOBLISSEUR_SLUG,
  BL_ENNOBLISSEUR_VERSION_INITIALE,
  retirerEcritures as retirerBlEnnoblisseur,
  sonderBoite as sonderBlEnnoblisseur,
  traiterPdfs as traiterBlEnnoblisseur,
} from './bl-ennoblisseur.js'
import {
  SUPERVISEUR_BOITES,
  SUPERVISEUR_HEURE,
  SUPERVISEUR_JOURS,
  SUPERVISEUR_SLUG,
  SUPERVISEUR_VERSION_INITIALE,
  executer as executerSuperviseur,
} from './superviseur/superviseur.js'
import { CONTROLES } from './superviseur/controles/index.js'
import type { AgentMode, AgentRun, AgentState, AgentVersion, Auteur, VersionInitiale } from './store.js'
import type { Contexte } from './bl-ennoblisseur.js'

/** What starts an agent: a mailbox poll every N ms, or once a day at an hour (Paris). */
export type Declenchement =
  | { type: 'releve'; intervalleMs: number }
  | { type: 'quotidien'; heure: number; /** ISO weekdays, 1 = Monday. */ jours: readonly number[] }

export interface AgentDef {
  slug: string
  nom: string
  description: string
  declenchement: Declenchement
  /** What triggers it, shown in the « Fonctionnement » tab. */
  declencheur: string
  /** What it writes, shown in the « Fonctionnement » tab. */
  ecritures: string[]
  /** When it holds back, shown in the « Fonctionnement » tab. */
  abstention: string
  /** What each score means for this agent, shown beside the three buttons —
   *  of the run dialog, or of each point when `pointsEvaluables`. Every score
   *  is the same (store.ts `Note`): réussite needs no comment, partielle and
   *  échec need one. */
  evaluation: {
    reussite: string
    partielle: string
    echec: string
    /** An échec removes what the run wrote (partielle keeps it for the user
     *  to correct). Returns the French line stored on the evaluation, or null
     *  when there was nothing to remove. Absent = an échec removes nothing. */
    retirer?(run: AgentRun): Promise<string | null>
  }
  /** Superviseur: what is scored is each point of the report, never the run
   *  (avis.ts, score.ts) — PUT /runs/:id/evaluation answers 409. */
  pointsEvaluables: boolean
  /** One line per mode the agent offers, for the status footer menu. An agent
   *  whose « essai » would change nothing (Superviseur: it writes nothing)
   *  leaves it out. */
  modes: Partial<Record<AgentMode, string>>
  versionInitiale: VersionInitiale
  /** Chat models a version may use. */
  modeles: readonly string[]
  /** One run now (scheduler tick, or « Relever / Lancer maintenant » when `par` is set). */
  sonder(state: AgentState, version: AgentVersion, par: Auteur | null): Promise<AgentRun[]>
  /** Run PDFs through the pipeline outside the mailbox (manual test, retraitement) — agents that read PDFs only. */
  traiter?(pdfs: Array<{ nom: string; contenu: Buffer }>, ctx: Contexte): Promise<AgentRun[]>
  /** The checks it runs, listed in the « Fonctionnement » tab (Superviseur). */
  controles?: ReadonlyArray<{ id: string; libelle: string; description: string }>
}

const MODELES_MISTRAL = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'ministral-8b-latest'].filter(isChatModel)

export const AGENTS: readonly AgentDef[] = [
  {
    slug: BL_ENNOBLISSEUR_SLUG,
    nom: 'BL Ennoblisseur',
    description:
      'Lit les bordereaux de livraison envoyés par le teinturier MATEL et prépare la réception : chaque pièce (poids, métrage, observations) est enregistrée pour pré-remplir le dialogue de réception de Sous-traitants › Commandes, et le PDF est classé dans les documents de la commande.',
    declenchement: { type: 'releve', intervalleMs: 2 * 60_000 },
    declencheur: `Relève toutes les 2 minutes la boîte ${BL_ENNOBLISSEUR_BOITE}, mails de ${BL_ENNOBLISSEUR_EXPEDITEURS.join(', ')} avec une pièce jointe.`,
    ecritures: [
      'Le PDF du BL dans les documents de la commande sous-traitant (type « BL retour ennoblisseur »).',
      'Une ligne par pièce dans les données de réception (table data_bl_tricotbot), lot « MA » + numéro de BL.',
      'Un libellé Gmail « ETM/BL traité » ou « ETM/BL à vérifier » sur le mail.',
    ],
    abstention:
      'Rien n’est enregistré si un contrôle bloque : numéro de commande ou de bordereau illisible, commande inconnue ou pas chez MATEL, pièce introuvable ou affectée à une autre commande, somme des poids ou des métrages différente des totaux imprimés. L’exécution passe alors « à vérifier » et les abonnés à la notification « BL Ennoblisseur à vérifier » reçoivent un email (Paramètres › Utilisateurs › Notifications).',
    evaluation: {
      reussite: 'Lecture juste : les pièces pré-remplies pour la réception sont bonnes.',
      partielle: 'Lecture en partie fausse : les pièces restent pré-remplies, corrigez-les dans le dialogue de réception.',
      echec: 'Lecture fausse : les pièces pré-remplies sont retirées de la réception. Le PDF reste dans les documents de la commande.',
      retirer: retirerBlEnnoblisseur,
    },
    pointsEvaluables: false,
    modes: { off: 'Ne lit pas la boîte mail.', essai: 'Lit et analyse, n’enregistre rien.', actif: 'Lit, analyse et enregistre.' },
    versionInitiale: BL_ENNOBLISSEUR_VERSION_INITIALE,
    modeles: MODELES_MISTRAL,
    sonder: sonderBlEnnoblisseur,
    traiter: traiterBlEnnoblisseur,
  },
  {
    slug: SUPERVISEUR_SLUG,
    nom: 'Superviseur',
    description:
      'Contrôle chaque nuit l’activité d’ETS Malterre et prépare le rapport du matin : les clients ont-ils tous une réponse, les commandes reçues par mail sont-elles saisies dans ETM et justes, reste-t-il des actions en attente (pièces à affecter, fil à commander, ennoblissement non lancé…). Le rapport se lit ici, dans Exécutions.',
    declenchement: { type: 'quotidien', heure: SUPERVISEUR_HEURE, jours: SUPERVISEUR_JOURS },
    declencheur: `Chaque jour ouvré à ${SUPERVISEUR_HEURE} h du matin. Lit la base ETM (ETS Malterre uniquement) et les boîtes ${SUPERVISEUR_BOITES.join(', ')}.`,
    ecritures: ['Rien dans la base ni dans les boîtes mail : il lit seulement. Le rapport est l’exécution elle-même.'],
    abstention:
      'Un point déjà signalé reste dans le rapport, marqué « toujours ouvert », jusqu’à ce qu’il soit résolu. Un point jugé en échec (fausse alerte) est écarté des rapports suivants tant qu’il reste identique. Un lancement manuel ne met jamais à jour sa mémoire : le rapport du lendemain reste juste.',
    // Each POINT is scored, never the report (the report is the morning's batch).
    evaluation: {
      reussite: 'Point juste : il fallait bien le traiter.',
      partielle: 'Point réel mais en partie faux (quantité, client, détail…) : dites ce qui ne va pas.',
      echec: 'Fausse alerte : le point est écarté des prochains rapports tant qu’il reste identique.',
    },
    pointsEvaluables: true,
    modes: {
      off: 'Ne fait aucun contrôle.',
      actif: 'Contrôle chaque nuit et prépare le rapport du matin.',
    },
    versionInitiale: SUPERVISEUR_VERSION_INITIALE,
    modeles: MODELES_MISTRAL,
    sonder: executerSuperviseur,
    controles: CONTROLES.map((c) => ({ id: c.id, libelle: c.libelle, description: c.description })),
  },
]

export function agentDef(slug: string): AgentDef | undefined {
  return AGENTS.find((a) => a.slug === slug)
}
