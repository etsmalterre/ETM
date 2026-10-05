// Notification subscriptions that exist in ETM only — next to the legacy
// catalog (`abonnement_notif`, shared with WinDev) in the same « Liste des
// abonnements » dialog and the same Notifications widget.
//
// Why not a row in `abonnement_notif` (decision 2026-09-28): WinDev would list
// a subscription it can never fill, and adding a row to that HFSQL table is a
// file-copy deploy on the shared server. An ETM-only subscription is stored
// here, per user, like the hidden cards (notification-hidden.json).
//
// Ids live far above the legacy catalog's (small autoincrements) so the two
// never collide in the widget, which keys everything by abonnement id.
//
// ⚠️ TODO migration: move to PostgreSQL with the other JSON stores.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionKey } from './permission-keys.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE_PATH = path.resolve(__dirname, '../../data/abonnements-etm.json')

/** Agent Superviseur — the points of its morning report, to handle. */
export const ABONNEMENT_SUPERVISEUR = 100001
/** Agent Factures Ennoblisseur — the dyers' invoices with a gap, to handle (LIVA #1255). */
export const ABONNEMENT_FACTURES_SST = 100002

export interface AbonnementEtm {
  id: number
  nom: string
  description: string
  /** Mapped to an icon by the widget (iconFor). */
  icone: string
  /** Offered only to users holding it — its sub-permission of
   *  `dashboard_notifications` (lib/permission-keys.ts). */
  permission: PermissionKey
}

export const ABONNEMENTS_ETM: readonly AbonnementEtm[] = [
  {
    id: ABONNEMENT_SUPERVISEUR,
    nom: 'Superviseur — points à traiter',
    description: 'Les points relevés chaque matin par l’agent Superviseur, à marquer « Traité » ou « Fausse alerte ».',
    icone: 'superviseur',
    // Also lets the widget's « Traité » / « Fausse alerte » through
    // (routes/agents-ia.ts traiteurPoints), without the Agents IA scoring right.
    permission: 'dashboard_notif_superviseur',
  },
  {
    id: ABONNEMENT_FACTURES_SST,
    nom: 'Factures sous-traitants — écarts',
    description: 'Les factures des ennoblisseurs où l’agent « Factures Ennoblisseur » a trouvé un écart (prix, poids, lot introuvable) ou n’a pas pu contrôler les prix, à traiter dans Sous-traitants › Factures.',
    icone: 'facture_sst',
    permission: 'dashboard_notif_factures_sst',
  },
]

export const estAbonnementEtm = (id: number) => ABONNEMENTS_ETM.some((a) => a.id === id)

type Fichier = Record<string, number[]>

async function lire(): Promise<Fichier> {
  try {
    return JSON.parse(await fs.readFile(FILE_PATH, 'utf8')) as Fichier
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

/** The ETM-only subscriptions of one user. */
export async function getUserAbonnementsEtm(userId: number): Promise<number[]> {
  return ((await lire())[String(userId)] ?? []).filter(estAbonnementEtm)
}

/** Replace the ETM-only subscriptions of one user among `offerts` (the ones
 *  they can see); those they cannot see are kept untouched. */
export function setUserAbonnementsEtm(userId: number, voulus: readonly number[], offerts: readonly number[]): Promise<number[]> {
  return exclusive(async () => {
    const f = await lire()
    const avant = (f[String(userId)] ?? []).filter(estAbonnementEtm)
    const apres = [...new Set([
      ...avant.filter((id) => !offerts.includes(id)),
      ...voulus.filter((id) => offerts.includes(id)),
    ])].sort((a, b) => a - b)
    if (apres.length) f[String(userId)] = apres
    else delete f[String(userId)]
    await fs.mkdir(path.dirname(FILE_PATH), { recursive: true })
    const tmp = `${FILE_PATH}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(f, null, 1), 'utf8')
    await fs.rename(tmp, FILE_PATH)
    return apres
  })
}
