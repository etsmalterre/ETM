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
// A child with `cascade: false` is NOT granted by toggling its parent on — it
// is ticked on its own (a sensitive child, e.g. dashboard_notif_superviseur).

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
    key: 'dashboard_commandes_fil',
    label: 'Fils en commande',
    description: 'Affiche le widget « Fils en commande » sur le tableau de bord : les lignes de commande de fil encore attendues, leur état et leur date de livraison prévue.',
    category: 'Tableau de bord',
  },
  {
    key: 'dashboard_notifications',
    label: 'Notifications',
    description:
      'Affiche le widget « Notifications » sur le tableau de bord : les alertes des abonnements auxquels l’utilisateur a souscrit (dossiers qualité à échéance, commandes de fil, stock mini, lots et pièces non affectés, certificats expirés). L’API refuse le flux sans ce droit — les alertes nomment des commandes clients et des niveaux de stock. Chaque abonnement a son sous-droit : il n’est proposé dans « Liste des abonnements » qu’à qui le détient.',
    category: 'Tableau de bord',
  },
  // One sub-permission per subscription of the widget, keyed to its
  // IDabonnement_notif in lib/abonnements.ts (NOTIF_PERMISSIONS) or to an
  // ETM-only subscription in lib/abonnements-etm.ts. The API offers, saves and
  // feeds a subscription only to a holder of its key.
  {
    key: 'dashboard_notif_dossiers_qualite',
    label: 'Dossiers qualité à échéance',
    description: 'Propose l’abonnement « Suivre les dossiers qualité qui arrivent à échéance » dans le widget Notifications. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
  },
  {
    key: 'dashboard_notif_commandes_fil',
    label: 'Commandes de fil à échéance',
    description: 'Propose l’abonnement « Suivre les commandes de fil qui arrivent à échéance » dans le widget Notifications. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
  },
  {
    key: 'dashboard_notif_stock_fil_mini',
    label: 'Stock de fil au minimum',
    description: 'Propose l’abonnement « Notification quand un stock de fil atteint son minimum » dans le widget Notifications. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
  },
  {
    key: 'dashboard_notif_fil_non_affecte',
    label: 'Stock de fil non affecté',
    description: 'Propose l’abonnement « Notification quand un stock de fil n’est pas affecté à une commande » dans le widget Notifications. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
  },
  {
    key: 'dashboard_notif_ecru_sans_fil',
    label: 'Tombé métier sans fil affecté',
    description: 'Propose l’abonnement « Notification quand un stock Tombé de métier n’a pas de fil affecté » dans le widget Notifications. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
  },
  {
    key: 'dashboard_notif_ecru_sans_commande',
    label: 'Tombé métier sans commande',
    description: 'Propose l’abonnement « Notification quand un stock Tombé de métier n’a pas de commande affectée » dans le widget Notifications. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
  },
  {
    key: 'dashboard_notif_certificats_fil',
    label: 'Certificats fournisseur expirés',
    description: 'Propose l’abonnement « Notification lorsque le certificat d’un fournisseur de fil est expiré » dans le widget Notifications. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
  },
  {
    key: 'dashboard_notif_superviseur',
    label: 'Superviseur — points à traiter',
    description: 'Propose l’abonnement « Superviseur — points à traiter » dans le widget Notifications, et autorise « Traité » / « Fausse alerte » depuis le widget. Donnée sensible (le rapport lit les boîtes mail) : cocher « Notifications » ne l’accorde PAS, il se coche à part.',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
    cascade: false,
  },
  {
    key: 'dashboard_notif_factures_sst',
    label: 'Factures sous-traitants — écarts',
    description: 'Propose l’abonnement « Factures sous-traitants — écarts » dans le widget Notifications : une carte par facture d’ennoblisseur où l’agent « Factures Ennoblisseur » a trouvé un écart, à traiter dans Sous-traitants › Factures. Sous-droit de « Notifications ».',
    category: 'Tableau de bord',
    parent: 'dashboard_notifications',
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
  // `dashboard_stock_valorisation` was removed on 2026-09-28: its widget has been
  // off the dashboard since 2026-08-26 and the right showed nothing. Its endpoint
  // `GET /rapports/stock/valorisation` is admin-only meanwhile — bring the key
  // back with the widget (components/dashboard/registry.tsx).
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
    key: 'gestion_acces_espace_client',
    label: 'Accès espace client',
    description:
      'Autorise à donner ou retirer l’accès à client.etsmalterre.fr à un contact, dans l’onglet « Contacts » de Clients > Gestion. L’ERP est la seule source : l’espace client ne crée ni ne supprime aucun compte.',
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
  // LIVA #1209: the Simone Pérèle code list (Clients › Gestion › Étiquettes)
  // without the whole client sheet. edit_client_info keeps covering it too.
  {
    key: 'gestion_codes_sp',
    label: 'Codes Simone Pérèle',
    description:
      'Autorise l’ajout, la modification et la suppression des coloris de l’onglet « Étiquettes » de Clients > Gestion (codes EAN des étiquettes Simone Pérèle), sans donner accès au reste de la fiche client. Le droit « Modifier la fiche client » l’inclut déjà.',
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
  // LIVA #1245: correcting poids / métrage departs from the dyer's BL, so it
  // is ticked person by person (cascade: false) and only on rolls received
  // 60+ days ago, every change journaled (lib/stock-fini-mesures.ts).
  {
    key: 'edit_stock_fini_mesures',
    label: 'Poids & métrage',
    description:
      'Autorise la correction du poids et du métrage d’un rouleau en stock reçu depuis plus de 60 jours (inventaire). Chaque correction est journalisée sur le rouleau. Cocher « Éditer un rouleau » ne l’accorde PAS, il se coche à part.',
    category: 'Finis',
    parent: 'edit_stock_fini',
    cascade: false,
  },
  // « Ml non facturés » on a roll (decision Vincent 2026-10-06,
  // lib/ml-non-factures.ts): a commercial gesture, not a measurement, so its
  // own key, closed by default, checked on every road that writes it (sst
  // reception, Clients › Commandes, Finis › Stock).
  {
    key: 'edit_ml_non_factures',
    label: 'Ml non facturés',
    description:
      'Autorise la saisie des mètres d’un rouleau fini qui ne seront pas facturés au client (taches, défaut…) avec leur motif — à la réception sous-traitant, depuis une commande client ou dans Finis > Stock. Le métrage du rouleau reste le métrage réel ; la facture déduit ces mètres et l’imprime sous la ligne. Refusé sur un rouleau déjà facturé. Chaque changement est journalisé.',
    category: 'Finis',
  },
  {
    key: 'surteindre_stock_fini',
    label: 'Surteindre des rouleaux finis',
    description:
      'Autorise la surteinture : supprime des rouleaux finis et renvoie leurs tombés de métier en teinture dans Finis > Stock.',
    category: 'Finis',
  },
  // Deleting a dyed coloris that nothing uses (an étude accepted on the wrong
  // sample) — LIVA #1254, lib/coloris-fini-suppression.ts.
  // Closed by default; a used coloris is refused whoever asks.
  {
    key: 'delete_coloris_fini',
    label: 'Supprimer un coloris',
    description:
      'Autorise la suppression d’un coloris teint dans Finis › Références › Coloris, uniquement s’il n’est utilisé nulle part (aucun rouleau, aucune ligne de commande, de devis ou de sous-traitance, aucune désignation ou étude). Un coloris utilisé reste, quel que soit le droit.',
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
  // Paramètres > Outils has NO key: who sees the screen is the Écrans axis
  // (menu `screen_settings`, lib/screen-keys.ts), and its routes check that
  // grant server-side. A key only earns its place when several users see the
  // same screen with different rights.
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
  // Agents IA — reading the screens needs only the menu (screen_agents_ia);
  // changing an agent or an automate (mode, prompt version, relaunch, feedback)
  // needs this key, checked server-side on every write of /api/agents-ia and
  // /api/automates.
  {
    key: 'edit_agents_ia',
    label: 'Piloter les agents IA et les automates',
    description:
      'Autorise, dans Agents IA, à mettre un agent ou un automate en service, en essai ou à l’arrêt, à publier ou réactiver une version du prompt d’un agent, à relancer une exécution, à retraiter une exécution d’agent et à écrire les retours sur un automate. Sans ce droit les écrans sont en lecture seule.',
    category: 'Agents IA',
  },
  // Scoring is separate from piloting (decision 2026-09-23): the people who
  // read the agents' output every day score it without being able to change
  // an agent. An « échec » on BL Ennoblisseur removes the pre-filled pieces —
  // a real HFSQL write, hence a right of its own.
  {
    key: 'evaluer_agents_ia',
    label: 'Évaluer les agents IA',
    description:
      'Autorise à traiter les points du Superviseur depuis le widget Notifications sans l’abonnement du widget. Les agents IA ne se notent jamais dans Agents IA : chaque retour à Tricobot (juste, ou corrigé avec un pourquoi) se donne là où le travail se fait — réception des rouleaux, factures sous-traitants, widget Notifications.',
    category: 'Agents IA',
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
