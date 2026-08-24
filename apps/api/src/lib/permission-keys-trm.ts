// Catalog of TRM permission keys — the Tricotage Malterre app's own gated
// actions, managed from TRM's Paramètres > Utilisateurs screen.
//
// Deliberately a SEPARATE catalog from permission-keys.ts (ETM's): the two
// apps gate different screens, and each admin UI renders its whole catalog —
// merging them would surface TRM toggles in ETM's screen and vice-versa.
// Grants live in their own store too (lib/permissions-trm.ts): both apps'
// PUT endpoints replace a user's whole key list after filtering to their own
// catalog, so sharing data/permissions.json would let one app silently strip
// the other's grants on every save.
//
// Adding a new gated TRM action requires three edits (same contract as ETM):
//   1. Append a new entry to TRM_PERMISSION_KEYS below
//   2. Gate the corresponding API route via trmUserHasPermission(...)
//   3. Hide the corresponding UI element via useHasPermission('...') in the
//      TRM app (its PermissionsContext reads /api/permissions-trm/me)
//
// Keys are flat snake_case strings — stored verbatim in the JSON file and
// sent on the wire, so don't rename without a migration. Key names may
// coincide with ETM's (both apps have an `edit_commandes_client`): the
// stores are separate, so there is no collision — pick the name that fits
// the action, not a `trm_` prefix.

export const TRM_PERMISSION_KEYS = [
  // Tableau de bord — one key per widget, the same model as ETM's dashboard_*
  // keys: granting shows the widget for that user; admins always see every
  // widget. Kept first so the "Tableau de bord" section renders at the top of
  // Paramètres > Utilisateurs.
  {
    key: 'dashboard_poids_pieces',
    label: 'Widget « Poids des pièces »',
    description:
      'Affiche sur le tableau de bord le suivi du poids des pièces par métier : pour chaque OF en cours, la part des rouleaux pesés dans la tolérance (du poids de pièce à +0,7 kg) et, au clic, le graphique des pesées de l’OF.',
    category: 'Tableau de bord',
  },
  {
    key: 'edit_commandes_client',
    label: 'Édition des commandes client',
    description:
      'Autorise la création, la modification et la suppression des commandes natives et de leurs lignes dans Clients > Commandes : boutons « Nouvelle commande », « Modifier », « Supprimer » et l’édition des lignes. Les commandes miroir ETM restent en lecture seule pour tout le monde.',
    category: 'Commandes client',
  },
] as const

export type TrmPermissionKey = (typeof TRM_PERMISSION_KEYS)[number]['key']

/** Set of all known TRM keys for fast membership checks during validation. */
export const KNOWN_TRM_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  TRM_PERMISSION_KEYS.map((p) => p.key),
)

export function isKnownTrmPermissionKey(k: string): k is TrmPermissionKey {
  return KNOWN_TRM_PERMISSION_KEYS.has(k)
}
