// Agents IA › Automates — the catalog. An automate is a DETERMINISTIC script
// run by the MPS API (no LLM, unlike lib/agents/): code + a stored state
// (mode, feedback, runs — store.ts). It runs on the agents' engine
// (lib/agents/scheduler.ts, one lock per tâche, production-only tick) through
// execution.ts. Adding an automate = one entry here + its module.

import type { Declenchement } from '../agents/catalog.js'
import { declarerEtatInitial, type AutomateMode, type AutomateState, type AutomateStatut } from './store.js'
import * as videosurveillance from './videosurveillance/videosurveillance.js'
import * as rapportsPointage from './rapports-pointage/rapports-pointage.js'

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
  /** State before the first one is stored (default: « off »), store.ts. */
  etatInitial?: () => Partial<AutomateState>
}

export const AUTOMATES: readonly AutomateDef[] = [
  {
    slug: videosurveillance.SLUG,
    nom: 'Vidéosurveillance',
    description:
      'Active les notifications des caméras (les détections choisies dans l’application Reolink) quand l’usine est fermée, d’après le planning de l’atelier TRM : aucune équipe planifiée = usine fermée = alertes sur les téléphones liés au NVR Reolink.',
    version: videosurveillance.VERSION,
    versions: videosurveillance.VERSIONS,
    declenchement: { type: 'releve', intervalleMs: 60 * 60_000 },
    declencheur: 'Toutes les heures : recalcule les 7 prochains jours et met le NVR à jour s’il diffère.',
    lit: [
      'Le planning de l’atelier TRM (Planning atelier, toutes les équipes planifiées, régleurs compris) de la semaine en cours et des deux suivantes.',
      'Le réglage des notifications de chaque caméra en ligne sur le NVR Reolink (10.10.40.10).',
    ],
    ecritures: [
      'Sur le NVR : les horaires des notifications de chaque caméra (planning activé), sur chaque détection laissée cochée (mouvement, personne, véhicule, animal).',
      'Jamais le choix des détections : une détection décochée dans l’application Reolink (par exemple « mouvement » pour ne garder que personnes et véhicules) reste décochée.',
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
  {
    slug: rapportsPointage.SLUG_RAPPORT,
    nom: 'Rapport de pointage',
    description:
      'Envoie chaque matin de semaine le pointage de la veille (le lundi : vendredi, samedi et dimanche) aux abonnés : début, pauses et fin de chaque salarié, avec les pointages à vérifier.',
    version: rapportsPointage.VERSION,
    versions: rapportsPointage.versions('Le rapport de pointage'),
    declenchement: { type: 'quotidien', heure: 9, jours: [1, 2, 3, 4, 5] },
    declencheur: 'Du lundi au vendredi à 9 h (heure de Paris). Si l’API était arrêtée à 9 h, il part dès son retour le même jour ; jamais deux fois le même jour, jamais le lendemain.',
    lit: [
      'Les pointages de la veille (base Pointage), le planning de l’atelier TRM (Planning atelier) et l’horaire de chaque salarié.',
      'Les abonnés : TRM › Paramètres › Utilisateurs › Notifications, « Rapport de pointage ».',
    ],
    ecritures: [
      'Un e-mail par abonné, envoyé par tricotbot@etsmalterre.com (« TRM - Pointage »).',
      'Seulement aux abonnés qui ont accès au menu Pointage de TRM et une adresse e-mail ; les autres sont nommés dans l’exécution.',
      'L’exécution garde le sujet, le résumé chiffré et les adresses, jamais le contenu du rapport (les heures des salariés).',
    ],
    abstention: 'Aucun salarié pointé ni planifié sur la période : aucun e-mail. Aucun abonné autorisé : aucun e-mail, l’exécution le dit.',
    modes: {
      off: 'N’envoie rien.',
      essai: 'Prépare le rapport à l’heure prévue et dit à qui il l’enverrait, n’envoie rien.',
      actif: 'Envoie le rapport aux abonnés. « Lancer maintenant » le renvoie à tous les abonnés.',
    },
    executer: rapportsPointage.executeur('notif_rapport_pointage'),
    etatInitial: rapportsPointage.etatInitial('notif_rapport_pointage'),
  },
  {
    slug: rapportsPointage.SLUG_BILAN,
    nom: 'Bilan des heures annualisées',
    description:
      'Envoie chaque mardi aux abonnés le solde annuel de chaque salarié (heures lissées − heures prévues − variables), arrêté à la semaine précédente.',
    version: rapportsPointage.VERSION,
    versions: rapportsPointage.versions('Le bilan des heures annualisées'),
    declenchement: { type: 'quotidien', heure: 9, jours: [2] },
    declencheur: 'Le mardi à 9 h (heure de Paris). Si l’API était arrêtée à 9 h, il part dès son retour le même jour ; jamais deux fois le même jour.',
    lit: [
      'Le lissage des heures de chaque salarié (base Pointage) pour la semaine précédente.',
      'Les abonnés : TRM › Paramètres › Utilisateurs › Notifications, « Bilan des heures annualisées ».',
    ],
    ecritures: [
      'Un e-mail par abonné, envoyé par tricotbot@etsmalterre.com (« TRM - Pointage »).',
      'Seulement aux abonnés qui ont accès au menu Pointage de TRM et une adresse e-mail ; les autres sont nommés dans l’exécution.',
      'L’exécution garde le sujet, le résumé chiffré et les adresses, jamais les soldes des salariés.',
    ],
    abstention: 'Aucun salarié avec un lissage pour la semaine précédente : aucun e-mail. Aucun abonné autorisé : aucun e-mail, l’exécution le dit.',
    modes: {
      off: 'N’envoie rien.',
      essai: 'Prépare le bilan à l’heure prévue et dit à qui il l’enverrait, n’envoie rien.',
      actif: 'Envoie le bilan aux abonnés. « Lancer maintenant » le renvoie à tous les abonnés.',
    },
    executer: rapportsPointage.executeur('notif_bilan_heures'),
    etatInitial: rapportsPointage.etatInitial('notif_bilan_heures'),
  },
]

for (const a of AUTOMATES) if (a.etatInitial) declarerEtatInitial(a.slug, a.etatInitial)

export function automateDef(slug: string): AutomateDef | undefined {
  return AUTOMATES.find((a) => a.slug === slug)
}
