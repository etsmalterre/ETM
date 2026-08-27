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
    key: 'dashboard_pieces_a_visiter',
    label: 'Widget « Pièces à visiter »',
    description:
      'Affiche sur le tableau de bord les pièces sorties d’un métier dans les 24 dernières heures et que personne n’a encore pesées : métier, numéro de pièce, fin du tricotage et équipe, la plus ancienne en tête, avec une alerte de couleur au-delà de 2 h puis de 3 h d’attente. Widget de consultation — le visitage lui-même se saisit dans Production > Visitage.',
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
  // ── Écrans dont la clé existait dans le code mais PAS dans ce catalogue ──
  //
  // Clients > Facturation, Clients > Gestion et Fils > Stock ont toujours
  // appelé useHasPermission('edit_factures' | 'edit_client_info' | …) côté
  // web et requirePermission(…) côté API, avec les noms du catalogue d'ETM.
  // Les six clés ci-dessous n'étaient déclarées QUE dans permission-keys.ts,
  // donc :
  //   • Paramètres > Utilisateurs ne rendait aucun interrupteur pour elles ;
  //   • setTrmUserPermissions les filtrait comme inconnues à l'enregistrement ;
  //   • /permissions-trm/me ne les renvoyait jamais.
  // Résultat : les boutons correspondants étaient invisibles pour TOUT
  // utilisateur non-admin, sans recours — c'est ce qui empêchait le poste de
  // visitage de créer un lot de fil. Côté API le garde interrogeait le store
  // d'ETM (voir PermissionScope dans lib/clients-common.ts), donc un droit
  // accordé dans ETM ouvrait la route TRM et réciproquement.
  //
  // Les libellés reprennent ceux d'ETM quand l'action est la même, et en
  // divergent là où la fiche TRM diffère (l'onglet Info de TRM n'a pas de
  // carte Général, et le lot de fil se crée depuis Fils > Stock, pas
  // Fournisseurs > Stock).
  {
    key: 'edit_factures',
    label: 'Édition des factures',
    description:
      'Autorise la création et la modification des factures dans Clients > Facturation : boutons « Nouveau », « Modifier », « Générer les factures », « Supprimer des factures » et « Convertir en facture », ainsi que le code comptable de la proforma. La consultation et l’impression restent ouvertes à tous.',
    category: 'Facturation',
  },
  {
    key: 'edit_client_info',
    label: 'Modifier la fiche client',
    description:
      'Autorise la modification des champs de l’onglet « Info » de Clients > Gestion — facturation (TVA, code comptable, RIB, domiciliation, transporteur), « Attente paiement facture » et commentaire. Sans ce droit, l’onglet reste en lecture seule même en mode édition.',
    category: 'Gestion client',
  },
  {
    key: 'delete_client',
    label: 'Supprimer / archiver un client',
    description:
      'Affiche l’icône corbeille ou archive en mode édition et autorise la suppression d’un client — ou son archivage lorsqu’il a des commandes ou de la marchandise — dans Clients > Gestion.',
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
  // Fils > Stock. Une seule clé pour les trois écritures du grand livre du
  // fil — créer un lot, le diviser, l'archiver avec son bilan de freinte —
  // parce que c'est la même personne qui reçoit le fil et qui solde le lot.
  // Le contrôle de titrage n'en fait PAS partie : il n'écrit que dans
  // controle_titrage et ne touche pas au stock.
  {
    key: 'create_stock_fil',
    label: 'Gérer les lots de fil',
    description:
      'Autorise la création d’un lot dans Fils > Stock (« Nouveau lot »), sa division et son archivage avec le rapport de freinte. Sans ce droit l’écran reste consultable et le contrôle de titrage reste possible, mais le stock ne peut pas être modifié.',
    category: 'Fils',
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
  // Production > Gestion des OF. Read stays open to anyone holding the
  // Production menu — a bonnetier or a visiteuse needs to see the consigne,
  // the queue and the pieces already declared. What this gates is the nine
  // write routes of /of-trm: creating an OF, editing it, its composition and
  // fil incorporé, posting an observation, activating, terminating,
  // re-ranking the queue and deleting. Terminating is in the same key as the
  // rest on purpose: it re-ranks the métier and can flip the next OF active,
  // which is the most consequential button on the screen, not a lesser one.
  {
    key: 'edit_of',
    label: 'Édition des ordres de fabrication',
    description:
      'Autorise la création, la modification, la suppression d’un ordre de fabrication dans Production > Ordres de fabrication, ainsi que « Passer en cours », « Terminer l’OF », la réorganisation de la file d’un métier et l’ajout d’observations. Sans ce droit l’écran reste entièrement consultable, mais en lecture seule.',
    category: 'Production',
  },
  // Production > Visitage. Gates the Valider button and the write route only —
  // consulting the poste (which piece is waiting, which defects the bonnetier
  // declared) stays open, like the rest of the production screens. What this
  // key really guards is the creation of stock: a validation inserts the
  // stock_ecru rolls, converts the piece's defects onto them, traces the event
  // AND decrements the yarn lots. There is no undo.
  {
    key: 'saisie_visitage',
    label: 'Saisir le visitage',
    description:
      'Autorise la validation d’une pièce dans Production > Visitage : création des rouleaux de tombé métier en stock, report des défauts relevés au métier, traçage de l’événement et décrément des lots de fil consommés. Sans ce droit l’écran reste consultable mais le bouton « Valider » est inactif.',
    category: 'Production',
  },
  {
    key: 'saisie_atelier',
    label: 'Saisir au poste de l’atelier',
    description:
      'Autorise l’enregistrement des actions du bonnetier depuis la PWA Atelier (atelier.malterre) : lancement d’un OF, nettoyage, fin de pièce, dernière pièce, fin d’OF, déclaration d’un défaut, interruption et relance. Ces actions écrivent la production réelle — pièces, événements, défauts et l’activation de l’OF suivant sur le métier. Sans ce droit l’app reste consultable mais rien ne s’enregistre.',
    category: 'Production',
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
