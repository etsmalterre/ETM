# Legacy → New Navigation Mapping

Maps legacy WinDev windows to new MPS_NG routes. Use this to identify which legacy screens to reference when building each new page.

## Route Mapping

### Tableau de bord (`/`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Accueil_MPS.wdw | Main home screen |
| FI_Dashboard_ETM.wdw | ETM dashboard |
| FI_Dashboard_TRM.wdw | Transport dashboard |
| FI_Dashboard_Confection.wdw | Assembly dashboard |

### Clients (`/clients`)

#### Gestion (`/clients/gestion`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Gestion_client.wdw | Client CRUD |
| FI_Gestion_Client.wdw | Client detail panel |
| FEN_Select_Client.wdw | Client picker |
| FEN_Gestion_adresse.wdw | Address management |
| FEN_Gestion_contact.wdw | Contact management |
| FEN_Gestion_Ref_Client.wdw | Client references |
| FEN_Prospection.wdw | Prospect management |

#### Commandes (`/clients/commandes`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Gestion_commande_client_ETM.wdw | Order management |
| FEN_Nouvelle_commande_client_ETM.wdw | New order form |
| FEN_Gestion_d_une_référence_de_commande_client.wdw | Order line detail |
| FI_Commande_Client_ETMV2.wdw | Order panel |
| FEN_Recherche_commandes_clients.wdw | Order search |
| FEN_Etats_commandes_clients.wdw | Order statuses |

#### Devis (`/clients/devis`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_devis_prospect.wdw | Quotation form |
| FEN_Gestion_ligne_devis_etm.wdw | Quote line detail |
| FI_Devis_ETM.wdw | Quote panel |
| FEN_Soumission.wdw | Submission |

#### Facturation (`/clients/facturation`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Factures.wdw | Invoice list |
| FEN_Détail_facture.wdw | Invoice detail |
| FEN_Factures_provisoires.wdw | Provisional invoices |
| FI_Facturation_ETM.wdw | Invoicing panel |
| FI_Attente_Paiement.wdw | Pending payments |

### Fournisseurs (`/fournisseurs`)

#### Gestion (`/fournisseurs/gestion`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Gestion_des_fournisseurs.wdw | Supplier list |
| FEN_Gestion_fournisseur.wdw | Supplier detail |
| FI_Fournisseurs.wdw | Supplier panel |

#### Commandes (`/fournisseurs/commandes`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Commandes_de_fils.wdw | Yarn order list |
| FEN_Gestion_d_une_commande_de_fil.wdw | Yarn order detail |
| FEN_Achat_Fil.wdw | Yarn purchasing |
| FEN_Offre_Fil.wdw | Yarn offers |

### Sous-traitants (`/sous-traitants`)

#### Gestion (`/sous-traitants/gestion`)
| Legacy Window | Purpose |
|--------------|---------|
| FI_Gestion_SST.wdw | SST management |
| FEN_Choix_SST.wdw | SST picker |

#### Commandes (`/sous-traitants/commandes`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Gestion_commande_sous_traitant.wdw | SST order management |
| FEN_Commande_SSTV2.wdw | SST order V2 |
| FI_Commande_SSTV2.wdw | SST order panel |

### Production (`/production`)

#### Tricotage (`/production/tricotage`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Tricoter.wdw | Knitting screen |
| FEN_Gestion_des_OF.wdw | Work order list |
| FEN_Gestion_d_un_OF.wdw | Work order detail |
| FEN_Lancement_OF.wdw | Launch work order |
| FEN_Gestion_des_machines.wdw | Machine list |
| FEN_Gestion_machine.wdw | Machine detail |
| FI_Planning_Atelier.wdw | Workshop planning |
| FI_Planning_Prod.wdw | Production planning |

