// Catalog of email notification types a user can subscribe to, managed from
// Paramètres > Utilisateurs › Notifications.
//
// Adding a new notification requires three edits:
//   1. Append a new entry to NOTIFICATION_KEYS below
//   2. Call notify('<key>', ...) from wherever the event happens
//   3. Nothing on the frontend — the Notifications tab renders the catalog
//
// Deliberately NOT permissions, and stored separately (data/notifications.json
// vs data/permissions.json): a permission gates an action, a notification is an
// opt-in subscription. Two consequences fall out of that distinction —
//   • there is NO admin bypass. An admin is not implicitly subscribed to
//     everything; nobody receives an email they didn't opt into.
//   • the delivery address is the user's mapped email (lib/user-emails.ts). A
//     subscriber without one is a silent no-op, which the admin UI flags.

export const NOTIFICATION_KEYS = [
  {
    key: 'notif_coloris_ajoute',
    label: 'Coloris client ajouté',
    description:
      'Envoie un email à chaque ajout d’un coloris sur une référence client dans Clients > Gestion, quel que soit l’auteur et quel que soit le chemin utilisé (dialogue « Référence client » ou bouton « Ajouter un coloris »). Les coloris retirés lors de la même modification sont rappelés dans le message.',
    category: 'Gestion client',
  },
  {
    key: 'notif_coloris_refuse',
    label: 'Demande d’ajout de coloris bloquée',
    description:
      'Envoie un email lorsqu’un utilisateur, bloqué parce que les coloris de la référence n’ont pas tous le même tarif standard, clique sur « Prévenir le responsable » pour demander l’ajout. Le message indique la référence, les coloris souhaités et la note laissée par le demandeur.',
    category: 'Gestion client',
  },
] as const

export type NotificationKey = (typeof NOTIFICATION_KEYS)[number]['key']

/** Set of all known keys for fast membership checks during validation. */
export const KNOWN_NOTIFICATION_KEYS: ReadonlySet<string> = new Set(
  NOTIFICATION_KEYS.map((n) => n.key),
)

export function isKnownNotificationKey(k: string): k is NotificationKey {
  return KNOWN_NOTIFICATION_KEYS.has(k)
}
