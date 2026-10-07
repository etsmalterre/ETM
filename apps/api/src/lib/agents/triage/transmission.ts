// Agent « Triage » — handing a mail to the agent behind its category.
//
// A direct in-process call (MFProd's shape, no queue) to the agent's own
// `traiterMessage`, under THAT agent's lock (verrous.ts) and with ITS mode
// and prompt version: the Triage only decides who gets the mail, never how it
// is read. Handed over whenever the agent is on: while the Triage is in
// service the agent no longer polls the mailbox itself (relais.ts). An agent
// that already has a run for the message — read by its own fallback poll
// while the Triage was failing — is never called again (« déjà traité »).
//
// No import of catalog.ts / scheduler.ts here (catalog imports the Triage).

import { lireMessage, type MessageInfo } from '../../gmail-reader.js'
import {
  BL_ENNOBLISSEUR_BOITE,
  BL_ENNOBLISSEUR_SLUG,
  BL_ENNOBLISSEUR_VERSION_INITIALE,
  traiterMessage as recevoirBl,
} from '../bl-ennoblisseur.js'
import { profilDe, profilDuSousTraitant } from '../bl-profils.js'
import {
  FACTURES_SST_SLUG,
  FACTURES_SST_VERSION_INITIALE,
  traiterMessage as recevoirFacture,
} from '../factures-sst/agent.js'
import { fournisseurDe, fournisseurDuSousTraitant } from '../factures-sst/extraction.js'
import { lireEtat, lireRuns, versionActive, type AgentMode, type AgentRun, type AgentVersion, type Auteur, type RunSource, type VersionInitiale } from '../store.js'
import { apresVerrou } from '../verrous.js'
import { TRIAGE_BOITE } from './constantes.js'
import type { Categorie } from './categories.js'
import type { Organisation } from './annuaire.js'

export interface Transmission {
  categorie: string
  /** Slug of the agent behind the category. */
  agent: string
  nom: string
  le: string
  /** transmis = the agent processed it now; deja_traite = it had already;
   *  non_transmis = it is off; erreur = retried. */
  statut: 'transmis' | 'deja_traite' | 'non_transmis' | 'erreur'
  raison: string | null
  runs: Array<{ id: string; statut: string; resume: string }>
  tentatives: number
}

export interface Destinataire {
  slug: string
  nom: string
  versionInitiale: VersionInitiale
  recevoir(m: MessageInfo, ctx: { mode: AgentMode; version: AgentVersion; source: RunSource; lancePar: Auteur | null }): Promise<AgentRun[]>
  /** The dyer its runs recognised in the PDF (refines the sub-category). */
  sousCategorie(runs: readonly AgentRun[]): string | null
}

const premier = (xs: Array<string | null | undefined>): string | null => xs.find((x): x is string => !!x) ?? null

export const DESTINATAIRES: Record<string, Destinataire> = {
  [BL_ENNOBLISSEUR_SLUG]: {
    slug: BL_ENNOBLISSEUR_SLUG,
    nom: 'BL Ennoblisseur',
    versionInitiale: BL_ENNOBLISSEUR_VERSION_INITIALE,
    recevoir: recevoirBl,
    sousCategorie: (runs) => premier(runs.map((r) => profilDe((r.resultat as { profil?: string | null }).profil)?.nom)),
  },
  [FACTURES_SST_SLUG]: {
    slug: FACTURES_SST_SLUG,
    nom: 'Factures Ennoblisseur',
    versionInitiale: FACTURES_SST_VERSION_INITIALE,
    recevoir: recevoirFacture,
    sousCategorie: (runs) => premier(runs.map((r) => fournisseurDe((r.resultat as { fournisseur?: string | null }).fournisseur)?.nom)),
  },
}

// The BL and invoice agents read the same mailbox as the Triage.
if (BL_ENNOBLISSEUR_BOITE !== TRIAGE_BOITE) console.warn(`[agents] triage: ${TRIAGE_BOITE} ≠ ${BL_ENNOBLISSEUR_BOITE} — the hand-off reads attachments from the Triage's mailbox`)

const resumes = (runs: readonly AgentRun[]) => runs.map((r) => ({ id: r.id, statut: r.statut, resume: r.resume }))

/** Hand one mail to the agent behind `c`. Never throws: an error is a
 *  transmission « erreur », retried by the next polls (relancer, agent.ts).
 *  `message` is fetched from Gmail when absent (a correction, a retry). */
export async function transmettre(
  c: Categorie,
  messageId: string,
  par: Auteur | null,
  message?: MessageInfo,
  destinataires: Record<string, Destinataire> = DESTINATAIRES,
  tentatives = 1,
): Promise<Transmission> {
  const d = c.cible ? destinataires[c.cible] : undefined
  const t: Transmission = {
    categorie: c.cle, agent: c.cible ?? '', nom: d?.nom ?? c.cible ?? '', le: new Date().toISOString(),
    statut: 'non_transmis', raison: null, runs: [], tentatives,
  }
  if (!d) { t.raison = 'aucun agent derrière cette catégorie'; return t }
  try {
    const state = await lireEtat(d.slug, d.versionInitiale)
    if (state.mode === 'off') { t.raison = `${d.nom} est à l’arrêt`; return t }
    // Under the agent's lock: never next to one of its own runs on the same mail.
    return await apresVerrou(d.slug, async () => {
      const deja = (await lireRuns(d.slug)).filter((r) => r.message?.id === messageId)
      if (deja.length) {
        t.statut = 'deja_traite'
        t.runs = resumes(deja)
        t.raison = `${d.nom} avait déjà traité ce mail`
        return t
      }
      const m = message ?? (await lireMessage(TRIAGE_BOITE, messageId))
      const runs = await d.recevoir(m, { mode: state.mode, version: versionActive(state), source: 'triage', lancePar: par })
      t.statut = 'transmis'
      t.runs = resumes(runs)
      return t
    })
  } catch (err) {
    t.statut = 'erreur'
    t.raison = err instanceof Error ? err.message : String(err)
    console.error(`[agents] triage: hand-off of ${messageId} to ${d.slug} failed:`, t.raison)
    return t
  }
}

/** The sub-category of a category on one mail: never the model's choice.
 *  For a category handed to an agent, the dyer it recognised in the PDF, else
 *  the dyer's contact that sent it; otherwise the sender's company. */
export async function sousCategorie(
  c: Categorie,
  org: Organisation | null,
  transmissions: readonly Transmission[],
  destinataires: Record<string, Destinataire> = DESTINATAIRES,
): Promise<string | null> {
  const d = c.cible ? destinataires[c.cible] : undefined
  if (d) {
    const ids = new Set(transmissions.filter((t) => t.agent === d.slug).flatMap((t) => t.runs.map((r) => r.id)))
    if (ids.size) {
      const lu = d.sousCategorie((await lireRuns(d.slug)).filter((r) => ids.has(r.id)))
      if (lu) return lu
    }
    if (org?.type === 'sous_traitant') return profilDuSousTraitant(org.id)?.nom ?? fournisseurDuSousTraitant(org.id)?.nom ?? org.nom
    return null
  }
  return org && org.type !== 'interne' ? org.nom : null
}
