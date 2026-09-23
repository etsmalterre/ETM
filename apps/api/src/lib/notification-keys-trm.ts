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
// `requires` names the stored TRM key a subscriber must hold — an action
// permission or a menu grant (`screen_<menu>`). The pointage reports carry
// employees' working hours, so only someone who may already see them — who has
// the menu « Pointage », which is the whole right since LIVA #1196 — can
// receive them: the admin tab refuses the subscription, and the sender skips a
// subscriber who lost the right.

import { TRM_PERMISSION_KEYS } from './permission-keys-trm.js'
import { TRM_SCREEN_MENUS, trmMenuAccessKey } from './screen-keys-trm.js'

export interface TrmNotificationDef {
  key: string
  label: string
  description: string
  category: string
  /** Stored TRM key required: an action permission or a menu grant. */
  requires?: string
}

const MENU_POINTAGE = trmMenuAccessKey('/pointage')

export const TRM_NOTIFICATION_KEYS = [
  {
    key: 'notif_rapport_pointage',
    label: 'Rapport de pointage',
    description:
      'Chaque matin de semaine à 9 h, le pointage de la veille (le lundi : vendredi, samedi et dimanche) : début, pauses et fin de chaque salarié, avec les pointages à vérifier (retard, départ anticipé, pause trop longue, pointage manquant).',
    category: 'Pointage',
    requires: MENU_POINTAGE,
  },
  {
    key: 'notif_bilan_heures',
    label: 'Bilan des heures annualisées',
    description:
      'Chaque mardi à 9 h, le solde annuel de chaque salarié (heures lissées − heures prévues − variables) arrêté à la semaine précédente.',
    category: 'Pointage',
    requires: MENU_POINTAGE,
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

/** French wording of a `requires` key and the Paramètres tab that grants it,
 *  for the 409 of a refused subscription. */
export function trmRequisLibelle(key: string): string {
  const menu = TRM_SCREEN_MENUS.find((m) => trmMenuAccessKey(m.href) === key)
  if (menu) return `l’accès au menu « ${menu.label} » : accordez-le d’abord dans l’onglet Écrans`
  const perm = TRM_PERMISSION_KEYS.find((k) => k.key === key)
  return `le droit « ${perm?.label ?? key} » : accordez-le d’abord dans l’onglet Permissions`
}
