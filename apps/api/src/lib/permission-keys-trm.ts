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
    key: 'dashboard_ca',
    label: 'Widget « Chiffre d’affaires »',
    description:
      'Affiche sur le tableau de bord le CA par client de Tricotage Malterre : classement, comparatif avec l’année précédente (année complète ou même période), progressions, nouveaux clients et répartition. Donnée confidentielle — l’API refuse les chiffres sans ce droit, même à un utilisateur qui devinerait l’adresse.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_evolution_ca',
    label: 'Widget « Évolution du CA »',
    description:
      'Affiche sur le tableau de bord le CA mensuel et annuel de Tricotage Malterre sur les cinq derniers exercices. Sous-droit de « Chiffre d’affaires » : même donnée confidentielle et même contrôle API, mais l’affichage du widget se règle séparément.',
    category: 'Tableau de bord',
    parent: 'dashboard_ca',
  },
  {
    key: 'dashboard_finance',
    label: 'Widget « Analyse financière »',
    description:
      'Affiche sur le tableau de bord les courbes cumulées de l’exercice (CA, marge brute, charges fixes et variables) et le CA, la marge brute et l’EBE du dernier relevé comptable de Tricotage Malterre. Donnée confidentielle — l’API refuse les chiffres sans ce droit. Indépendant de « Charges », qui donne le détail compte par compte.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_charges',
    label: 'Widget « Charges »',
    description:
      'Affiche sur le tableau de bord le total des charges fixes et variables du dernier relevé comptable de Tricotage Malterre, face à la même période de l’année précédente. Ce droit ouvre aussi le détail compte par compte servi par l’API — donnée confidentielle : il nomme les lignes de salaires.',
    category: 'Tableau de bord',
  },
  {
    key: 'edit_commandes_client',
    label: 'Édition des commandes client',
    description:
      'Autorise la création, la modification et la suppression des commandes natives et de leurs lignes dans Clients > Commandes : boutons « Nouvelle commande », « Modifier », « Supprimer » et l’édition des lignes. Les commandes miroir ETM restent en lecture seule pour tout le monde.',
    category: 'Commandes client',
  },
  // Atelier > Maintenance — the métier upkeep fiche and the workshop-wide
  // entretien gauges. Read stays open to anyone holding the Atelier menu (the
  // bonnetier needs to see when the rouloir is due); only the writes are gated.
  // One key covers both surfaces on purpose: the same person declares the
  // rouloir visit and the ventilateur cleaning.
  {
    key: 'edit_maintenance',
    label: 'Édition de la maintenance des métiers',
    description:
      'Autorise la modification de la fiche maintenance d’un métier dans Atelier > Maintenance (description, fonture, visite du rouloir, dates et commentaires de garniture) et la déclaration des entretiens d’atelier (« Effectué ce jour » sur les jauges Ventilateurs, Couronnes et Fuites d’air). La consultation reste ouverte à tous les utilisateurs qui ont le menu Atelier.',
    category: 'Atelier',
  },
  // Rapports > Finance — the accountant's balance, account by account. Gated
  // rather than open like a production report, because the balance names the
  // payroll lines. Same key NAMES as ETM's catalog on purpose: same action,
  // separate store (see the header).
  //
  // Note the overlap with `dashboard_charges`: both open the same
  // compte-by-compte payload (`FINANCE_SCOPE_TRM.financeKeys` is an any-of
  // list), because the Charges widget sums the very rows this screen lists.
  // Neither is the other's parent — a user can hold the widget without the
  // screen, or the screen without the widget.
  {
    key: 'view_rapport_finance',
    label: 'Consulter le rapport finance',
    description:
      'Affiche l’entrée « Finance » du menu Rapports et autorise la consultation de la balance comptable de Tricotage Malterre (charges fixes et variables, montants annuels et comparaison N-1). Ces données incluent les comptes de personnel.',
    category: 'Rapports',
  },
  {
    key: 'edit_compte_description',
    label: 'Annoter les comptes',
    description:
      'Autorise la modification de la description libre d’un compte comptable et de sa nature (charge fixe ou variable) depuis le tiroir de Rapports > Finance.',
    category: 'Rapports',
    parent: 'view_rapport_finance',
  },
  // Qualité > Retour client. Only the WRITE side is gated: a retour client is
  // the atelier's own quality record, not confidential data, and who sees the
  // screen at all is already the Écrans axis's job. What this key protects is
  // the FNC round-trip — the réponse written here is republished onto ETM's
  // dossier, so an unintended edit speaks to the other company in TRM's name.
  {
    key: 'edit_retour_client',
    label: 'Traitement des retours client',
    description:
      'Autorise la création, la modification, la suppression et la clôture d’un retour client dans Qualité > Retour client — boutons « Nouveau », « Modifier », « Supprimer » et « Terminer / Réactiver ». La réponse et la résolution saisies ici sont renvoyées sur la fiche de non-conformité d’Ets Malterre : sans ce droit l’écran reste consultable, mais en lecture seule.',
    category: 'Qualité',
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
