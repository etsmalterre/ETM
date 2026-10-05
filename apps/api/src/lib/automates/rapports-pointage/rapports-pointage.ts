// Automates « Rapport de pointage » and « Bilan des heures annualisées » — the
// two TRM pointage report emails (lib/rapports-pointage-envoi.ts builds and
// sends them; the markup is lib/rapport-pointage-email.ts). They ran on their
// own in-process timer from 2026-09-22 to 2026-09-30; they now run on the
// agents' engine like every automate, so the screen shows what went out.
//
// Who receives them is NOT decided here: the automate's « Destinataires » tab
// (abonnement.ts, since 2026-10-02; the Pointage menu grant). A run records the
// subject, the one-line summary (counts, no names), the addresses and the
// subscribers left out — NEVER the report body: whoever may open Agents IA
// need not have the Pointage menu, and the body lists every salarié's hours.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { destinataires, construireRapport, envoyerRapport } from '../../rapports-pointage-envoi.js'
import { jourParis } from '../../pointage-etat.js'
import type { TrmNotificationKey } from '../../notification-keys-trm.js'
import type { AutomateState } from '../store.js'
import type { Issue } from '../catalog.js'

export const SLUG_RAPPORT = 'rapport-pointage'
export const SLUG_BILAN = 'bilan-heures'

export const VERSION = 1
export const versions = (quoi: string) =>
  [
    {
      version: 1,
      date: '2026-09-30',
      note: `${quoi} passe dans les automates : mêmes règles, même horaire, mêmes destinataires qu’avant (minuteur de l’API depuis le 22/09, n8n avant). Chaque envoi est maintenant visible ici.`,
    },
  ] as const

/** The daily report moved on its own on 2026-10-02 (the balance did not). */
export const VERSION_RAPPORT = 3
export const VERSIONS_RAPPORT = [
  ...versions('Le rapport de pointage'),
  {
    version: 2,
    date: '2026-10-02',
    note: 'N’envoie plus que les pointages à vérifier : seuls les salariés concernés sont listés, et aucun e-mail ne part quand tout est conforme. Les destinataires se choisissent dans l’onglet « Destinataires » (avant : Paramètres › Utilisateurs › Notifications).',
  },
  {
    version: 3,
    date: '2026-10-05',
    note: 'Un départ jusqu’à 10 min avant l’heure prévue n’est plus signalé (5 min avant). Une pause de midi plus courte ou plus longue de plus de 10 min que l’horaire est signalée ; elle est jugée à part du départ, jamais compensée. Retard à l’arrivée et au retour de midi : toujours 5 min.',
  },
] as const

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** The old timer's journal (key → YYYYMMDD of the last send), read once so the
 *  first tick after the deploy does not send a report a second time that day. */
const JOURNAL_ANCIEN = path.resolve(__dirname, '../../../../data/rapports-pointage-envois.json')

/** Starts « actif » in production (the reports were live before becoming
 *  automates), on the old journal's last day. Only read until the automate's
 *  state is first stored. ⚠️ Anywhere else it starts « essai »: a « Lancer
 *  maintenant » on a dev or worktree API must never mail real people. */
export function etatInitial(key: TrmNotificationKey): () => Partial<AutomateState> {
  return () => {
    if (process.env.NODE_ENV !== 'production') return { mode: 'essai' }
    let dernier: string | null = null
    try {
      dernier = (JSON.parse(fs.readFileSync(JOURNAL_ANCIEN, 'utf8')) as Record<string, string>)[key] ?? null
    } catch {
      // No journal (dev, or never sent): nothing to carry over.
    }
    return { mode: 'actif', dernierePlanification: dernier }
  }
}

const sansGras = (s: string) => s.replace(/\*\*/g, '')
const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`

/** One run: build the report of now, send it to every subscriber (actif) or
 *  say what it would send (essai). */
export function executeur(key: TrmNotificationKey) {
  return async (mode: 'essai' | 'actif', resultat: Record<string, unknown>): Promise<Issue> => {
    const now = Date.now()
    const { adresses, ecartes } = await destinataires(key)
    resultat.destinataires = adresses
    resultat.ecartes = ecartes
    const r = await construireRapport(key, now)
    if (!r) {
      // The daily report goes out only when a pointage needs checking (2026-10-02).
      const resume = key === 'notif_rapport_pointage'
        ? 'Rien à signaler : aucun pointage à vérifier, pas d’e-mail.'
        : 'Rien à envoyer : aucun salarié concerné sur la période.'
      return { statut: 'inchange', resume }
    }
    resultat.sujet = r.subject
    resultat.apercu = sansGras(r.content.intro ?? '')
    const noteEcartes = ecartes.length ? ` Non envoyé à : ${ecartes.map((e) => `${e.nom} (${e.raison})`).join(', ')}.` : ''
    if (!adresses.length) return { statut: 'inchange', resume: `« ${r.subject} » : aucun abonné ne peut le recevoir.${noteEcartes}` }
    const qui = pluriel(adresses.length, 'destinataire', 'destinataires')
    if (mode === 'essai') {
      return { statut: 'simule', resume: `Enverrait « ${r.subject} » à ${qui}.${noteEcartes}`, empreinte: `${jourParis(now)}|${r.subject}` }
    }
    const envoyes: string[] = []
    const echecs: string[] = []
    // One call per address so the run names who did not get it.
    for (const a of adresses) ((await envoyerRapport(r, [a])) ? envoyes : echecs).push(a)
    resultat.envoyes = envoyes
    resultat.echecs = echecs
    if (echecs.length) {
      return { statut: 'erreur', resume: `« ${r.subject} » envoyé à ${envoyes.length} sur ${adresses.length} ; échec pour ${echecs.join(', ')}.${noteEcartes}` }
    }
    return { statut: 'applique', resume: `« ${r.subject} » envoyé à ${qui}.${noteEcartes}` }
  }
}
