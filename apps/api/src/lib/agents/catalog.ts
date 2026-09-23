// « Agents IA » — the catalog. An agent is code (what it reads, how it
// decides, what it writes) plus a stored state (mode, prompt versions — see
// store.ts). Adding an agent = one entry here + its pipeline module.

import { isChatModel } from '../mistral.js'
import {
  BL_MATEL_BOITE,
  BL_MATEL_EXPEDITEURS,
  BL_MATEL_SLUG,
  BL_MATEL_VERSION_INITIALE,
  sonderBoite as sonderBlMatel,
  traiterPdfs as traiterBlMatel,
} from './bl-matel.js'
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
import type { Contexte } from './bl-matel.js'

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
  /** How a run is judged on screen: `lecture` = correct / incorrect (a reading,
   *  BL MATEL); `execution` = « réussie » unless marked « échouée » with a
   *  mandatory comment (Superviseur). Same stored verdict field. */
  jugement: 'lecture' | 'execution'
  /** One line per mode for the status footer menu. */
  modes: Record<AgentMode, string>
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
    slug: BL_MATEL_SLUG,
    nom: 'BL MATEL',
    description:
      'Lit les bordereaux de livraison envoyés par le teinturier MATEL et prépare la réception : chaque pièce (poids, métrage, observations) est enregistrée pour pré-remplir le dialogue de réception de Sous-traitants › Commandes, et le PDF est classé dans les documents de la commande.',
    declenchement: { type: 'releve', intervalleMs: 2 * 60_000 },
    declencheur: `Relève toutes les 2 minutes la boîte ${BL_MATEL_BOITE}, mails de ${BL_MATEL_EXPEDITEURS.join(', ')} avec une pièce jointe.`,
    ecritures: [
      'Le PDF du BL dans les documents de la commande sous-traitant (type « BL retour ennoblisseur »).',
      'Une ligne par pièce dans les données de réception (table data_bl_tricotbot), lot « MA » + numéro de BL.',
      'Un libellé Gmail « ETM/BL traité » ou « ETM/BL à vérifier » sur le mail.',
    ],
    abstention:
      'Rien n’est enregistré si un contrôle bloque : numéro de commande ou de bordereau illisible, commande inconnue ou pas chez MATEL, pièce introuvable ou affectée à une autre commande, somme des poids ou des métrages différente des totaux imprimés. L’exécution passe alors « à vérifier » et les abonnés à la notification « BL MATEL à vérifier » reçoivent un email (Paramètres › Utilisateurs › Notifications).',
    jugement: 'lecture',
    modes: { off: 'Ne lit pas la boîte mail.', essai: 'Lit et analyse, n’enregistre rien.', actif: 'Lit, analyse et enregistre.' },
    versionInitiale: BL_MATEL_VERSION_INITIALE,
    modeles: MODELES_MISTRAL,
    sonder: sonderBlMatel,
    traiter: traiterBlMatel,
  },
  {
    slug: SUPERVISEUR_SLUG,
    nom: 'Superviseur',
    description:
      'Contrôle chaque soir l’activité d’ETS Malterre : les clients ont-ils tous une réponse, les commandes reçues par mail sont-elles saisies dans ETM et justes, reste-t-il des actions en attente (pièces à affecter, fil à commander, ennoblissement non lancé…). Il envoie un mail récapitulatif seulement s’il trouve un point nouveau.',
    declenchement: { type: 'quotidien', heure: SUPERVISEUR_HEURE, jours: SUPERVISEUR_JOURS },
    declencheur: `Chaque jour ouvré à ${SUPERVISEUR_HEURE} h. Lit la base ETM (ETS Malterre uniquement) et les boîtes ${SUPERVISEUR_BOITES.join(', ')}.`,
    ecritures: [
      'Rien dans la base ni dans les boîtes mail : il lit seulement.',
      'Un mail aux abonnés de la notification « Superviseur — points à voir » quand il trouve un point nouveau.',
    ],
    abstention:
      'Pas de mail les soirs où rien de nouveau ne demande d’attention : un point déjà signalé réapparaît seulement dans la liste « Toujours ouvert » d’un prochain mail. Un lancement manuel ne met jamais à jour sa mémoire et n’envoie jamais de mail.',
    jugement: 'execution',
    modes: {
      off: 'Ne fait aucun contrôle.',
      essai: 'Contrôle chaque soir et prépare le mail, sans l’envoyer.',
      actif: 'Contrôle chaque soir et envoie le mail aux abonnés.',
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
