// Agents IA › Automates — the catalog. An automate is a DETERMINISTIC script
// run by the MPS API (no LLM, unlike lib/agents/): code + a stored state
// (mode, feedback, runs — store.ts). It runs on the agents' engine
// (lib/agents/scheduler.ts, one lock per tâche, production-only tick) through
// execution.ts. Adding an automate = one entry here + its module.

import type { Declenchement } from '../agents/catalog.js'
import type { AutomateMode, AutomateStatut } from './store.js'
import * as videosurveillance from './videosurveillance/videosurveillance.js'

/** What one run produced. `resultat` is filled as the run goes, so a run that
 *  throws half-way still keeps what it read (and the snapshot it took). */
export interface Issue {
  statut: AutomateStatut
  resume: string
  /** Essai: the same proposal every hour is kept once (execution.ts). */
  empreinte?: string
}

export interface AutomateDef {
  slug: string
  nom: string
  description: string
  /** The code version — bump it (and add a `versions` line) with every behaviour change. */
  version: number
  /** What each version changed, newest last (the « Retours » tab lists them). */
  versions: ReadonlyArray<{ version: number; date: string; note: string }>
  declenchement: Declenchement
  /** « Fonctionnement » tab. */
  declencheur: string
  lit: string[]
  ecritures: string[]
  abstention: string
  modes: Partial<Record<AutomateMode, string>>
  /** One run. `mode` is what it may do: essai never writes. */
  executer(mode: 'essai' | 'actif', resultat: Record<string, unknown>): Promise<Issue>
  /** Called once when the automate leaves « actif » (under the same lock). */
  quitterActif?(resultat: Record<string, unknown>): Promise<Issue>
  /** Live view of what the automate drives (« État » tab). Read-only. */
  etat?(): Promise<unknown>
}

export const AUTOMATES: readonly AutomateDef[] = [
  {
    slug: videosurveillance.SLUG,
    nom: 'Vidéosurveillance',
    description:
      'Active les notifications de détection de mouvement des caméras quand l’usine est fermée, d’après le planning de l’atelier TRM : aucune équipe planifiée = usine fermée = alertes sur les téléphones liés au NVR Reolink.',
    version: videosurveillance.VERSION,
    versions: videosurveillance.VERSIONS,
    declenchement: { type: 'releve', intervalleMs: 60 * 60_000 },
    declencheur: 'Toutes les heures : recalcule les 7 prochains jours et met le NVR à jour s’il diffère.',
    lit: [
      'Le planning de l’atelier TRM (Planning atelier, toutes les équipes planifiées, régleurs compris) de la semaine en cours et des deux suivantes.',
      'Le réglage des notifications de chaque caméra en ligne sur le NVR Reolink (10.10.40.10).',
    ],
    ecritures: [
      'Sur le NVR : le planning hebdomadaire des notifications « mouvement » de chaque caméra (planning activé). Les autres détections (personne, véhicule, animal) ne sont pas modifiées.',
      'Jamais l’interrupteur des notifications d’une caméra : une caméra coupée à la main dans l’application Reolink reste coupée, l’automate la signale sans y toucher.',
      'Avant chaque écriture, le réglage complet de chaque caméra est gardé dans l’exécution.',
    ],
    abstention:
      'Une semaine sans aucune équipe planifiée (planning pas encore saisi, ou fermeture) reprend le planning fixe d’avant : du vendredi 18 h au lundi 5 h. Une heure est considérée occupée dès qu’une équipe y travaille, avec une heure de marge avant et après. En passant de « actif » à un autre mode, l’automate remet une fois le planning fixe sur le NVR.',
    modes: {
      off: 'Ne fait rien. Le NVR garde le planning fixe.',
      essai: 'Calcule chaque heure ce qu’il changerait sur le NVR, n’écrit rien.',
      actif: 'Met à jour le NVR chaque heure d’après le planning.',
    },
    executer: videosurveillance.executer,
    quitterActif: videosurveillance.remettreFixe,
    etat: videosurveillance.etat,
  },
]

export function automateDef(slug: string): AutomateDef | undefined {
  return AUTOMATES.find((a) => a.slug === slug)
}
