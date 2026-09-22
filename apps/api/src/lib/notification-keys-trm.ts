// Catalog of the email notifications a TRM user can subscribe to, managed from
// the TRM app's Paramètres > Utilisateurs › Notifications tab.
//
// TRM's own catalog and store (data/notifications-trm.json), separate from
// ETM's (lib/notification-keys.ts) for the same reason the permissions are: the
// two apps' admin screens must not list each other's entries.
//
// Adding a notification: append an entry here, then send it — scheduled reports
// through lib/rapports-pointage-envoi.ts, event notifications with the store's
// subscribersOf(). The frontend tab renders this catalog as-is.
//
// `requires` names the TRM permission a subscriber must hold. The pointage
// reports carry employees' working hours, so only someone who may already see
// them in the Pointage menu (view_pointage) can receive them: the admin tab
// refuses the subscription, and the sender skips a subscriber who lost the right.

import type { TrmPermissionKey } from './permission-keys-trm.js'

export interface TrmNotificationDef {
  key: string
  label: string
  description: string
  category: string
  requires?: TrmPermissionKey
}

export const TRM_NOTIFICATION_KEYS = [
  {
    key: 'notif_rapport_pointage',
    label: 'Rapport de pointage',
    description:
      'Chaque matin de semaine à 9 h, le pointage de la veille (le lundi : vendredi, samedi et dimanche) : début, pauses et fin de chaque salarié, avec les pointages à vérifier (retard, départ anticipé, pause trop longue, pointage manquant).',
    category: 'Pointage',
    requires: 'view_pointage',
  },
  {
    key: 'notif_bilan_heures',
    label: 'Bilan des heures annualisées',
    description:
      'Chaque mardi à 9 h, le solde annuel de chaque salarié (heures lissées − heures prévues − variables) arrêté à la semaine précédente.',
    category: 'Pointage',
    requires: 'view_pointage',
  },
] as const satisfies readonly TrmNotificationDef[]

export type TrmNotificationKey = (typeof TRM_NOTIFICATION_KEYS)[number]['key']

const KNOWN: ReadonlySet<string> = new Set(TRM_NOTIFICATION_KEYS.map((n) => n.key))

export function isKnownTrmNotificationKey(k: string): k is TrmNotificationKey {
  return KNOWN.has(k)
}

export function trmNotificationDef(key: TrmNotificationKey): TrmNotificationDef {
  return TRM_NOTIFICATION_KEYS.find((n) => n.key === key)!
}