#### Teinture (`/production/teinture`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Traitements.wdw | Treatment list |
| FEN_Gestion_d_un_traitement.wdw | Treatment detail |
| FEN_Ennoblir.wdw | Finishing |
| FEN_Surteinture.wdw | Over-dyeing |
| FEN_Controle_Titrage.wdw | Titration control |

#### Confection (`/production/confection`)
| Legacy Window | Purpose |
|--------------|---------|
| FI_Commande_Confection.wdw | Assembly orders |
| FI_OF_Confection.wdw | Assembly work orders |
| FEN_Assemblage.wdw | Assembly screen |
| FEN_Coupe_Fini.wdw | Finished cutting |

#### Contrôle qualité (`/production/controle-qualite`)
| Legacy Window | Purpose |
|--------------|---------|
| FI_Dossier_QualitéV2.wdw | Quality dossier |
| FI_Action_Qualité.wdw | Quality actions |
| FI_Saisie_Defaut.wdw | Defect entry |
| FEN_liste_defauts.wdw | Defect list |
| FI_Visitage.wdw | Inspection |
| FEN_Ajout_retour_client.wdw | Client returns |

### Stock (`/stock`)

#### Matières premières (`/stock/matieres-premieres`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Stock_fil.wdw | Yarn stock |
| FEN_Stock_écru.wdw | Raw fabric stock |
| FEN_Etat_stock_fil.wdw | Yarn stock status |
| FEN_Stock_Mini.wdw | Minimum stock levels |
| FEN_Gestion_lot_fil.wdw | Yarn lot management |

#### Produits finis (`/stock/produits-finis`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Stock_fini.wdw | Finished stock |
| FEN_Gestion_pièce_fini.wdw | Finished piece mgmt |
| FEN_Stock_Divers.wdw | Misc stock |

#### Mouvements (`/stock/mouvements`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Suivi_lots.wdw | Lot tracking |
| FEN_Transfert_Lot.wdw | Lot transfers |
| FEN_Bons_de_transfert.wdw | Transfer slips |
| FEN_Utilisation_Lot.wdw | Lot usage |

### Produits (`/produits`)

#### Références (`/produits/references`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Gestion_des_références_d_écrus.wdw | Raw fabric refs |
| FEN_Gestion_des_références_de_fil.wdw | Yarn refs |
| FI_Ref_Fini.wdw | Finished product refs |
| FI_Ref_Article.wdw | Article refs |
| FI_Ref_Divers.wdw | Misc refs — **implemented at `/divers/references`** |

#### Coloris (`/produits/coloris`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Gestion_Coloris.wdw | Color management |
| FEN_Gestion_colori_référence_fini.wdw | Finished product colors |
| FEN_Etudes_coloris.wdw | Color studies |
| FEN_Coloris_Site.wdw | Website colors |

### Transport (`/transport`)

#### Expéditions (`/transport/expeditions`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Expéditions.wdw | Shipment list |
| FEN_Gestion_expédition_ETMV2.wdw | Shipment detail |
| FEN_Affectation_expédition_ETM.wdw | Shipment assignment |
| FEN_Expedition_Groupé.wdw | Grouped shipments |

#### Livraisons (`/transport/livraisons`)
| Legacy Window | Purpose |
|--------------|---------|
| FEN_Validation_BL.wdw | Delivery note validation |
| FI_Suivi_Transport.wdw | Transport tracking |
| FI_Suivi_pièce.wdw | Piece tracking |

### Paramètres (`/parametres`)
| Legacy Window | Purpose |
|--------------|---------|
| FI_Entreprise.wdw | Enterprise settings |
| FEN_Gestion_des_cages.wdw | Storage cages |
| FEN_Gestion_des_codes_comptables.wdw | Accounting codes |
| FEN_Gestion_des_TVA.wdw | VAT rates |
| FEN_Gestion_des_modes_de_paiement.wdw | Payment methods |
| FEN_Gestion_Materiel.wdw | Equipment |
| FI_Maintenance.wdw | Maintenance |
| FEN_Contrats.wdw | Contracts |
