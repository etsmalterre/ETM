// Catalog of permission keys gated by the per-user permissions feature.
// Adding a new gated action requires three edits:
//   1. Append a new entry to PERMISSION_KEYS below
//   2. Gate the corresponding API route via userHasPermission(...)
//   3. Hide the corresponding UI element via useHasPermission('...')
//
// Keys are flat snake_case strings — they're stored verbatim in the
// permissions JSON file and sent on the wire, so don't rename without a
// migration.
//
// Sub-permissions: an entry may carry `parent: '<key>'` — the admin UI then
// renders it as an indented child toggle that only appears while the parent
// is granted (toggling the parent on grants every child; off removes them).
// The API must check parent AND child on gated routes (children are stored
// as plain flat keys — nothing enforces the hierarchy at the storage layer).

export const PERMISSION_KEYS = [
  // Tableau de bord — one key per dashboard widget. Granting shows the widget
  // for that user; admins always see every widget. Read by useHasPermission in
  // Dashboard.tsx. Kept first so the "Tableau de bord" section renders at the
  // top of Paramètres > Utilisateurs.
  {
    key: 'dashboard_fil_etat',
    label: 'État des stocks de fil',
    description: 'Affiche le widget « État des stocks de fil » sur le tableau de bord.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_notifications',
    label: 'Notifications',
    description:
      'Affiche le widget « Notifications » sur le tableau de bord : les alertes des abonnements auxquels l’utilisateur a souscrit (dossiers qualité à échéance, commandes de fil, stock mini, lots et pièces non affectés, certificats expirés). L’API refuse le flux sans ce droit — les alertes nomment des commandes clients et des niveaux de stock.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_utilisation_fil',
    label: 'Utilisation fil',
    description:
      'Affiche le widget « Utilisation fil » sur le tableau de bord : pour une référence de fil (et éventuellement un de ses coloris), la liste des références écru qui l’utilisent dans leur composition.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_commandes_jour',
    label: 'Commandes du jour',
    description:
      'Affiche le widget « Commandes du jour » sur le tableau de bord : les commandes clients saisies dans la journée et le chiffre d’affaires qu’elles représentent. Donnée confidentielle — l’API refuse les montants sans ce droit, même à un utilisateur qui devinerait l’adresse.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_suivi_piece',
    label: 'Suivi pièce',
    description:
      'Affiche le widget « Suivi pièce » sur le tableau de bord : à partir d’un numéro de pièce (écru ou fini), retrace son parcours — pièce écru, commandes source et affectée, transferts entre magasins, puis les rouleaux finis qui en sont issus.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_la_gentle',
    label: 'Stock La Gentle',
    description: 'Affiche le widget « Stock La Gentle » (export Excel) sur le tableau de bord.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_ca',
    label: 'Chiffre d’affaires',
    description:
      'Affiche le widget « Chiffre d’affaires » sur le tableau de bord : comparatif du CA par client entre deux années, classement, et détail mensuel. Donnée confidentielle — l’API refuse les chiffres sans ce droit, même à un utilisateur qui devinerait l’adresse.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_evolution_ca',
    label: 'Évolution du CA',
    description:
      'Affiche le widget « Évolution du CA » sur le tableau de bord : le chiffre d’affaires annuel sur plusieurs exercices. Sous-droit de « Chiffre d’affaires » : même donnée confidentielle et même contrôle API, mais l’affichage du widget se règle séparément.',
    category: 'Tableau de bord',
    parent: 'dashboard_ca',
  },
  {
    key: 'dashboard_finance',
    label: 'Analyse financière',
    description:
      'Affiche le widget « Analyse financière » sur le tableau de bord : évolution du CA, de la marge brute et des charges fixes / variables sur l’année, et CA, marge brute et EBE du dernier relevé comptable. Donnée confidentielle — l’API refuse les chiffres sans ce droit. Indépendant de « Consulter le rapport finance », qui donne le détail compte par compte.',
    category: 'Tableau de bord',
  },
  {
    // ⚠️ Le widget a été retiré du tableau de bord le 2026-08-26 (voir le
    // commentaire dans `components/dashboard/registry.tsx`). La clé RESTE : elle
    // garde toujours l'endpoint `GET /rapports/stock/valorisation`, qui sert un
    // poste de bilan. Le libellé dit explicitement qu'il n'y a rien à afficher,
    // sinon un admin coche la case et se demande pourquoi rien n'apparaît.
    key: 'dashboard_stock_valorisation',
    label: 'Valorisation du stock (widget retiré)',
    description:
      'Le widget « Valorisation du stock » n’est plus affiché sur le tableau de bord depuis le 26/08/2026 — cocher ce droit ne fait donc apparaître aucune carte. Il donne encore accès à l’endpoint de valorisation (valeur d’achat et valeur dépréciée du stock, taux de provision, détail par type), donnée confidentielle car c’est un poste de bilan. À rétablir le jour où le widget revient.',
    category: 'Tableau de bord',
  },
  // Prospects — ticket #1112. Both keys are closed by default and no
  // grandfathering script was run (user decision, 2026-09-02): the screen is
  // read-only for everyone until an admin grants the keys — same rollout as
  // edit_etudes_coloris (#1092). Before #1112 the prospects router had no
  // write gate at all.
  {
    key: 'edit_prospects',
    label: 'Édition des demandes',
    description:
      'Autorise la création, la modification et la suppression des demandes dans Prospects > Demandes, le changement de statut et la conversion en client. Sans ce droit, l’écran est en lecture seule.',
    category: 'Prospects',
  },
  {
    key: 'devis_prospect',
    label: 'Devis prospect',
    description:
      'Autorise la création d’un devis directement depuis une demande de Prospects > Demandes, ainsi que la modification, la suppression et l’envoi par email des devis prospect dans Clients > Devis. La consultation et l’impression des devis prospect restent ouvertes à tous.',
    category: 'Prospects',
  },
  // Commandes client — kept right after the dashboard keys so the section
  // renders directly below "Tableau de bord" in Paramètres > Utilisateurs.
  {
    key: 'edit_commandes_client',
    label: 'Édition des commandes client',
    description:
      'Autorise la création, la modification et la suppression des commandes et de leurs lignes dans Clients > Commandes : boutons « Nouvelle », « Modifier » et « Supprimer ».',
    category: 'Commandes client',
  },
  {
    key: 'cloture_commande_client',
    label: 'Clôturer / rouvrir une commande',
    description:
      'Affiche le bouton « Clôturer » / « Rouvrir » sur la pastille d’état et autorise le changement d’état d’une commande dans Clients > Commandes.',
    category: 'Commandes client',
  },
  {
    key: 'deverrouiller_tarifs',
    label: 'Déverrouiller les tarifs',
    description:
      'Affiche le cadenas « Déverrouiller le prix » dans le dialogue de ligne de commande et autorise la saisie manuelle d’un prix à la place du tarif calculé dans Clients > Commandes.',
    category: 'Commandes client',
  },
  {
    key: 'donation_commande_client',
    label: 'Marquer une commande comme donation',
    description:
      'Affiche l’interrupteur « Donation » et autorise à marquer une commande comme donation dans Clients > Commandes.',
    category: 'Commandes client',
  },
  {
    key: 'proforma_commande_client',
    label: 'Facture proforma',
    description:
      'Affiche l’entrée « Facture proforma » dans les menus « Imprimer » et « Envoyer un email » de Clients > Commandes et autorise l’impression et l’envoi de la proforma. Sans ce droit, les deux boutons agissent directement sur la confirmation de commande.',
    category: 'Commandes client',
  },
  {
    key: 'edit_observations_rouleaux',
    label: 'Modifier les observations des rouleaux',
    description:
      'Affiche le bouton « Modifier les observations » dans l’onglet Affectation d’une ligne et autorise la modification des observations des rouleaux dans Clients > Commandes.',
    category: 'Commandes client',
  },
  // Facturation — rendered between "Commandes client" and "Gestion client" in
  // Paramètres > Utilisateurs (sections follow catalog insertion order).
  {
    key: 'edit_factures',
    label: 'Édition des factures',
    description:
      'Autorise la création et la modification des factures dans Clients > Facturation : boutons « Nouveau », « Modifier », « Générer les factures », « Supprimer des factures » et « Convertir en facture ».',
    category: 'Facturation',
  },
  // Gestion client — rendered directly below "Facturation" in
  // Paramètres > Utilisateurs (sections follow catalog insertion order).
  {
    key: 'delete_client',
    label: 'Supprimer / archiver un client',
    description:
      'Affiche l’icône corbeille ou archive en mode édition et autorise la suppression d’un client — ou son archivage lorsqu’il a des commandes ou de la marchandise — dans Clients > Gestion.',
    category: 'Gestion client',
  },
  {
    key: 'edit_client_info',
    label: 'Modifier la fiche client',
    description:
      'Autorise la modification des champs de l’onglet « Info » de Clients > Gestion — cartes Général (dont le bouton « Client interne »), Facturation et Commentaire. Sans ce droit, l’onglet reste en lecture seule même en mode édition.',
    category: 'Gestion client',
  },
  {
    key: 'edit_client_rapport_qualite',
    label: 'Inclure rapports contrôle',
    description:
      'Autorise le seul bouton « Inclure rapports contrôle (exp.) » de l’onglet « Info » de Clients > Gestion. Indépendant de « Modifier la fiche client » — peut être accordé seul.',
    category: 'Gestion client',
  },
  {
    key: 'edit_client_commercial',
    label: 'Suivi commercial',
    description:
      'Autorise la modification de l’onglet « Commercial » de Clients > Gestion : date de dernier contact et journal commercial.',
    category: 'Gestion client',
  },
  {
    key: 'crud_client_contacts',
    label: 'Gestion des contacts',
    description:
      'Autorise la création, la modification et la suppression des contacts dans l’onglet « Contacts » de Clients > Gestion.',
    category: 'Gestion client',
  },
  {
    key: 'crud_client_adresses',
    label: 'Gestion des adresses',
    description:
      'Autorise la création, la modification et la suppression des adresses dans l’onglet « Adresses » de Clients > Gestion.',
    category: 'Gestion client',
  },
  {
    key: 'gestion_tarifs',
    label: 'Gestion des tarifs',
    description:
      'Autorise la modification du mode de tarification d’une référence client — standard, coefficient fixe ou contrat — en mode édition dans Clients > Gestion.',
    category: 'Gestion client',
  },
  {
    key: 'gestion_references',
    label: 'Gestion des références',
    description:
      'Autorise la création et la modification des références client et de leurs coloris — dialogue « Référence client » et bouton « Ajouter une référence » — dans Clients > Gestion.',
    category: 'Gestion client',
  },
  {
    key: 'gestion_coloris',
    label: 'Gestion des coloris',
    description:
      'Autorise l’ajout d’un coloris à une référence client existante — bouton « Ajouter un coloris » du tiroir Coloris de Clients > Gestion — sans donner accès aux références ni aux tarifs. Le nouveau coloris reprend les conditions déjà en place ; l’ajout est refusé si les coloris existants n’ont pas tous le tarif standard avec les mêmes tranches.',
    category: 'Gestion client',
  },
  {
    key: 'retour_marchandise',
    label: 'Retour marchandise en stock',
    description:
      'Autorise la sélection de pièces expédiées et leur remise en stock, avec observation de récupération, dans l’onglet « Marchandise expédiée » de Clients > Gestion.',
    category: 'Gestion client',
  },
  // Transferts — one key per kind (Rouleaux / Fils) so a user can be allowed
  // to move rolls without touching yarn, and vice-versa. Each key covers the
  // whole écran: création, modification de l'en-tête, ajout / retrait des
  // pièces et suppression du bon. Kept right before "Fournisseurs" so both
  // sections render above it in Paramètres > Utilisateurs (sections follow
  // catalog insertion order).
  {
    key: 'gestion_transfert_rouleaux',
    label: 'Gestion des bons de transfert',
    description:
      'Autorise la création, la modification, la suppression des bons de transfert ainsi que l’ajout et le retrait des rouleaux dans Transferts > Rouleaux : boutons « Nouveau », « Modifier », « Supprimer » et « Ajouter depuis le stock ». Sans ce droit, l’écran est en lecture seule.',
    category: 'Transferts rouleaux',
  },
  {
    key: 'gestion_transfert_fils',
    label: 'Gestion des bons de transfert',
    description:
      'Autorise la création, la modification, la suppression des bons de transfert ainsi que l’ajout et le retrait des lots de fil dans Transferts > Fils : boutons « Nouveau », « Modifier », « Supprimer » et « Ajouter depuis le stock ». Sans ce droit, l’écran est en lecture seule.',
    category: 'Transferts fils',
  },
  {
    key: 'create_stock_fil',
    label: 'Créer un lot de fil',
    description: 'Autorise la création de nouvelles entrées dans Fournisseurs > Stock.',
    category: 'Fournisseurs',
  },
  {
    key: 'cut_stock_fini',
    label: 'Couper un rouleau',
    description: 'Autorise la découpe d’un rouleau en plusieurs dans Finis > Stock.',
    category: 'Finis',
  },
  {
    key: 'create_stock_fini',
    label: 'Créer un rouleau',
    description: 'Affiche le bouton « Nouveau » et autorise la création de rouleaux dans Finis > Stock.',
    category: 'Finis',
  },
  {
    key: 'edit_stock_fini',
    label: 'Éditer un rouleau',
    description: 'Affiche le bouton « Modifier » et autorise la modification d’un rouleau dans Finis > Stock.',
    category: 'Finis',
  },
  {
    key: 'edit_stock_fini_stockage',
    label: 'Stockage',
    description: 'Autorise la modification de l’emplacement, du conteneur et de la date de pointage d’un rouleau.',
    category: 'Finis',
    parent: 'edit_stock_fini',
  },
  {
    key: 'edit_stock_fini_etat',
    label: 'État',
    description: 'Autorise la modification de l’état d’un rouleau (2ᵉ choix, statut).',
    category: 'Finis',
    parent: 'edit_stock_fini',
  },
  {
    key: 'edit_stock_fini_affectation',
    label: 'Affectation',
    description: 'Autorise la modification de l’affectation d’un rouleau (donation, déstockage).',
    category: 'Finis',
    parent: 'edit_stock_fini',
  },
  {
    key: 'edit_stock_fini_notes',
    label: 'Notes',
    description: 'Autorise la modification des observations et de l’observation sous-traitant d’un rouleau.',
    category: 'Finis',
    parent: 'edit_stock_fini',
  },
  {
    key: 'surteindre_stock_fini',
    label: 'Surteindre des rouleaux finis',
    description:
      'Autorise la surteinture : supprime des rouleaux finis et renvoie leurs tombés de métier en teinture dans Finis > Stock.',
    category: 'Finis',
  },
  // Études coloris — ONE key covering every write on the screen (étude,
  // statut, soumissions, réponse du sous-traitant, envois email). Ticket #1092.
  // The screen had no write gate at all before this, so the key is closed by
  // default and nobody edits until an admin grants it — deliberate: no
  // grandfathering script was run (user decision, 2026-08-28).
  {
    key: 'edit_etudes_coloris',
    label: 'Édition des études coloris',
    description:
      'Autorise la création, la modification et la suppression des études et de leurs soumissions dans Finis > Études coloris, le changement de statut, l’enregistrement de la réponse du sous-traitant (Accepter / Refuser) et l’envoi par email. Sans ce droit, l’écran est en lecture seule — l’impression et le téléchargement des PDF restent accessibles à tous.',
    category: 'Finis',
  },
  {
    key: 'create_stock_ecru',
    label: 'Créer un rouleau écru',
    description: 'Affiche le bouton « Nouveau » et autorise la création de rouleaux dans Tombé Métier > Stock.',
    category: 'Tombé Métier',
  },
  {
    key: 'edit_stock_ecru',
    label: 'Édition rouleau(x)',
    description: 'Affiche le bouton « Modifier » (détail) et « Édition groupée » (mode édition), et autorise la modification d’un ou plusieurs rouleaux dans Tombé Métier > Stock.',
    category: 'Tombé Métier',
  },
  {
    key: 'cut_stock_ecru',
    label: 'Couper un rouleau écru',
    description: 'Autorise la découpe d’un rouleau en plusieurs dans Tombé Métier > Stock.',
    category: 'Tombé Métier',
  },
  // Rapports — the finance report exposes the full accounting balance
  // (including payroll accounts), so it is gated rather than open to every
  // user like the other rapports. Without the key the submenu entry is
  // hidden, the route redirects, and the API answers 403.
  {
    key: 'view_rapport_finance',
    label: 'Consulter le rapport finance',
    description:
      'Affiche l’entrée « Finance » dans le menu Rapports et autorise la consultation de la balance comptable (charges fixes et variables, montants annuels et comparaison N-1). Ces données incluent les comptes de personnel.',
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
  {
    key: 'dashboard_charges',
    label: 'Widget « Charges » du tableau de bord',
    description:
      'Affiche le widget « Charges » sur le tableau de bord : total des charges fixes et variables du dernier relevé comptable. Sous-droit de « Consulter le rapport finance » car le widget interroge le même endpoint : il ne peut donc être accordé qu’à un utilisateur qui a déjà accès au rapport.',
    category: 'Rapports',
    parent: 'view_rapport_finance',
  },
  {
    key: 'create_stock_divers',
    label: 'Créer une ligne de stock divers',
    description:
      'Affiche le bouton « Nouveau » et autorise la création de lignes de stock dans Divers > Stock.',
    category: 'Divers',
  },
  {
    key: 'edit_stock_divers',
    label: 'Modifier / supprimer une ligne de stock divers',
    description:
      'Affiche le bouton « Modifier » du panneau de détail et autorise la modification de la quantité ainsi que la suppression d’une ligne dans Divers > Stock.',
    category: 'Divers',
  },
  {
    key: 'responsable_qualite',
    label: 'Responsable qualité',
    description:
      'Autorise la validation / reprise des lots et la saisie des contrôles dans Qualité > Suivi des lots, ainsi que la création et la modification des dossiers de non-conformité dans Qualité > Dossiers. Sans cette permission, ces écrans sont en lecture seule.',
    category: 'Qualité',
  },
] as const

export type PermissionKey = (typeof PERMISSION_KEYS)[number]['key']

/** Set of all known keys for fast membership checks during validation. */
export const KNOWN_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  PERMISSION_KEYS.map((p) => p.key),
)

export function isKnownPermissionKey(k: string): k is PermissionKey {
  return KNOWN_PERMISSION_KEYS.has(k)
}
