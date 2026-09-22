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
  prevenir as prevenirBlMatel,
} from './bl-matel.js'
import type { AgentRun, AgentState, AgentVersion, Auteur, VersionInitiale } from './store.js'
import type { Contexte } from './bl-matel.js'

export interface AgentDef {
  slug: string
  nom: string
  description: string
  /** What triggers it, shown in the « Fonctionnement » tab. */
  declencheur: string
  /** What it writes, shown in the « Fonctionnement » tab. */
  ecritures: string[]
  versionInitiale: VersionInitiale
  /** Chat models a version may use. */
  modeles: readonly string[]
  /** One mailbox poll (scheduler tick or « Relever maintenant »). */
  sonder(state: AgentState, version: AgentVersion, par: Auteur | null): Promise<AgentRun[]>
  /** Run PDFs through the pipeline outside the mailbox (manual test, retraitement). */
  traiter(pdfs: Array<{ nom: string; contenu: Buffer }>, ctx: Contexte): Promise<AgentRun[]>
  /** Mail the subscribers about runs that need a human. */
  prevenir(runs: AgentRun[]): Promise<void>
}

export const AGENTS: readonly AgentDef[] = [
  {
    slug: BL_MATEL_SLUG,
    nom: 'BL MATEL',
    description:
      'Lit les bordereaux de livraison envoyés par le teinturier MATEL et prépare la réception : chaque pièce (poids, métrage, observations) est enregistrée pour pré-remplir le dialogue de réception de Sous-traitants › Commandes, et le PDF est classé dans les documents de la commande.',
    declencheur: `Relève toutes les 2 minutes la boîte ${BL_MATEL_BOITE}, mails de ${BL_MATEL_EXPEDITEURS.join(', ')} avec une pièce jointe.`,
    ecritures: [
      'Le PDF du BL dans les documents de la commande sous-traitant (type « BL retour ennoblisseur »).',
      'Une ligne par pièce dans les données de réception (table data_bl_tricotbot), lot « MA » + numéro de BL.',
      'Un libellé Gmail « ETM/BL traité » ou « ETM/BL à vérifier » sur le mail.',
    ],
    versionInitiale: BL_MATEL_VERSION_INITIALE,
    modeles: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'ministral-8b-latest'].filter(isChatModel),
    sonder: sonderBlMatel,
    traiter: traiterBlMatel,
    prevenir: prevenirBlMatel,
  },
]

export function agentDef(slug: string): AgentDef | undefined {
  return AGENTS.find((a) => a.slug === slug)
}
