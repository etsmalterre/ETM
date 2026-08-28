# Worktree merge log

Newest first. `/feature-complete` prepends one entry per screen it lands on `master`, so
other worktrees see what changed when they rebase. Format:

```
## <date> — feat/<name>
<one-paragraph note: what the screen does / what changed>
```

<!-- entries below -->

## 2026-08-28 — feat/trs-erp (API de Production › TRS, l'écran ERP de FI_TRS)
`GET /api/trs/equipe?debut=YYYYMMDDHHMMSS` (guard `view_trs`, nouvelle clé Production fermée par
défaut) rend une équipe complète, n'importe laquelle : les quatre KPI de `MAJAffichageAtelier`
(pièces finies au poids nominal, rouleaux pesés, second choix en %, non visitées à la fin
d'équipe), la timeline par métier (segments de la même marche que `calculerTrs`, événements
pièce, lancement / fin d'OF, `detail` des déductibles pour le ⓘ), les quatre listes de pièces
avec les cartes d'événements de toutes (`evenement_piece` ∪ `defaut_qualite` en « Défaut », deux
requêtes batchées) et les bonnetiers pointés (`pointage`, pas le planning — régleurs compris).
Chargeurs partagés avec `/atelier` dans `lib/trs-equipe-trm.ts` : états initiaux lus en une
requête (48 h avant l'équipe) puis cache LRU par équipe, OF et événements bornés à l'équipe, IN
chunkés ; équipes passées cachées 10 min. Spec récupérée dans le cache de compilation de
`FI_TRS` (20 requêtes, libellés, contrôles) + `HorairesEquipeEnCours` verbatim. Lib : 38 tests ;
sonde `probe-trs-equipe-trm.ts` (à rejouer sur la prod contre la capture du 28/08 13 h).

## 2026-08-28 — feat/trs (API half of the TRS tablet's « arrêts / pièce »)
`GET /api/trs/atelier` now returns `arretsParPiece` / `arretsPieces` per métier: the legacy
tablet's own `NombreArrets` (recovered from the WinDev compile cache — per piece, machine
stops inside the piece minus the events declared on it), averaged over the last 3 finished
pieces of the active OF (`ARRETS_PIECES`, `lib/trs-trm.ts` § Arrêts par pièce, 4 tests).
Computed once per finished piece (cached per OF on the ids of its last pieces), one narrow
`piece_production` read per poll. The FI_TRS shift count the pill used to show survives as
`arretsEquipe` (not displayed). No faux-arrêts filter, like the tablet.

## 2026-08-28 — feat/visitage (verrou de POST /valider)
Correctif de l'incident du 2026-08-28 14:35:38 : deux `POST /visitage-trm/valider` identiques
partis du poste dans la même seconde ont tous deux passé la garde « pièce déjà visitée » (un
COUNT lu avant la première écriture) et produit quatre rouleaux pour une coupe en deux, plus deux
lignes par clé primaire dans `evenement_piece` (MAX+1 sans index unique). `lib/serial-lock.ts`
(mutex FIFO, testé) sérialise désormais le handler, globalement — les PK MAX+1 sont partagées entre
pièces. Le second appel attend puis 409 `piece_deja_visitee`. `check-visitage-trm.ts` vérifie que
trois plans concurrents répondent tous (un verrou qui ne se relâche pas gèlerait chaque poste).
Données de prod réparées à la main le jour même. Le verrou côté web est dans TRM (même branche).

## 2026-08-28 — feat/trs
L'API de la tablette murale TRS de l'atelier (`TRM/apps/trs`, hôte `trs.malterre`) :
`GET /api/trs/atelier` rend l'état de chaque métier vivant sur l'équipe en cours — marche/arrêt et
depuis quand, la vitesse mesurée, le TRS de l'équipe, les arrêts — plus le TRS du parc et l'âge du
dernier événement. Le calcul est la procédure timeline de `FI_TRS` (fournie verbatim par Vincent),
pur et testé dans `lib/trs-trm.ts` (18 tests) : temps en marche / (temps de production − arrêts
déductibles), avec trois deltas assumés (union des fenêtres d'OF, état initial pris avant l'équipe,
tout arrêt compté). Lecture seule, sans garde ni identité. Sonde `scripts/probe-trs-trm.ts`.
`TRM_PWA_PORTS` (5176/5177) rejoint le CORS dev des worktrees.

## 2026-08-28 — feat/debug
Tickets #1098 et #1099 (Clients › Commandes, modale « Expédition groupée » des commandes divers).
**#1098 « il manque la ligne de bleu / 20 mètres » n'était pas une ligne manquante** : `SearchableCombobox`
et `PopoverSelect` ancraient leur liste portalisée à `top: trigger.bottom` avec un `max-h-64` fixe, sans
retournement ni bornage — une liste ouverte en bas de page se peignait donc hors écran, options rendues mais
inatteignables. Bug **applicatif**, pas propre à cet écran : nouveau `placePopover()` partagé (retourne
au-dessus s'il y a plus de place, borne `maxHeight` à l'espace réellement disponible, borne aussi `left`) ;
toutes les listes déroulantes de l'app en profitent.
**#1099** : la saisie article par article via combobox est remplacée par un **mode édition par carton** —
bouton « Modifier le contenu », tableau de tous les articles divers de la commande avec quantité éditable,
filtre et bouton « Remplir », enregistré en un seul `PUT /expeditions/divers/lignes/:id/contenu` (writer
extrait en `setDiversCartonContenu()` pour que la garde exerce le vrai code plutôt qu'une copie). Forme reprise
du legacy `FEN_Expedition_Groupé`, récupéré dans le cache de compilation WinDev (`.wcw` → le SQL de
`TABLE_RefExpedie`, `.wbw` → l'inventaire des champs).
Contrat clé sur le **combo** (ref × variation1 × variation2, l'unité que l'utilisateur lit et que la facture
regroupe) : le tableau unit les lignes de commande **et** les articles déjà présents dans le carton (61 des
1 589 articles de cartons rattachés à une commande ne correspondent à aucune ligne — invisibles et donc
incorrigeables sans cette union) ; les combos portés par deux lignes sont sommés (7 commandes) ; un total
inchangé n'écrit rien, ce qui protège l'unique carton détenant deux lignes pour un même combo.
« Reste » remplit la ligne, jamais « Cmdé » : 1 443 des 1 770 combos (81,5 %) sont déjà expédiés en tout ou
partie, donc remplir depuis la quantité commandée double-expédierait la majorité des lignes. Reste et Stock se
recalculent pendant la frappe et affichent l'état **après** enregistrement.
Corrigé au passage : le seuil de dépassement de stock comparait la quantité saisie au stock stocké, qui exclut
déjà le contenu courant du carton (`stock_divers` est décrémenté à l'écriture) — un réenregistrement à
l'identique passait toute la colonne en ambre. La base de comparaison est désormais `stock + contenu du
carton`. Stock et Reste restent des avertissements, jamais des blocages (584 combos n'ont aucune ligne
`stock_divers`).
Habillage §18.D (bandeau navy + tuile or, corps zinc, pied zinc), avec la recette complète « aucun liseré
blanc » consignée dans `mps_designer` — y compris le piège de la magnification par `transform: scale()`, qui
invente un défaut de coin inexistant à 1×. En-tête condensé de 3 lignes à 2 pour rendre la hauteur au tableau ;
sélection du contenu au focus sur les champs quantité (convention grille) ; plus de montant en euros dans le
pied, une modale de colisage n'a pas à porter de prix.
`vite.config.ts` : plafond de précache workbox relevé — le bundle était à 0,2 ko de la limite de 2 Mio **avant**
ce travail, donc la prochaine fonctionnalité venue aurait cassé le build. Le vrai correctif reste le découpage
par route.
Garde : `check-divers-carton-contenu.ts` (`--roundtrip` : ajout → hausse → no-op → suppression, avec le grand
livre de stock vérifié à chaque étape et le carton d'essai nettoyé).

## 2026-08-28 — feat/issues (tickets #1090, #1092, #1097)

Trois tickets remontés par les utilisateurs, sans lien entre eux sauf d'être des corrections
sur des écrans en service.

**#1090 — Fils › Références affichait deux chiffres faux, et aucun ne pouvait échouer en
local.** « Stock actuel » sommait tous les lots depuis 2020, épuisés et négatifs compris :
113 des 130 références stockées étaient fausses et 4 affichaient un stock **négatif**.
Cause : `terminé` revient du pont Linux tronqué à l'accent **et avec un octet-poubelle non
déterministe** (`termin` / `termint` / `termini` … selon la charge serveur), donc le repli
codé en dur `row.termin` lisait juste sous Windows et **manquait la clé en production** —
un drapeau à 0 sur toutes les lignes, chiffre faux et jamais d'erreur. Et si personne ne
l'avait vu en dev, c'est que `SELECT *` sur `stock_fil` renvoie **zéro ligne** sur le pilote
Windows (la table porte des memos binaires) : l'écran de dev montrait un stock vide.
`pickVal` / `stripKeys` sortent donc dans **`lib/accented-keys.ts`** (`routes/stock.ts` les
ré-exporte, c'est leur adresse historique) et la lecture par préfixe est appliquée partout
où le même défaut dormait : le badge recyclé de la carte référence et les lots proposés à
l'affectation d'une ligne de commande fil. L'ordre compte — **lire, PUIS purger, PUIS
assigner** : `/^recycl/i` matche aussi la clé canonique `recycle` qu'on vient d'écrire.

Deuxième chiffre : **« En commande » n'était pas ce qui reste attendu mais tout l'historique
d'achat**, ×28 trop sur le catalogue. Refait sur la règle `qte_restante` de Rapports ›
Commandes fils (lignes ouvertes de commandes ouvertes, moins le reçu), le reçu venant de
`Σ stock_fil.stock_initial` — le poids **à la réception**, `stock` étant ce qu'il en reste —
et clé **sur la ligne, pas sur la référence** (12 lots vivants pendent d'une ligne dont le
`ref_fil` diffère). Les deux agrégats sont maintenant des fonctions pures
(`lib/references-fil-agg.ts`) : `references-fil-agg.test.ts` épingle les cas limites sans
base, et `check-references-fil-agg.ts` prouve sur données vivantes ce que seule la prod peut
prouver — son test #4 est la parité ligne à ligne avec le rapport.

**#1092 — Finis › Études coloris n'avait AUCUNE garde en écriture.** `attachUser()` est
best-effort et il n'y a pas de middleware d'auth global : les 9 routes d'écriture (étude,
soumissions, statut, réponse du sous-traitant, envois email) étaient joignables
**anonymement**. Un droit unique `edit_etudes_coloris`, un `ensureCanEdit()` en tête des
neuf, et un seul `canEdit` fileté dans l'écran (liste, en-tête, cartes de soumission,
tiroir, pilule de statut). Les lectures restent ouvertes, **les deux PDF compris** — un
utilisateur en lecture seule doit pouvoir imprimer. Sans le droit, la pilule de statut §29
perd sa moitié « Changer » et redevient un afficheur. ⚠️ Clé **fermée par défaut, aucun
script de rattrapage** (décision Vincent) : l'écran est en lecture seule pour tout le monde
tant qu'un admin ne l'accorde pas.

**#1097 — le destinataire d'un bon de transfert se lisait sur `envoi_bl`.** Vincent a ajouté
`contact.envoi_bt` en base ; `buildTransfertEmailDefaults()` s'y branche, et la case « Bon de
transfert » se coche dans Sous-traitants › Gestion › Contacts — **là seulement**, puisque la
destination d'un transfert est toujours un `sous_traitant` (ou `0` = Ets Malterre, sans
contact externe). Les cases portent le nom complet du document, pas les sigles. ⚠️ La colonne
est neuve et vaut 0 partout : tant que personne n'a coché, un bon de transfert ne
présélectionne **aucun** destinataire — les contacts restent proposés en un clic, rien n'est
injoignable. **14 contacts chez 13 sous-traitants** étaient présélectionnés par l'ancienne
règle ; c'est la liste à recocher si l'on veut la continuité. Vérifié de bout en bout sur le
bon rouleaux #3611 (contact passé de `selected` à `suggestions`, puis retour après coche),
écritures de test restaurées.

## 2026-08-28 — feat/bug2 (recherche multi-critères du picker de transfert — ticket #1093)

**Ce que c'est.** Le champ de recherche du dialogue « Éditer le bon de transfert »
(Transferts › Rouleaux et › Fils) devient multi-critères : le texte libre se découpe sur
les espaces et **tous** les termes doivent matcher (« 029 gris » = référence 029 ET coloris
gris), et un terme peut être épinglé à une seule colonne sous forme de **chip**, via le
`SmartSearchInput` partagé des écrans de stock (mps_designer §27.2bis — on réutilise le
widget, on ne le forke jamais). Champs proposés : Référence / Coloris / N° de pièce / Lot
pour les rouleaux, Référence / Coloris / Lot / Fournisseur pour le fil.

**Le vrai bug du ticket : le coloris n'était pas cherchable du tout.** `/available` ne
matchait que `numero`, `lot` et `reference` — « 029 gris » et « 029 ecru » étaient donc
strictement indiscernables, ce que Pierre-Emmanuel décrit comme « choisir une variante ».
Les jointures `colori_ecru` (écru) et `ref_fini_colori` + `colori_ecru` (fini) ont été
ajoutées, calquées sur `stock-ecru.ts` / `stock-fini.ts` ; le fil avait déjà sa jointure
`colori_fil`, seule la colonne manquait aux prédicats. Les deux jointures portent sur la PK
de leur cible, donc elles ne peuvent pas multiplier les lignes (vérifié).

⚠️ **La recherche reste côté SERVEUR, et ce n'est pas un détail d'implémentation.** Chaque
groupe est plafonné à `AVAILABLE_CAP` = 200 lignes les plus récentes parce qu'un magasin en
porte 30 000+ ; filtrer après le fetch — comme le fait Finis › Stock, qui lui charge sa table
entière — ne chercherait que dans une fenêtre arbitraire de 200 lignes et raterait
silencieusement des rouleaux. Les chips voyagent donc dans l'URL (`c=<champ>:<valeur>`, texte
libre dans `q`). Corollaire côté UI : « Tout sélectionner » porte désormais sur les lignes
**rendues**, plus sur `candidates` — cocher une ligne que l'utilisateur ne voit pas, c'est
un bon qui gagne une pièce que personne n'a choisie.

⚠️ **Aucun octet non-ASCII n'atteint SQL** — un terme accentué dans un `LIKE` est le même
danger pour le pont Linux qu'une écriture, et le littéral hexadécimal n'est pas utilisable
dans un motif `LIKE`. `likePattern()` remplace donc chaque caractère non-ASCII par le joker
un-caractère `_` : « écru » part en `%_cru%`. Effet de bord recherché — la comparaison
devient insensible aux accents dans le sens utile, et c'est nécessaire ici parce que les
coloris portent leurs accents de façon **incohérente** (le même coloris existe en « ecru » et
en « écru »). Ça élargit un peu (`%_cru%` matche aussi « ancru »), donc le client
**réapplique le test exact, accents repliés**, sur les lignes reçues : l'élargissement
n'atteint jamais l'utilisateur. Règle reportée dans CLAUDE.md § HFSQL, avec la dette
associée : `stock-ecru.ts`, `stock-fini.ts` et `stock.ts` interpolent toujours `esc(q)`
brut dans leur `LIKE` de recherche — même danger latent, le jour où quelqu'un tape un accent
dans une barre d'outils de stock.

**Garde** : `check-transfert-picker-search.ts` (lecture seule). Il épingle les jointures (pas
de collapse, pas de doublon), le ET des termes, la séparation effective de deux coloris d'une
même référence — le scénario du ticket —, le fait qu'un chip ne déborde pas de sa colonne, et
les deux invariants de `likePattern` (le joker accentué joue, et rien de non-ASCII ne sort).
Vérifié en plus sur l'API qui tourne : « 029 » → 48 rouleaux mélangés, « 029 ecru » → 24
uniquement écrus, « 029 gris » → 24 uniquement gris.

**Pas fait, sciemment.** Le picker n'a toujours pas la sélection par **MAJ+clic** que
mps_designer §44 rend obligatoire sur toute liste multi-sélection — c'est le compagnon
naturel de ce filtrage (on réduit à « 029 gris », puis on coche vingt cases une par une), et
c'est une modification contenue au même composant.

## 2026-08-27 — feat/atelier (l'API de la PWA atelier : lecture + chemin d'écriture)

**Ce que c'est.** Le premier routeur de la PWA bonnetier/régleur (`apps/atelier` côté TRM,
hôte `atelier.malterre`), monté `/api/atelier`. Un **deuxième client TRM** de l'API MPS,
distinct de l'ERP. Lectures : la grille de visages (`bonnetier`, scopée par `regleur`), la
liste des métiers avec leur OF actif, et le contexte complet d'un OF pour le poste.
Écriture : `POST /of/:id/evenement`, les huit actions de `BTN_Valider`, sous le nouveau
droit **`saisie_atelier`** (catégorie Production, fermé par défaut).

**Le legacy n'est PAS PCS-compressé** — inédit pour un portage TRM.
`C:\Mes Projets\MPS\Android\dbg\Compile\` contient les 45 fichiers Java générés, WLanguage
en commentaires et SQL en clair. Chaque requête du routeur cite son original verbatim.
⚠️ **Mais c'est un instantané du 24/03/2026** : son `info.build` liste 12 fenêtres et l'app
qui tourne en a au moins une de plus (un écran Production/Visitage atteint par une 4ᵉ icône
ronde, introuvable sous ce nom dans le projet). Autorité sur ce qu'il contient, pas sur
l'inventaire — et pour tout ce qui compte, revérifier dans le cache de compilation, qui
lui est à jour.

**La structure des huit branches vient du FLUX DE CONTRÔLE du Java, pas des commentaires** :
le générateur WinDev ne commente que la première ligne de chaque branche, donc les `sinon`
n'y sont pas. Reconstitué depuis la chaîne if/else, puis recoupé avec le cache du
25/08/2026. Trois pièges que ça a mis au jour :

- **Le libellé n'est pas la chaîne stockée.** La combo dit « Fin de pièce » et écrit
  `Fin du tricotage` ; « Interrompre OF » écrit `Interruption OF`. Tout l'historique de
  `evenement_piece` est clé là-dessus — ne jamais dériver l'un de l'autre.
- **« Interrompre OF » et « Relancer OF » sont TOUS DEUX compilés**, choisis à l'exécution
  selon `arret_prod`. Le Java de mars ne montrait que le second, d'où une hypothèse qui a
  tenu jusqu'à la vérification dans le cache.
- **La combo des défauts de l'atelier est la sienne** (8 entrées, ordre propre), et **pas**
  l'ordre de `TYPES_DEFAUT`, qui est le vocabulaire du *visitage* classé par fréquence. Le
  test cm/nb du legacy est **positionnel** (`si COMBO_Défaut.Select() dans (1,3,4,5)`) et
  tombe sur Maille / Barrure Lycra / Autre Barrure / Plis Marchand — exactement ce que
  `uniteForType()` appelle déjà `'cm'`. Les deux listes s'accordent sur le sens, pas sur
  l'ordre : on clé sur le nom du type.

**L'origine des 453 lignes « Autre Barrure » sales est trouvée** : la fenêtre legacy stocke
le libellé **avec un espace final** (`setContenuInitial("… Autre Barrure \r\n…")`). C'est
ce que `normaliseTypeDefaut()` replie à la lecture et ce qui avait mordu l'écran Prime.
La PWA écrit l'orthographe propre, donc le tas cesse de grossir.

**Le piège qui aurait fait des dégâts** : l'ordre physique de `piece_production` au runtime
n'est **pas** celui du `.xdd` (`numero` est en dernier, pas en troisième). Un INSERT
positionnel bâti sur le `.xdd` aurait écrit le numéro de pièce dans `bonnetier_debut` et
une date dans `date_controle`, en silence, sur de vraies lignes de production. D'où
l'INSERT **nommé** pour cette table — elle n'a ni mot réservé ni accent, rien ne force le
positionnel — et une règle ajoutée au § HFSQL de `CLAUDE.md`.
`scripts/probe-atelier-trm.ts` (lecture seule) imprime l'ordre runtime des trois tables
écrites, plus les derniers événements et défauts.

**Deux écarts assumés avec le legacy.** `interruption_prod` n'est pas écrit : c'est la
seule colonne *Durée* de la base, `OF_COLUMNS` l'exclut parce que la LIRE rend du JSON
invalide sur le pont Linux, et rien ne la consomme — écrire un encodage deviné dans une
colonne qu'on ne peut pas relire pour vérifier est pire que laisser la valeur du legacy.
Et il n'y a **pas encore d'annulation**, alors que le legacy en a une (`IMG_Annuler` sur la
dernière action) : sans elle une mauvaise « Terminer OF » n'est pas rattrapable depuis le
téléphone, puisqu'elle arrête l'OF et passe le métier au suivant via `AutoActivation()`.

**La liste des actions offertes est recalculée au serveur.** Le client décide de ce qu'il
affiche, la route décide de ce qui peut arriver ; une action non proposée rend 409, pas une
écriture. Vérifié : un bonnetier ne peut pas interrompre un OF même en forgeant la requête.
⚠️ Le téléphone porte le cookie d'un **compte-poste** (le modèle du PC de visitage) et
*qui* travaille voyage dans `IDbonnetier` — l'identité bonnetier de la PWA est une grille
de visages en `localStorage`, jamais une authentification. Le compte-poste n'existe pas
encore et personne ne détient `saisie_atelier`.

## 2026-08-27 — feat/of (les observations régleur, et la recherche des OF terminés)

**Le bug d'origine.** Vincent signale que l'OF 1741 porte une observation dans le legacy
(« ouverture sur tube », 17/04/2024) et que la PWA TRM affiche « Aucune observation ».
L'onglet Obs. de la fiche OF lisait **`message_of`** ; le legacy bureau y montre
**`obs_ref_ecru`** — les consignes durables portées par la RÉFÉRENCE écru, ciblées par
métier et par coloris. Requête récupérée verbatim dans le cache de compilation WinDev
(`FI_Gestion_OF.wcw`), prédicat `IDref_ecru = :ref AND (IDmachine = :machine OR
IDmachine = 0) AND (IDcolori_ecru = :colori OR IDcolori_ecru = 0) ORDER BY date DESC`.
Un OF de 2022 qui affiche une note de 2024, c'est exactement ce qui trahissait l'erreur :
la note appartient à la référence, pas à la série. `message_of`, lui, n'apparaît **nulle
part** dans le legacy desktop — grep sur tout `C:\Mes Projets\MPS` : il ne vit que dans
l'app Android du poste (`FEN_Consigne`), 113 messages toujours alimentés.

**CRUD `obs_ref_ecru`** dans `routes/of-trm.ts`, derrière `edit_of` (pas de nouvelle clé :
ces notes existent pour être lues au lancement, c'est le même acte). `GET /:id/observations-ref`
applique le prédicat legacy ; `POST /references/:refId/observations-ref`,
`PUT|DELETE /observations-ref/:obsId` écrivent ; `GET /lookups/coloris-ecru?ref=` alimente
le sélecteur du dialogue. Le scope se lit sur l'OF, pas sur sa ligne de commande :
`ordre_fabrication` porte ses propres `IDref_ecru` / `IDcolori_ecru` et ils **divergent de
la ligne sur 848 OF sur 3 178**. `DATE` est réservé → INSERT positionnel (ordre physique
vérifié sur le `SELECT *` runtime), UPDATE nommé pour le reste, et **une modification ne
re-date pas la ligne** (les deux tables trient par `date`). Garde
`check-obs-ref-ecru-trm.ts`, verte, qui épingle ces deux faits que rien d'autre
n'attraperait.

**L'écran partagé Tombé Métier › Références gagne une prop, pas un fork.** `obs_ref_ecru`
n'a pas de sens côté ETM (qui achète son écru et n'a pas de métiers), et son onglet
« Obs OF » y reste en lecture seule. Plutôt que forker le fichier ou y coder en dur une URL
TRM, il expose **`obsOfEditor` — un COMPOSANT** que TRM injecte via un contexte local.
`ObsOfEditorProps` porte aussi `isEditing`, pour qu'un éditeur injecté suive la règle §8 de
l'écran hôte (« Add button, edit mode only »). Troisième précédent de la doctrine « une
différence par app est une prop » après `RapportFinance basePath` et
`createFinanceRouter(scope)`.

**Recherche des OF terminés.** `?q=` ne répondait qu'à un numéro d'OF exact — limitation
assumée au premier port, sur l'hypothèse que résoudre les libellés de 3 100 OF avant de
filtrer serait trop lent. Mesuré sur le pilote : ~0,6 s au pire, pour une liste qu'on
n'atteint qu'en tapant. `searchTermineIds` rapproche **en JS sur des projections étroites**
— le LIKE de HFSQL ne replie pas les accents (les libellés en portent, la boîte non), et
l'axe client demanderait sinon un `IN` de tous les `IDligne_commande_client` d'Ets Malterre ;
les lignes ne sont lues que si des commandes ont matché. Axes : référence (reference +
designation), coloris, client, n° de commande, métier — les mêmes que les onglets vivants
filtrent côté web. Le `TOP 200` borne désormais les **résultats** et non le corpus.
⚠️ **Un nombre est à la fois un n° d'OF et une référence plausible** (249, 027, 161 sont de
vraies étiquettes écru) : une requête numérique ne court-circuite plus le balayage, elle
place son OF exact en tête puis les libellés.

## 2026-08-27 — feat/permissions
Les écrans TRM lisent enfin le magasin de droits de TRM. Six clés — `create_stock_fil`
(Fils › Stock), `edit_factures` (Clients › Facturation) et les quatre de Clients › Gestion
(`edit_client_info`, `delete_client`, `crud_client_contacts`, `crud_client_adresses`) —
étaient nommées par les écrans TRM et par leurs routes, mais déclarées **uniquement dans le
catalogue d'ETM**. L'échec était silencieux et sans recours : Paramètres › Utilisateurs ne
rendait aucun interrupteur (l'onglet se construit depuis `GET /permissions-trm/keys`),
`setTrmUserPermissions` les jetait comme inconnues, `/permissions-trm/me` ne les renvoyait
jamais — donc le bouton restait invisible pour tout non-admin, et ça se lisait comme une
restriction voulue plutôt que comme un bug (symptôme signalé : le poste de visitage ne
pouvait pas créer un lot de fil). Côté API le défaut était symétrique : `requirePermission()`
de `lib/clients-common.ts` appelait `userHasPermission` en dur alors qu'il est importé par
`clients.ts` (ETM) autant que par `clients-trm.ts` et `stock-fil-trm.ts` (TRM) — un droit
accordé dans TRM ne faisait rien, un droit accordé dans ETM ouvrait la route TRM. Le garde
prend désormais un **`PermissionScope`** explicite (`ETM_PERMISSIONS` / `TRM_PERMISSIONS`)
**sans valeur par défaut**, troisième instance de la forme `FinanceScope` / `FacturesScope` ;
`FacturesScope` gagne `permissions` pour la même raison. Vérifié sur l'API de dev en
non-admin : 403 sans droit, 403 avec le droit accordé côté ETM seul, 400 (garde franchie)
avec le droit accordé côté TRM. Garde permanente : `check-permission-keys-trm.ts --web <chemin
absolu vers TRM/apps/web/src>`, le miroir de `check-screen-access-trm.ts`. Aucun code web ne
change des deux côtés — les écrans nommaient déjà les bonnes clés. Reste ouvert et documenté :
`expeditions-trm.ts` (6 routes d'écriture) et `planning-atelier.ts` (7) n'ont toujours aucune
garde.

## 2026-08-27 — feat/visitage (la zone imprimable de l'étiquette, la quantité d'un défaut, la précision du taux)

Trois retours de Vincent sur le poste de visitage, plus un sur Prime. Côté API :

**1 · La tête d'impression ne va pas jusqu'au bout de l'étiquette.** Le pavé DÉCLASSÉ est
sorti tranché en plein mot (« DÉCLASS ») sur un tirage du poste. Photogrammétrie sur le
cliché, calée sur le cadre du métier dont on connaît les coordonnées au point près : le bord
gauche tombe **exactement** là où le PDF le met — donc rien n'est décalé ni mis à l'échelle —
mais l'impression s'arrête à **~234 pt**, soit ~82,5 mm des 89 mm. Les ~6,5 mm de droite ne
sont pas imprimables. D'où `SAFE_RIGHT = 26` pt : ce n'est pas une marge mais une **zone
sûre**, volontairement bien plus large que les 5 pt de gauche, et tout ce qui est calé à
droite s'aligne dessus. Vérifié en rendant le PDF et en relisant les coordonnées du flux de
contenu : le pavé va maintenant de 167,9 à **226,3 pt**, 7,7 pt sous la limite mesurée. Sur
l'étiquette physique ça se lit centré, parce que c'est centré dans la bande *imprimable* —
ne jamais « rééquilibrer » ce padding contre celui de gauche. Les étiquettes sœurs ne
l'avaient jamais rencontré parce que tout y est calé à gauche : leur `paddingRight: 8`
n'était pas un précédent.

**2 · La quantité d'un défaut devient corrigible au poste.** Au terminal le bonnetier saisit
une approximation — **999 pour « plus de 3 m »** — et c'est à la visiteuse de mesurer et de
rectifier. Ce n'est pas une extension : la requête de la fenêtre legacy, récupérée verbatim
dans le cache de compilation, ne lit **que** `IDdefaut_qualite, type_defaut, taille_cm,
nombre FROM defaut_qualite WHERE Type_Reference = 1 AND reference = ?`, avec les masques
`9 999 cm` / `x9 999` — la colonne était liée et éditable. `POST /valider` écrit donc la
quantité en convertissant le défaut, avec deux garde-fous : **seule la colonne de l'unité du
type** vient du payload (l'autre garde ce que le terminal a écrit, pour qu'un client ne
puisse pas la vider), et `description` n'est pas touchée — le legacy ne la lit même pas ici,
et c'est la phrase du bonnetier que Prime rend verbatim. Les colonnes écrites sont ASCII,
donc `UPDATE` nommé classique ; c'est `récuperé` seul qui force encore la réécriture
positionnelle, qui porte désormais la quantité aussi.

**3 · Le taux de la prime s'affiche à sa vraie précision.** `fmtTaux` était figé à deux
décimales et sortait « +0,06 €/Kg » depuis la révision du barème — un taux que personne ne
touche, imprimé sur le document qui paie la prime, à côté d'un total calculé sur le vrai
0,055. La troisième décimale n'apparaît que si elle porte quelque chose (-0,40 et -0,60 se
lisent toujours à deux). **Le calcul, lui, n'a jamais arrondi** : `kg × bareme.premierChoix`
est exact depuis le barème daté. Au passage, la mention « Retour client » du PDF codait
`-0,60 €/Kg` en dur au lieu de lire le barème.


## 2026-08-27 — feat/etiquette-band (l'étiquette du rouleau : une seule colonne à gauche)

Suite du 2026-08-27 (`feat/visitage`), retour de Vincent sur le rendu : le badge M et le
cadre du métier n'avaient pas la même largeur, et la bande gauche se lisait comme deux
objets flottants au lieu d'un tampon. Les deux passent à **50 pt** (badge 46 → 50, cadre
62 → 50, hauteur 44 → 40, métier 24 → 21 pt), et la bande passe de 68 à 56.

Le commentaire du style **affirmait déjà** cette égalité (« same width as the métier box
below it ») : elle était vraie au premier jet, puis a dérivé quand l'étiquette a été
agrandie pour remplir le tag et que les deux ont grandi séparément. C'est donc le code qui
rattrape ce qu'il disait faire, et l'invariant est maintenant écrit en ⚠️ au-dessus de
`band` — changer l'un, changer les trois.

Effet de bord voulu : les 12 pt libérés vont au corps, donc les numéros longs
(« 3415/1003 ») ne serrent plus le bord droit.


## 2026-08-27 — feat/visitage (l'étiquette du rouleau s'imprime à la validation)

Le poste de visitage TRM crée des rouleaux depuis le 2026-08-26, mais il ne collait rien
dessus : dans le legacy, valider une pièce envoie une étiquette par rouleau sur la Dymo du
poste. Cette branche porte l'étiquette et la route qui la sert.

**La source n'était pas là où on la cherchait.** `FI_Visitage.wdw` ne contient aucune
impression — j'en ai extrait toutes les chaînes du cache de compilation, il n'y a ni état ni
littéral d'étiquette. Le tirage vit dans une **procédure globale**, `ImprimeEtiquetteTM`
(collection `Utilitaire`), repérée par son nom dans `Utilitaire.AF726741.wdg.wbg` puis lue
dans le `.wcg` du même cache. Ses littéraux donnent l'étiquette en toutes lettres : `TRM.jpg`,
`Arial`, le métier via `ordre_fabrication` → `machine`, `"N° : "`, `"Poids : " %5,2f " Kg"`,
`"Réf. : "` via `ref_ecru` → `colori_ecru`, `"Date : "` en `JJ/MM/AAAA HH:mm:SS`. **Les champs
du PDF sont donc ceux du legacy, verbatim et dans son ordre** ; seule la présentation change.
À noter pour les portages TRM à venir : le cache WinDev garde aussi les procédures des
collections, pas seulement les fenêtres — et `ImprimeEtiquetteEchantillon` y est juste à côté,
pour le jour où l'écran Échantillons sera porté.

`GET /visitage-trm/etiquettes?ids=…` rend **une page par rouleau** (`EtiquetteEcruPdf.tsx`,
Dymo 99012 89 × 36 comme `StockFiniLabelPdf` / `StockFilLabelPdf`), pour qu'une pièce coupée
sorte tout son jeu en un seul travail d'impression. Deux deltas assumés avec le legacy : le
vieux logo pyramide `TRM.jpg` devient le **badge M carré** (décision de Vincent — la bande
gauche d'une 89 × 36 est haute et étroite, le mot-symbole large doit y rétrécir et la laisse
à moitié vide), et un rouleau déclassé porte un **pavé noir « DÉCLASSÉ »** que le legacy
n'imprime pas, alors que c'est précisément ce que l'étiquette d'un rouleau devrait dire.

Pas de garde `saisie_visitage` : réimprimer une étiquette déjà collée sur le rouleau est
aussi sensible que consulter le poste. Le garde-fou de partition est **`IDordre_fabrication
> 0`** — seul le tricotage TRM a un OF — et surtout **jamais `IDsociete`** : la réception ETM
bascule le rouleau en société 1, une étiquette filtrée sur la société cesserait d'être
réimprimable dès la livraison.

⚠️ **`?demo=N` est temporaire.** La seule machine capable d'exercer la vraie Dymo est le poste
de production, donc la route sert aussi N étiquettes d'exemple, sans rien lire ni écrire, pour
les deux boutons « Test Dymo » du côté TRM. À retirer des deux côtés une fois le rendu validé
sur le poste, avec les deux vérifications `demo=3` de `check-visitage-trm.ts`.

`check-visitage-trm.ts` gagne huit vérifications, en **lecture seule** et placées **avant** la
porte du worklist (qui coupe le script sur une base de dev périmée) : elles sont donc
rejouables partout, y compris en prod.

Piège react-pdf trouvé en chemin, noté dans `claude_doc/pdf_email.md` : un `<Text>` en
`position: absolute` ne se dimensionne pas sur son contenu, il s'effondre — le pavé « DÉCLASSÉ »
s'imprimait en tache noire de quelques points. La position va sur un `<View>` englobant, avec
une largeur explicite.


## 2026-08-27 — feat/widget (API du widget « Pièces à visiter » + lecteur de pièces partagé)

Moitié API du port de `FI_PiecesAVisiter.wdw`, le widget du tableau de bord TRM qui liste le
tombé métier sorti d'un métier et que personne n'a encore pesé. Le web est dans la branche
jumelle `feat/widget` du dépôt TRM ; cette branche-ci porte les endpoints, le droit et la sonde.

**`GET /api/dashboard-trm/pieces-a-visiter`** — pièce `piece_production` terminée, sans
`stock_ecru`, `date_fin` dans les 24 h, la plus ancienne en tête. Nouveau droit
`dashboard_pieces_a_visiter` (catégorie « Tableau de bord »). Fenêtre élargissable en dev par
`PIECES_A_VISITER_WINDOW_HOURS` — la base locale est un instantané de mars, donc 0 ligne à 24 h ;
même knob et même raison que `VISITAGE_PIECE_MAX_AGE_DAYS`. La prod garde 24 h.

**Le lecteur de pièces en attente est sorti de `routes/visitage-trm.ts` vers
`lib/production-trm.ts` (`awaitingPieces`).** Le poste de Visitage et le widget posent la même
question et ce qu'elle encode est de la discipline de pilote, pas de la règle métier : l'anti-
jointure est résolue en JS (`date_fin <> ''` et `IS NULL` ne se comportent pas pareil des deux
côtés) et le balayage se fait **par machine**, pas par OF comme le legacy — c'est précisément
ainsi que le legacy perd les pièces dont l'OF a été terminé entre-temps. Une deuxième copie
aurait été un deuxième endroit où se tromper. Chaque appelant garde sa propre fenêtre :
7 jours pour le poste (`awaitingByMachine` n'est plus qu'un group-by par-dessus), 24 h pour le
widget. Les deux routes du poste ont été refumées après coup (7 métiers / 11 pièces en fenêtre
élargie).

**Deux règles durables dans `CLAUDE.md`.** La première est un footgun HFSQL neuf : *la forme
TEXTE d'un DATETIME dépend du pilote*. Windows ODBC rend `'2025-11-24 19:58:40.412'`, le pont
Linux `'20251124195840'`. Le `SUBSTR(date_fin,9,2)` du legacy — qui lit bien l'heure sur le
`AAAAMMJJHHMMSS` de WinDev — y lit donc le **quantième** sous ODBC, sans la moindre erreur :
mesuré 0/8. D'où l'« équipe » du widget dérivée de l'heure **parsée**, bornes legacy conservées
(5–13 Matin, 13–21 Après-Midi, sinon Nuit). La seconde amende la règle de récupération d'une
fenêtre PCS-compressée : les littéraux entiers ne survivent pas au cache de compilation, et
avant de *mesurer* un seuil contre une capture d'écran (ce qu'avait coûté le rouloir de
Maintenance), **il faut demander à l'utilisateur** — il a le projet WinDev ouvert. C'est ainsi
que le barème de couleur du widget (rouge ≥ 3 h, orange ≥ 2 h) a été récupéré en un tour.

**Sonde `scripts/probe-pieces-a-visiter-trm.ts`** (lecture seule, rejouable en prod après un
`/etm_deploy`) : elle fait tourner le SQL legacy et le helper côte à côte — **56 vs 56** dans la
profondeur de scan —, vérifie que l'anti-jointure n'a pas de trou (aucun `stock_ecru` sans
`date_saisie`) et enregistre la forme de DATETIME que parle le pilote. `PROBE_WINDOW_DAYS`
élargit la fenêtre pour que l'instantané de dev ait des lignes à comparer.

## 2026-08-26 — feat/prime-bareme (les taux de la prime sont datés, et montent à 0,055 / −0,40)

Vincent a tranché la révision du barème discutée avec l'atelier depuis le 2026-08-24 : 1er choix
+0,05 → **+0,055 €/Kg**, 2nd choix −0,20 → **−0,40 €/Kg**. Le chiffre était la partie facile ;
la condition posée par `CLAUDE.md` depuis l'écriture de l'écran était l'autre moitié.

**Les trois taux étaient des constantes de module appliquées à TOUTE période navigable.** Les
réviser en place aurait recalculé l'historique entier : en rouvrant un semestre payé, l'écran
aurait affiché une prime que personne n'a jamais touchée — et la répartition par bonnetier avec.
`BAREMES_PRIME` (`lib/bareme-prime-trm.ts`) est donc une **table datée**, résolue par
`baremePour(debut du semestre)` : S1 2026 et avant gardent +0,05 / −0,20, S2 2026 et après
prennent les nouveaux. **On ne touche jamais une ligne passée** — une révision s'ajoute.

⚠️ **Le `from` doit tomber sur une frontière de semestre (15/06 ou 15/12).** La prime est *une*
somme sur toute la période × *un* taux, donc un barème démarrant en cours de semestre n'est pas
calculable sans découper chaque somme de kg à la date de bascule — `sumPoids`, les montants de
déclassement et le donut. Si l'atelier demande ça un jour, **c'est ce découpage le travail**,
pas une ligne de plus dans la table. Le test l'épingle, avec la bascule au jour près et le tri
de la table : `baremePour` sort de sa boucle au premier `from` futur, une table désordonnée
résoudrait faux **en silence**.

Deux détails qui ne se devinent pas : le **semestre** est prixé au barème de *son* `debut`, la
**semaine** à celui d'aujourd'hui (elle décrit toujours la semaine courante, quelle que soit la
période consultée — les deux coïncident dès que le semestre courant est affiché, seul cas où
l'écran la rend) ; et `retourClient` reste à −0,60, la tuile étant morte depuis le legacy.

La table vit dans `lib/` et pas dans `routes/prime-trm.ts` pour être testable sans charger le
driver HFSQL, à côté de `lib/pricing-trm.ts` où vivent déjà les règles de prix TRM. **Le payload
garde sa forme** (`taux: {premierChoix, secondChoix, retourClient}`) : l'écran et le PDF
affichent les taux qu'on leur envoie, donc **aucun changement côté TRM** — pas de worktree
jumeau, pas de `/trm_deploy`. Vérifié en base sur la bascule : S1 2026 rend 0,05 / −0,20 et
2 369,91 €, S2 2026 rend 0,055 / −0,40 ; `montant = kg × taux` sur chaque période.

## 2026-08-26 — feat/cmd-client (lancement d'OF depuis la commande : ce que le régleur fait vraiment)

Suite de la même branche. Vincent est allé demander à son régleur ce que font au juste les deux boutons de la fenêtre OF, et sa réponse a invalidé deux hypothèses du port — plus, en passant, deux bugs de fond.

**« Incorporer un fil » n'est pas de la freinte, c'est de la consommation.** On verse un reliquat de lot dans un OF pour s'en débarrasser, et ce poids doit être « pris en compte dans le rapport de freinte ». Or `computeBilan` ne lisait que `asso_fil_of` : le poids incorporé ressortait intégralement en perte. La preuve est arithmétique — sur ~10 des 32 lots concernés, la freinte calculée **était** le poids incorporé au kilo près (lot 9479 : 50,5 pour 50 ; lot 10065 : 20,6 pour 20), et la médiane tombe de 4,58 % à 1,46 % une fois déduit (`check-freinte-incorpore-trm.ts`). `Bilan` gagne donc `incorpore[]` / `incorpore_total`, la freinte devient `initial − tricoté − incorporé` dans `/bilan` et dans le PDF. **Gardé comme ligne à part, jamais fondu dans `produit`** : le poids est *déclaré* (« incorporer le lot X si possible » dit la consigne), et quelques lots ne réconcilient pas — le 10106 déclare 8 Kg incorporés sur un lot de 8 Kg dont 6,6 déjà tricotés. L'archiviste doit voir le chiffre pour le juger. Le *moment* de la consommation, lui, n'est enregistré nulle part : `fil_incorpore` n'a que quatre colonnes, et les trois cas coexistent dans les consignes — « 1 sur 2 », « à la fin de la prod », « avant de prendre le 10187 ». Décision : ça reste en consigne.

**« Ajouter un fil » sert à deux choses, on n'en avait vu qu'une.** Le port avait retenu la variation (tricoter un fil hors fiche écru) ; la répartition d'une même part sur **plusieurs lots** manquait. Le registre la sépare nettement de la règle des positions d'alimentation : sur 105 groupes (OF, fil, coloris) à 2 lignes, **83 sont sur le même lot** (positions dupliquées, règle intacte) et **22 sur des lots différents**, dont 18 avec plus de lignes que la référence n'en déclare et le pourcentage **éclaté** — réf 97 % tricotée 70 + 27, réf 95 % en 47,5 + 47,5. `GET /of-trm/:id` expose maintenant `composition[].hors_ref` (le couple absent de `composition_ecru`) pour que la variation soit **visible** et pas seulement enregistrée : 316 lignes sur 5 064, 271 OF sur 3 175, garde `check-hors-ref-trm.ts`.

**Le bug de fond : l'onglet Stock de fil ignorait à qui appartient le fil.** Vincent voit le lot 10131 sur la commande 2799, le legacy ne l'affiche pas. La requête WinDev porte `stock_fil.IDclient = {pIDClient}` — **TRM tricote à façon, le fil est fourni par le client**, et `stock_fil` n'étant pas partitionné par société, `IDclient` est la seule chose qui dit à qui est un lot. La 2799 est à Bonneterie Gautier, le 10131 à Ets Malterre. `/stock-fil` reprend les trois filtres du legacy — `IDclient`, `IDMagasin = 1`, `terminé = 0` — et ⚠️ **`stock > 0` n'équivaut pas à `terminé = 0`** : 3 lots sont archivés avec du stock dessus. Effet mesuré (`check-stock-fil-commande-trm.ts`) : 5 lots retirés sur 4 des 15 lignes ouvertes, **tous appartenant à un autre client**, et le bug allait dans les deux sens (des lots Gant Maille et La Gentle Factory étaient offerts sur des commandes Ets Malterre). `terminé` étant accentué, la lecture du drapeau est scindée par plateforme (`archivedLotIds`) : Windows accepte l'identifiant en WHERE mais rend zéro ligne sur `SELECT *`, le pont Linux fait l'inverse — aucune forme ne marche des deux côtés.

**Et le lancement lui-même.** `POST /of-trm` accepte un tableau `incorpore` (les fils incorporés se posent à la création plutôt qu'en modifiant l'OF dans la foulée), `/of-trm/lookups/observations` sert les « Observations Régleur » (`obs_ref_ecru`, prédicat legacy récupéré verbatim du cache de compilation WinDev), et `/stock-fil` renvoie `composants` — la composition complète, **y compris les fils dont ce client n'a aucun lot**, ce que `lots` ne sait pas exprimer — pour que le bouton « Créer un OF » n'apparaisse qu'une fois chaque fil couvert.

**Côté ETM.** Aucun changement de comportement : les routes touchées sont toutes `*-trm`, `RapportFreintePdf` est le PDF TRM, et `TYPE_DOC_COMMANDE_CLIENT` passe simplement `export` (la confirmation TRM journalise dans le même `envoi_email`, `commande_client` étant une seule table pour les deux sociétés). Sondes d'enquête conservées, toutes en lecture seule : `probe-fil-incorpore-trm{,2,3,4}.ts`.

## 2026-08-26 — feat/of-lecture (`edit_of` : les OF passent en lecture seule, et neuf routes cessent d'être anonymes)

Vincent voulait que le PC de visitage voie **Tableau de bord + Production › Visitage / Prime / Ordres de fabrication, ces derniers en lecture seule**. Les deux premiers tiers se réglaient déjà sans code (l'axe Écrans : un menu est un droit fermé par défaut, un écran dans un menu accordé est un `hide_*`). Le troisième, non.

**Ce que la revue a trouvé.** `/api/of-trm` porte **neuf routes d'écriture** — création, modification, composition, fil incorporé, observation, activer, terminer, réordonner, supprimer — et **aucune n'avait de garde**. Pas seulement pas de droit : **pas d'authentification du tout.** `attachUser()` est best-effort et il n'existe aucun middleware d'auth global, donc n'importe quel appelant capable de joindre l'API pouvait terminer un OF ou vider la file d'un métier sans cookie. `check-of-trm.ts` en est la preuve fossile : il faisait tourner tout le cycle d'écriture **sans jamais envoyer de cookie**, et passait. Il en envoie un maintenant, et vérifie les deux refus (401 anonyme, 403 sans la clé) avant le cycle.

**La clé.** `edit_of`, sur le patron exact d'`edit_commandes_client` : un `requireEditOf` en tête des neuf handlers, et côté écran un `useHasPermission('edit_of')` descendu en prop qui retire Modifier, Nouveau, Supprimer, les flèches ▲▼ de la file, les transitions de la pastille §29 et la zone d'ajout d'observation. **La lecture reste ouverte** à qui détient le menu Production — la file, la consigne et les pièces déclarées sont ce que l'atelier consulte toute la journée, et le poste de visitage d'à côté en a besoin. `Terminer` est dans la même clé que le reste volontairement : il re-classe le métier et peut activer l'OF suivant, c'est le bouton le plus conséquent de l'écran, pas un moindre.

⚠️ **`edit_of` est fermé par défaut comme toute clé TRM, donc au déploiement l'atelier perdrait l'écriture d'un coup.** `seed-edit-of-trm.ts` (idempotent, `--write` pour appliquer) accorde la clé à toutes les personnes qui l'avaient de fait — c'est-à-dire tout le monde — et **saute les trois comptes-postes** (`Visitage` 10, `Regleur` 14, `eloise` 16) : un PC d'atelier partagé est précisément ce que la clé existe pour tenir en lecture seule. **À lancer sur l'hôte de prod avant le déploiement web TRM**, comme `seed-screen-access-trm.ts`.

Côté TRM le compte-poste **`Visitage`** rejoint `TRM_STAFF` — il existait en base depuis le legacy mais l'allowlist de Paramètres › Utilisateurs ne listait que des personnes physiques, donc aucun admin ne pouvait atteindre ses droits et `saisie_visitage` ne pouvait pas lui être accordé. Sa clé finit par un `|` nu (pas de nom de famille) ; ce n'est pas une coquille.

Vérifié en bout de chaîne, connecté comme le compte Visitage : navigation réduite à Tableau de bord + Production, sous-menu Ordres de fabrication / Visitage / Prime (TRS masqué), et l'écran OF entièrement lisible sans un seul bouton d'écriture.

## 2026-08-26 — feat/visitage (poste de visitage TRM — API, layout « Poste » du design system)

La moitié API d'un écran TRM : **Production › Visitage**, le poste où la visiteuse pèse le tombé métier qui sort du métier, le coupe éventuellement en plusieurs rouleaux, arbitre les défauts déclarés au terminal par le bonnetier, et valide. C'est le point d'entrée du stock écru TRM : jusqu'ici l'ERP web le lisait partout (Tombé Métier › Stock, Expéditions, Prime, le widget « Poids des pièces ») sans jamais pouvoir le créer.

**Refactor préalable, à connaître avant de toucher à `of-trm.ts`.** Tout ce que les deux écrans partagent — `selectMachines` / `selectBonnetiers` / `selectDefauts` / `loadOf` / `resolveEcruRefs` / `parseDtMs` / `sqlText` / le catalogue `TYPES_DEFAUT` — est sorti dans **`lib/production-trm.ts`** (514 lignes) ; `routes/of-trm.ts` perd 375 lignes et les importe. Améliorer la lib, ne pas re-porter les helpers dans un troisième fichier.

**`POST /valider` est le seul écrit, et il n'y a pas de transaction derrière.** Il crée les `stock_ecru`, convertit les `defaut_qualite` de la pièce (`Type_Reference` 1 → 2, **sur place**, en préservant `DATE` / `Type_Spotteur` / `IDSpotteur` / `description` — c'est ce qui distingue encore un défaut terminal d'un défaut visitage des années après), écrit un `evenement_piece` par rouleau, et **décrémente `stock_fil`**. Tout le vérifiable l'est avant la première écriture (pièce encore libre, défauts appartenant bien à la pièce, poids, droits) et un échec en cours de route renvoie les rouleaux réellement créés plutôt qu'un 500 nu. `?dry_run=1` renvoie le plan exact sans rien écrire : c'est ce que `check-visitage-trm.ts` exerce, pour qu'un passage de garde ne laisse jamais de pièce fantôme en stock (Tombé Métier › Stock est en lecture seule, rien ne permettrait de la retirer).

**Le décrément du fil est l'écriture risquée** : `Σ(poids) × asso_fil_of.pourcentage / 100`, **déclassés compris** — 43 des 75 lots ouverts reproduisent `stock_initial − stock` ainsi, **aucun** en ne comptant que le 1er choix. Une mauvaise assiette ferait dériver le grand livre du fil en silence, et rien en aval ne le signalerait.

**Le worklist remplace la liste de métiers du legacy, et répare une fuite.** Le legacy demande les pièces **OF par OF** et ne passe jamais que l'OF en tête de file : une pièce dont l'OF a été terminé entre-temps devient invisible pour toujours (56 pièces terminées sans rouleau sur 5 mois, dont 45 sur un OF terminé). On scanne donc **par machine** et les égarées reviennent en `autres_pieces` — mais seulement **7 jours** (`ORPHAN_MAX_AGE_DAYS`, constante dure, décision utilisateur) : passé une semaine la matière est partie, et c'est un passif comptable, plus un travail d'atelier. La dérogation dev `VISITAGE_PIECE_MAX_AGE_DAYS` (la base locale est un instantané de mars) n'élargit **que** les pièces de l'OF en tête de file.

**Une approximation assumée, mesurée.** Le bandeau « Pièce à visiter » est **exact** quand `ouvert_visiteuse = 1` (18 355/18 362 = 100,0 %) ; sinon c'est une cadence ~1 sur 3 dont la parité plafonne à **71,8 %** (sept variantes essayées, aucune meilleure ; « toujours visiter » donne 57,4 %). La lecture la plus probable est que le bandeau legacy est indicatif — d'où le « changer » de l'écran, qui laisse la visiteuse trancher et empêche une règle imparfaite d'écrire une fausse histoire toute seule. Le choix décide aussi lequel des deux événements est écrit.

**Le design system gagne un 4e layout.** `mps_designer` §45 « **Poste** » — l'écran d'atelier plein écran : contexte imposé par le matériel, une seule action qui engage la production, bandes empilées dont une seule flexe, bouton d'engagement épinglé en haut à droite de la bande de saisie, sélecteur de contexte en barre d'outils et non en liste maître. Le tableau des layouts nommés en tête du fichier passe de trois à quatre entrées. §45.7 documente la seule dérogation : **pas de garde §28**, parce que son troisième bouton (« Enregistrer puis continuer ») engagerait de la production depuis un dialogue de navigation.

Trois scripts : `probe-visitage-trm.ts` (les règles contre tout l'historique — à relancer après un `/etm_deploy`), `check-visitage-trm.ts` (les routes, en `dry_run`), et `seed-visitage-historique.ts` (**dev only**, refuse de tourner si la connexion ne pointe pas sur localhost). Clé de permission `saisie_visitage`, **fermée par défaut** : à accorder aux visiteuses en prod après déploiement.

## 2026-08-26 — feat/retour-client (l'envoi de la FNC ouvre vraiment le dossier chez TRM)

Moitié NG d'une paire de worktrees : la branche TRM porte l'écran Qualité › Retour client (port de `FI_Retour_ClientTRM.wdw`), celle-ci porte son API — et referme la boucle FNC, qui était ouverte depuis le portage de Qualité › Dossiers.

**Le trou.** MPS-NG savait imprimer une FNC et dater son envoi, mais le bouton « Envoyer la FNC » était un dialogue « En developpement ». Une FNC envoyée depuis cet écran n'atteignait donc personne : côté TRM, `retour_client` ne contenait que les 91 lignes créées par WinDev. Le legacy, lui, demandait « Voulez-vous envoyer cette FNC a TRM ? » puis créait la ligne et ouvrait la fenêtre de mail. C'est ce passage de témoin qui manquait.

**Ce qui traverse, et ce qui ne traverse jamais.** À l'aller, `POST /dossiers-qualite/:id/fnc/envoi` (ou `…/fnc/email`, qui fait le même geste une fois le mail parti) date `envoiFNC` et crée la ligne, en recopiant `messageFNC`, `IDdefaut_textile`, `Type_Reference` et `reference`. Au retour, **seule la réponse** remonte : `retour_client.IDresolution_qualite` + `.reponse` → `dossier_qualite.reponseFNC`, dans la forme `"<libellé>\r\n<commentaire>"` que cet écran relit pour son `has_reponse` et pour la FNC imprimée. L'encodage garde un seul propriétaire, **`writeFncReponse()`**, exporté plutôt que dupliqué.

Ne remontent **jamais** : la clôture (ETM ferme son dossier quand la réponse le satisfait — autre décision) et surtout **l'affectation**, qui diverge sur **13 dossiers sur 91**. L'atelier repointe la référence sur le rouleau qu'il a réellement trouvé, ou réduit un lot d'ETM à une pièce (dossier 105 : `2:Ma101079` → `1:2323/12`). Elle est donc amorcée à la création puis appartient à TRM.

⚠️ **L'asymétrie qui coûterait cher.** `dossier_qualite.IDclient` nomme le client **final d'ETM** (LEMAHIEU, Cocorico, Le Slip Français) ; `retour_client.IDclient` nomme le client **de TRM**, c'est-à-dire Ets Malterre. Le client TRM est donc résolu **par le nom de la société émettrice**, et `resolveTrmClientForSociete()` **lève** si elle ne le trouve pas : un repli silencieux classerait la réclamation sous le client qui a le hasard d'être l'`IDclient` 1. Bénéfice de bord : l'écran TRM peut afficher le vrai plaignant, que le legacy réduisait à « Ref client : 183 ».

**Garde-fous du geste.** Idempotent — un second envoi ne rouvre pas de dossier en double pour l'atelier. Exécuté **après** le départ du mail, pour qu'un envoi raté n'ouvre pas chez TRM un dossier dont personne n'a été prévenu ; s'il échoue une fois le mail parti, la réponse le dit (`handover: 'failed'`) au lieu d'un 500 qui inviterait à renvoyer. Et seule `IDSociétéFNC = 1` (Tricotage Malterre) se transmet : le `retour_client_confection` de Malterre Confection est une autre table, d'une autre forme, sans écran qui la lise — une FNC visant Confection part quand même par mail et le dit (`unsupported_societe`).

**Où vivent les primitives.** `lib/retour-client-trm.ts` — ordre physique des colonnes, encodage, lectures, écriture du booléen accentué `archivé`, passage de témoin. En `lib/` et non dans l'un des deux routeurs parce que **les deux écrivent la table**, et que c'est ce qui les empêche de s'importer mutuellement en cycle. `RC_COLUMNS` — dont dépend la réécriture positionnelle sur Linux — n'existe donc qu'à un seul endroit ; c'est l'ordre du `SELECT *` **runtime**, qui diffère du `MPS.xdd` (même piège que `controle_titrage`) et que la sonde revérifie à chaque passage.

**Le reste de l'API TRM** (`/api/retours-client-trm`, 1 262 lignes) : lookups, liste, fiche, écritures, clôture, suppression, traçabilité (rouleaux résolus + `evenement_piece` + `defaut_qualite` + les deux documents, qui réutilisent des endpoints PDF existants), pièces jointes du dossier ETM, `RetourClientPdf` émis par `companyTrm`, et les deux endpoints d'email du §32. Droit `edit_retour_client` : seule l'écriture est gardée — la donnée qualité n'est pas confidentielle, ce que la clé protège c'est la boucle FNC, puisqu'une réponse écrite ici parle à ETM au nom de TRM.

**Vérifications.** `probe-retour-client-trm.ts` (lecture seule, rejouable en prod) établit le miroir colonne par colonne et les pièges ; `check-retour-client-trm.ts` conduit les routes sur un dossier jetable qu'il supprime — **30 contrôles**, dont l'idempotence, la republication de la réponse, le fait que la réécriture positionnelle de la clôture ne perd ni la réponse ni le lien FNC, le refus du blob d'un autre dossier (404) et les en-têtes §21 sur le PDF. Boucle complète rejouée de bout en bout : création → envoi → la ligne apparaît « En cours » côté TRM → second envoi idempotent → TRM répond → l'écran ETM affiche « Personnel Informé » et `has_reponse: 1`.

⚠️ **L'onglet Documents reste dégradé sur Linux**, et pas par choix : `doc_qualite` porte sa PK *et* sa FK accentuées, donc le pont ne sait pas cadrer sur un dossier et un `SELECT *` traînerait 87 Mo de blobs. L'API répond `degraded: true` plutôt que de faire croire le dossier vide — même limite et même formulation que l'écran ETM. Le §8 de la sonde reteste la question à chaque passage et dira quand ce chemin pourra disparaître.

**Déploiement :** `/etm_deploy` doit précéder `/trm_deploy` — l'écran TRM 404 sans ces routes.

## 2026-08-26 — feat/maintenance (Atelier › Maintenance TRM : API + droit `edit_maintenance`)

Port de `FI_Maintenance.wdw` (mode Tricotage Malterre) côté API : `routes/maintenance-trm.ts` monté `/api/maintenance-trm`, plus la clé `edit_maintenance` dans `permission-keys-trm.ts`. Deux tables neuves pour nous, `machine` et `operation_maintenance`, ni l'une ni l'autre partitionnée — les métiers *sont* Tricotage Malterre, comme `ordre_fabrication`.

**La récupération du legacy a changé de route, et c'est la leçon durable.** `FI_Maintenance.wdw` est PCS-compressée et, contrairement à `FI_Prime`, n'a **aucun** jumeau Java Android : le chemin qui avait sauvé la prime n'est pas universel. Tout est sorti du **cache de compilation WinDev** — `MPS.cpl/<user>/00000000/FI_Maintenance.4C33DFB6.wdw.{wcw,wbw}`. Le `.wcw` donne les littéraux chaîne et le SQL embarqué (la procédure `PoidsRestantRouloir` en entier) ; le `.wbw`, moins connu, donne **l'inventaire complet des champs** — les six couples `SAI_nett_*` / `SAI_Comm_*`, `SEL_Fonture`, `JAUGE_Ventilateur` / `JAUGE_Couronne` / `JAUGE_FuiteAir`, `BTN_Mise_a_Zéro` — soit la spec du formulaire. À essayer **avant** l'Android pour tout futur portage.

**Le seuil de 15 000 Kg est une mesure, pas une lecture.** Les littéraux entiers ne survivent à aucune des deux routes. Il a donc été résolu en reconstituant depuis la base les quatorze valeurs « Rouloir dans N Kgs » lisibles sur une capture du legacy fournie par Vincent : **14/14, écart maximal 0 Kg** (3H → 610,09 pour 610 affiché ; 3F → 3 494,94 pour 3 495 ; 2I → 7 770,25 pour 7 770). `scripts/probe-maintenance-trm.ts` rejoue cette réconciliation avec les valeurs de la capture **en dur**, pour que le test ne puisse pas devenir circulaire. La frontière amber/vert (10 000 Kg) reste, elle, **non prouvée** : la capture ne la contraint qu'à l'intervalle `]4 650 ; 5 170]`.

**Deux pièges de schéma, notés dans `CLAUDE.md`.** Le champ « Description » de l'écran est `machine.commentaire` et **pas** `machine.nom` (métier 2E : `nom` = '2E', `commentaire` = 'Terrot') — l'erreur inverse est tentante et silencieuse. Et deux fautes de frappe sont les vrais noms de colonnes : `observation_maintenace` et `comm_pulsonque`.

**Côté HFSQL, `machine` est un contre-exemple utile.** Elle porte trois colonnes accentuées (`connecté`, `archivé`, `diamètre`), donc lecture par `SELECT *` + pliage de clés et filtre `archivé = 0` en JS — mais **`SELECT *` y passe aussi sur Windows**, faute de colonne mémo-binaire : le quirk des zéro lignes est bien par table, pas général. Les écritures sont la moitié facile (tout est ASCII → `UPDATE` nommé classique, pas de réinsertion positionnelle), à une réserve près : le `SET` ne nomme **que** les colonnes de maintenance, parce que `nom`, `Jauge`, `nb_chutes*`, `vitesse` appartiennent à `FEN_Gestion_des_machines` (non porté) et que non-nommé conserve, nommé écraserait.

**Gardes.** `probe-maintenance-trm.ts` (lecture seule — **à rejouer après `/etm_deploy`**, c'est le seul test du chemin Linux) et `check-maintenance-trm.ts` (aller-retour PUT avec accents, 409 sur métier archivé, 403 sans le droit, vérification que les colonnes de `FEN_Gestion_des_machines` et les accentuées n'ont pas bougé, reset d'opération, tout restauré). 33/33 au vert.

**Aucun changement de comportement ETM** : nouveau routeur, nouvelle clé de droit, aucun fichier ETM existant touché hormis le montage dans `index.ts` et le manifeste `screen-keys-trm.ts` (renommage du libellé « Gestion des OF » → « Ordres de fabrication » et retrait de l'écran Atelier › Productivité, tous deux côté TRM).

## 2026-08-26 — feat/finance (les quatre widgets financiers relus, et le constat BFR)

Vincent, sur le tableau de bord financier : « in "Charges" what i really want is to quickly compare the charges of this year to the ones from last year. basically if charges fixes are at 50% at half the year then we're good, if less it's even better and if more there is a problem to investigate. the same goes for the charges variables but here more will typically mean that we worked more so it's not a bad thing. » Plus trois réglages sur les trois autres cartes. Tout est fait **ici** et re-copié dans TRM (branche jumelle `TRM-finance`), les widgets étant des miroirs verbatim.

**Charges — la carte ne montre plus le ratio brut comme verdict.** C'était le vrai sujet : « 23 % » en mars ne veut rien dire tout seul, parce que le montant N est un cumul YTD tandis que le montant N-1 est l'année ENTIÈRE (règle légataire : dernier upload tombant dans l'année civile). Le nombre utile est donc ce ratio **moins la part de l'année écoulée**, en points. D'où une jauge qui porte les deux quantités à la fois — remplissage = part consommée de l'enveloppe N-1, trait navy = le repère — si bien que tout ce qui est à gauche du trait est de l'argent pas encore dépensé. L'échelle est fixe 0→100 % de N-1 sur les deux cartes, sinon elles cessent de se comparer entre elles ; un dépassement remplit la jauge et c'est la pastille qui en porte l'ampleur. La pastille donne l'écart signé (flèche + signe + nombre, jamais la couleur seule) et son `title` porte la phrase complète plus une **projection de fin d'exercice au rythme actuel**.

⚠️ **Le repère se mesure à la date d'ARRÊTÉ, pas à aujourd'hui.** Le dernier upload peut avoir des mois (23/03 quand on est le 26/08) et c'est la date des *montants* qui doit borner la comparaison — prendre aujourd'hui ferait paraître le rythme faussement bon. Arithmétique en UTC de bout en bout : une `Date` construite à minuit local glisse d'un jour autour d'un changement d'heure, et le repère avec elle.

⚠️ **Fixes et variables ne partagent pas la même échelle de verdict, délibérément.** Les charges *fixes* portent l'échelle d'alerte (±3 pts « au rythme », jusqu'à +10 ambre « à surveiller », au-delà rouge « à investiguer », en dessous vert « sous le rythme »). Les *variables* n'en portent aucune : elles suivent l'activité, donc au-dessus du rythme veut d'abord dire qu'on a plus produit — ce que Vincent a dit explicitement — et elles prennent un bleu informatif dans les deux sens (« activité en hausse » / « sous le rythme »). Peindre les deux en rouge apprendrait au lecteur à ignorer la couleur sur les deux cartes. Les seuils sont en **points de pourcentage**, pas en euros, donc ils se lisent pareil sur un poste à 600 k€ et sur un poste à 10 k€. Un état `ralenti` a été ajouté après coup : sans lui, un poste variable cinq points sous le rythme affichait « au rythme », ce qui est faux.

**Le rapport, lui, garde le ratio brut** (`lib/depassement.tsx`, la pastille par compte de Rapports › Finance). « Ce compte a-t-il dépassé l'an dernier ? » et « sommes-nous dans les clous à cette date ? » sont deux questions différentes sur les deux mêmes nombres : ne pas les unifier sans trancher laquelle le rapport devrait poser.

**Chiffre d'affaires** ouvre désormais sur **Même période** (`period=ytd`) et non plus sur Année complète — la seule lecture honnête en cours d'exercice ; le mode legacy reste à un clic et redevient le bon sur un exercice clos, où les deux coïncident de toute façon.

**Évolution du CA — l'année en cours mène le graphe, et la légende disparaît.** La couleur est maintenant indexée sur la **récence** dans la liste complète (la plus récente = style 0, bleu accent plein, `STROKE_LEAD` 3,25 contre `STROKE_BACK` 1,75 à 0,72 d'opacité, tracée en dernier donc au-dessus) et non plus sur la position dans la liste croissante, qui laissait à l'exercice courant le violet pointillé — le moins lisible des cinq — et obligeait à chercher la ligne qui compte le plus. L'indexation reste calculée sur la liste **complète**, jamais sur les séries visibles, donc masquer une année ne repeint pas les survivantes. La **légende du bas est supprimée** (elle répétait ce que disent les pastilles et coûtait une rangée entière sur une carte de 420 px) et remplacée par une **infobulle au survol** listant le CA de chaque année visible pour le mois pointé, **classé** : la lecture devient « ce mois-ci, qui fait quoi » au lieu de « voici les couleurs ». Elle est positionnée dans l'espace pixel du plot (le SVG est dessiné à la taille réelle, donc les unités SVG *sont* des pixels CSS), bascule de côté passé le milieu et se borne verticalement, donc elle ne sort jamais de la carte. En « Annuel » il n'y a pas de pastilles : chaque barre porte donc son total au-dessus — le nombre que la légende tenait — au-dessus d'une cible de survol pleine hauteur. Le second canal exigé par le WARN CVD de la palette reste tenu : dash par année + pastilles nommées.

**Analyse financière** perd la mention permanente « Variation de stock estimée à … et intégrée » sous ses tuiles (elle annonçait un montant que rien d'autre sur la carte ne permettait de recouper, et coûtait une ligne sur un widget déjà dense). **Le calcul est intact** et porte toujours l'EBE affiché — `lib/variation-stock.ts` et `valorisation-stock.ts` ne sont pas touchés.

**Enfin, le BFR : question posée, réponse mesurée, sujet fermé.** Vincent a demandé un widget besoin en fonds de roulement. Sondage en lecture seule sur la base vivante plutôt que déduction — et c'est non, avec trois faits qui ferment le sujet, désormais consignés dans `CLAUDE.md` § BFR / bilan : **`compte_compta` ne contient aucun compte sous 600000**, ni société 1 ni société 2 (les 84 lignes de relevé du dernier arrêté sont toutes en classe 6 ou 7 — ce que dépose l'expert-comptable est un compte de résultat, pas un bilan : pas de 411, pas de 401, pas de 3x) ; **`facture` n'a que 14 colonnes et pas une n'est un règlement**, donc un encours client ne peut être que théorique ; **aucune facture fournisseur dans les 204 tables**, et `fournisseur` n'a même pas de conditions de paiement. Un widget étiqueté « BFR » afficherait donc un nombre qui n'en est pas un, et faux dans le sens dangereux — gonflé, faute du financement fournisseur, qui n'est pas un arrondi (achats 60→62 : 669 857 € au 23/03/2026). Les trois sorties possibles sont classées dans la note, la meilleure étant de demander à l'expert-comptable d'ajouter les classes 3/4/5 à son export : le BFR deviendrait exact sur la machinerie `finance-common.ts` déjà en place. Les cinq scripts de sonde écrits pour l'enquête ont été supprimés — la branche ne porte que le travail demandé plus le constat.

⚠️ Note de méthode consignée au passage : la **copie dev s'arrête au 24/03/2026 pour `facture`** alors que les commandes y vont jusqu'au 24/08. Un encours théorique calculé dessus sort à 0 € — artefact du jeu de données, pas du calcul. Ce genre de vérification doit se faire sur la prod.
## 2026-08-26 — feat/cmd-client (tarif suggéré des lignes de commande client TRM)

Vincent : « in clients/commandes, when i create a new line, there is a price difference between TRM pwa and the legacy app ». L'écran proposait **2,88 €** là où le WinDev en propose **2,01 €** sur la même référence (005, 100 kg).

**L'enquête, parce que le rapport 0,7 entre les deux chiffres est un piège.** 2,88 × 0,7 = 2,016 : on lit « la marge de 30 % est appliquée en trop ». Faux. Le legacy **ne calcule rien** sur cette fenêtre — l'événement « sélection d'une ligne » de `COMBO_Reference` dans `FEN_Gestion_d_une_référence_de_commande_client` ne nomme que deux identifiants, `ref_ecru` et `prix`, et s'arrête là (récupéré du cache de compilation WinDev `MPS.cpl/<user>/00000000/<Window>.<hash>.wdw.wcw`, lisible même quand le `.wdw` est PCS-compressé). Le 2,01 € est donc `ref_ecru.prix` nu, et la coïncidence vient de cette référence-là : revient 2,0158 ≈ base 2,0125. Les arrondis les départagent (2,02 vs 2,01), et c'est 2,01 qui s'affiche.

**La règle retenue.** `ref_ecru.prix` est la **base sûre**, un plancher sur le *coût* : le tarif suggéré devient **`max(revient ; base) / 0,7`** au lieu de `max(revient / 0,7 ; base)`, donc la plus haute des deux assiettes porte les 30 % et une commande client TRM ne sort jamais sous base + 30 %. Les deux lectures coïncidaient précisément sur la référence testée, ce qui est pourquoi le cas ne l'exposait pas : sur les 51 références utilisées par les commandes natives, elles divergent sur 40 à 100 kg (réf. 63 : 2,45 € contre 3,50 €).

**Ce qui ne bouge pas, et pourquoi.** `prixDeRevientTRMDetail` prend un paramètre `TrmBaseRole` (`'price-floor'` par défaut = la règle legacy, `'cost-floor'` = la nouvelle) et expose `retainedFrom`, via un unique helper `retain()` que les deux chemins du breakdown traversent. **`trmLinePrix` reste sur le défaut** : il price les lignes de sous-traitance ETM → TRM, qui doivent continuer à coller au WinDev qui les écrit encore — vérifié 15/15 sur les miroirs récents, dont la réf. 4 @500 kg stockée à 2,07 €, la base nue sans marge. Basculer le défaut renchérirait ce prix de transfert intercompany de **~+39 %** en valeur ; d'où le refus délibéré d'unifier les deux règles, et `pricing-trm.test.ts` (10 tests purs, sans base) qui les épingle toutes les deux.

**Côté API.** `/commandes-trm/lookups/line-price` renvoie `base` et `retenu` en plus de `prix`/`cout`, pour que le dialogue TRM dise d'où vient le chiffre au lieu d'afficher un prix nu. Aucun changement de comportement ETM : `trmLinePrix`, la fenêtre « Coût de tricotage » (`/references-ecru/:id/cout-tricotage`) et l'écriture des lignes sst sont inchangées — la seule différence observable côté NG est la correction de la règle dans `CLAUDE.md`, qui affirmait l'inverse.

## 2026-08-26 — feat/siren (champ SIREN sur la fiche client — ticket #1088)

Isabelle : « il faudrait mettre un champ siren dans la gestion client afin que je puisse commencer à le mettre car c'est ce numéro qui sera le plus utile pour la facturation électronique. » Vincent avait déjà créé la colonne `client.siren` en base ; cette branche l'expose.

**Le champ.** Clients › Gestion → Info → carte Facturation, « N° SIREN » sous le N° TVA (les deux identifiants légaux ensemble, ordre choisi par Vincent). Lecture groupée par 3 (`552 100 554`), saisie normalisée en chiffres seuls — un collage `552.100.554` passe.

**Validation calibrée sur l'usage réel : le champ est FACULTATIF.** La colonne se remplit client par client (619 clients ETM, 0 renseigné aujourd'hui), donc un champ vide est un état normal, pas une erreur. Seule une valeur non vide est contrôlée — exactement 9 chiffres, sinon bordure rouge, `Enregistrer` grisé et sortie d'édition bloquée par le même `infoIssue` que le compte 411, plus un 400 `siren_invalide` côté serveur. Un collage de SIRET est nommé pour ce qu'il est (« 14 correspond à un SIRET, gardez les 9 premiers ») plutôt que tronqué en silence.

⚠️ **La clé de Luhn est un avertissement ambre, jamais un refus.** Elle attrape les transpositions de chiffres, ce qui vaut cher quand un SIREN faux = une facture rejetée par le PPF. Mais le registre a porté des identifiants qui ne la vérifient pas, et refuser une saisie légitime coûterait plus cher que la faute qu'on attrape. (En passant : l'exception « La Poste » souvent citée porte sur le **SIRET**, pas sur le SIREN — le test unitaire écrit d'abord sur cette croyance a échoué et a été corrigé.)

**Portée volontairement tenue.** La colonne est nommée par la seule fiche ETM : `clients-trm.ts` ne la touche pas, donc une sauvegarde TRM la laisse intacte (l'invariant des deux fiches) — l'ajouter côté TRM sera une édition séparée. Et le SIREN **ne part sur aucun document** : la facturation électronique elle-même reste une feature à part, cette branche ne fait que rendre la donnée saisissable, ce que demandait le ticket.

**Vérifications.** Colonne sondée sur la copie dev avant d'écrire quoi que ce soit : texte, ≥ 20 caractères, donc aucun risque de troncature silencieuse à 9. `check-siren.ts` audite les valeurs stockées (longueur, clé) et, en `--roundtrip`, conduit la vraie route : PUT « 552 100 554 » → stocké `552100554`, PUT « 12345 » refusé sans écraser la valeur en place, PUT « » vide le champ, valeur initiale restaurée. Test unitaire `siren.test.ts` (8 cas) sur la normalisation, la longueur et la clé.
## 2026-08-26 — feat/bug (ticket #1089 : les écrans de stock ne se rafraîchissaient pas)

Pierre-Emmanuel transfère trois pièces finies de MATEL vers Ets Malterre, va sur Finis › Stock, et les voit toujours au magasin d'origine — puis « ça s'est réparé tout seul ». Les deux moitiés du symptôme désignent la même cause : **rien n'était cassé en base, le transfert avait bien eu lieu**, c'est l'écran qui rejouait sa liste d'avant.

**La cause.** Le `staleTime` global est de 5 minutes (`main.tsx`). `TransfertsScreen` n'invalidait que `['transferts']` et `['transfert-available']`, jamais `['stock-fini']` — alors que l'ajout d'une pièce à un bon déplace le stock **immédiatement** (`est_valide` ne conditionne pas le mouvement, cf. la règle legacy). Arriver sur Finis › Stock resservait donc le cache d'avant le transfert, et l'expiration au bout de cinq minutes produisait la « réparation spontanée ».

**L'audit a montré que le trou était bien plus large que les transferts : seuls les quatre écrans de stock invalidaient leur propre cache.** Tous les autres écrans qui écrivent du stock le laissaient périmé — Expéditions (rouleau ↔ ligne d'avis, suppression d'avis, articles divers), Commandes client (réservation de rouleau), Gestion › Marchandise (retour stock — le flux du ticket #1086), et Sous-traitants › Commandes, où la **réception crée** des lignes `stock_ecru`/`stock_fini` que la liste en cache n'a jamais vues.

**Le correctif, en deux moitiés**, dans le `lib/cache-sync.ts` existant, à côté de `invalidateLotQualityCaches` :

1. **`invalidateStockCaches(queryClient)`**, câblé sur les onze points de mutation des six écrans écrivains. Appelé inconditionnellement et sur toutes les familles : `invalidateQueries` ne refetch que les requêtes ayant un observateur monté, donc nommer une famille qu'aucun écran n'affiche ne coûte rien — et un bon de rouleaux porte de l'écru **et** du fini.
2. **`STOCK_QUERY_FRESHNESS`** (`staleTime: 0` + `refetchOnMount: 'always'`) répandu dans les requêtes liste et détail des quatre écrans de stock, pas dans leurs lookups. C'est la moitié que l'invalidation **ne peut pas** couvrir : **l'application WinDev légataire écrit ces mêmes tables en direct**, comme les sessions des autres utilisateurs, et rien dans ce navigateur ne peut le savoir.

**Le coût est réel et assumé** : une requête par arrivée sur un écran de stock (mesuré sur l'API dev — fini 1,1 s / 1 Mo, écru 2,2 s, fil 1,3 s, divers 0,2 s). Mais l'écran ne se vide jamais : les quatre rendent sur `isLoading` et jamais sur `isFetching`, donc le tableau en cache s'affiche instantanément et se corrige derrière. Une requête par navigation n'est pas le motif de rafales concurrentes qui met le pont HFSQL en difficulté.

Garde : `apps/web/src/lib/cache-sync.test.ts` diffe `STOCK_QUERY_ROOTS` contre toutes les clés `['stock-…']` de l'application (une future famille de stock ne peut plus échapper au helper — vérifié en retirant une racine : le test tombe), et épingle le comportement au remontage contre un vrai `QueryClient` portant le défaut de 5 minutes, en affirmant **à la fois** que l'ancienne configuration rejoue la liste périmée (1 fetch) et que la nouvelle relit (2 fetches) — le test ne peut donc pas passer à vide.

Signalé sans le corriger, hors périmètre du ticket : changer le magasin de destination d'un bon **après** y avoir mis des pièces ne déplace pas ces pièces (`PUT /transferts/:kind/:id` n'écrit que l'en-tête, `transferts.ts:690`) — elles restent à l'ancienne destination. C'est une question de données, pas de cache.

## 2026-08-26 — feat/finance (l'EBE se calcule sur l'exploitation seule)

Vincent, en confrontant le widget Analyse financière au bilan 2025 : « je vois un EBE de 353 466 €, ça ne colle pas avec le compte de résultat ». Le compte de résultat en porte **314 422 €**. Il avait raison, et l'écart se décompose en deux moitiés très différentes.

**Le bug (6 100 €).** Le calcul découpait le plan comptable en « classe 6 = charge / classe 7 = produit ». C'est trop large : l'EBE s'arrête **avant** le financier, l'exceptionnel et les dotations, et ces postes entraient donc dans un agrégat défini comme s'arrêtant avant eux — escomptes obtenus 8 011 €, escomptes accordés 1 562 €, dons 350 €. Le périmètre est désormais borné aux **charges d'exploitation (PCG 60-64)** et aux **produits d'exploitation (70-74)**. Le CA n'est plus `upload_compta.produits`, qui somme toute la classe 7 ; il est recalculé sur `releve_compta`, l'upload ne servant plus que de repli quand aucune balance n'est déposée à la date de l'arrêté — vérifié qu'en relâchant la borne, le recalcul reproduit `upload_compta.produits` **au centime sur les 57 arrêtés ETM et les 58 de TRM**, donc même source, seul le périmètre change.

**Le calage qui prouve tout.** 2025 n'est pas comparable (voir plus bas), mais **2024 l'est** : exercice clos. L'EBE recalculé donne **269 613 €** contre **269 982 €** au compte de résultat — 369 € de résidu. Cette année-là l'erreur valait 40 040 €, le compte 768000 portant 33 896 € de produits financiers. C'est ce calage qui valide le périmètre ; toute retouche de la formule doit le refaire.

**La limite acceptée (32 944 €).** Le dernier arrêté d'un exercice est celui de fin décembre (22/12/2025) ; les écritures de clôture de l'expert-comptable — cut-off, régularisations, variation de stock définitive, subventions — **ne remontent jamais dans l'ERP**, et l'upload du 05/01/2026 porte encore les mêmes chiffres d'avant clôture. Aucun code ne peut rattraper ça : l'information n'existe pas en base. Décision Vincent : le widget estime en continu, le bilan fait foi.

**Le périmètre s'applique aux DEUX surfaces**, la série ET la balance de Rapports › Finance, pour tenir l'invariant « le widget suit l'écran » que le guard épingle depuis le 25/08. Quelques comptes hors exploitation quittent donc aussi le tableau du rapport (ETM 665000 / 670000 / 671200 / 671300, 1 914 € sur 2025 ; TRM 661000 / 670000 / 671200, 146 €) — arbitré explicitement plutôt que subi : l'alternative laissait les deux écrans diverger de ~1 900 € en silence.

**Une erreur de doc corrigée au passage.** CLAUDE.md et le libellé du widget affirmaient qu'ETM avait 178 359 € de « production stockée » en 2024. C'est faux : la case **FM** du 2052 est vide en 2023, 2024 **et** 2025 ; ces 178 359 € sont la case **FP, reprises sur amortissements et provisions**. La mention est retirée de l'écran. Ce qui manquait réellement à l'EBE intermédiaire, c'est la variation de stock du compte de charge **603700**, déjà estimée depuis la veille.

`check-finance-analyse-buckets.ts` épingle désormais le périmètre en plus de l'égalité des charges : aucune ligne hors 60-64 dans le rapport, CA de l'analyse strictement égal aux comptes 70-74 de la balance. Vert sur les deux sociétés × trois années.

## 2026-08-25 — feat/valorisation-4-types (variation de stock estimée dans l'EBE)

Suite de la même session. Vincent : « en regardant mon EBE trop bas et ce widget, comment tu conclus que c'est parce que j'ai augmenté mon stock ? » — question juste, le widget montrait un **niveau** quand la conclusion demandait une **variation**. Le croisement des deux méthodes a révélé que mon estimation par les flux **surestimait l'effet stock de 108 k€** (168 k€ annoncés contre 59 k€ réels) : elle valorisait au coût variable moyen au kilo *produit* des kilos encore à l'état d'écru, à ~6 €/kg et non ~14 €/kg.

**Trois apports.**

1. **Valorisation étendue aux quatre types** (fil, TM disponible, TM en ennoblissement, fini) à partir des sept inventaires légataires fournis. Ancrage : les quatre rapports du 27/12/2024 reproduisent EXACTEMENT `inventaire_compta` au 28/12/2024, et le total se raccorde au bilan 2025 (ERP 581 921/312 793 + escrime hors ERP 57 600/13 935 = 639 521/326 728). Le fil a son propre barème — exemption 100 % élasthanne, règle petit lot, échelle à quatre crans — et son ordre est signifiant. Le fil confié (46 lots, 8 201 kg : Hermès, La Gentle Factory…) est exclu : il est dans nos murs, pas à notre bilan.

2. **Série `inventaire_compta` amorcée.** Elle s'était arrêtée le 28/06/2025. L'arrêté du 28/12/2024 était déjà en base ; celui du 31/12/2025 a été écrit depuis les rapports (`seed-inventaire-compta.ts`, contrôle bilan avant écriture, `--revert` disponible). Avec deux photos, la variation devient une soustraction : **+59 411 € au 25/08/2026**, contre −49 755 € sur l'exercice 2025.

3. **L'estimation entre dans l'EBE**, sur le compte 603700 (seul compte de variation du plan ERP, et charge variable) plutôt que dans un widget de plus — choix de Vincent, plus simple et au bon endroit. Badge « estimation » sur la ligne du rapport, mention factuelle sous les tuiles de l'Analyse financière, et la correction irrigue la courbe mois par mois.

**Propriété de sûreté centrale : l'estimation ne s'applique que si le compte est à zéro.** À la clôture, l'écriture réelle reprend la main d'elle-même. Rien à nettoyer.

Deux pièges corrigés en route : la base doit être une **clôture d'exercice** (sinon une série arrêtée en juin fait porter à l'année suivante une variation de quatorze mois, fausse et crédible), et le dernier mois actif se lit sur les **mouvements** et non sur le cumul (qui reste non nul une fois démarré, donc renvoie toujours décembre). L'interpolation mensuelle est **bornée à ses deux extrémités** : la forme brute dépassait le point d'arrivée de moitié.

Limites assumées et affichées : l'escrime reste hors périmètre (57 600 € brut fin 2025, montant connu), le métrage du type Fini est irrécupérable au 31/12/2025 donc l'arrêté amorcé est en kilos pour les quatre types, et les mois intermédiaires sont une répartition plausible — l'arrêté mensuel les rendra exacts.

## 2026-08-25 — feat/valorisation-4-types (la valorisation du stock passe aux quatre types)

Le widget livré le matin ne couvrait que les rouleaux finis — moins de la moitié de l'assiette. Vincent ayant fourni les sept inventaires légataires manquants (2024 et 2025 pour fil, TM dispo, TM en ennoblissement, fini), le calcul couvre désormais **les quatre types**, avec la méthode de son expert-comptable.

**La reconstitution est ancrée, pas devinée.** Les quatre inventaires imprimés au 27/12/2024 reproduisent EXACTEMENT la ligne `inventaire_compta` du 28/12/2024 — Fil 199 090/122 891, TM dispo 56 372/27 937, TM en cours 44 236/43 469, Fini 331 978/179 142. Et la boucle se ferme jusqu'au bilan 2025 : les quatre types donnent brut 581 921 / net 312 793, l'escrime hors ERP 57 600 / 13 935, total 639 521 / 326 728 — les chiffres exacts du bilan. **L'escrime manquant est donc un montant connu, pas une inconnue**, et le widget l'affiche.

**Deux barèmes, et le fil a le sien.** Fini / TM dispo / TM en cours partagent 2ᵉ choix −90 % · < 1 an 0 % · 1-2 ans −50 % · > 2 ans −90 %. Le fil ajoute une **exemption 100 % élasthanne** (qui prime sur tout), une règle **petit lot** (< 100 kg **et** > 1 an → −90 %, évaluée avant l'échelle d'âge) et une échelle à quatre crans (0 / −50 / −75 / −90). L'ordre des règles est signifiant et le code le suit littéralement.

**Populations.** Fil = `stock > 0` **et `IDclient = 1`** — le fil confié (Hermès, La Gentle Factory, SIGVARIS… 46 lots / 8 201 kg) est dans nos murs mais **pas à notre bilan**. TM = écru ETM non expédié et sans enfant `stock_fini`, scindé sur **`IDref_commande_affectation`** et non sur le magasin : MATEL figure dans les deux inventaires imprimés, donc le magasin est orthogonal au critère.

Trois pièges HFSQL traversés : `asso_fil_matiere` et `matiere_premiere` portent des identifiants **accentués** que le pont Linux refuse (→ `SELECT *` + `pickKey`, vérifié en exécution réelle sur le serveur de prod), `stock_fil` porte des **memos binaires** qui font renvoyer 0 ligne à `SELECT *` sur Windows (→ colonnes nommées), et `asso_fil_matiere.pourcentage` est une **fraction** (0,31 = 31 %) là où `composition_ecru.pourcentage` est en centièmes.

Le widget rend le taux de provision par une **barre net/brut** plutôt qu'un feu tricolore : les seuils « bon / mauvais » sont une décision de gestion qui n'a pas été prise, et inventer un vert à 30 % dirait au lecteur une chose que personne n'a arbitrée.

Garde : `check-valorisation-stock.ts` — cohérence interne, application des deux barèmes, populations recomptées en SQL, exclusion du fil confié, et refus des tranches dégénérées (la régression du parseur de dates : `date_saisie` revient en TIMESTAMP, `dateDigits` renvoie `''` partout et range tout le stock à 90 %).

## 2026-08-25 — feat/fix-sstatut-encoding (isLineDone compare le préfixe ASCII)

`isLineDone()` comparait à `'Terminé'` accentué, alors qu'ODBC renvoie la valeur en `Termin�`. Toute ligne réellement terminée était donc **fausse** dès que la requête d'origine n'avait pas passé `fixEncoding` — mesuré sur la table vivante : **0 ligne reconnue sur 7 257**, alors que 4 619 portent ce statut.

Le dégât réel était sur `commandes-sous-traitant.ts:860` : l'échéance « ouverte » la plus proche de chaque commande était calculée **en incluant les lignes déjà terminées**. **4 228 commandes sur 7 247** en héritaient d'une échéance qui n'existait plus, et le liseré rouge « en retard » (`mps_designer §30`) s'allumait sur **6 651 commandes au lieu de 2 423** — l'indicateur d'urgence criait au loup sur des commandes intégralement soldées.

Le second site suspecté (`:264`, `maybeAutoCloseCommande`) s'avère **du code mort** : l'auto-clôture a été retirée au profit du bouton Clôturer manuel. Vérifié avant de livrer, précisément parce qu'un correctif qui « réveille » une fermeture automatique sur 4 609 commandes n'aurait pas été anodin.

Le correctif est un **préfixe ASCII** (`startsWith('Termin')`) plutôt qu'un `fixEncoding` ajouté à chaque appelant : il est correct que la valeur ait été réparée ou non. Sans ambiguïté — sur les 12 valeurs distinctes en base, **une seule** commence par « Termin ». Même raisonnement que `SUPPLY_NOT_DONE` dans `commandes-client.ts`, qui filtre `NOT LIKE 'Termin%'` en SQL pour la même raison. Test unitaire `lib/sst-shared.test.ts` qui épingle les 12 valeurs **telles que le driver les renvoie**.

## 2026-08-25 — feat/finance-stock (Valorisation du stock fini + portée de l'Analyse financière)

Le tableau de bord ne pouvait pas montrer la valeur du stock. `upload_compta`, que lit l'Analyse financière, **ne porte ni la production stockée ni les provisions** — vérifié sur deux exercices : en 2024 la production stockée valait 178 359 € pour un résultat d'exploitation de 180 614 €, soit **la totalité du résultat** ; en 2025, 1 509 €. Conséquence concrète : l'EBE de juillet 2026 se lisait comme un effondrement (−133 k€ sur un an) alors que **146 k€ de production non vendue** en portaient 82 % — l'entreprise produisait 15 % de plus en n'expédiant que 4 % de plus, et la clôture annuelle redresse cet écart. En parallèle, un stock passé de **37 % à 49 % de taux de provision** entre 2024 et 2025 n'apparaissait nulle part dans l'app.

**Analyse financière** gagne donc une mention de portée **permanente** sous ses tuiles (« Hors production stockée et provisions, comptabilisées à la clôture annuelle ») — pas une infobulle : c'est précisément son absence qui a fait mal lire le chiffre.

**Nouveau widget « Valorisation du stock fini »** — valeur d'achat, valeur dépréciée, taux de provision et répartition par ancienneté. Port de la requête légataire de dévalorisation (2ᵉ choix −90 % · moins d'un an 0 % · 1-2 ans −50 % · plus de 2 ans −90 %), validé à **+1,6 %** contre l'inventaire imprimé au 31/12/2025 (20 966 kg / 287 945 € contre 21 039 kg / 283 526 €). Le coût est **fil + façon tricotage + ennoblissement**, le fil au prix réellement payé (`ref_fil_commande.prix_unitaire`) et **jamais** au catalogue `ref_fil.prix_kg` — l'erreur donnait 6,44 €/kg au lieu de 13,48 ; le poids vient de `stock_ecru.poids`, pas de `stock_fini.poids`.

⚠️ **Portée assumée : rouleaux FINIS seulement**, et le widget le dit. Les règles Fil / TM dispo / TM en cours n'ont pas été retrouvées ; au 28/12/2024 le fini pesait 179 142 € sur 373 439 € de stock net. ⚠️ **Le calcul ne peut décrire que MAINTENANT** (colonnes d'état courant + dépréciation depuis `SYSDATE`), donc les 14 mois manquants d'`inventaire_compta` — le mécanisme légataire mensuel, arrêté le 28/06/2025, qui se rapprochait du bilan **à l'euro près** — ne sont pas rejouables.

Piège corrigé au passage : **`stock_fini.date_saisie` est un TIMESTAMP**, donc `sst-shared.dateDigits` (`/^d{8}$/`) renvoie `''` sur **toutes** les lignes ; une chaîne vide perd toute comparaison `>` et rangeait l'intégralité du stock dans « plus de 2 ans » à 90 % de provision — un chiffre plausible, pas un plantage. Garde : `check-valorisation-stock.ts`, qui échoue si une seule tranche est peuplée.

## 2026-08-25 — feat/debug (Marchandise expédiée : recherche, tri, pagination + retour en stock réparé)

Deux tickets sur **Clients › Gestion › Marchandise expédiée**.

**#1086 — « trois pièces retournées n'apparaissent dans aucun stock ».** « Expédié » est **deux faits indépendants** sur `stock_fini` : `IDligne_expedition > 0` **et** `IDetat_stock_fini = 4`, ce second étant posé par la routine d'expédition WinDev sur quasiment tout rouleau expédié (45 708 des 46 297 en prod). Tous les prédicats « est-ce encore en stock » testent les deux, donc ne libérer que la ligne d'expédition faisait tomber le rouleau dans un trou **sans aucun écran** : sorti de Marchandise expédiée (son INNER JOIN a besoin de la ligne), jamais entré dans Finis › Stock (état 4), jamais entré dans le pool libre d'une commande (état 4 + toujours réservé) — et l'écru ne rattrape rien, `stock-ecru.ts` excluant tout écru ayant un enfant `stock_fini`. `retour-stock` défait désormais les trois : ligne d'expédition → 0, état 4 → 3 (« Validé », et **seulement** depuis 4, pour qu'un autre état reste la classification du magasin), `IDligne_commande_client` → 0. Ce dernier est ce qui remet le rouleau dans le pool libre ; la commande d'origine se relit alors comme sous-livrée, ce qui est correct — la marchandise est revenue. Le dialogue de confirmation le dit, au lieu de promettre un retour dans Finis › Stock qu'il ne pouvait pas tenir.

**#1085 — « une recherche par numéro de pièce, ou un tri ? Et si la pièce est antérieure aux 400 ? »** La liste était un `TOP 400` nu : une pièce expédiée il y a longtemps était introuvable, donc **non retournable**. Mesuré sur la copie dev : 379 clients ont des rouleaux expédiés, 15 dépassent 400, et le plus gros (client 231) avait **7 932 de ses 8 332 pièces hors d'atteinte**. Le plafond n'a jamais été une question de coût de requête — ce client se lit **sans plafond en ~230 ms** — mais de taille de payload et de rendu. L'endpoint lit donc tout l'historique, applique recherche et tri **côté serveur**, et sert une page à la fois : `?q=` (chaque terme doit toucher la ligne sur pièce / lot / réf / coloris / n° d'expédition, accents repliés, termes purement ponctuation ignorés — une ligne collée depuis un ticket retrouve le rouleau), `?sort=&dir=` sur n'importe quelle colonne, `?limit=&offset=` par pages de 200 **après** recherche et tri (40 Ko la page au lieu de 1,65 Mo). ⚠️ **Les numéros de pièce se trient en comparaison naturelle** : 3378/51 avant 3378/1007, qu'une comparaison de chaînes met à l'envers. Le tri est **total** (tie-break `IDstock_fini`) donc les pages pavent l'ensemble exactement — vérifié sur 42 pages de 200 pour 8 332 lignes, sans trou ni doublon, chez un client portant 11 numéros de pièce en double. Chargement paresseux au défilement (`useInfiniteQuery` + sentinelle `IntersectionObserver` **rootée sur le conteneur de scroll**, pas le viewport : la table défile en interne). L'ancre du Shift+clic (`mps_designer §44.1`) passe d'un **index de ligne** à un `IDstock_fini`, la liste grandissant et se re-triant sous l'utilisateur.

Gardes : `check-retour-marchandise.ts` (audit, `--roundtrip`, `--repair` — passé en prod : 3378/51, 3378/1007, 3378/29 sont de nouveau en stock, Validé et libres) et `check-marchandise-search.ts`.

## 2026-08-25 — feat/issue-tracker (suivi par email — widget tickets v1.2.0)

Le widget de tickets passe en **1.2.0** : le rapporteur peut demander à être **notifié par
email à chaque changement de statut** de son ticket. Une case « Me tenir informé par
email », **décochée par défaut**, sur le formulaire ; un interrupteur §35 dans la fiche du
ticket pour changer d'avis après coup — c'est là que le besoin apparaît, après une semaine
sans nouvelles, pas au moment de la saisie.

**Rien n'est stocké ici.** Le drapeau vit dans le tracker LIVA (`bugs.follow_up`), comme le
ticket lui-même : une seule source de vérité pour « suis-je abonné », et zéro schéma HFSQL
à toucher — la même contrainte dure que la pastille non-lu respecte déjà. La conséquence
côté web : l'interrupteur **attend la réponse** avant de bouger. Un contrôle qui bascule de
façon optimiste et revient en silence est pire qu'un contrôle qui met 200 ms.

Côté API, une seule route nouvelle sur la factory `tickets.ts` (donc montée sur les deux
mounts) : `PATCH /:id/follow`, avec **le même contrôle de propriété que le détail et les
pièces jointes**. Ce n'est pas de la ceinture-bretelles : la clé API du tracker est
*company*-scoped, pas *reporter*-scoped, donc sans cette vérification n'importe quel
collègue pourrait s'abonner au ticket d'un autre. Le corps est validé par zod
(`{follow_up: boolean}`), jamais pipé tel quel.

⚠️ **`follow_up` doit rester hors de `ticketSignature()`.** S'abonner à un ticket n'est pas
une nouvelle *sur* ce ticket : l'inclure dans la signature allumerait la pastille non-lu à
chaque bascule de l'interrupteur, sur le ticket que l'utilisateur vient justement d'ouvrir.

Le déclencheur est le **statut, et seulement le statut** — une réponse développeur ou une
retouche interne n'envoie rien, et la réponse voyage dans l'email du changement suivant. La
clôture automatique à la publication d'une version en fait partie, donc « votre correctif
est en ligne » arrive gratuitement. Le mail ne contient **aucun lien vers le dashboard** :
les rapporteurs n'y ont pas accès, il les renvoie vers « Mes tickets » dans leur propre app
et leur dit comment se désabonner.

Garde HTTP : `apps/api/src/scripts/check-tickets-follow.ts` (POST avec `follow_up`,
aller-retour PATCH dans les deux sens, rejet d'un non-booléen, 404 sur le ticket d'autrui).
Elle **crée un vrai ticket `[CHECK]`** sur le tracker visé — pointer l'API dev sur un
tracker local avant de la lancer, sinon elle laisse une entrée sur le board LIVA.

⚠️ **Dépendance de déploiement, dans cet ordre** : tracker LIVA (migration `follow_up`) →
API partagée (`/etm_deploy`) → web. Le tracker a été **déployé le 2026-08-25** (repo
`admin-liva/issue_tracker`, alembic `c3d4e5f6a7b8`), donc la dépendance est levée. Contre
un tracker plus ancien, la case partirait avec le POST sans effet et l'interrupteur 404 —
le widget promettrait des emails que personne n'envoie.

Spec de référence mise à jour en même temps : skill `issue_tracker_integration` v1.2.0
(CONTRACT.md § Follow-up notifications + `references/react/follow-up.tsx`).
## 2026-08-25 — feat/prime (la semaine de la Prime TRM ne liste plus que les déclassements)

Le tableau qui remplit la colonne sous le bloc taux, dans la carte « Analyse des
déclassements » de `Production › Prime` (TRM), listait **tous** les défauts relevés par le
visitage sur la semaine, les deux choix — au motif qu'un défaut n'est pas un déclassement.
Il vit pourtant dans la carte des déclassements, et ce que l'atelier veut y lire c'est ce
que la semaine a coûté. Il est donc désormais limité aux pièces 2nd choix, **une ligne par
rouleau** (l'unité qui coûte de l'argent) et non plus une ligne par défaut, avec son manque
à gagner (`poids × 0,20 €`, même base que `DeclassementType.montant` et que la tuile
Production 2nd Choix). Les défauts de la pièce descendent sur une seconde ligne, doublons
repliés en `×N`.

Côté API (`routes/prime-trm.ts`), `fetchDefautsSemaine` devient `fetchDeclassementsSemaine`
et `semaine.defauts` devient `semaine.declassements`. Le point important est le prédicat :
la requête passe par le `periodWhere(1, monday)` partagé, donc **exactement la population
que `semaine.secondChoix` somme**. Les lignes totalisent toujours la tuile — y compris les
pièces déclassées **sans** ligne `defaut_qualite`, qui gardent leur ligne (« Aucun défaut
relevé ») au lieu d'être jetées comme avant. Un filtre « doit porter un défaut » ferait
diverger silencieusement la colonne et la tuile ; c'est l'invariant à ne pas casser.

Vérifié sur la semaine du 16/02/2026 de la base dev : 41 pièces, 227,80 kg, 45,56 € —
réconcilie à la virgule avec `semaine.secondChoix`. Le PDF (`PrimePdf.tsx`) ne touchait pas
ce champ et est inchangé : c'est le document de paie, pas la vue ops.

## 2026-08-25 — feat/rapport-finance (l'écran Rapports › Finance sert aussi TRM)

L'écran ETM `Rapports › Finance` est désormais **le même fichier** dans les deux apps :
TRM l'importe par son alias `@etm` et lui passe `basePath="/rapports-trm/finance"`. Un
seul ajout côté web ETM — une prop `basePath` optionnelle (défaut `/rapports/finance`) qui
préfixe les trois appels API. C'est le pendant frontend de ce que `FinanceScope` est côté
backend, et la **seule** différence entre les deux montages : les imports `@/` d'un écran
partagé se résolvent dans le `src` de l'app qui l'importe, donc les composants, le
`PermissionsContext` et les clés de droits sont ceux de TRM sans rien paramétrer.

Côté API, **aucune reprise des handlers** : les widgets financiers avaient déjà monté
`createFinanceRouter(FINANCE_SCOPE_TRM)` sur `/api/rapports-trm` (c12b0e3), et l'écran lit
exactement ces endpoints. Le landing tenait donc aux deux modifications que ce scope
attendait — `view_rapport_finance` rejoint `financeKeys`, `editComptesKey` allume les
routes du tiroir. `dashboard_charges` **reste** dans `financeKeys` (c'est un any-of) : l'en
retirer viderait silencieusement la carte Charges de qui ne tient que ce droit. Deux clés
TRM ajoutées : `view_rapport_finance` et `edit_compte_description` (sous-droit), catégorie
« Rapports », mêmes noms que le catalogue ETM — même action, magasins séparés.

⚠️ **Faille corrigée au passage** : `GET /finance/comptes/:id/historique` n'avait pas le
contrôle d'appartenance que le PATCH voisin avait déjà. `releve_compta` ne porte pas
d'`id_societe` — l'id du compte est le seul porteur de la partition — donc la route était
inoffensive tant qu'ETM la montait seule, et devenait une lecture inter-société le jour où
un second scope la montait. Règle promue dans CLAUDE.md : sur une factory partagée, **toute
route atteinte par un `:id` d'URL vérifie la partition de cette ligne, dans chaque
handler**. Garde HTTP : `scripts/check-finance-comptes-trm.ts` (historique + aller-retour
PATCH + les deux 404 inter-partition).

Côté TRM enfin, le menu Rapports perd ses quatre placeholders (Production, Lots de fils,
État stock fil, Analyse) et n'a plus que Finance — d'où `screen-keys-trm.ts` mis à jour
pour rester le miroir de `navigation.ts` (`check-screen-access-trm.ts` le vérifie). Comme
Finance est l'unique écran du menu, l'entrée porte `permission: 'view_rapport_finance'`
en plus du grant `screen_rapports` : sans le droit, c'est le **menu entier** qui disparaît.

## 2026-08-25 — feat/prime (défauts de la semaine + régleurs dans la répartition)

Deux changements sur `/api/prime-trm`, servant la refonte de la mise en page de l'écran
Production › Prime côté TRM.

**1. Nouveau champ `semaine.defauts[]`** — chaque ligne `defaut_qualite`
(`Type_Reference = 2`) relevée au visitage sur une pièce saisie depuis le lundi
(fenêtre ouverte, comme les sommes de la semaine). **Les deux choix, volontairement** :
un défaut n'est pas un déclassement, une pièce de 1er choix en porte aussi, et la table
répond à « qu'a vu le visitage cette semaine », pas à « qu'est-ce qui a été déclassé »
(c'est le rôle de `declassements.types`). Une semaine ≈ 50 pièces, donc le coût est
négligeable. Le métier est résolu **en deux sauts** (`stock_ecru` → `ordre_fabrication`
→ `machine`) avec des projections explicites : ni `machine` ni `ordre_fabrication` ne
peuvent être lues en `SELECT *` ni voir leurs colonnes accentuées nommées.

⚠️ **`defaut_qualite.taille_cm` n'est pas en centimètres** (découverte de ce lot, promue
dans CLAUDE.md) : 25 pour « Moins de 50 cm », 1500 pour « 1m - 3m », 200 pour
« Autre Barrure 1m - 3m ». Les unités sont propres à chaque vocabulaire et non
reconstituables — ne jamais l'afficher ni la sommer comme une longueur. Le qualificatif
fiable est dans `description`, préfixé par `type_defaut`, qu'il faut retirer ; les
défauts de type comptage (Trou, Démaillage) laissent `taille_cm` à 0 et utilisent
`nombre`.

**2. Les régleurs entrent dans la répartition.** Le prédicat `regleur = 0` hérité du
legacy écartait silencieusement les deux seuls — Nicolas Antonino (16) et Mickaël
Grivelet (15), tous deux toujours en poste. **Même cagnotte, même poids journalier** : le
total du semestre est inchangé, chaque part existante diminue (mesuré sur le S1 2026 :
7 personnes, 637 jours, somme des parts = total au centime). L'entrée du 2026-08-24
ci-dessous décrit donc l'ancien comportement — c'est celle-ci qui fait foi. Le changement
vaut pour **toutes les périodes navigables**, y compris passées : les répartitions
historiques affichées ne correspondent plus à ce qui a été payé à l'époque (décision
utilisateur, 2026-08-25).

Le PDF (`PrimePdf.tsx`) est inchangé : il lit le même payload, hérite donc de la nouvelle
répartition, et n'imprime pas la table des défauts — c'est le document de paie, pas la vue
d'exploitation.
## 2026-08-25 — feat/widget (API des widgets financiers TRM)

Les quatre widgets financiers du tableau de bord ETM (Charges, Chiffre d'affaires, Analyse
financière, Évolution du CA) sont désormais servis **aussi** pour Tricotage Malterre. Aucune
seconde agrégation : `upload_compta` / `compte_compta` (`id_societe`) et `facture`
(`IDsociete`) sont des tables partitionnées dont les deux moitiés sont le **même objet**,
donc c'est la forme `factures.ts` — **une router factory montée deux fois**. Le bloc
finance + CA (756 lignes) sort de `routes/rapports.ts` vers **`lib/finance-common.ts`**
(`createFinanceRouter(scope)`), monté sur `rapportsRouter` en `/` — **les URL ETM ne
changent pas** — et sur **`/api/rapports-trm`** via `routes/rapports-trm.ts`.

**Le `FinanceScope` porte aussi le magasin de droits** (`userHasPermission` vs
`trmUserHasPermission`) : c'est la nouveauté par rapport à `FacturesScope`, les deux apps
ayant des stores séparés. À recopier pour toute future factory à cheval sur les deux apps —
avec le piège de typage documenté dans CLAUDE.md (méthode bivariante + `satisfies`, jamais
un cast).

**`view_rapport_finance` n'existe volontairement PAS côté TRM.** `GET /finance` renvoie la
balance compte par compte (elle nomme les lignes de salaires) : elle est donc gardée par
`dashboard_charges`, la clé du widget lui-même, plutôt que par un droit dont l'écran n'est
pas porté. `financeKeys` est une **liste** (any-of) précisément pour que l'écran
Rapports › Finance TRM n'ait qu'à s'y ajouter. Les routes d'écriture d'un compte ne sont
**pas montées** sur TRM (`editComptesKey: ''`) : elles répondent 404, pas 403.

Quatre clés TRM ajoutées (`dashboard_ca`, `dashboard_evolution_ca` en sous-droit,
`dashboard_finance`, `dashboard_charges`).

**Vérifié en base avant de livrer** (`scripts/probe-finance-trm.ts`, à rejouer après un
`/etm_deploy`) : les sommes au niveau compte reproduisent **exactement** les seaux
`frais_fixe` / `frais_variable` d'`upload_compta` sur les ancres 2025 et 2026 (46 633,56 €
/ 10 562,04 € au 23/03/2026), et le CA `facture` × `ligne_facture` recoupe
`upload_compta.produits` à 0,0 % sur 2026 — deux sources indépendantes du même nombre.
L'ancre **2024 dérive d'environ 4,5 k€** parce que `compte_compta.frais_variable` est la
classification *actuelle* et non celle en vigueur cette année-là ; ETM dérive pareil et
l'écran legacy aussi, donc ce n'est pas corrigé. Côté ETM, contrôle de non-régression après
l'extraction : charges fixes 111 604,54 €, CA 2025 2 684 442,74 € — inchangés.

## 2026-08-25 — feat/users (axe d'accès aux écrans côté TRM)

L'onglet **Écrans** de Paramètres › Utilisateurs existait côté ETM seulement ; TRM le
gagne, avec le même modèle à deux directions mais **son propre arbre et son propre
magasin**. Cette entrée couvre la moitié API ; l'écran vit dans le repo TRM voisin.

Nouveau manifeste `lib/screen-keys-trm.ts` (`TRM_SCREEN_MENUS`, `trmMenuAccessKey` /
`trmScreenHideKey` / `isTrmScreenAccessKey`), miroir de
`TRM/apps/web/src/config/navigation.ts` : un **menu est un grant fermé par défaut**
(`screen_<menu>`), un **écran dans un menu accordé est un hide**
(`hide_<menu>_<screen>`). `lib/permissions-trm.ts` rend ces clés stockables à côté des
clés d'action (mêmes tableaux à plat, `isStorableTrmKey`), et
`routes/permissions-trm.ts` gagne `GET /screens` (catalogue), donne à l'admin effectif
les grants de menu sur `/me` — **jamais les hides**, qui sont des clés négatives — et
accepte les deux axes sur `PUT /users/:id`.

⚠️ **Certaines chaînes de clés coïncident avec celles d'ETM** (`screen_clients`,
`hide_clients_facturation`). C'est sans conséquence : les deux magasins
(`permissions.json` / `permissions-trm.json`) ne se croisent jamais et chaque PUT filtre
sur son propre catalogue. Ne pas « dédupliquer » les deux manifestes.

Deux scripts accompagnent : `check-screen-access-trm.ts` diffe le manifeste contre le
`navigation.ts` du repo TRM voisin (`--nav <chemin absolu>` pour viser un worktree
plutôt que `../TRM` ; un chemin relatif se résout depuis le cwd, que `pnpm --filter`
place à la racine du repo) — 7/7 menus concordants au moment du merge. Et
`seed-screen-access-trm.ts --write` fait le rattrapage : **à lancer sur le serveur avant
le déploiement du web TRM**, sinon, les menus étant fermés par défaut, chaque non-admin
se retrouve avec une navigation vide. Il est idempotent et c'est aussi la façon de
donner un menu *nouvellement livré* à tout le monde d'un coup.

Docs : `claude_doc/auth_permissions.md` § Screen access gagne un point sur le miroir TRM.

## 2026-08-24 — feat/prime (API de l'écran Prime TRM)

Nouvelle route `/api/prime-trm` (+ `lib/pdf/PrimePdf.tsx`) servant l'écran Production ›
Prime du frontend TRM — port de `FI_Prime.wdw`, dont la logique WLanguage a été récupérée
dans le Java généré Android (`C:\Mes Projets\MPS\Android\dbg\Compile\GWDFFEN_Prime.java`),
le .wdw étant compressé PCS et illisible. **Un seul payload alimente l'écran ET le PDF**,
pour qu'ils ne puissent pas diverger.

**Le semestre de prime pivote sur le 15/06 et le 15/12** (S1 = 15/12/(A−1) → 15/06/A,
libellé par l'année de *fin* ; S2 = 15/06 → 15/12, libellé par l'année de *début*),
navigation ±6 mois bloquée sur la période courante. Sommes = `SUM(stock_ecru.poids)` sur
`date_saisie` × barème : 1er choix +0,05 €/kg, 2nd choix −0,20 €/kg. La ligne « Retour
client » (−0,60 €/kg) est **morte dans le legacy** — codée en dur à 0, jamais calculée :
elle reste affichée à 0 tant que l'écran Qualité › Retour client n'existe pas ; ne pas la
« réparer » au hasard.

⚠️ **Les sommes ne filtrent PAS `IDsociete`.** À la livraison une pièce TRM bascule en
société 1 (règle du handover déjà documentée dans CLAUDE.md), donc scoper par société
ferait disparaître l'essentiel du semestre — mesuré : 46 833 kg sur 50 091. La production
TRM est identifiée par **`IDordre_fabrication > 0`**, ce qui écarte au passage les lignes
manuelles ETM `lot='fictif'` que le prédicat legacy comptait à tort (~0,4 % d'un semestre).
Second écart assumé vs legacy : la **répartition plafonne les jours à la fin de période**
(`min(today, fin, date_sortie)`) — le legacy comptait jusqu'à *aujourd'hui* même sur un
semestre passé, si bien qu'une répartition historique dérivait avec le temps au lieu de
rester celle qui a été payée. Les deux écarts sont des décisions utilisateur du 2026-08-24.

La **répartition** couvre les bonnetiers `regleur = 0` dont l'emploi recoupe la période —
sans filtre `archivé`, c'est `date_sortie` qui borne l'historique — au prorata des jours.

**Analyse des déclassements** (absente du legacy) : taux de 2nd choix en kg comparé au
**semestre précédent complet** — volontairement pas à la même fenêtre écoulée, pour que la
barre soit une cible fixe à battre — plus la ventilation par type de défaut lue dans
`defaut_qualite` (`Type_Reference = 2`, mêmes règles que `fetchDefectsByEcru`). Le poids
d'une pièce est **réparti à parts égales entre ses types de défauts distincts** (≈1,6 défaut
par pièce : une attribution pleine dépasserait 100 %), les types inconnus tombent dans
« Autres » et les pièces sans défaut structuré dans « Non renseigné » — la ventilation somme
donc toujours exactement au poids déclassé. Tri strict par manque à gagner décroissant.
⚠️ Des défauts existent **aussi sur des pièces de 1er choix** : cette analyse porte sur les
*déclassements*, pas sur les défauts en général — ne pas la rebaptiser.

`GET /bonnetiers/:id/photo` sert les portraits, et impose une règle HFSQL nouvelle :
**une colonne binaire ne se lit qu'avec `queryRaw`** — `query()` fait passer chaque ligne
par `cleanRow`, qui décode tout `ArrayBuffer` en UTF-8 et rend le JPEG en chaîne mangée qui
ressemble à des données sans en être. Ensuite `sharp` (`.rotate()` pour l'EXIF puis crop
carré, cache mémoire) redescend des originaux de 750–1300 px à des vignettes de ~3,5 Ko,
contre ~300 Ko bruts. Vérification des octets magiques et 404 sinon. Nouvelle dépendance
de l'API : **`sharp`**.

PDF sur le cadre `MalterreDocument` avec **`issuer: companyTrm`** (SIRET / TVA / capital de
Tricotage Malterre — c'est un document TRM) : production du semestre, table des
déclassements, répartition par bonnetier. Le bloc semaine n'y figure que pour le semestre
courant, comme à l'écran.

⚠️ **Les taux sont des constantes de module** : les modifier recalculerait *tout*
l'historique et l'écran afficherait des primes jamais versées. Une révision de barème
(en discussion côté direction au moment où ceci est écrit) impose d'abord des **taux
datés** — barème applicable par période.


## 2026-08-24 — feat/stock-fil
**API du Fils › Stock TRM** (`routes/stock-fil-trm.ts`, second routeur sur le mount
`/api/stock`, endpoints `/fil-trm/*`) — le port de `FI_Stock_Fil_TRM.wdw`, consommé par
l'écran `TRM/apps/web/src/pages/FilsStock.tsx`. `stock_fil` n'est **pas partitionné** :
mêmes lignes que Fournisseurs › Stock, `IDclient` = propriétaire du fil (TRM tricote à
façon). Liste/détail avec colonne Client, filtre Disponible/Archivé/Tous sur `terminé`,
création (lot auto `MAX(lot)+1` en JS, `IDMagasin = 1`, dates de mouvement/pointage),
PATCH borné, **division** d'un lot, **contrôle de titrage** (INSERT positionnel dans
`controle_titrage` — ordre physique vérifié au runtime, le `.xdd` ment), **bilan
d'archivage** (freinte = `stock_initial − Σ(poids pièces × asso_fil_of.pourcentage/100)`,
verdict défauts via `defaut_qualite` Type_Reference 2) et **archivage** (`stock = 0`,
`terminé = 1` par delete + réinsertion positionnelle sur Linux, garde
`certificat_bloque`). PDFs : étiquette Dymo 89×36 (`StockFilLabelPdf`) et rapport de
freinte A4 (`RapportFreintePdf`, `issuer: companyTrm`). Perf : select léger filtré en SQL
(Windows) / JS avant hydratation (Linux), memos lus pour les seules lignes retournées,
catalogues et lots archivés en cache 60 s — liste 1,3 s → 60 ms. `stock.ts` : helpers
exportés + cache de la recycle map. Design : §18.D « dialogue bilan à bandeau » ajouté à
`mps_designer`. Découverte driver : nommer une colonne memo-binaire dans un SELECT
Windows renvoie 0 lignes (règle ajoutée à CLAUDE.md).

## 2026-08-24 — feat/dashboard
**API + shell side of TRM's Tableau de bord (the screen and widget live in the TRM repo).**
New `routes/dashboard-trm.ts` mounted at `/api/dashboard-trm` — one router for every TRM
widget, gated by TRM keys (`trmUserHasPermission`). First widget « Poids des pièces »
(`/poids-pieces` list + `/poids-pieces/:id` chart series), a port of the legacy
`FI_Mauvais_Compteur` / `FEN_Graphe_Compteur`: the SQL was recovered from WinDev's compile
cache (`MPS.cpl\…\*.wcw`) and is quoted in the file header — unit is the `stock_ecru` roll,
valid ⇔ `poids_piece ≤ poids ≤ poids_piece + 0,7` or `poids ≤ 0,65 × poids_piece`, active OFs
with ≥ 1 roll, `machine.emplacement`, verified 6/6 against the live widget. New TRM key
`dashboard_poids_pieces` (category « Tableau de bord »). **The dashboard layout endpoint is now
scoped per app**: `GET/PUT /api/user-profiles/me/dashboard?app=etm|trm` (default `etm`, so every
existing client is unchanged) stores TRM arrangements in `dashboards_trm`. To let TRM import
`pages/Dashboard.tsx` verbatim, `WidgetDef` moved from `registry.tsx` to `types.ts`, the registry
exports `DASHBOARD_APP`, and `useDashboardLayout.ts` imports registry/types via `@/…` so the
sister app resolves its own registry.

## 2026-08-24 — feat/users
**API side of TRM's Paramètres › Utilisateurs (the screen lives in the TRM repo).**
TRM gets its **own permission catalog and store** on the shared API: `lib/permission-keys-trm.ts`
(catalog — first key `edit_commandes_client`), `lib/permissions-trm.ts` (JSON store
`data/permissions-trm.json`, same shape as ETM's), and `routes/permissions-trm.ts` mounted at
`/api/permissions-trm` (`/me`, `/keys`, `/users`, `PUT /users/:id`). Deliberately NOT ETM's
`/api/permissions`: each admin screen saves by replacing a user's whole grant list filtered to
its own catalog, so a shared file would have let ETM's screen silently strip TRM grants on every
save (and vice-versa). `commandes-trm.ts` now gates create / header edit / delete / line CRUD
behind `edit_commandes_client` (`requireEditCommandes`, effective-admin bypass); the état toggle
stays open, mirroring ETM's split where clôture has its own key. Also adds
`scripts/add-utilisateur-mickael-grivelet.ts` — idempotent insert of a TRM staff member missing
from the shared `utilisateur` table (dev has him; **run on prod before the TRM deploy**).

## 2026-08-24 — feat/of-linux-fix
**Hotfix prod : `/api/of-trm` (liste + détail des OF) renvoyait 500 sur le bridge Linux.**
Repéré au déploiement API de la journée (gestion-of + tickets TRM) : le C bridge émettait
`"interruption_prod":0000000000` — `ordre_fabrication.interruption_prod` est la **seule
colonne HFSQL de type Durée de toute l'analyse MPS** (xdd type 35), déclarée numérique par
l'ODBC mais renvoyée en texte à zéros de tête, donc écrite sans guillemets = JSON invalide.
Invisible en dev Windows (le driver `odbc` la renvoie en string). La colonne n'est lue nulle
part (ni API ni écran) : retirée de `OF_COLUMNS`, requête corrigée rejouée dans le bridge
prod et parsée OK. Règle consignée dans `CLAUDE.md` § HFSQL (bullet `ordre_fabrication`).

## 2026-08-24 — feat/issue-tracker
**Le proxy tickets LIVA sert désormais aussi l'app TRM.** `routes/tickets.ts` est
refactoré en factory (pattern `factures.ts`) montée deux fois : `/api/tickets`
(produit `etm-erp`, inchangé pour ETM) et `/api/tickets-trm` (produit `trm-erp`,
consommé par le widget de tickets du frontend TRM — v1.1.1, miroir de
`components/tickets/`). Chaque mount scope créations ET lectures sur son propre slug —
la clé du tracker est company-scoped, sans ça les tickets ETM et TRM se mélangeraient
dans « Mes tickets ». Seule différence par mount : la variable d'env qui nomme le slug ;
nouvelle variable **`ISSUE_TRACKER_PRODUCT_SLUG_TRM`** (ajoutée aux env dev/prod du
checkout principal, requise en prod — `dev_setup.md` §4). Le produit `trm-erp` a été
créé dans la base du tracker (schéma `admin` de livavps, propriété de liva-admin) et
associé au client `ets-malterre` ; testé de bout en bout contre le tracker prod (ticket
N°1084, créé puis purgé). Aucun changement côté écrans ETM.

## 2026-08-24 — feat/gestion-of (API du écran TRM Production › Gestion des OF)
**Nouvelle famille de routes `of-trm.ts` (`/api/of-trm`) — le premier chemin d'écriture
vers `ordre_fabrication` / `asso_fil_of` / `fil_incorpore` / `message_of`.** Portage de
`FEN_Gestion_des_OF.wdw` (fenêtres PCS-compressées : le modèle a été reconstitué depuis
`MPS.xdd` + sondage read-only de la base). Lectures : liste par statut (en cours / attente
/ terminés), fiche complète (composition avec lots + stock par paire, incorporé,
réalisable = algorithme potentiel_kg, compatibles, chaîne commande), les 5 onglets du
panneau legacy (Observations = `message_of` ; Production = `piece_production` +
`evenement_piece` avec % théorique estimé via `ref_ecru_machine.trs_10kg_chute` ;
Visitage = rouleaux `stock_ecru` + défauts ; Qualité = `defaut_qualite` deux populations
(`Type_Reference` 1 = pièce, 2 = rouleau), camembert par famille avec « Maille récupéré »
= `récuperé` (accentué, lu via SELECT * + regex), tranches de 300 kg ; Performance =
arrêts `evenement_machine` avec filtre faux-arrêts 120 s), lookups (métiers, lignes de
commande ouvertes, graine de composition, paires fil/coloris en stock, lots), et un blob
`bonnetier.photo` pour les avatars. Écritures : création (défauts depuis `ref_ecru`,
composition depuis `composition_ecru`, `priorite = MAX+1` du métier, toujours en
attente), mise à jour (quantité verrouillée dès qu'une pièce existe ; changement de
métier re-classe les deux files, 409 `machine_occupee` si le métier cible est occupé),
remplacement composition/incorporé, observation (INSERT positionnel — colonne réservée
`date`), terminer (arret_prod + re-classement + **flip d'auto-activation du nouveau chef
de file**), activer, réordonner, suppression (409 `production_lancee` si des pièces
existent). Cycle d'écriture complet gardé par `scripts/check-of-trm.ts` (31 assertions,
nettoie derrière lui). Consommé par `TRM/apps/web/src/pages/ProductionOf.tsx`.

## 2026-07-31 — feat/cmd-client
**« Générer les factures » ignorait complètement les expéditions diverses.**
`POST /factures/prov/generate` ne lisait que la table `expedition` : les expéditions
`expedition_divers` non facturées ne produisaient aucun proforma et leur `est_facture`
restait à 0 indéfiniment (5 en attente au moment du correctif, dont la plus ancienne
datait du 27/02/2026). Le générateur balaie désormais les deux registres, avec **deux
groupements différents** : formelle → un proforma **par client**, divers → un proforma
**par expédition**. Ce second groupement n'est pas un choix : le lien retour est la
colonne d'en-tête `IDexpedition_divers`, qui ne tient qu'un id — et c'est exactement ce
que faisait legacy (535 factures, une expédition chacune, jamais mêlée à une ligne
formelle). Ce back-pointer est maintenant écrit sur `facture_prov`, **recopié à la
conversion** (donc la facture définitive apparaît dans Expéditions › onglet Factures) et
lu par `wipeOpenProformas` pour rouvrir l'expédition quand le proforma est supprimé. Un
commentaire de `expeditions.ts` affirmait qu'ETM avait « détourné » cette colonne en
marqueur de conversion : c'était faux (0 ligne en base l'utilisait ainsi, et le code y
écrivait toujours 0) — corrigé. La passe divers est **entièrement sautée sur le montage
TRM**, `expedition_divers` n'ayant pas de colonne `IDsociete`.

Les règles de ligne ont été reconstituées depuis les données puis validées contre le
registre définitif, et deux d'entre elles sont contre-intuitives : **un même article
réparti sur plusieurs cartons ne donne qu'UNE ligne** portant le total (la facture 5098
facture 320 pour les 125 du carton 1130 + les 195 du carton 1131 — la première version
émettait deux lignes, c'est la garde qui l'a attrapé), et **`unite = 4` s'imprime
« Pièce » sur une facture** (2 417 lignes legacy) là où le bon de livraison dit
« unité ». S'y ajoutent : libellé = `designation` libre de l'article sinon désignation
catalogue, suivi des variations ; bloc commande présent **ssi** l'expédition est
rattachée à une commande et portant alors **les deux segments même si la référence
client est vide** (`N/Commande : 2921 V/Commande : `), sans repli sur
`expedition_divers.ref_client` quand il n'y a pas de commande ; prix **figé à
l'expédition**, la grille `tarif_divers` ne comblant qu'un `0` (375 des 2 904 articles
n'ont pas de prix, dont 2 des 100 dernières expéditions) — même règle que la ligne divers
d'une commande. Les frais de port sont facturés **une fois par commande pour l'ensemble
du run**, les deux passes partageant le même garde-fou : une commande expédiée des deux
façons ne les paie plus deux fois.

Garde : `apps/api/src/scripts/check-divers-facturation.ts` rejoue le générateur sur les
496 expéditions facturées — **355 se reproduisent** (127 à l'octet près, 21 modulo la
troncature WinDev à 60 caractères, 133 aux mêmes chiffres sous les gabarits de
désignation plus anciens, 74 avec en plus des lignes ajoutées à la main). Les 138
restantes sont toutes **sous l'avis 575** et relèvent de la saisie manuelle d'époque
(libellé tapé au lieu d'être choisi, quantité modifiée sur l'expédition après émission,
désignation catalogue renommée depuis) ; le script échoue si une divergence apparaît
**au-dessus** de ce seuil, c'est-à-dire si le constructeur de lignes s'écarte de ce que
les deux applications produisent aujourd'hui. Vérification bout-en-bout sur la base de
dev via `e2e-divers-generate.ts` (crée puis annule tout par `/prov/delete-batch`,
refuse toute cible non-localhost) : 4 proformas divers créés avec le bon client, la bonne
adresse de facturation et la bonne TVA, accents intacts au retour, l'avis vide 603
correctement laissé ouvert, et rollback complet vérifié. Côté écran, le dialogue de
confirmation décrit maintenant les deux groupements et les proformas issus d'une
expédition diverse portent une pastille « Diverse » dans le récapitulatif.

## 2026-07-30 — feat/worktree-reap-guard
**Un worktree vivant ne peut plus être supprimé par la file de suppression différée.**
Pas un écran : une correction de l'outillage worktree, écrite après l'incident du jour où
deux worktrees fraîchement créés (`cmd-client`, `divers`) ont été effacés — dossiers **et**
branches — par un simple `/worktree-status`. Cause : `/feature-complete` ne peut pas
supprimer son propre dossier (la session y est positionnée), donc il met le *chemin* en
attente dans `pendingRemovals`, et le prochain script worktree le balaie. Or le chemin est
dérivé du nom de la fonctionnalité : recréer un worktree portant le nom d'une feature déjà
livrée redonne au balayeur un arbre vivant à détruire. Le registre `~/.claude/mps-worktrees.json`
étant partagé par toutes les sessions Claude de la machine, deux sessions sur le même nom
travaillent sur le même dossier. Correctifs : `reapPending()` refuse tout chemin revendiqué
par un slot actif du registre, jette l'entrée périmée au lieu de l'appliquer et le signale
(`Kept <name> — a live slot owns that path`) au lieu d'agir en silence ; `up.mjs` annule
l'entrée en attente quand il recrée légitimement le chemin, et prévient quand le nom
correspond à une branche déjà mergée. Vérifié en reproduisant la panne dans un registre
bac-à-sable (`USERPROFILE` factice) : avant, le worktree vivant est détruit ; après, il
survit, le vrai résidu est toujours balayé et l'entrée périmée disparaît. Au passage, deux
pièges de docs corrigés dans `/etm_deploy` : son test « branche mergée » (ancêtre de
`origin/master`) qualifie de MERGED une branche neuve sans commit — elle *est* master — et
l'étape 5 affirmait à tort que les worktrees actifs en étaient exclus automatiquement, ce
qui a failli faire démonter deux arbres vivants ; la liste soustrait désormais les features
que le registre possède. Et l'argument de version (`/etm_deploy v0.2.1`) est enfin
documenté : le bump du `package.json` racine doit précéder le build, sinon le bundle
embarque l'ancien `__APP_VERSION__`.

## 2026-07-30 — feat/cmd-client
**Le tarif d'une ligne de commande client dépend enfin du CLIENT : contrat négocié,
coefficient fixe, blocage sur contrat expiré — et le sélecteur de coloris se limite au
catalogue du client.** Deux bugs remontés le même jour par les utilisateurs, tous deux
causés par la même chose : l'écran Commandes connaissait la *référence* mais pas le
*client*, alors que Clients › Gestion tient un catalogue par client (`designation_client`
→ `ref_client_colori`) avec ses coloris et ses tarifs.

**1. Tarification.** `calcLignePriceClient` ne recevait ni `IDclient` ni quoi que ce soit
du catalogue : toute ligne était cotée sur la grille standard `PrixDeVenteV4`. Le modèle
de modes tarifaires (standard / coefficient fixe / contrat) a donc été sorti de
`routes/clients.ts` vers **`lib/tarif-client.ts`**, partagé par la fiche et la commande,
avec en plus `resolveLigneTarifMode()` (paire référence × coloris → `ref_client_colori`,
règle `avec_teinture` + colonne de repli, entrées archivées ignorées) et
`contratPrixForTrancheIdx()`. Le pricer applique maintenant le `prix_saisi` négocié
(€/Ml, converti en €/Kg par le rendement pour une ligne Kg) et restreint le nudge Tricobot
aux tranches que ce contrat cote réellement — un contrat mono-bande ne propose donc plus
une tranche du catalogue que le client n'a jamais signée. ⚠️ **Un contrat expiré ne
retombe PAS sur la grille standard** : la référence n'est plus vendable tant qu'un nouveau
contrat n'est pas établi (règle déjà appliquée par la fiche client). L'endpoint renvoie
`blocked` + `blocked_reason` dès le choix du coloris, le dialogue affiche un bandeau rouge
et grise Enregistrer, et POST/PUT `/lignes` répondent **409 `contrat_expire`**. Le PUT ne
bloque que sur un changement **commercial** (référence, coloris, quantité, prix) : une
ligne prise quand le contrat était valide reste modifiable pour sa date et son
commentaire — sinon on punirait l'utilisateur pour une expiration qu'il ne peut pas
corriger depuis cet écran. Incident d'origine : le contrat C2TEC sur E1731 a expiré le
30/06/2026 et une commande est passée le 30/07 sans que rien ne le signale ; à l'inverse
un client sous contrat actif était coté **12,00 €/Ml au lieu des 3,81 €/Ml négociés**.
Garde `check-contrat-tarif-ligne.ts` : le cas C2TEC épinglé + rejeu de toute la base
(12/12 contrats actifs et 11/11 coefficients conformes).

**2. Coloris.** `/lookups/colori-ecru|colori-fini` filtraient par référence seulement, si
bien qu'une référence teinte pour des dizaines de clients proposait **389 coloris là où le
client en achète 71**. Elles acceptent désormais `client` (+ `current`) et se limitent aux
`ref_client_colori` de la paire. Trois états, et les deux derniers **retombent sur la liste
complète** — un sélecteur vide rendrait la référence non commandable — chaque ligne portant
alors `hors_catalogue: true` pour que l'UI le dise : catalogue exploitable → liste
restreinte ; aucun `ref_client_colori` (13 des 2 025 entrées fini actives) → repli ;
**catalogue disjoint de la liste affichée** → repli aussi (cas réel client 202 / ref 1426,
dont les rcc pointent des `colori_ecru` d'un `ref_ecru` que le fini ne référence plus).
`current` conserve et marque le coloris d'une ligne existante : **381 des 7 062 lignes
historiques sont hors catalogue** et perdraient sinon leur coloris à l'ouverture du
dialogue. ⚠️ Sans `client`, la liste reste complète — c'est ce dont Clients › Gestion a
besoin, puisque c'est l'écran où le catalogue se construit. Garde
`check-coloris-client-scope.ts` (balayage de 150 paires : 104 réduites, 0 vide).

Le même angle mort tarif/coloris subsiste sur **Devis** (`/devis/lookups/colori-*` et son
`/pricing/suggest`, tous deux client-blind) : périmètre volontairement limité aux commandes.
## 2026-07-30 — feat/divers
**Divers › Stock ne liste plus que le stock réellement disponible (276 lignes → 62), et
la création de ligne devient un upsert. Au passage, la recherche à puces de Finis › Stock
est extraite en composant partagé et remplace le filtre « Toutes les références ».**

`stock_divers` n'est pas une grille de toutes les combinaisons : c'est un **journal des
combinaisons que quelqu'un a touchées** — 1 466 combinaisons théoriques sur les 505
références pour seulement 276 lignes stockées (à elle seule, Tissu Voltige en autorise 551
et n'en stocke que 117). Et **214 de ces 276 lignes sont à 0**, ce qui noyait les ~62 qui
portent du stock. La case « Masquer les quantités nulles » disparaît donc au profit d'un
masquage inconditionnel : une ligne remise à zéro doit devenir indiscernable d'une
combinaison jamais créée. Une quantité **négative** reste visible — c'est une anomalie de
données, pas du stock.

Le piège, et la vraie raison du changement d'API : `POST /stock-divers` refusait (409
« modifiez la ligne existante ») dès que la combinaison existait. Avec les zéros masqués,
cela concernait **214 lignes invisibles** — l'utilisateur se serait fait renvoyer vers une
ligne introuvable. L'endpoint est donc un **upsert** : il remplit silencieusement une ligne
**vide** (de son point de vue il a bien ajouté une ligne), mais une combinaison qui **porte
déjà du stock** refuse toujours, en annonçant la quantité en place — l'écraser sans un mot
détruirait un chiffre réel. `create_stock_divers` suffit pour ce chemin : il ne peut que
transformer un 0 en quantité. Corollaires : le dialogue refuse la quantité 0 (la ligne
disparaîtrait aussitôt créée) et le tiroir explique la disparition quand on remet à zéro.
Le doublon hérité (réf 535 / variation 558, deux lignes à 0) est géré : on prend le plus
petit `IDstock_divers`, et on refuse si l'une des lignes du doublon porte du stock.

Côté recherche, la recherche à puces (champ scopé « Emplacement : BD » + popover de
suggestions) vivait uniquement dans `FinisStock.tsx`. Elle est extraite telle quelle dans
`components/stock/SmartSearchInput.tsx` (+ `filterRowsByChips`) et consommée par les deux
écrans — le rendu de Finis › Stock est identique au pixel près (vérifié en stashant les
modifications : les baselines Playwright échouent avec exactement le même diff de 1 889 px
avant et après, dérive préexistante due aux nouveaux onglets de menu). Sur Divers › Stock
elle remplace la combobox « Toutes les références » : une puce `Référence :` fait le même
travail et sait chercher. Le renommage des colonnes « Variation 1 / 2 » vers les vrais axes
(Couleur / Taille / Référence) se déduit désormais des lignes visibles au lieu du filtre
supprimé, donc il fonctionne aussi quand on restreint en texte libre. Convention à retenir :
`mps_designer §27.2bis`.

## 2026-07-30 — feat/facturation
**Le ledger de facturation devient multi-société : `factures.ts` est désormais une
factory montée deux fois (`/api/factures` = ETM, `/api/factures-trm` = TRM), pour
alimenter le nouvel écran Clients › Facturation de TRM.**

`facture` / `facture_prov` sont partitionnées par `IDsociete` mais les deux moitiés sont
**le même objet** (mêmes colonnes, même cycle de vie, même écran) — contrairement à
`stock_ecru`, qui a justement deux fichiers de routes. D'où `createFacturesRouter(scope)`
plutôt qu'un second fichier : tout ce qui diffère est regroupé dans un unique enregistrement
`FacturesScope` (clé de partition, colonne de rattachement des rouleaux —
`stock_ecru.IDligne_expedition_TRM` vs `_ETM`, ce qui conditionne la génération des
proformas —, identité légale du PDF, marque utilisée dans les emails). Aucun autre endroit
du fichier ne connaît la société.

Côté PDF, rien de nouveau à inventer : `feat/expe` avait déjà doté `MalterreDocument`
d'un prop `issuer?: CompanyInfo` et créé `companyTrm` pour l'avis d'expédition TRM. Cette
branche s'y branche (`FacturePdf` prend un `company` et le passe en `issuer`) et se
contente de **compléter le bloc bancaire** de `companyTrm`, laissé vide parce qu'un bon de
livraison n'affiche pas de coordonnées bancaires — la facture, si : c'est le compte sur
lequel le client paie, et il diffère de celui d'ETM (IBAN
FR76 3000 3035 8100 0200 1609 813, relevé sur FC85218.pdf). `rcs` reste volontairement
vide, comme documenté par `feat/expe`. Le logo reste celui d'ETM, faute d'artwork TRM
(déjà noté dans le `CLAUDE.md` de TRM).

**Trois bugs corrigés au passage, dont deux touchent aussi ETM :**

1. **L'arithmétique des factures était fausse.** Le code sommait `quantite * prix` brut, or
   `prix` est un REAL 4 octets qui porte tout le bruit flottant quand il vient du moteur de
   tarif (`2.100738048553467`), alors que la facture **imprime** le prix unitaire à 2
   décimales. Le legacy arrondit le prix, multiplie, puis arrondit la ligne. Vérifié sur les
   14 factures TRM lisibles dans l'écran legacy : la nouvelle formule en reproduit 13 (la
   14e à 1 centime près, sur une égalité au demi-centime), l'ancienne seulement 4 — avec un
   écart allant jusqu'à 6,71 € sur une facture, que l'export XImport injectait tel quel en
   compta. Corrigé via `lineMontant()` / `round2()`, utilisés par la liste, le détail, le
   PDF et XImport.
2. **Accès inter-ledger**, ouvert par le second montage : les PK sont une séquence unique
   partagée, donc `GET /api/factures-trm/def/5332` renvoyait la facture ETM n°9099 et un
   `PUT` l'aurait réécrite avec des références TRM. Garde `inScope()` sur toutes les routes
   adressées par id, en 404.
3. **`client.IDtva` / `IDcode_comptable` sont des colonnes uniques** partagées par les trois
   sociétés alors que `tva` et `code_comptable` sont partitionnées. Les recopier tel quel
   comptabilisait une facture TRM sur un compte de TVA ETM dès qu'un client est commun.
   `clientBillingDefaults()` les ré-héberge dans la société qui écrit (TVA par **taux**, code
   comptable par appartenance sinon défaut société) — sans effet sur ETM, dont les 5 297
   factures existantes respectent déjà l'invariant.

Ajouts mineurs : lookup `/lookups/codes-comptables` et `IDcode_comptable` accepté au
POST/PUT (l'écran TRM l'expose, le legacy TRM aussi) ; `TYPE = 4` des lignes de commande
TRM traité comme de l'écru ; `loadModePaiementLabel`/`loadCodeComptableLabel` projettent
leur PK, sans quoi `fixEncoding` ne répare rien.

Vérifié en base réelle puis restauré à l'identique (génération de 26 expéditions →
1 proforma aux désignations conformes au legacy, conversion allouant 85212 sur la séquence
TRM sans toucher celle d'ETM restée à 9100, avoir, suppression en lot, XImport, PDF des
deux sociétés). Non testé : l'envoi d'email, qui passe par Gmail et enverrait un vrai
message.

## 2026-07-30 — feat/expe
**Endpoints expédition côté TRM (`/api/expeditions-trm`) + variante TRM du bon de livraison PDF.**

Nouveau fichier `apps/api/src/routes/expeditions-trm.ts`, monté sous `/api/expeditions-trm`,
consommé uniquement par le frontend TRM (écran Clients › Expéditions, port du couple WinDev
`FEN_Expéditions` / `FEN_Gestion_expédition` en mode Tricotage Malterre). Liste paginée
(`?q=&state=facture|nonfacture&before=`), détail, création / modification / suppression,
sélection des pièces par ligne de commande, lookups (transporteurs, commandes TRM, adresses,
contacts), avis d'expédition PDF et envoi mail.

Pourquoi un fichier séparé plutôt qu'un `?societe=` sur `expeditions.ts` : les tables sont bien
partagées (`expedition` / `ligne_expedition`, partitionnées par `expedition.IDsociete`), mais la
marchandise diffère à chaque requête. Une expédition ETM porte des rouleaux finis
(`stock_fini.IDligne_expedition`) ou de l'écru acheté (`stock_ecru.IDligne_expedition_ETM`), et
c'est le `TYPE` de la ligne de commande qui tranche. Une expédition TRM ne porte que du tombé de
métier tricoté en interne : `stock_ecru.IDligne_expedition_TRM`, dont le vivier de pièces libres
pend de **`IDLigne_Commande_TRM`** (et non `IDligne_commande_client`, à 0 sur toutes les lignes
TRM). Les pièces n'ont ni lot, ni métrage, ni magasin, mais un métier (`ordre_fabrication` →
`machine.nom`) et des défauts de visitage. `expedition_divers` n'a pas de colonne `IDsociete` :
les expéditions diverses restent ETM-only, d'où l'absence de bascule Textile/Diverses côté TRM.

⚠️ **Le piège du transfert de propriété.** Quand TRM livre Ets Malterre — le cas courant — la
réception ETM prend possession de la pièce : le flux legacy bascule `stock_ecru.IDsociete` de 2 à
1 et estampille `lot = 'trm<IDexpedition>'`, en gardant `IDligne_expedition_TRM` comme lien de
provenance. Les pièces d'un avis livré sont donc des lignes société 1. Les lectures ne filtrent
donc **jamais** sur `IDsociete` (sinon tout avis livré afficherait « 0 pièce ») ; les écritures
exigent **`IDsociete = 2`** et renvoient 409 sur toute tentative de retirer une pièce
réceptionnée d'un avis, ou de supprimer un avis qui en contient une. Mesuré sur les 120
dernières expéditions TRM : livraisons à Ets Malterre → 100 % société 1, livraison à un client
tiers (Bonneterie Gautier) → 100 % société 2.

Comme côté ETM, le concept legacy **validé / dévalider** reste retiré : une expédition est « non
facturée » (modifiable) ou « facturée » (`est_facture = 1`, ou une facture définitive référence
une de ses `ligne_expedition`) et toute écriture renvoie alors 409. `est_valide` est écrit une
fois à l'INSERT (0) puis ignoré. Les colonnes accentuées `envoyé_client` / `envoyé_sst` (les deux
cases à cocher de la liste legacy) ne sont jamais nommées en SQL — ça noierait le bridge Linux —
donc pas exposées.

**PDF** : `BonLivraisonPdf` porte désormais un discriminant `variant: 'etm' | 'trm'` et une seule
table `VARIANTS` qui concentre toutes les différences (émetteur, colonne Métrage, colonne
Défauts, libellé de lot, mention charte). `'etm'` est le défaut, donc les appels existants sont
inchangés — vérifié en rendant un avis de chaque et en comparant le texte extrait. La variante
`'trm'` porte le legacy `ETAT_Expédition_TRM` : pas de métrage (le tombé de métier se vend au
poids, `metrage` = 0 partout), une colonne Défauts (le visitage voyage AVEC le BL côté TRM, alors
qu'ETM l'envoie en rapport de contrôle séparé), et des lots identifiés par *métier + lots Malterre
+ lots fournisseur* plutôt que par un code lot (`stock_ecru.lot` est vide côté TRM). Le
regroupement se fait par `ordre_fabrication` : toutes les pièces d'un OF partagent la machine et
les lots de fil (`asso_fil_of` → `stock_fil.lot` / `lot_frs`), ce qui est exactement cette ligne
d'en-tête.

`MalterreDocument` accepte une prop `issuer` (défaut : `company`) qui pilote le bloc légal du
pied de page et l'auteur du PDF ; `theme.ts` exporte `companyTrm` (Tricotage Malterre SARL,
SIRET 332 604 727 00021, NAF 1391Z, TVA FR 25 332 604 727, capital 46 500 €, transcrits du pied
de page du rapport legacy). Un BL signé Tricotage Malterre ne peut pas porter le SIRET d'Ets
Malterre. Le logo n'est pas basculé : il n'existe qu'une seule image et pas encore de version TRM.

Autres changements : `stock-ecru.ts` expose `defaut_qualite.nombre` sur `DefautQualite` (un
défaut est *soit* mesuré `taille_cm` → « Maille 25 cm », *soit* compté `nombre` → « Trou x1» ;
`defautSummary` ne rend que la taille, donc l'avis TRM formate la paire lui-même) ; une vingtaine
de helpers d'`expeditions.ts` passent en `export` pour être réutilisés au lieu d'être dupliqués
(`resolveClientNames`, `loadAdresse`, `attachedFactures`, `newIdAfterInsert`, `logEnvoiEmails`,
`pieceCollator`, …) — aucun changement de logique, uniquement des mots-clés `export`.

L'export **CSV TAD** de l'écran legacy n'est volontairement pas porté.

## 2026-07-30 — feat/gestion-client (API du second registre `client`)

**La table `client` a désormais deux registres servis par cette API.** `client` est partitionnée
par `IDsociete` (1 ETM / 2 Tricotage Malterre / 3 Confection) : `routes/clients.ts` sert la fiche
ETM (`/api/clients`), le nouveau `routes/clients-trm.ts` sert celle de TRM (`/api/clients-trm`,
portage de `FI_Gestion_Client_TRM.wdw` ; l'écran vit dans le dépôt frère et n'est **pas** un écran
partagé `@etm` — les deux fiches n'affichent pas les mêmes champs).

- **`lib/clients-common.ts` (nouveau)** rassemble ce qui est identique des deux côtés : helpers
  SQL/format (`sqlText`, `numOf`, `strOf`, `pick`…), `requirePermission`, `repairNames`,
  `countClientActivity`, les helpers de drapeaux accentués `setClientFlag`/`readClientFlag`
  (`archivé` **et** `bloqué`, via delete + réinsertion positionnelle sous Linux — généralisation
  de l'ancien `setClientArchive`), et `registerContactAdresseRoutes()` : `contact`/`adresse` sont
  polymorphes sur `IDclient` et **non** partitionnées, donc les deux montages enregistrent le même
  CRUD. `clients.ts` a été rebasculé dessus — aucun changement de comportement (fiche ETM
  revérifiée : 421/658 clients, les 3 onglets, la sidebar).
- ⚠️ **L'invariant qui empêche les deux fiches de se détruire mutuellement : un routeur ne doit
  JAMAIS NOMMER une colonne que l'autre fiche possède.** Une colonne non nommée conserve sa valeur
  au `UPDATE` ; une colonne nommée est remise à zéro à chaque enregistrement. ETM possède
  `client_interne`, `IDsecteur_activite`, `IDactivite`, `journal_commercial`, `dernier_contact`,
  `inclureRapportQualite`, `pct_ajeol` ; TRM possède `rib`, `domiciliation`, `IDtransporteur` et
  `bloqué`.
- ⚠️ **`tva` et `code_comptable` sont partitionnées aussi.** La « Vente à façon » de TRM
  (`IDcode_comptable = 1`, 701103) n'est pas la « VENTE FACON » d'ETM (8, 707302). Servir la liste
  d'ETM à un écran TRM réécrirait silencieusement la TVA du client vers la ligne d'une autre
  société au prochain enregistrement — d'où des lookups `/clients-trm/lookups/*` distincts.
- **« Attente paiement facture » = `client.bloqué`** (colonne accentuée). Établi par les données :
  A.E.T. / `IDclient` 627 est le seul client société 2 avec `bloqué = 1`, et le seul dont la case
  est cochée sur la capture du legacy.
- **Deux panneaux propres à TRM** : l'historique des commandes (société 2, **sans** exclure
  `IDcommande_ETM > 0` — côté TRM ces 2 518 miroirs *sont* le tricotage commandé par ETM ; ajoute
  un `TYPE = 4` que le côté ETM ne connaît pas, `type_sst` 4 = Confectionneur, 175 lignes qui se
  résolvent sur le catalogue écru) et les stocks de fil du client (`stock_fil.IDclient` — TRM
  tricote à façon, le fil appartient au client).
- **Deux manques assumés**, sources `.wdw` compressées PCS donc illisibles : le radio « En
  Attente » des stocks de fil n'est pas reproduit (`terminé` est le seul drapeau d'état ;
  `niveau` est le niveau d'étagère, `controlé` vaut 0 sur tout lot ouvert, l'affectation OF ne
  colle pas non plus), et la colonne « Marge Brute » de l'historique reste vide (`marge_brute:
  null`) — toutes les valeurs observables du legacy valent 0,00 %.

Détail complet : `claude_doc/implemented_screens.md` § Clients TRM.


## 2026-07-30 — feat/cmd-client
**Exonération de TVA côté client, commandes sous-traitant manquantes dans le tiroir de ligne,
et un `status.mjs` qui ne ment plus sur la santé d'un slot.**

**1. TVA — le taux appartient au client.** La confirmation de commande et le devis lisaient le
taux par défaut de la société 1 (20 %) au lieu de `client.IDtva` : un client marqué
« Exonération » dans Clients › Gestion (export — AGAPE au Maroc) était taxé sur tous ses
documents imprimés. Le taux se résout désormais dans `apps/api/src/lib/tva.ts`
(`loadClientTvaRate`), avec repli sur le défaut ETM **uniquement** si le client n'a pas de
ligne `tva` — un `valeur = 0` est une vraie valeur, pas un « non renseigné ». Un taux nul
**réduit le bloc de totaux** : plus de ligne TVA, plus de TTC, le document se termine sur
`TOTAL HT` (le sous-total ne subsiste que si une remise ou des frais de port l'en distinguent).
Vaut pour la confirmation, le devis, la proforma et la facture — cette dernière conserve son
propre `IDtva`, copié du client à la création, donc une ancienne facture garde son taux
d'émission. Garde `check-tva-exoneration.ts` : vérifie le taux **et** le bloc de totaux rendu,
en parcourant l'arbre React du PDF (les octets sont illisibles, polices sous-ensembles).

**2. Les commandes sst créées depuis le tiroir n'apparaissaient pas.** Créer une commande
ennoblisseur depuis l'onglet Ennoblissement d'une ligne ne la faisait pas apparaître dans le
tableau juste au-dessus, alors qu'elle existait dans Sous-traitants › Commandes.
`buildEnnoblissement`/`buildTricotage` filtraient sur une **liste blanche** de statuts ouverts
(`En_Cours`, `Attente_Delai`) alors qu'une commande neuve démarre à `Non_Envoye`. Même symptôme
pour une commande de tricotage chez un tricoteur **externe** (`createKnitOrder` ne met
`Attente_Delai` que pour Tricotage Malterre) et pour les lignes `Notification` /
`Soumis_Au_Client`, invisibles depuis toujours : **5 lignes vivantes cachées** sur les données
actuelles. Le filtre devient une liste noire — tout ce qui n'est pas terminé — donc un statut
auquel personne n'a pensé ne peut plus masquer une commande vivante.
⚠️ Le prédicat compare le **préfixe ASCII** (`NOT LIKE 'Termin%'`) : nommer `'Terminé'` accentué
en SQL enverrait de l'UTF-8 brut dans le pont Linux, et un filtre JS via `isLineDone()` serait
**pire que le bug** — ODBC renvoie la valeur en `Termin?`, la comparaison échouerait et toutes
les lignes terminées passeraient pour ouvertes. Vérifié sur données réelles : garde
`check-supply-open-lines.ts`, rouge avant (5 échecs), verte après (75 contrôles).
⚠️ **Découvert au passage, non corrigé** (hors périmètre) : `commandes-sous-traitant.ts:264` et
`:860` appellent `isLineDone()` sur un `SELECT sstatut` brut, sans `fixEncoding` — leurs tests
« toutes les lignes terminées » / « ignorer la ligne terminée » ne se déclenchent donc jamais.

**3. Outillage — `status.mjs` disait `UP` pendant que l'API était inutilisable.** Deux fois dans
la session, « ça charge à l'infini » a dû être diagnostiqué à la main : le script ne testait que
la vivacité (pid vivant, port ouvert) alors que `/api/health` répondait en 1 ms pendant que
chaque route data expirait à 15 s sur une connexion ODBC bloquée. `probeDbHealth()` est extrait
de `waitForDbHealth` et appelé par slot, en parallèle : `UP` → **`DEGRADED`** avec le remède
exact. Un slot TRM est sondé sur l'API ETM qu'il emprunte, sinon personne ne signale son
blocage. `spawnDetached` fait aussi tourner les logs vers `<nom>.prev.log` — sur Windows
`Start-Process` **tronque** ses redirections, donc le redémarrage effaçait le journal qui
expliquait la panne. Cause documentée (CLAUDE.md, `worktrees.md`, skill `worktree-status`) :
une **rafale d'éditions** sous `apps/api/src` redémarre `tsx watch` à chaque sauvegarde et
laisse une connexion ODBC pendante — elle frappe donc juste après avoir édité, au moment où on
demande à l'utilisateur d'aller regarder. Grouper les éditions, redémarrer soi-même avant de
rendre la main.
## 2026-07-30 — feat/stock
**Endpoints écru côté TRM (`/api/stock/ecru-trm`) pour l'écran Tombé Métier › Stock de TRM.**

Nouveau fichier `apps/api/src/routes/stock-ecru-trm.ts`, monté sous `/api/stock`, consommé
uniquement par le frontend TRM. Deux routes en lecture seule : `GET /ecru-trm`
(`?statut=disponible|affecte|tous`, `?second_choix=1`) et `GET /ecru-trm/:id` (qui ajoute un
bloc `production` : l'OF, le métier, le n° de pièce et les horodatages `piece_production`).

Pourquoi un fichier séparé plutôt qu'un paramètre `?societe=` sur `stock-ecru.ts` : les deux
moitiés de `stock_ecru` sont des objets différents. Un écru ETM est acheté à un tricoteur,
stocké dans un `IDmagasin` et affecté à un ennoblisseur (`IDref_commande_affectation`) avant
de devenir un `stock_fini`. Un écru TRM est tricoté en interne — son origine est un
`IDordre_fabrication` (→ `ordre_fabrication.IDmachine` → `machine.nom`, le métier) et un
`IDpiece_production` — avec `IDmagasin = 0`, `lot` vide, `metrage = 0`, et aucune étape de
teinture. « Encore en stock » diffère aussi : `IDligne_expedition_ETM = 0` + aucun enfant
`stock_fini` côté ETM, `IDligne_expedition_TRM = 0` côté TRM (~1 070 lignes sur 6 707). Et
surtout, la réservation client pend d'une colonne différente : `IDligne_commande_client` côté
ETM, **`IDLigne_Commande_TRM`** côté TRM (le back-pointer du grand livre miroir), l'autre
restant à 0 sur toutes les lignes TRM.

Ce qui est réellement commun n'est pas dupliqué : `fetchDefectsByEcru`, `defautSummary` et
`resolveClientReservations` sont importés de `stock-ecru.ts` — cette dernière a été **exportée**
pour l'occasion (la chaîne `ligne_commande_client → commande_client → client` est identique,
seul le pointeur d'entrée change). Aucune colonne accentuée n'est nommée dans les nouvelles
requêtes, bien que les tables jointes en portent (`machine.archivé`/`diamètre`/`connecté`,
`ordre_fabrication.productivité*`) — commenté sur place pour que personne n'ajoute un
`SELECT *`.

Corrige aussi un bug de l'outillage worktree : `up.mjs <name> trm --api 808N --restart`
affichait le nouveau port mais ne réécrivait jamais `VITE_API_URL` (la branche restart ne
répare que les deps et le CORS). Le navigateur continuait donc d'appeler l'ancienne API et les
endpoints tout neufs renvoyaient 404 sans rien dans la console. Détail dans
`claude_doc/worktrees.md` § Shared-API changes.
## 2026-07-30 — feat/permissions
**Accès par écran : chaque utilisateur ne voit que les menus et écrans dont il a besoin.**
Deuxième axe de droits, à côté du catalogue d'actions, réglé dans le nouvel onglet **Écrans**
de Paramètres › Utilisateurs. Demande d'origine : Laetitia n'a pas besoin de Sous-traitants,
Transferts, Fils, Tombé de métier, Divers, Rapports ni Réseau.

- **Deux directions, volontairement** — « on accorde des menus ; dans un menu accordé on peut
  retirer des écrans ». Un **menu est un droit accordé, fermé par défaut** (`screen_<menu>`) ;
  un **écran dans un menu accordé est un masquage** (`hide_<menu>_<écran>`). Une liste blanche
  intégrale rendrait chaque écran livré ensuite invisible pour toute l'entreprise jusqu'à ce
  qu'un admin le coche utilisateur par utilisateur — corvée hebdomadaire sur ce projet. Accorder
  le menu couvre ses écrans futurs ; un écran réellement confidentiel reçoit son propre droit
  d'action (`view_rapport_finance` est le précédent). Les clés dérivent du href, donc aucun
  manifeste ne contient de chaîne écrite à la main.
- **Un menu dont plus aucun écran n'est visible disparaît** — règle que le menu Paramètres
  suivait déjà quand sa seule entrée était `adminOnly`. Accorder un menu **efface les masquages
  de ses écrans**, pour qu'une exclusion posée des mois plus tôt ne ressuscite jamais.
- ⚠️ **Les clés de masquage sont des clés négatives : les lire via `hasRaw()`, jamais `has()`.**
  `has()` répond vrai pour *toute* clé quand l'utilisateur est admin effectif — lire un masquage
  à travers lui masquerait l'application entière à l'admin. `PermissionsContext` expose
  `hasRaw` (appartenance brute, sans bypass) exactement pour ça, `GET /permissions/me` ne
  renvoie jamais de clé de masquage à un admin effectif, et `navigation.test.ts` fixe le
  comportement.
- **L'application est filtrée en un seul point pour les routes** : `AppShell` (`useScreenGuard`)
  est le parent de toutes les pages, donc un garde y remplace 40 wrappers de routes. Il porte
  aussi la **redirection d'index de menu** (`/clients` → le premier écran réellement ouvrable ;
  le `<Navigate>` statique du router ne peut pas le savoir), affiche un spinner tant que
  `/permissions/me` est en vol, et ne filtre jamais `/`, les autres tableaux de bord ni
  `/settings`.
- **C'est un rideau, pas un verrou** — décision produit assumée : les endpoints sont partagés
  entre écrans (lookups clients, `/stock/ecru/suivi` qui alimente un widget…), donc les filtrer
  par écran casserait des fonctionnalités sans rapport. La confidentialité reste portée par les
  droits d'action vérifiés côté serveur. `/api/rapports/*` et `/api/transferts/*` sont les
  candidats simples si on veut durcir, chacun étant une famille de routes mono-écran.
- **Reprise de l'existant** : `seed-screen-access.ts --write` accorde à chaque utilisateur les
  clés de menu qui lui manquent, donc personne ne perd rien le jour du déploiement.
  **À lancer sur le serveur** (`apps/api/data/permissions.json` est gitignoré et vit à côté de
  l'API qui tourne). Idempotent, sauvegarde le fichier d'abord, et c'est aussi la façon de
  donner un **nouveau menu** à tout le monde d'un coup. Il traite **toutes les lignes
  `utilisateur`, pas la liste dédupliquée** : plusieurs lignes existent par personne
  (Laetitia #12 et #15, Vincent #1 et #18) et les droits sont stockés par `IDutilisateur`.
- **« Copier les droits de… »** recopie l'ensemble des clés d'un autre utilisateur — écrans et
  actions. C'est le substitut assumé aux rôles/groupes sur une petite équipe : rien ne relie
  les deux comptes ensuite, donc aucun objet partagé ne peut dériver. Il absorbe aussi la
  charge d'intégration créée par le « fermé par défaut », les utilisateurs arrivant de la table
  WinDev `utilisateur` sans aucun menu.
- **Garde-fous** : `check-screen-access.ts` diffe le manifeste API contre `navigation.ts` (un
  menu ajouté à la nav mais pas au manifeste serait silencieusement ignoré par
  `PUT /permissions/users/:id`) ; `navigation.test.ts` couvre 11 cas — premiers tests
  unitaires du paquet web.
- **Bug préexistant corrigé au passage** : ouvrir `/settings/utilisateurs` par URL ou par
  rafraîchissement renvoyait vers `/`. La page tranchait « pas admin » avant la résolution de
  `/permissions/me` ; elle ne marchait qu'en arrivant par la barre latérale. Règle promue dans
  `CLAUDE.md` § React.

## 2026-07-30 — feat/cmd-divers
**Prix unitaire et montant sur les lignes divers des commandes clients.**

Les lignes divers (`ligne_commande_client.TYPE = 3`) s'enregistraient avec `prix = 0` : la
boîte « Nouvelle ligne » ne calculait un tarif que pour l'écru et le fini (barème par tranches
de rouleaux) et laissait le divers en saisie libre, que personne ne remplissait. La carte de
ligne affiche pourtant déjà `Prix u.` et `Montant` pour tous les types — les deux stats sont
simplement conditionnées à `prix > 0` — donc elles restaient invisibles et le total de la
commande affichait 0,00 €.

Le divers se tarife désormais sur la **grille `tarif_divers`**, via le résolveur et l'endpoint
qui existaient déjà pour la boîte article des Expéditions
(`GET /expeditions/divers/lookups/prix`, repli combinaison exacte → `(v1,0)` → `(0,0)` →
`ref_divers.prix_unitaire`). Le prix se recalcule à chaque changement de référence ou d'axe de
variation, et se fige dès que l'utilisateur saisit lui-même un montant. **Pas de cadenas ni de
permission `deverrouiller_tarifs`** ici, contrairement à l'écru/fini : c'est un prix catalogue,
pas un tarif calculé, et ~417 des 1 836 lignes divers existantes visent des références sans
aucune entrée dans la grille — la saisie manuelle doit rester ouverte.

⚠️ Deux faits de données à retenir : une référence à **deux axes n'a pas de ligne `(0,0)`**
(« Tissu Voltige » = 533 cellules couleur × taille), donc le champ reste légitimement vide tant
que les deux axes ne sont pas choisis — ce n'est pas un bug ; et une ligne enregistrée garde son
`prix` comme instantané pris à la commande (rejouer la grille sur les lignes legacy en reproduit
1 346 à l'identique et en écarte 59, antérieures à un changement de tarif) — on ne recalcule
jamais le prix d'une ligne existante, seul un `0` stocké est re-rempli.

Vérifié dans l'app : Tissu Voltige ® / Noir / 20 Mètres → 86,80 €, soit exactement la cellule
(344, 328) de la grille. **Les lignes existantes à 0 ne sont pas reprises** — les rouvrir en
édition pré-remplit le prix, un ré-enregistrement suffit ; un script de backfill reste à faire
si le volume le justifie en production.


## 2026-07-29 — feat/widget
**Six widgets de tableau de bord — Notifications, Utilisation fil, Suivi pièce, Commandes
du jour, Charges, Évolution du CA — dont quatre portent des écrans legacy `FI_*.wdw`.**

- **Notifications** (`dashboard_notifications`) — port de `FI_Notifications.wdw` +
  `FEN_Abonnement.wdw`. Le catalogue et les abonnements sont **partagés** avec l'appli WinDev
  (`abonnement_notif` / `abonnement_user` : s'abonner ici s'abonne là-bas), mais la liste
  d'alertes est **recalculée à chaque lecture** au lieu d'être écrite dans `notifutilisateur` :
  le `hash` legacy est un SHA-1 dont la formule n'a pas pu être retrouvée, donc toute ligne
  insérée s'afficherait en double côté WinDev — et la routine WinDev reconstruit cette table
  de toute façon. `visible = 0` n'a donc plus de ligne où vivre : le masquage est **par
  utilisateur** (`data/notification-hidden.json`), ce qui corrige un défaut legacy où masquer
  une carte la masquait pour toute l'entreprise. 8 détecteurs dans `lib/abonnements.ts`.
  ⚠️ **Un abonnement hors catalogue (société 2) est préservé à l'écriture** — sans ça,
  enregistrer désabonnait silencieusement l'utilisateur côté WinDev.
- **Utilisation fil** (`dashboard_utilisation_fil`) — port de `FI_Utilisation_fil.wdw` :
  pour un fil (+ coloris optionnel), les références écru qui l'utilisent, via
  `composition_ecru`. Le filtre coloris renvoie légitimement **moins** de refs (les lignes de
  base portent `IDcolori_fil = 0`), donc l'écart est affiché plutôt que subi ; les coloris
  sont groupés **par nom** parce que `colori_fil` réutilise les noms (ce fil a neuf « ecru »,
  un seul référencé).
- **Suivi pièce** (`dashboard_suivi_piece`) — port de `FI_Suivi_pièce.wdw`, en frise
  **antéchronologique** séparant les objets (tombé de métier / rouleau fini) des événements
  (transferts, expéditions, commandes). Enrichi au-delà du legacy : fils consommés avec leurs
  commandes d'achat et dates, OF, expéditions, emplacement courant.
  ⚠️ `stock_ecru.IDref_commande_source` contient un id de **ligne**, pas de commande.
- **Commandes du jour** (`dashboard_commandes_jour`) — commandes clients du jour + CA
  (`Σ quantite × prix`, scope ETM `IDsociete = 1 AND IDcommande_ETM = 0`). Les dons sont
  listés mais **hors CA**. Rafraîchi à chaque arrivée sur le tableau de bord.
- **Charges** (`view_rapport_finance`) — charges fixes / variables face à N-1 avec le ratio
  en pastille. **Ni endpoint ni permission supplémentaires** : appelle `/rapports/finance` sur
  la **même clé React Query** que le rapport et somme ses lignes comme le bandeau de totaux.
- **Évolution du CA** (`dashboard_ca`) — CA mensuel, une courbe par année, 5 années en
  pastilles activables, + mode « Annuel » en barres. Endpoint dédié `/rapports/ca-evolution`.

**Transverse — trois points qui touchent du code partagé :**

- **`useElementSize` renvoie désormais une ref CALLBACK.** Avec `useRef` + `useEffect([])`
  l'observer ne s'attache **jamais** à une cible rendue conditionnellement (`{data && <div
  ref={…}>}`) : la taille reste `{0,0}` et un graphe qui teste `w > 0 && h > 0` ne s'affiche
  jamais. Les deux graphes existants ont été revérifiés après le changement.
- **`lib/depassement.tsx`** (pastille N/N-1 + règle de couleur) extrait de
  `RapportFinance.tsx`, **`lib/chart-scale.ts`** (`niceScale`) extrait
  d'`AnalyseFinanciereWidget` — une seule règle, deux consommateurs.
- **`WidgetFrame` gagne `iconBleed`** pour une icône qui est une image (Tricobot).

**Pièges de données documentés dans `CLAUDE.md` (chacun vérifié sur les données) :**
`defaut_qualite.reference` sous `Type_Reference = 2` est **ambigu** entre écru et fini (881
des 900 refs échantillonnées sont des ids écru valides *et* 810 des ids fini) ;
`caAvailableYears()` énumère **à rebours** ; sur l'année en cours les mois non facturés sont
`null` et non `0`, sinon la courbe s'effondre sur l'axe.

Garde-fous : `check-abonnements` (+ `--write`), `check-utilisation-fil`, `check-suivi-piece`,
`check-commandes-du-jour` — tous épinglés sur les captures de l'écran legacy.


## 2026-07-29 — feat/gestion-client
**Clients › Gestion : le compte client (`client.compte`) devient obligatoire, généré
automatiquement à partir du nom, et la création passe par une boîte de dialogue.**

- **« + Nouveau » ouvre désormais un dialogue** (nom obligatoire, secteur, activité) au lieu
  d'insérer une ligne « Nouveau client ». C'est ce qui met fin aux doublons de placeholders
  — la table en contenait 3 au moment du développement — et surtout, **connaître le nom avant
  l'INSERT est ce qui permet d'en dériver le compte**. Après création : sélection de la
  nouvelle fiche + passage en édition automatique (`mps_designer §25.1`).
- **Génération du code** — `apps/api/src/lib/compte-client.ts` (`pickCompte`), doublé côté
  navigateur par `apps/web/src/lib/compte-client.ts` pour la validation en direct. Le
  mnémonique vient des mots significatifs du nom, en écartant les formes juridiques
  (SARL/SAS/SOCIETE…) et les mots génériques du métier (BONNETERIE/TRANSPORTS/ATELIER…)
  exactement comme le faisait le comptable : « Bonneterie Gautier » → `411GAU`. En cas de
  collision on descend une liste de candidats (compression des consonnes, initiales, puis
  variantes numérotées `411SO2` — la forme que le legacy utilisait déjà pour séparer SIGVARIS
  de SIGVARIS SAS), avec un balayage base-36 exhaustif en dernier recours : la génération ne
  peut pas échouer.
- **Génère 3 caractères, valide 3 ou plus.** Mesuré sur les 649 clients qui portent un compte :
  **388 suffixes de 4 caractères**, 225 de 3, 36 d'autres formes. Le produit standardise les
  nouveaux codes sur 3, mais la validation accepte 3+, sinon les 388 fiches historiques
  deviendraient impossibles à enregistrer.
- **Unicité vérifiée uniquement sur les valeurs qui changent**, et **non cloisonnée par
  `IDsociete`** (le code identifie l'entreprise dans le grand livre). 10 doublons existent déjà
  dans le legacy (`411SOFI`, `411HERM`…) : les bloquer sur une modification sans rapport aurait
  été une régression.
- **Le doublon est signalé pendant la frappe**, pas au clic. `GET /clients/comptes` renvoie
  tous les codes en usage et `useComptesPris()` les met en cache sous une seule clé React Query
  (l'appel de l'InfoTab est dédupliqué, zéro requête supplémentaire) : Créer / Enregistrer
  restent grisés tant que le code est invalide ou déjà pris. Le serveur revalide sur POST/PUT
  et reste l'autorité — le cache peut vieillir si quelqu'un d'autre crée un client entre-temps.
- **Aucune fiche ne peut plus être enregistrée sans compte valide** : format contrôlé côté API
  sur POST **et** PUT, et côté écran l'enregistrement *et* la sortie du mode édition sont
  bloqués via `shouldBlockExit` / `onExitBlocked` (`mps_designer §28.5b`). Entrer en édition sur
  une fiche au compte vide ou malformé pré-remplit une suggestion (l'instantané est mis à jour
  en même temps, donc le pré-remplissage seul ne rend pas le formulaire « sale »). La validation
  est conditionnée à `edit_client_info` : un utilisateur qui ne peut pas éditer le champ n'est
  jamais bloqué par lui.
- **Garde-fou** : `apps/api/src/scripts/check-compte-client.ts` rejoue la génération sur les
  654 clients — 0 code invalide, 0 collision, et le mnémonique du comptable est reproduit sur
  60 % des fiches (167/240 en correspondance exacte sur le sous-ensemble comparable à 3
  caractères). Il montre aussi ce qui serait généré pour les fiches sans compte et vérifie que
  les collisions en cascade convergent.

Les fiches existantes ne sont **pas** rétro-remplies : les deux clients sans compte (OMELA,
MAPOESIE) recevront une suggestion à la première ouverture en édition.

## 2026-07-29 — feat/expedition

**Clients › Expéditions — demande de transport groupée : une seule demande d'enlèvement pour
plusieurs expéditions, cumulant tous leurs rouleaux.**

Port de la sélection multiple + clic droit → « Transport » de l'écran legacy *Expéditions*.

- **Bouton « Demande de transport » en bas de la liste de gauche** (barre épinglée au-dessus du
  pied, comme les actions par lot de Clients › Facturation). **Bucket Textile uniquement** — la
  fiche n'a pas d'équivalent Diverses — et désactivé en mode édition, comme toute action par lot
  (imprimer en cours d'édition imprimerait des chiffres d'avant enregistrement).
- **Dialogue de sélection** alimenté par les expéditions **actuellement affichées** : la
  recherche et les filtres Textile / Non facturées de la liste de gauche restreignent donc aussi
  le sélecteur. Chaque ligne affiche n° · client · date · `rlx · kg`, avec un total vivant
  « Total à enlever : X kg en N rouleaux » — le chiffre imprimé est visible **avant** de cliquer.
  Sélection par plage **MAJ + clic** (`mps_designer §44`) et « Tout sélectionner ».
- **Une fiche = un client et une adresse de livraison.** Le premier choix **filtre la liste** sur
  ce client et cette adresse : les expéditions qui ne peuvent plus rejoindre le lot disparaissent
  au lieu de rester grisées (le legacy, lui, refusait la sélection *après coup* avec « Toutes les
  lignes sélectionnées ne sont pas liées au même client »). Les expéditions sans adresse restent
  éligibles : elles héritent de celle qui est renseignée. Vider la sélection rend toute la liste.
- **API** : `GET /expeditions/formelle/groupee/demande-transport/pdf?ids=…`, **déclarée avant**
  `/formelle/:id/demande-transport/pdf` — les deux motifs font 4 segments, sinon Express prendrait
  `groupee` pour un id. `buildDemandeTransportPdfData` prend désormais un **tableau** d'ids, si
  bien que la route unitaire et la route groupée partagent un seul chemin de code, et les deux
  règles (même client / même adresse) sont **revérifiées côté serveur** (400 + message français).
  Le transporteur n'est imprimé que si toutes les expéditions désignent le même, sinon le bloc
  Destinataire reste vierge — c'est un champ à remplir à la main sur la fiche legacy.
  `GET /expeditions` expose en plus `IDadresse` (c'est lui qui pilote le verrou d'adresse côté
  écran).
- **PDF** : la référence de l'en-tête liste les numéros (`N°A + N°B + N°C`) et se replie en
  « N expéditions » au-delà de 3, sinon elle déborderait sur la date ; la ligne « Commandes » de
  la carte Informations se replie en « N commandes » au-delà de 2, pour la même raison (la carte
  est une colonne de largeur fixe dont la valeur, alignée à droite sur une seule ligne, repasse
  **par-dessus son propre libellé** quand elle est trop longue). Les listes complètes sont
  imprimées sous l'encadré de poids, en texte courant, où elles peuvent revenir à la ligne :
  *« Regroupement de 6 expéditions : … »* + *« Commandes : … »*. La fiche mono-expédition est
  inchangée au pixel près. Aperçu sans base : `apps/api/src/scripts/dump-demande-transport-pdf.ts`
  (une 3ᵉ variante groupée a été ajoutée).

**Limite connue, laissée en l'état** : le débordement de valeur longue est latent dans
`MetadataCard` (`MalterreDocument.tsx`) pour **tous** les documents, pas seulement celui-ci — un
`flexShrink: 1` sur `metaValue` le ferait revenir à la ligne, mais cela touche la mise en page de
tous les PDF de l'app et méritait un commit dédié plutôt qu'un effet de bord de celui-ci.

## 2026-07-29 — feat/rapport-finance
**Rapports › Finance : tiroir enrichi (nature de la charge éditable) + le bandeau bleu marine
des widgets adopté par TOUS les tiroirs latéraux de l'app.**

Côté **Rapports › Finance** :

- **Le bouton « Modifier » remonte dans l'en-tête du tiroir**, en haut à droite, comme sur tous
  les écrans de détail de l'app (`mps_designer §6.1`). La carte Description perd son pied de
  boutons : un seul mode édition couvre désormais les deux champs, avec Annuler / Enregistrer
  dans le même bandeau.
- **La nature de la charge devient éditable.** Nouvelle carte « Nature de la charge », placée en
  **première** position du corps (elle qualifie tous les chiffres en dessous) : lecture seule en
  vue, sélecteur segmenté Charges fixes / Charges variables en édition. `PATCH
  /rapports/finance/comptes/:id` accepte maintenant `description` **et/ou** `variable`
  (`compte_compta.frais_variable`), chaque champ optionnel — un champ non touché n'est jamais
  réécrit, et éditer la seule note ne peut pas reclasser le compte par effet de bord. Même clé de
  permission que l'annotation (`edit_compte_description`, dont le libellé est mis à jour).
  Reclasser un compte **bascule le tableau sur l'autre onglet en gardant la ligne sélectionnée** :
  le cache React Query est patché *avant* l'invalidate, sinon la ligne quitte la liste fraîchement
  changée pendant un rendu et le tiroir se referme d'un clignotement.
- **Historique annuel trié à l'envers** : l'année la plus récente en haut, la plus ancienne en bas.

Côté **design system** — le nouveau bandeau a plu, il devient le standard :

- **`mps_designer §27.5bis`** (nouveau) décrit le bandeau « widget » des tiroirs latéraux :
  surface bleu marine `bg-primary`, filet or `border-b-2 border-gold`, tuile or plate `h-8 w-8`
  (qui passe en blanc en mode édition), titre blanc, sous-titre `text-white/70`, plus un tableau
  des rôles de boutons (Modifier or / Enregistrer **or** et non bleu — invisible sur bleu —
  / Annuler ghost blanc / actions icône ghost blanches). §27.5 et la checklist §27.7 pointent
  dessus ; §43 précise que le bandeau zinc ne survit que là où il coiffe un panneau zinc *de la
  page* (barre d'onglets §8, tiroir intégré §31), jamais un calque.
- **Appliqué aux 5 tiroirs latéraux de l'app** (les seuls `fixed right-0 … translate-x-full`) :
  Rapports › Finance, **Fils › Stock**, **Finis › Stock**, **Tombé Métier › Stock**,
  **Divers › Stock**. Les puces pastel porteuses de sens (Bio, Recyclé, 2ᵉ choix, Don, Expédiée)
  sont conservées telles quelles — elles se lisent très bien sur le marine et la couleur EST
  l'information ; seule une puce sans fond (« Archivée » de Divers, invisible sur marine) passe
  en puce neutre `bg-white/15`.

**Note pour la suite** : la campagne de captures Playwright (`§40.7`) est rouge sur ce poste,
**y compris avant ce changement** — vérifié en remisant le travail : diffs identiques (648 /
1635 / 570 px) sur des tests sans tiroir (`cards-default`, `mobile-sort`). Les baselines ont
donc dérivé indépendamment (moteur de rendu). Elles n'ont **pas** été re-bénies ici, pour ne pas
mélanger le changement de design volontaire avec cette dérive préexistante : à faire dans un
commit dédié, sur la machine qui les a bénies.

## 2026-07-29 — feat/cmd-client
**Clients › Commandes — dialogue « Nouvelle commande » ennoblisseur : plus de présélection, rouleaux triés.**

Deux corrections d'usage sur `CreateEnnoblisseurOrderDialog` (`ClientsCommandes.tsx`), le
dialogue ouvert depuis l'onglet Ennoblissement d'une ligne de commande client, bouton
« Nouvelle commande » d'une ligne d'emplacement :

- **Aucun rouleau sélectionné par défaut.** L'effet de montage qui présélectionnait tout
  l'écru disponible chez l'emplacement (et le `initRef` qui le gardait) est supprimé. Le
  dialogue s'ouvre sur « Aucun rouleau sélectionné », la jauge n'affiche que l'affecté déjà
  en place, et « Créer la commande » reste désactivé tant que l'utilisateur n'a rien coché.
  L'intention « tout confier au teinturier » reste à un clic via le raccourci **Tout**.
- **Tri croissant par numéro de rouleau.** La liste est triée sur `numero` avec un
  comparateur numérique (`localeCompare(…, { numeric: true })`), donc `3377/1, 3377/2, …
  3377/16, 3377/1001` se lit de haut en bas dans l'ordre réel et non lexical (où `1001`
  passait avant `16`). `Tout` / `Aucun` et les plages Maj+clic suivent le même ordre affiché,
  puisque `orderedIds` dérive de la liste triée.

## 2026-07-29 — feat/qualite
**Qualité : écran Actions + conformité par lot + mentions automatiques sur les commandes sous-traitant.**

Porte le légacy `FI_Action_Qualité.wdw`. Une **action qualité** (`action_qualite`) est un sujet
qualité suivi (Titre + Description) qui porte des **mentions** (`mention_qualite`) : des
commentaires automatiques qui s'impriment sur chaque bon de commande sous-traitant
correspondant. Chaque mention accumule des verdicts de **conformité** (`conformite_action`,
un par couple (ligne de commande sst, mention) : `Non_Contrôlé` / `Conforme` / `Non_Conforme`
/ `Aucun`), saisis depuis Qualité › Suivi lots.

**Règle de correspondance** (rétro-conçue depuis les données — les sources WinDev sont
compressées PCS — et validée : elle reproduit **les 248 lignes `conformite_action` du légacy**) :
une mention s'applique à une `ligne_commande_sous_traitant` quand `lcs.type = IDtype_sst` ET
`lcs.IDreference = mention.IDreference` ET (`mention.IDsous_traitant = 0` OU = le sst de la
commande) ET (`mention.IDColoris = 0` OU = `lcs.IDColoris`). Ici `0` est le **joker « tous »**
du légacy, pas une donnée manquante. Les `IDreference`/`IDColoris` de la mention sont
polymorphes exactement comme ceux de la ligne (type 1 → `ref_ecru`/`colori_ecru` ; type 2 →
`ref_fini` + la règle `avec_teinture`) — cf. mention 21, un fini `avec_teinture=0` qui pointe
sur `colori_ecru`.

**Les mentions ne sont jamais persistées sur la commande** — le légacy ne le faisait pas non
plus (aucun `commentaire`/`journal` de commande ne contient le texte d'une mention). Elles sont
résolues à la volée, donc modifier une action met à jour tous les futurs bons de commande.
Source unique : `GET /commandes-sous-traitant/:id/mentions-qualite`, consommée à la fois par
l'écran et par le PDF, pour qu'ils ne puissent pas diverger.

**Écrans.** `/qualite/actions` (layout Fiche) : liste filtrée En cours / Terminées / Toutes,
sections Description + Mentions + Conformité des commandes, dialogue de mention calqué sur la
popup légacy Tricoteurs/Ennoblisseurs, sidebar Suivi/Infos, pied de statut binaire.
**Suivi lots** gagne un onglet **Actions** (verdicts Conforme / Non conforme / Non contrôlé,
écriture immédiate) ; un verdict saisi sous une action ensuite clôturée reste visible en
historique. **Sous-traitants › Commandes** affiche une carte rouge *Mentions qualité* en
lecture seule, et le bon de commande PDF un bloc `MENTIONS QUALITÉ`.

**Archivage manuel, par décision produit explicite.** L'*objectif de conformités* (stocké dans
`data/action-qualite-targets.json`, hors HFSQL, car le WinDev lit encore `action_qualite`)
n'allume qu'un indicateur « objectif atteint » — il ne clôture **jamais** une action tout seul.
Ne pas « améliorer » ça en auto-clôture plus tard.

**Pièges HFSQL (détaillés dans `apps/api/src/lib/actions-qualite.ts`).** `mention_qualite` a une
**PK accentuée ET une FK parent accentuée** (`IDmention_qualité`, `IDaction_qualité`) : aucun
identifiant ASCII ne permet un `WHERE`. Les écritures Linux réécrivent donc tout le **bucket
`IDreference`** (DELETE par la colonne ASCII `IDreference`, puis INSERT positionnels en
préservant PK et action parente). La PK de `conformite_action` est ASCII grâce à la coquille
légacy **`IDconfomite_action`** (conf-**o**-mite, sans `r`) — mal lire ce nom fait parser toutes
les PK à `0`, donc `max+1` vaut 1 et l'écriture suivante **écrase silencieusement la vraie ligne
1** (c'est arrivé pendant le développement, sur la base de dev, réparé). `assertPk()` garde
désormais chaque calcul de PK.

**Nettoyages.** L'onglet *Client* de Suivi lots est supprimé (il ne portait que le nom client —
déjà dans le récapitulatif — le n° de commande client et la réf. client, tous deux déplacés dans
le récapitulatif) ; ça ramène la barre à 4 onglets, qui débordait à 5. Le récapitulatif est
regroupé en deux panneaux *Commande sous-traitant* / *Commande client* (les deux ont un
« Commande N° »), sans les lignes `Numéro de lot` et `Référence` qui dupliquaient le H1 et le
sous-titre de l'en-tête.

**Vérification.** `apps/api/src/scripts/check-actions-qualite.ts` (`--write` pour l'aller-retour
d'écriture) ; son option `--linux` **refuse de tourner hors Linux** (`queryB64Text` y est un
passe-plat, donc simuler le bridge sous Windows lit du texte mangé et le réécrit sur les lignes
voisines — ça a corrompu deux mentions en développement, restaurées depuis).
`find-actions-qualite-demo-data.ts` liste les enregistrements de dev qui exercent la
fonctionnalité. Build + 52 tests verts.

## 2026-07-29 - feat/widget
**Tableau de bord : widget Analyse financière, plusieurs tableaux de bord, et enrichissement du widget Chiffre d'affaires.**

(1) **Widget `Analyse financière`** (nouvelle permission `dashboard_finance`, catégorie Tableau
de bord, gardée aussi côté API). Porte l'écran légacy *Analyse Financière* : courbes cumulées de
l'année (CA, marge brute, charges fixes, charges variables) et les trois chiffres du jour (CA,
marge brute, EBE) avec leur part du CA. Les formules sortent des agrégats pré-calculés de
`upload_compta` : `CA = produits`, `marge brute = produits - frais_variable`,
`EBE = marge brute - frais_fixe` (les provisions restent dehors, c'est la définition de l'EBE).
Vérifié contre l'écran légacy du 28/07/2026 : sa marge moins son EBE vaut exactement les charges
fixes que son aire rouge atteint en juillet. Les uploads étant des balances **cumulées** depuis
le 1er janvier, un point de courbe est le **dernier upload du mois**, jamais une somme ; et le
premier upload de l'année est écarté quand c'est la clôture de l'exercice précédent (début
janvier, il écrase le suivant : 2026-01-05 porte les chiffres finaux de 2025). Route
`GET /api/rapports/finance/analyse` ; `loadUploads()` a été extrait pour que le rapport Finance
et cette série mensuelle ne lisent la table qu'une fois. Le graphique est un SVG écrit à la main
(aucune librairie ajoutée) ; sa palette est validée par `validate_palette.js` de la compétence
`dataviz` (bande de clarté, chroma, séparation daltonisme, contraste 3:1), et le seul
avertissement restant est couvert par un second canal non coloré : **produits en trait plein,
charges en pointillés**, dans le graphique comme dans la légende. Ne pas « simplifier » les
pointillés.

(2) **Plusieurs tableaux de bord par utilisateur.** Ce sont désormais les onglets de sous-menu de
« Tableau de bord ». « Principal » existe toujours et reste routé sur `/` ; ceux que
l'utilisateur crée vivent sur `/tableau-de-bord/<id>` (id aléatoire, donc renommer ne casse
jamais un favori). Les onglets sont de la **donnée, pas de la config** : `navigation.ts` ne
déclare rien, `Header.tsx` les lit via `useDashboardTabs()` qui partage l'entrée de cache de la
disposition, donc créer / renommer / supprimer met la barre à jour immédiatement. La gestion est
dans le menu « Tableaux » du mode édition (un menu plutôt que trois boutons de plus sur une
ligne qui en portait déjà quatre) : le principal se renomme mais ne se supprime pas, et créer un
tableau embarque le brouillon en cours dans la même écriture au lieu de le perdre. **La règle de
fusion diffère par onglet** : un widget que la disposition ne mentionne pas est ajouté
**visible sur le principal** (une disposition périmée ne doit jamais masquer un widget qu'un
admin vient d'accorder) et **masqué sur les autres** (un nouveau widget ne doit pas s'inviter
dans un tableau composé à la main), donc un nouveau tableau démarre vide, tous ses widgets dans
le tiroir. Stockage `dashboards: [{id, name, layout}]` dans `data/user-profiles.json` ; les
profils écrits avant les onglets portent un `dashboard` simple, migré **à la lecture** dans
l'onglet principal et réécrit seulement à la première sauvegarde (donc un retour arrière
retrouve l'ancienne forme intacte).

(3) **Widget `Chiffre d'affaires`.** Le classement départage désormais les ex aequo sur le CA
N-1, ce qui range les clients à 0 € cette année par leur CA de l'an dernier au lieu de l'ordre
alphabétique. Deux contrôles nouveaux : une **période de comparaison** (`period=full|ytd`, où
`ytd` coupe **les deux années** au jour d'aujourd'hui, sinon on compare une année partielle à
une année pleine) et une **vue** sur le tableau (classement CA, meilleures progressions, plus
fortes baisses, nouveaux clients, clients perdus, répartition). Progressions et baisses se
mesurent en **mouvement de rang** et écartent chacune la catégorie qui a sa propre vue (un
nouveau n'a pas grimpé, il n'avait pas de rang ; un perdu n'a pas glissé, il a quitté le
classement). La vue **Répartition** remplace le tableau par un anneau : chaque client à
10 000 € ou plus a sa part, les 5 000 - 10 000 € en partagent une et la traîne sous 5 000 € une
autre. Les deux paniers sont gris, hors palette, pour que l'œil sépare les clients nommés de la
traîne ; au-delà de huit clients la palette fait un second tour éclairci (encodage hue × nuance)
plutôt qu'une neuvième teinte inventée, qu'aucun daltonien ne pourrait distinguer. Le total, ou
le client survolé, s'affiche au centre.

(4) **Corrections de structure du tableau de bord.** `CardContent` passe de `min-h-full` à
`h-full` : avec une hauteur automatique, la boîte de classement grandissait jusqu'à ses 144
lignes et c'était **la carte entière qui défilait**, laissant inutilisés le défilement interne
du tableau, son en-tête collant et sa ligne de totaux. Le tableau du classement passe en
`table-fixed` + `colgroup` (`mps_designer §27.3`) : en disposition automatique, un nom de client
long fixait la largeur minimale du tableau et poussait les colonnes € hors de la carte. Enfin,
les deux widgets se dimensionnent sur **leur propre largeur** (`hooks/useElementSize.ts`,
partagé) et non sur celle de l'écran : un point d'arrêt `sm:` garde trois tuiles côte à côte
dans une carte de 300 px sur un écran de 1920, ce qui coupait les montants en trois lignes.
Seuils : tuiles empilées sous 470 px, colonne N-1 retirée sous 470 px, colonne Évolution sous
350 px. L'anneau est tracé à une taille carrée explicite prise de sa boîte mesurée, jamais en
`h-full w-auto` : un SVG 1:1 à qui on demande de remplir une carte haute et étroite ressort plus
large que la carte et fait défiler le widget latéralement.
## 2026-07-29 — feat/commande-client
**Sélection par plage (MAJ + clic) sur les listes multi-sélection + règle `mps_designer §44`.**

Dans **Clients › Commandes**, le tiroir d'affectation d'une ligne (`AffectationDrawer`)
n'acceptait qu'un clic par rouleau : cocher vingt rouleaux dans *Stock disponible* demandait
vingt clics, alors que les tableaux de *Sous-traitants › Commandes* acceptent déjà MAJ + clic.
Les deux listes du tiroir — *Stock disponible* (→ Affecter) et *Affecté à la commande*
(→ Expédier) — passent au modèle à ancre : un clic simple bascule la ligne et devient l'ancre
(`useRef`, pas d'état → aucun rendu supplémentaire), MAJ + clic applique la plage inclusive
entre l'ancre et la ligne cliquée **dans l'ordre affiché**. L'ancre ne bouge pas sur un
MAJ + clic, ce qui permet d'élargir puis de rétrécir une plage depuis une origine fixe ;
MAJ + cliquer une extrémité déjà sélectionnée **désélectionne** toute la plage. `RollRow`
transmet désormais `e.shiftKey` depuis la carte **et** depuis la case à cocher interne
(qui garde son `stopPropagation`), et la carte prend `select-none` — sans quoi MAJ + clic
peint une sélection de texte au lieu d'étendre la sélection. Les ancres sont remises à zéro
au succès des mutations (affecter / expédier), sur *Aucun*, et quand la sélection sœur prend
la main (les deux sélections du tiroir sont mutuellement exclusives : sans ça un MAJ + clic
ultérieur partirait d'une origine périmée dans une liste que l'utilisateur a quittée).
*Tout* place l'ancre sur la **dernière** ligne, pour qu'un MAJ + clic suivant rétrécisse
depuis la fin.

La règle est écrite dans **`mps_designer §44`** (« Shift+click range selection — mandatory on
every multi-select list ») : elle était appliquée au cas par cas (`SousTraitantsCommandes`,
`FinisStock`, `ClientsGestion`) mais n'était documentée nulle part, d'où l'oubli sur cet
écran. §44 la rend obligatoire pour **toute** surface multi-sélection, donne le handler
canonique à recopier et consigne les pièges : ancre en `useRef` immobile sur MAJ + clic,
plage calculée sur l'ordre **rendu** (ou sur le sous-ensemble réellement sélectionnable),
`select-none` obligatoire, branche `deselect`, remises à zéro de l'ancre, et pas de Ctrl+clic
(le clic simple bascule déjà sans vider la sélection). Note au passage : les handlers de
`SousTraitantsCommandes` sont en ajout seul (ils précèdent la branche `deselect`) — non
modifiés ici, mais le nouveau code doit inclure la branche.

Aucun changement API, aucun changement de schéma.
## 2026-07-29 — feat/rapport-finance (2e lot)
**Rapports › Finance : code couleur du dépassement N vs N-1.**

Le tableau signale désormais d'un coup d'œil les comptes qui coûtent plus cher que l'an
dernier. Le ratio affiché (`montant / montant N-1`) pilote un feu tricolore : **vert** sous
le montant N-1, **ambre** de 100 % à 120 %, **rouge** au-delà de 120 %. La classification lit
le pourcentage **arrondi** (celui rendu à l'écran), jamais le ratio brut, pour que la couleur
ne puisse pas contredire le nombre affiché juste à côté. Le pourcentage devient une pastille
douce (même langage que les pastilles d'état stock fini), reprise dans le tableau desktop, la
carte mobile, le totalisateur et le tiroir. Les lignes ne se teintent que sur les états
d'attention (`bg-amber-50` / `bg-red-50`, mêmes teintes que Rapports › Commandes sst) — une
ligne verte reste blanche, sinon les comptes en dépassement ne ressortent plus ; la sélection
(`bg-accent/10`) l'emporte toujours.

**Compte sans montant N-1** = compte ouvert cette année : il n'y a rien à dépasser, donc
**aucun pourcentage n'est écrit** (l'API renvoie 0, et afficher « 0 % » se lit « n'a rien
coûté »), ni à l'écran ni dans l'export Excel — la cellule reste vide plutôt que de fausser
une moyenne de colonne. Ces lignes portent une **teinte grise** (`bg-zinc-100/70`) pour se
lire « hors comparaison ». Un compte à zéro sur les deux années n'est pas « nouveau » mais
dormant : il reste neutre (`estNouveau()` exige un montant non nul cette année). Le tiroir
garde sa ligne « Pourcentage » avec le tiret cadratin habituel, une ligne étiquetée vide se
lisant comme un bug d'affichage.

Le totalisateur a aussi été aéré : les trois chiffres (Total N, Total N-1, ratio) s'enchaînaient
en une seule longue suite de nombres, les libellés inline se mêlant aux montants. Chaque
figure est maintenant un **bloc étiquette-au-dessus-valeur** (libellé `text-[10px]` majuscules
muted), avec des séparateurs qui couvrent les deux lignes et des écarts élargis. Sous `sm`,
les libellés d'année restent masqués et les valeurs redescendent en `text-sm` : la barre tient
toujours sur une ligne (§40.5bis).

## 2026-07-29 — feat/finis
**Finis › Tarifs : simulateur de prix + nettoyage du menu Finis.**

(1) **Menu Finis** : les sous-menus `Coloris Teint` et `Prévisions` sont retirés (entrées de
navigation, table des titres de page, routes et composants placeholder). Finis se limite
désormais à Références · Stock · Études coloris · Tarifs.

(2) **Écran `Finis › Tarifs`** (`/finis/tarifs`), portage du légacy `FI_Tarifs.wdw`. Une
simulation (`ref_tarif`) est un **bac à sable de chiffrage**, pas une fiche catalogue : tous
les paramètres physiques sont saisis à la main, y compris le **€/Kg de chaque fil**. Layout
Fiche : à gauche la liste avec filtre segmenté `En cours` / `Archivées` / `Toutes` ; au centre
*Composition* (table Référence / Coloris / Prix / %, badge de total % vert-ou-ambre, pied
`Coût matière`, édition en ligne au clic, bouton pointillé `Ajouter un fil`), *Paramètres*
(prix de tricotage, poids rouleau, rendement, laize, poids, freinte + bascule de port
`Pourcentage` / `Au Kg`), *Ennoblissement* (Sans / Simple / Double × Blanc / Tous Coloris,
multiplicateur, puces de traitements) et *Commentaire* ; à droite deux onglets — `Tarif`
(les 9 tranches + le détail de coût dans le rendu doré `CostSection` partagé avec Finis ›
Références) et `Simulation` (chiffrage libre) — surmontant la pastille d'état §29
`En cours` / `Archivée`.

(3) **Aperçu en direct.** `POST /api/tarifs-fini/:id/preview` chiffre les paramètres **non
enregistrés** : le panneau droit se recalcule pendant la saisie, ce qui est tout l'intérêt de
l'écran. La clé de requête est l'ensemble des paramètres sérialisé, débouncé à 400 ms en
édition (0 en consultation), et le corps de la requête est reparsé **depuis cette même clé** —
une entrée de cache ne peut donc jamais diverger des paramètres qu'elle a chiffrés. La
composition et les traitements, eux, sont persistés immédiatement (même modèle que les
sous-formulaires de FilsGestion).

(4) **Moteur de prix** (`apps/api/src/lib/pricing-ref-tarif.ts`). Il partage les maths du
chiffreur catalogue — bandes de marge `COEFFICIENT_V2`, recherche de tranche tarifaire sur
`poids = rouleaux × poids_rouleau + 1`, majoration conditionnement +5 %, remises tricotage
−5 %/−10 % à 15/30 rouleaux, port à 3 % sur la tranche 30 — avec **deux différences
délibérées**, toutes deux rétro-conçues depuis les données (sources WinDev compressées PCS) :
la majoration d'ennoblissement est le champ manuel `ref_tarif.multiplicateur` et **non**
`multiplicateurMatel(rendement)` (la simulation 522 a un rendement de 3,78 — MATEL donnerait
×1,03 — mais affiche `X1` et ses neuf prix ne se reproduisent qu'avec ×1) ; et le prix de
tricotage est le `prix_tricotage` saisi, puisqu'il n'y a pas de `ref_ecru` derrière une
simulation. Contrôle de non-régression : `apps/api/src/scripts/check-ref-tarif-parity.ts`,
**46/46 exact** sur les simulations 522 et 514 (les 18 prix de tranche + les détails de la
tranche 0). Le chiffrage libre inverse la même formule : donnez-lui un coefficient il rend le
prix, donnez-lui un prix cible en €/Ml il résout le coefficient (borné à 0 sous le coût).

(5) **Modèle de données.** `ref_tarif` : `ok_tarif = 1` ⇒ archivée ; le mode de teinture vient
de `IDteinture` (0 = sans ; `teinture.simple_teinture` sépare simple/double,
`designation_interne` sépare Blanc / Tous Coloris) — **`avec_teinture` sur cette table est une
copie vestigiale de la référence source et n'est pas lue** ; le mode de port est *dérivé*
(`port_pct > 0` ⇒ pourcentage, sinon `port_fixe` €/Kg forfaitaire), l'enregistrement remet à
zéro la colonne inutilisée pour que le mode fasse l'aller-retour. `asso_fil_tarif.prix` est un
**instantané par simulation** que l'utilisateur surcharge, jamais une lecture vivante de
`ref_fil.prix_kg` : c'est pourquoi une vieille « Copie de 081A » continue de chiffrer son fil
de 2026. `asso_traitement_tarif` porte une ligne **par application** — un même traitement peut
se répéter (la simulation 514 embarque Chardonnage ×4) — affiché trié par `traitement.ordre`.

(6) **Création** (`POST /api/tarifs-fini`) en trois modes : `from_fini` (reprend géométrie,
freinte et rendement de `ref_fini`, prix de tricotage et poids rouleau de son `ref_ecru`, la
composition de l'écru avec les prix instantanés, et `traitement_ref_fini` ; `avec_teinture`
1/2 se mappe sur la teinture « Tous Coloris » du niveau correspondant, 7 / 5 — c'est ainsi que
toutes les lignes « Copie de … » du légacy ont été faites), `duplicate` et `blank`.

Notes HFSQL : `ref_tarif.reference` / `.commentaire` portent du texte accentué sous des **noms
de colonnes ASCII** — nommables en SQL, mais lecture via `fixEncoding()` et écriture via
`sqlText()` (littéral hexa Latin-1) ; aller-retour vérifié guillemets compris. Les libellés de
composition passent par des requêtes plates + fusion JS, jamais un JOIN + `CONVERT` (qui
effondre le résultat sur le pont Linux). Les routes `/lookups/*` sont déclarées **avant
`/:id`** pour qu'Express ne les avale pas.

Point de vigilance laissé ouvert : la règle du multiplicateur n'a pas pu être confirmée sur
une simulation à fort rendement portant un Lavage (les deux captures de référence ont un
rendement ≤ 3,78, où MATEL vaut ×1 de toute façon). L'arithmétique est concluante sur la ligne
de teinture ; ouvrir `228/59 test` (rendement 6,53) dans le légacy et y lire `X1` la
confirmerait définitivement.

## 2026-07-28 — feat/widget
**Tableau de bord : widget Chiffre d'affaires + tableau de bord personnalisable.**

(1) **Widget `Chiffre d'affaires`** (permission `dashboard_ca`, catégorie Tableau de bord).
Porte le bloc légacy *Comparatif CA* : chaque client classé par CA de l'année choisie, avec le
CA de l'année précédente, l'écart de rang et l'évolution en %. La formule a été rétro-conçue
depuis les données (les sources WinDev sont compressées PCS) et reproduit le légacy **au
centime** : `CA = Σ round2(ligne_facture.quantite × prix)` sur `facture` avec `IDsociete = 1`,
**`facture.TYPE = 2` (avoir) compté en négatif**, cumulé en centimes entiers. L'arrondi est
appliqué **par ligne** : sommer les flottants bruts dérive de quelques centimes par an et ne
colle plus au légacy (2025 : 2 684 442,74 € vs 2 684 442,81 €). Routes
`GET /api/rapports/ca-clients` et `/ca-mensuel` (`routes/rapports.ts`), **gardées côté API**
par `dashboard_ca` — la donnée est confidentielle, l'API refuse même à qui devinerait l'URL.
Contrôle de non-régression : `apps/api/src/scripts/check-ca-legacy-parity.ts`. Écart connu et
assumé : la cellule mars 2026 du légacy affiche 220 144,84, ce qui fait que ses colonnes
mensuelles totalisent un centime de moins que sa propre ligne TOTAL — on garde la somme exacte
(220 144,85).

(2) **Tableau de bord personnalisable.** *La permission décide de la disponibilité, la
disposition de l'utilisateur décide de l'affichage.* « Personnaliser » ouvre un mode édition
**sans panneau de contrôle par widget** : la carte entière est la poignée de déplacement, les
bords la redimensionnent. Moteur : **react-grid-layout v2** avec compaction verticale — chaque
widget a une **position (x, y)** réelle, un fantôme doré suit le curseur et la gravité tasse
tout vers le haut. C'est ce qui permet de poser un widget dans la colonne de droite sous un
voisin court pendant qu'un grand occupe la gauche ; le modèle de flux ordonné essayé d'abord
ne pouvait pas l'exprimer (ne pas y revenir). Sous `lg` la grille est court-circuitée :
colonne unique triée par (y, x), hauteurs **définies** (avec `auto` le corps scrollable ne
s'enclenche jamais et la carte s'étire à tout son contenu). Ajouter un widget = **une entrée**
dans `components/dashboard/registry.tsx` ; un widget que la disposition enregistrée ne
mentionne pas est ajouté **visible**, donc une disposition périmée ne peut jamais masquer un
widget qu'un admin vient d'accorder. Persistance par utilisateur dans `data/user-profiles.json`
(`GET`/`PUT /api/user-profiles/me/dashboard`) : la disposition suit la personne d'un poste à
l'autre, et une disposition égale aux défauts est stockée `null` (« je n'ai pas d'avis »)
plutôt qu'en copie figée. ⚠️ `isEmptyEntry()` dans `lib/user-profiles.ts` doit lister **tous**
les champs optionnels — sans ça, effacer une signature supprimait la disposition.

(3) **Emplacement des actions d'écran.** Nouveau `contexts/HeaderActionsContext.tsx` : un écran
publie ses propres boutons dans l'en-tête de l'app, à droite, juste avant les actions globales.
Zéro place perdue en vertical, et l'en-tête étant `sticky`, Enregistrer reste atteignable en bas
d'un tableau de bord long — le bandeau in-page qu'il remplace défilait hors écran. Piège
documenté (`mps_designer §3`) : **les événements d'un portail remontent l'arbre REACT**, donc un
clic dans l'en-tête atteignait le gestionnaire de l'écran — d'où le garde
`rootRef.contains(target)` du menu contextuel. Le clic droit sur le fond du tableau de bord est
un raccourci secondaire (jamais le seul chemin : introuvable et inexistant au tactile).

(4) **Design.** Nouveau `WidgetFrame` : bandeau **navy, pastille dorée, titre blanc**, filet doré
dessous — le couple de la sidebar transposé sur une carte (`mps_designer §43`, avec les deux
traitements essayés et rejetés). Sous-titres supprimés, bandeau ramené de 76 à 54 px.
`PopoverSelect` gagne `widthClass` : `size="sm"` impose `w-[220px]` sur sa propre racine, donc
l'envelopper dans un div plus étroit ne le contraint pas — il déborde et pousse ses voisins hors
de la carte (`§11bis`).

⚠️ **Gotcha Vite** : react-draggable (dans react-grid-layout) lit `process.env.DRAGGABLE_DEBUG`
— `vite.config.ts` le définit, sinon le navigateur lève « process is not defined » au premier
glisser.

Retiré au passage : le dialogue *Rapport CA/Client* (matrice mensuelle + export Excel), devenu
inatteignable après la suppression demandée du bouton « Détail ». L'endpoint
`/api/rapports/ca-mensuel` reste en place — le rapport est à re-héberger sous **Rapports** quand
on le voudra.

## 2026-07-28 - feat/donation
**Clients › Commandes** - nouveau document **« Calcul de la valeur »** sur les commandes de
type donation, portage de l'état legacy `ETAT_ValeurDonation` (imprimé en `DON<numero>.pdf`).
Il apparaît comme entrée supplémentaire des menus contextuels **Imprimer** et **Envoyer un
email** (mps_designer §42 `DocMenuButton`), uniquement quand `commande_client.donation = 1` :
une commande donation n'a pas de proforma, elle a donc désormais deux entrées au lieu d'une
seule. Les commandes normales sont inchangées.

**Modèle de coût** (reconstitué depuis les données de la donation 3693 - les sources WinDev
sont compressées PCS, illisibles). Pour chaque pièce rattachée par `IDcommande_donation`
(rouleau écru ou fini) :

```
€/kg = Σ(% composition × prix d'achat du lot de fil)   ← ref_fil_commande.prix_unitaire
     + ref_ecru.prix                                    ← tricotage
     + teinture + Σ traitements                         ← tranche_tarif_ennoblissement, sst 0
valeur = €/kg × le poids de la pièce
```

Points non évidents, tous vérifiés à l'euro près : le prix du fil est le prix **d'achat du
lot** (`ref_fil_commande.prix_unitaire` via `stock_fil.IDref_fil_commande`), **pas**
`ref_fil.prix_kg` ; le libellé d'une ligne fil suit le coloris **du lot**, qui peut différer de
celui de la composition (l'OF 988 tricote la réf 003 « ecru » avec un lot *noir*) ; une ligne
de `composition_ecru` sans lot affecté s'imprime « ? » et rend la pièce non chiffrable, exclue
du total (comportement legacy) ; les lignes de coût se calculent sur le poids **écru**
(`stock_ecru.poids` source pour un fini, avant variation de poids à l'ennoblissement) alors
que la valeur utilise le poids de la pièce ; l'ennoblissement est tarifé sur la **grille
interne** (`IDsous_traitant = 0`) à un poids de référence fixe de 200 kg, pas au prix
réellement payé au sous-traitant ; les traitements s'impriment dans l'ordre
`IDtraitement_ref_fini` (ordre de rattachement), teinture juste après le tricotage ;
l'arrondi est un demi-cent vers le haut sur la valeur décimale exacte (`roundEuro` :
20,5 × 2,07 = 42,44 et non 42,43 comme le donnerait `Math.round`).

**Bug legacy corrigé.** L'état legacy lit la teinture dans `ref_fini_colori` d'après
`stock_fini.IDColoris` **sans** passer par `ref_fini.avec_teinture`, et les deux espaces d'ids
se recouvrent (l'id 895 existe dans `colori_ecru` *et* dans `ref_fini_colori`). Sur la donation
3693, la pièce 2381/10 (réf 007A, `avec_teinture = 0`, donc lavage) hérite ainsi de la teinture
d'une référence sans rapport : 17,38 €/kg au lieu de 11,21, +94 € sur une valorisation de
569 €. La liste des lignes du même état n'imprime pas cette ligne de teinture, ce qui a révélé
l'incohérence. On ne garde le terme teinture que si la ligne `ref_fini_colori` appartient bien
à la référence de la pièce ; le drapeau `LEGACY_TEINTURE_COLLISION` permet de reproduire les
chiffres legacy à l'identique pour comparaison. Décision utilisateur : version corrigée
(3693 → 474,57 € au lieu de 568,97 €).

**Fichiers.** `apps/api/src/lib/donation-valeur.ts` (le calcul, requêtes plates + `fixEncoding`,
colonnes ASCII uniquement, `stock_fil` sans le bloc `certif_*`),
`apps/api/src/lib/pdf/ValeurDonationPdf.tsx` (rendu dans le cadre `MalterreDocument` : bandeau
par pièce avec Poids / Prix /kg / Prix total, lignes de coût dessous, récap « Valeur Total »),
trois endpoints sur `commandes-client.ts` (`/donation-valeur/pdf`, `/donation-valeur/email-defaults`,
`POST /donation-valeur/email` - 400 `not_a_donation` hors donation, pas de CGV en pièce jointe,
journalisé `notes='donation-valeur'`). Le libellé de l'onglet Historique passe d'un booléen
`proforma` à une table `notes → libellé`, extensible au prochain document du même
`IDtype_doc = 7`. Côté web, les URLs des trois documents passent par un `DOC_PATH` au lieu de
ternaires imbriquées.

**Icônes PDF.** Les pièces portent les icônes standard de l'app (`TmRollIcon` rouleau détouré
pour l'écru, `FiniRollIcon` rouleau plein pour le fini), copiées de `apps/web/public/icons/`
en versions 64 px dans `apps/api/src/assets/icons/`. Deux pièges `@react-pdf` : un **chemin de
fichier** en `src` ne rend **rien**, silencieusement (200, emplacement vide) ; et un `Buffer`
réembarque l'image à **chaque** `<Image>` - d'où des **data URIs**, dont l'identité de chaîne
stable fait que chaque icône n'est embarquée qu'une fois quel que soit le nombre de pièces.

**Vérification.** `apps/api/src/scripts/verify-donation-valeur.ts` rejoue la donation 3693
ligne par ligne contre le PDF legacy (lots, commandes fil, poids, €/kg, totaux, propagation des
« ? ») : tout passe, seul l'écart de teinture documenté ci-dessus subsiste.
`apps/api/src/scripts/dump-donation-valeur-pdf.ts [out.pdf] [--cmd <id>]` rend le PDF pour
inspection (données synthétiques sans `--cmd`).
## 2026-07-28 — feat/rapport-finance
**Rapports › Finance** (`/rapports/finance`) - new read-only balance comptable, porting the
legacy `FI_Analyse_Finance.wdw` tab (Analyse › Finance). Unlike its three siblings in the
Rapports menu it is not a line-level tracking table: it is the accountant's balance, one row
per compte comptable, with a Charges fixes / Charges variables toggle and an N vs N-1
comparison.

Investigation first, because the .wdw is PCS-compressed and yielded no readable source. The
model is three tables: `upload_compta` (the accountant's weekly balance file, per société,
carrying the produits / charges / frais_fixe / frais_variable / provisions aggregates),
`compte_compta` (chart of accounts partitioned by `id_societe`, with `frais_variable` 0=fixe
1=variable and a free-text `Description` the user maintains), and `releve_compta` (debit /
credit per account per upload date). **The rule recovered: montant(compte, année) = debit -
credit at the LAST upload falling inside that calendar year.** Not the sum, because each
upload is a cumulative year-to-date balance; and not January's upload, which carries the
prior exercise's final figures (2026-01-05 holds the definitive 2025 numbers, yet legacy
reports 2025 as of 2025-12-22). `pourcentage` = round(montant / montant N-1 x 100), 0 when
N-1 is empty.

Two scope rules had to be deduced rather than read: **class-7 accounts (numero >= 700000) are
produits and are excluded**, and accounts absent from both reference balances are hidden.
Both are proven by reconciliation - summing each bucket reproduces `upload_compta.frais_fixe`
/ `frais_variable` to the cent (111 604,54 EUR and 610 431,35 EUR at 2026-03-23), and the
totals only balance once the 7xxxxx rows are dropped. Verified screen against screen with the
legacy app: 67 rows in fixes, 15 in variables, same amounts, same percentages. Probe kept at
`apps/api/src/scripts/inspect-finance-compta.ts`.

API - three endpoints added to `apps/api/src/routes/rapports.ts`: `GET /rapports/finance`
(4 bounded set-based queries per call, independent of row count),
`GET /rapports/finance/comptes/:id/historique`, and `PATCH /rapports/finance/comptes/:id` for
the description. Accent repair goes through the batched `repairAliased` so an empty
`Description` never enters a CONVERT; the description write uses a Latin-1 hex literal
(`sqlText`) because the iODBC bridge corrupts multi-byte UTF-8 embedded in a SQL line. Scope
is société 1 (ETM) only, matching legacy.

Screen - `apps/web/src/pages/RapportFinance.tsx`, Tableau layout (§27) with the mobile card
list (§40) and the unsaved-changes guard (§28). Beyond legacy: a year picker, search, Excel
export, and a drawer showing the écart, the editable description and the account's yearly
history.

**Permission-gated, and it is the first screen that is.** The balance names payroll accounts
("Salaires Isa, Pierrot, Laetitia, Eloise"), so the screen is closed by default behind
`view_rapport_finance` (child: `edit_compte_description`). This introduced
`SubMenuItem.permission` plus the shared `useSubmenuFilter` hook, now applied to all three nav
surfaces (sidebar context menu, header tabs, mobile nav) so a hidden entry cannot leak through
one of them. **If you add a permission-gated submenu, use that hook - do not filter in one
surface only.**


## 2026-07-28 — feat/rapport-fil
**Rapports › Commandes fils** (`/rapports/commandes-fils`) — new read-only line-level report,
the yarn-purchasing twin of Rapports › Commandes sst, porting legacy `FI_Rapport_fil.wdw`.

Investigation first: the legacy grid is one row per `ref_fil_commande`, and its scope is
**open lines of open commandes** (`commande_fil.etat = 0 AND ref_fil_commande.etat = 0`) —
verified by reproducing its exact 8-row result set against the local HFSQL copy (line 951 is
`etat=0` but its commande 674 is closed, which is why legacy shows 8 rows and not 9). The
key semantic recovered is that **`ref_fil_commande.date_notif` ("Délai Notification") is the
relance date**: legacy sets it ~2–3 working days after the order and leaves `date_livraison`
empty until the supplier announces one — the same `attente_delai` shape as the SST orders.
Probe kept at `apps/api/src/scripts/probe-rapport-fil.ts`.

API — `GET /api/rapports/commandes-fil?terminees=0|1` added to `apps/api/src/routes/rapports.ts`
next to its SST twin. Same HFSQL discipline: a bounded, constant number of set-based queries
regardless of row count (7 chunked `IN` queries), batched `fixEncoding` for the accented
fournisseur / ref / coloris labels, no accented identifiers named in SQL, `stripRtf` applied
defensively to the header commentaire/journal. Full history (867 lines) returns in ~0.75 s.
A yarn line only carries `etat` 0/1, so the endpoint derives a phase — **reception is tested
first**, because once lots have landed "waiting for a délai" is no longer what the line is
about: `terminee` (etat=1) → `recue` (received ≥ ordered, just not clôturée) → `partielle`
(some `stock_fil` lots linked, still short) → `attente_delai` (nothing received, no
`date_livraison`) → `en_cours`. Urgency follows the phase's anchor date — `date_notif` while
waiting for a délai, `date_livraison` afterwards — in the app's §30 language (red =
due/overdue/missing, amber = within 3 days / next working day); `recue` and `terminee` lines
carry none. `qte_restante` is forced to 0 on settled lines: most historical lines never had
their stock lots linked, so raw arithmetic would show the full ordered quantity as
outstanding on nearly every closed line.

Screen — `RapportCommandesFil.tsx`, a deliberate line-for-line sibling of
`RapportCommandesSst.tsx` so the two reports read identically: same toolbar (search / "Voir
les lignes terminées" / Exporter Excel), sticky-header sortable wide table with red/amber row
tint, totalizer footer, and the per-user localStorage Excel column picker (key
`mps:rapport-fil:export-columns`, dates exported as real `Date` cells so Excel sorts them
chronologically). 16 columns: the legacy 8 plus Qté reçue, Reste, Prix €/Kg, Montant, Retard,
Commentaire and Journal. Route swapped from placeholder to real in `router.tsx`; CLAUDE.md
§Navigation item 11 updated.

Two deliberate divergences from legacy, both flagged to the user: (1) legacy paints commande
651 orange despite a Jan-2027 delivery date, whereas the app's §30 rule leaves it neutral —
all 6 red rows match, that one differs; (2) the §40 responsive card list below `md` is NOT
implemented here, because the SST report hasn't been ported either and keeping the two
siblings identical beat diverging one of them. Worth doing as a pair later.

## 2026-07-28 — feat/rapport-cmd-client
**Rapports › Commandes clients** — port of the legacy WinDev
`FEN_Rapport_commandes_clients.wdw`, the client-side mirror of the existing Commandes sst
report. New read-only endpoint `GET /api/rapports/commandes-clients?soldees=0|1` in
`routes/rapports.ts` + new screen `pages/RapportCommandesClients.tsx` (Tableau layout, no page
title, search + "Voir les commandes soldées" + Excel export with the per-user column picker,
20 sortable columns, red/amber deadline row tints, totalizer with line count / **total HT non
facturé** / late+watch counts). The placeholder route in `router.tsx` is replaced; the nav entry
already existed.

The legacy `.wdw` is PCS-compressed, so every column was reverse-engineered from live data and
verified figure-for-figure against commandes 3616 / 3617 / 3643 — the harness that does it is
committed as `scripts/verify-rapport-cmd-client.ts` (drives the real handler in-process, 21
assertions). The non-obvious finding is that the four quantity columns are a **decomposition of
the supply pipeline**, not four independent gauges: `Qté expédiée` = rolls shipped (fini état 4
or on a `ligne_expedition`; écru via `IDligne_expedition_ETM`); `Affecté` = rolls reserved to the
line and still on site; `En SST` = écru reserved to the line but still out at an ennoblisseur
(`IDref_commande_affectation > 0`) and not yet dyed back, converted `poids × rendement` because
écru rolls carry `metrage = 0` (331,90 kg × 2,6420891 = 876,91 Ml, matching the legacy cell
exactly); `Qté stock` = **free** stock of the same ref+coloris (reserved to no line, on no
expedition, not état Expédié). Écru already dyed into a `stock_fini` is skipped everywhere — the
fini roll represents it and counting both double-counts the line. `Total HT non facturé` =
`quantité × prix − Σ(ligne_facture)` reached via `ligne_commande_client → ligne_expedition →
ligne_facture`, definitive invoices only (proformas are drafts); negatives are correct and mean
more was shipped+invoiced than ordered. `Désignation` is `ref_fini.designation`, **not**
`designation_client` (which just repeats the reference). All three line types are handled —
fini, écru, and divers (which carry no rolls and read the `expedition_divers` ledger +
`stock_divers` keyed on the ref+variation1+variation2 triple).

One deliberate divergence from the Commandes clients affectation gauge: `affectation_cmd_tricotage`
(yarn *planned* for knitting) is NOT counted here. It is a planning allocation rather than physical
stock and the legacy report has no column for it — the verified rows confirm legacy excludes it —
so this report's Affecté can read lower than the gauge on Clients › Commandes for a line whose yarn
is allocated but not yet knitted.

Two HFSQL performance/safety issues were found while profiling the full-history scope and fixed in
the new endpoint (both are storm-shaped risks on the shared Linux bridge, not just slowness):
`fixEncoding` is a per-row-per-field `CONVERT` N+1, so the new code uses a local `repairText()`
wrapper over the batched `repairAliased` with CHUNK-sized id slicing (one `CONVERT … WHERE id IN
(…)` per column per chunk); and the dyed-écru lookup was chunking `WHERE IDstock_ecru IN (…)` over
20 k+ ids at 5,9 s across 54 round trips, replaced by a single unfiltered
`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru > 0` (~45 k single-column rows, ~180 ms).
Default scope 855 ms / 202 lines; the soldées opt-in 12,4 s / 4 845 lines (was 18,9 s). **The
sibling `/commandes-sst` endpoint still uses the per-row `fixEncoding`** — same N+1 shape, left
untouched as out of scope, worth the same treatment next time it is opened.

## 2026-07-28 — feat/stock-divers
**Divers › Stock** (`/divers/stock`) — nouvel écran, portage de `FEN_Stock_Divers.wdw` +
`FEN_Gestion_Stock_Divers.wdw`. Layout **Tableau** (mps_designer §27, même moule que
`FilsStock` / `TombeMetierStock`) : table triable sur `stock_divers`, tiroir latéral droit,
liste en cartes sous `md`, garde de modifications non enregistrées, `ConfirmDialog` pour la
suppression.

**Modèle.** `stock_divers` = la quantité en stock d'une référence diverse, **une ligne par
COMBINAISON de variations** (`IDref_divers` + `IDVariation1` + `IDVariation2`, toutes colonnes
ASCII, aucun accent). Tout le vocabulaire (les deux axes de variation, le modèle de prix
`tarif_divers`, la gestion de `ref_divers.archivé` accentué) était déjà modélisé dans
`references-divers.ts` : les helpers `money` / `qty` / `pickKey` / `uniteLabel` /
`normalizeVariationType` / `batchRepair` / `VARIATION_TYPES` y sont désormais **exportés** et
importés par la nouvelle route, plutôt que redérivés — les deux écrans Divers ne peuvent pas
diverger.

**API** `apps/api/src/routes/stock-divers.ts` → `/api/stock-divers` : liste (batchée — une
requête pour toutes les références, une pour tous les libellés de variation, une pour tous les
tarifs, jamais par ligne), détail (+ contexte référence : stock total, nombre de combinaisons,
observations), création, PATCH quantité, suppression, et `lookups/references` qui alimente la
modale de création (123 références actives avec leurs axes et leurs valeurs). Deux nouvelles
permissions `create_stock_divers` / `edit_stock_divers` (catégorie **Divers**), contrôlées côté
serveur comme côté UI.

**Parité legacy + apports.** La modale legacy verrouille la référence et les deux variations dès
que la ligne existe et ne laisse passer que la quantité : le tiroir reproduit exactement ça
(déplacer du stock vers une autre combinaison = suppression + création, pas une édition). Les
combos de la modale de création sont nommés d'après les axes réels de la référence
(« Couleur » / « Taille »), et disparaissent quand l'axe vaut `Aucun` — comme en legacy.
En plus du legacy : colonnes **Prix unitaire / Valeur** et barre de **valorisation**
(15 511,70 € sur les 273 lignes), résolues via le même modèle de prix à trois cas que l'écran
Références (pas d'axe → `ref_divers.prix_unitaire` ; avec axes → ligne `tarif_divers` de la
combinaison, sinon la ligne globale `(0, 0)`) ; filtre par référence qui **renomme les en-têtes
génériques « Variation 1 / 2 » en les axes réels** de la référence filtrée ; case « Masquer les
quantités nulles » (211 des 273 lignes sont à 0) ; garde **anti-doublon de combinaison** à la
création (une combinaison en double fausserait les totaux de l'écran Références, qui les somme).

**Deux constats sur les données.** (1) Le « 8M / 8M » visible dans la fiche legacy de *119 PVC*
est un **artefact WinDev, pas une donnée** : les deux `IDVariation` de cette ligne valent `0`, et
la combo legacy résout l'id 0 sur la première ligne de `ref_divers_variation` (qui se trouve être
« 8M »). Le nouvel écran affiche `—`. (2) Il existe **un doublon de combinaison préexistant** dans
les données (`IDref_divers 535`, variation 558) ; il est laissé tel quel, la garde n'empêche que
les nouveaux.

**Note transverse (non corrigée ici).** `apiFetch` (`apps/web/src/lib/api.ts`) ne lit jamais le
corps de la réponse : les messages d'erreur français renvoyés par l'API remontent en « API 409 »
sur **tous** les écrans. Cet écran contourne le problème avec un `apiMutate` local (une seule
requête, message serveur porté sur l'`Error`) plutôt que de modifier le helper partagé. Le
correctif global vaut le coup d'être fait à part — rien dans `apps/web` ne dépend de la chaîne
`API <status>`.

**Vérifié en base** (copie locale, revenue à son état initial : 273 lignes, 15 511,70 €) :
création avec auto-sélection de la nouvelle ligne, édition de quantité avec indicateur de delta,
chemin « enregistrer puis basculer » de la garde, 409 de doublon, suppression. Rendu contrôlé à
1600 / 768 / 345 px (pas de débordement horizontal). `apps/api/src/scripts/inspect-stock-divers.ts`
et `test-stock-divers-route.ts` restent comme sonde rejouable du modèle de données.

## 2026-07-28 — feat/transfert (2e lot)
Transferts picker: **cross-tab selection fixed**, plus a **user signature on every outgoing
mail, app-wide**.

(1) **Picker selection now survives a tab switch.** In "Éditer le bon de transfert" (Rouleaux),
ticking a rouleau on *Tombé de métier*, switching to *Fini*, ticking one there and validating
only added the fini one: a `useEffect` wiped the selection on every `activeTab` change, and
Valider posted a single `{type: activeTab, stockIds}` group. That reset was not gratuitous, and
the fix keeps what it protected: the tabs read different stock tables (`stock_ecru` /
`stock_fini` / `stock_fil`) whose ids collide, so one flat Set could post an écru id as `'fini'`
and move the wrong roll. Selection is now `Record<PickerTab, Set<number>>`, so ids stay bound to
the table they came from, and Valider builds one group per non-empty tab and PUTs them
sequentially to `/pieces`, aggregating `added` / `skipped`. A group that 409s (all its pieces
left the source magasin meanwhile) counts as skipped instead of aborting the other group, so the
existing "X ignorée(s)" warning still surfaces and the dialog stays open. The footer counter and
weight sum across tabs (weight map re-keyed `tab:stockId`, since raw stock ids collide), so
"N à ajouter" reflects both tabs. Frontend only, no API change.

(2) **Every mail now goes out signed.** The signature mechanism was already central and already
covered every send dialog: `sendMail()` (`lib/gmail.ts`) resolves the sender's signature from the
`from` address and appends it to both MIME parts, and every send route relies on that default
(only `lib/notify.ts` opts out with `signatureHtml: null`, correctly, for system notifications).
The gap was that it only fired once an admin had filled the signature fields for that user, so
users with nothing stored sent unsigned mail. New `lib/signature-defaults.ts` derives a fallback
from identity alone: `displayName` from `utilisateur.prenom/nom` (selecting `IDutilisateur` so
`fixEncoding` never builds `WHERE id = NaN`) and `email` from the per-user Gmail address; never an
invented fonction or téléphone, and a failed lookup degrades to email-only rather than failing the
send. `getEffectiveSignature(userId)` in `lib/user-profiles.ts` applies the precedence stored
fields → legacy pasted HTML → derived, and `getSignatureForEmail()` routes through it, so the
fallback reaches every send route through the one central path. `GET /user-profiles/me` now
returns the *effective* signature plus `signatureIsDefault` (stored-only fields stay in the
payload, so the admin editor still tells "configured" from "default"), and `SendEmailDialog` /
`ProfileModal` caption the default case and point at Paramètres › Utilisateurs. Anything an admin
saves supersedes the fallback, and the dialog previews exactly what the recipient gets.
## 2026-07-28 — feat/tickets
Widget de tickets LIVA — **deux corrections de périmètre** (feature version 1.1.0 → 1.1.1).

(1) **`resolu` n'est plus un statut clôturé.** Le tiroir "Tickets clôturés" ne garde que
`ferme` et `ne_sera_pas_corrige`. `resolu` veut dire "corrigé, rattaché à une version qui
n'est pas encore publiée" — le rapporteur attend encore la livraison, c'est précisément le
moment où le ticket doit rester visible dans la liste ouverte avec ses pastilles
"Résolu · v0.1.5". Le tracker bascule lui-même les tickets liés à une release de `resolu`
vers `ferme` (avec `closed_at`) au moment de la publication — `release_service._close_linked_bugs`
— donc le widget n'a plus qu'à cesser d'anticiper cette transition. Aucun changement d'UI :
le split liste ouverte / tiroir et l'auto-ouverture sur non-lus sont inchangés.

(2) **Toutes les lectures sont cadrées sur le produit.** La clé API du tracker est
*company*-scoped, pas product-scoped : un `GET /bugs?reporter_email=…` renvoyait les tickets
de la personne **sur tous les produits ETS Malterre**, donc Isabelle voyait ses tickets MFProd
dans ETM. Le proxy envoie désormais `product_slug` (= `ISSUE_TRACKER_PRODUCT_SLUG`) sur la
liste, et `belongsToProduct()` rejette en 404 un ticket d'un autre produit sur le détail et sur
l'upload de pièces jointes — même traitement que le contrôle `reporter_email` existant. Les
lignes renvoyées sont en plus filtrées côté serveur, ce qui rend le déploiement de l'app sûr
même si le tracker n'a pas encore la nouvelle version.

**Dépendance côté tracker** (dépôt `C:\dev\liva\issue-tracker`, à déployer séparément) : le
filtre `product_slug` a dû être ajouté à `GET /bugs`, l'API n'acceptait que `product_id` et
n'expose aucune résolution slug → id (pas d'endpoint `/products`) alors que les apps intégrées
ne connaissent que leur slug. Les objets bug exposent maintenant `product_slug`. Un slug inconnu
ne matche rien plutôt que de retomber sur toute la société. Tant que le tracker n'est pas
déployé, le paramètre est ignoré et seul le filtre défensif côté proxy s'applique.

Spec canonique mise à jour dans le skill `issue_tracker_integration` (CONTRACT.md § Product
scoping + note sur l'enum de statuts, changelog 1.1.1, proxys de référence express/flask) —
les deux règles valent pour toutes les intégrations, MFProd compris (qui a les deux bugs en
miroir et n'a pas été touché ici).

## 2026-07-28 — feat/transfert
Transferts (Rouleaux + Fils) — **permission gating, and the stock picker reworked into an
"Éditer le bon de transfert" modal that both adds and retires pièces.**

(1) **Two permissions, one per kind**: `gestion_transfert_rouleaux` and `gestion_transfert_fils`,
each in its own catalog category so Rouleaux and Fils are grantable independently (a user may
move rolls without touching yarn). One key covers the whole écran — création, modification de
l'en-tête, ajout / retrait des pièces, suppression du bon. Without it the screen is read-only:
"Nouveau" and "Modifier" disappear and no piece affordance renders. Enforced server-side by
`ensurePermission(req, res, kind)` in `routes/transferts.ts` on all five writes (`POST /:kind`,
`PUT /:kind/:id`, `DELETE /:kind/:id`, `PUT /:kind/:id/pieces`, `DELETE /:kind/:id/pieces/:pieceId`),
401 when unauthenticated / 403 otherwise. **Existing non-admins lose piece editing until the
keys are granted** in Paramètres > Utilisateurs.

(2) **Piece mutation moved into edit mode.** It used to be the inverse (pieces editable in view
mode, frozen while editing the header). Adding or retiring a pièce moves stock between magasins
immediately, so it now sits behind the same deliberate gate as the rest of the bon:
`canMutatePieces = isEditing && canManage`. The empty state tells a permitted user in view mode
to "Passez en mode édition pour en ajouter."

(3) **Picker drawer → modal.** The bottom drawer became a `Dialog` titled "Éditer le bon de
transfert" (`<Pencil>`), mounted only while open so search + selection reset each time. It now
lists the pièces **already on the bon** — ticked, at the top, badged "Sur le bon" — above the
stock still available at the source; unticking one retires it (returns it to the source magasin),
ticking an available one queues it, and **Valider** applies the queue and closes. On-bon rows
come from the detail payload (they sit at the *destination*, so `/available` never returns them)
and are filtered client-side with an accent-insensitive match so they narrow with the same query.
Partial applies keep the dialog open with a per-piece explanation instead of a terse count.
Selection is now cleared **on tab change** — `type` is read from the active tab at Valider time
and ids collide across `stock_ecru`/`stock_fini`/`stock_fil`, so a carried-over selection could
transfer the wrong roll rather than merely fail.

(4) **Dirty header flushed before the picker opens.** Pieces land in the bon's *persisted*
destination, so opening the picker with an unsaved en-tête draft would move stock to the magasin
the user no longer sees selected. `saveHeaderMut` gained a `{ keepEditing }` option: the header
saves and the draft snapshot re-baselines, without kicking the user out of edit mode.

(5) **`mps_designer` §7.1 — the row-add button on a single-list center panel.** New section
codifying what the five reference screens already do: exactly two renderings (centered outline
button in the empty state, full-width dashed ghost button as the last child of the scroll
container when non-empty), fixed classes, same label and icon in both, edit-mode gated, and
never in the totals footer — the failure it prevents is the button appearing to vanish once the
first row lands. Also: name the manager + use `<Pencil>` when the dialog also removes. Transferts
was migrated onto it (the footer "Ajouter" button is gone), and the per-row remove button is now
always visible in edit mode rather than hover-revealed — hover is unreachable on the factory
touchscreen.

## 2026-07-28 — feat/ref-fini
Finis > Références — **per-coloris fiche tarifs, the OEKO-TEX certificate on the fiche
technique, and an app-wide fix to left-list auto-selection.**

(1) **Search no longer strands a stale detail (app-wide).** Typing in a master-detail left
list narrowed the list but left the previously selected record on screen. `useAutoSelectFirst`
had two modes and the broken one was in wide use: **6 screens** ran `behavior: 'fill'`, and 5
of those also passed the **raw** query result instead of the `filtered` array the list actually
renders — so narrowing never re-targeted (`FinisReferences`, `FilsReferences`, `FilsGestion`,
`Entreprises`, `SettingsUtilisateurs`; `SousTraitantsGestion` passed `filtered` but still with
`fill`). Each already *had* a `filtered` memo — it was just declared below the hook call and
only fed to the list component. Moved the memos above the call, switched all six to sync
behaviour, and added the right `suspended` guard per screen (`isEditing`, plus
`autoEditForId !== null` on the two Références screens whose §25.1 create flow selects a row
before the refetch settles). With `'fill'` then dead across all 19 call sites, the `behavior`
prop was **removed entirely** — from the interface, its branch, and every call site — so the
broken variant can no longer be picked and new screens get correct behaviour by default.
`mps_designer` §5 rewritten accordingly: it documented a hand-rolled `useEffect` that no screen
uses, and now documents the hook, the "`rows` must be the filtered array" rule, and the three
legitimate reasons to pass `suspended`.

(2) **Fiche tarifs: pick which coloris to print.** The sheet always included every coloris.
The existing §42 pre-generation dialog (15/30 rouleaux toggles) gained a coloris checkbox list
with select-all, a live count, and Générer disabled when nothing is ticked — checkboxes per
§35, which reserves the pill toggle for single booleans. All coloris start selected, so the
habitual "open → Générer" prints exactly what it did before, and the `coloris` param is
**omitted** when everything is picked so the default request is unchanged.
`buildFicheTarifsPdfData` takes an optional `colorisIds`, applied **before** the 60-coloris cap
so a selection is never silently truncated. Verified against the dev DB on both halves of the
`avec_teinture` polymorphism — dyed (`ref_fini_colori`) and washed (`colori_ecru`).

(3) **Fiche technique: OEKO-TEX STANDARD 100 mark.** ETS Malterre's own certificate
(CQ 1357/1, IFTH) now prints bottom-left, opposite the fiche dates. Official green-on-white
artwork, bundled at `apps/api/src/assets/` (the API ships `src/` via tsx, so no build step).
The certificate number is in the artwork, so there's no caption. The layout trap: the closing
block is `wrap={false}` at the very end of the flow, so the mark's height is paid out of the
page's leftover space — naively adding it at 48pt pushed **7 of the 30 most text-heavy
references** onto a second, near-empty page. Space was reclaimed deliberately to fund it: a new
opt-in `contentPaddingTop` prop on `MalterreDocument` (set to 0 here — the fiche has no top
address/metadata cards, so that gap was dead space; **no other document is affected**), the
footnotes' 8pt bottom margin, and section `marginBottom` 10 → 7 (~21pt over ~7 sections,
imperceptible between cream cards). That budget puts the mark at **74pt**; 80pt regresses.
The footnotes also moved back under Code entretien, flush with the section's left edge. The
legacy "** Tous nos sous-traitants sont certifiés OEKOTEX" line was dropped so the page doesn't
mix two different certification claims — neither note was ever keyed to a marker in the body.
New guard `apps/api/src/scripts/check-fiche-page-counts.ts` renders the most text-heavy
references and asserts each fits one page; **re-run it after any change to that closing block**,
since the size ceiling is otherwise invisible. Page counts are back to baseline (the single
pre-existing `Duo01` spill).

**Open**: the OEKO-TEX mark prints on *every* fiche technique — there is no per-reference
certification flag in the schema, so it follows the document's other static blocks (customs
code, provenance, care symbols). If CQ 1357/1 does not cover the whole range, this needs gating.

## 2026-07-28 — feat/commande-client
Clients > Commandes — **demande de transport PDF, proforma behind a permission, search by
article reference**, plus a hover-state fix on the expédition tables.

(1) **Demande de transport** (`lib/pdf/DemandeTransportPdf.tsx` + `GET
/expeditions/formelle/:id/demande-transport/pdf`). Port of the legacy WinDev
"Demande_transport_<id>" sheet: the pickup request sent to a carrier, printed from a new truck
button in the per-line "Expéditions de la ligne" table (right of print + email). Rebuilt on the
`MalterreDocument` frame per the `malterre_doc` brand pack, so it carries the gold band,
tricolore footer and cream gold-edged cards: DESTINATAIRE + Informations cards, centered
"DEMANDE D'ENLÈVEMENT MESSAGERIE" heading, the "Merci d'enlever +/- X kg, en N rouleaux"
payload box, Enlèvement / Livraison address cards, dashed fill-in rows, the confirmation
callout with matin / après-midi checkboxes, and a salutation signed with the sender. Builder
sums weight + roll count over `stock_fini` (`IDligne_expedition`) and `stock_ecru`
(`IDligne_expedition_ETM`), reads the expedition's own adresse (same one the BL uses), the
transporteur, the client/commande, and the acting user's `prenom` for the "Prénom - Ets
Malterre" sender line (`IDutilisateur` is in the SELECT, so `fixEncoding` can't hit the NaN
storm). Pickup is always ETS Malterre, as in legacy, even when the rolls sit at a
sous-traitant magasin. Divers expeditions are deliberately not covered (cartons, not rolls).
Visual check: `scripts/dump-demande-transport-pdf.ts` renders both variants from synthetic
data, no DB.

(2) **`proforma_commande_client`** — new permission gating the facture proforma. Server side,
`requireProformaPermission` guards all three routes (`/:id/proforma/pdf`,
`/:id/proforma/email-defaults`, `POST /:id/proforma/email`), so a denied user can't reach the
PDF by URL either. UI side the key drops the "Facture proforma" row from the shared `docItems`
array feeding both header menus, and `DocMenuButton` now short-circuits on a single item to a
plain direct-action button (tooltip "Imprimer : Confirmation de commande") per mps_designer
§42.3 - which also fixes the pre-existing one-row menu on donation orders. **Default closed**:
existing non-admins lose the proforma until granted in Paramètres > Utilisateurs.

(3) **Search by article reference** in the left list. `findCommandeIdsByRefLabel(q)` runs
alongside the client-name resolution and OR's into the same WHERE. Two steps, because
`ligne_commande_client.IDreference` is polymorphic: LIKE over `ref_fini.reference` (type 2),
`ref_ecru.reference` (type 1) and `ref_divers.designation` (type 3) - the labels the line cards
show - then one type-scoped IN over the lines (the type predicate matters: the same numeric id
exists in all three catalogs). Non-ASCII input skips the ref pass (a raw accented literal
corrupts the Linux bridge; references are ASCII codes), `archivé` on `ref_divers` is never
named, and hits are capped at 500 per catalog / 500 commandes so a one-character query can't
build a runaway IN list. Probed live: "040A" → 8 commandes, "254" matches écru 254 + finis
254A/254B → 83, "0" → 2293 capped to 500; LIKE is case-insensitive here.
`scripts/probe-commande-ref-search.ts` reproduces it.

(4) **Hover fix** on the expédition tables: the shadcn `ghost` variant ships
`hover:bg-accent`, which is the vivid gold - combined with the row's `hover:text-accent` the
icons turned into solid gold squares with invisible glyphs. The four action buttons now pass
`hover:bg-accent/10`, matching the subtle tint used everywhere else.

## 2026-07-27 — feat/gestion-client
Clients > Gestion — **permission granularity, an add-a-coloris path for users who can't touch
tarifs, and the first email-notification subsystem.**

(1) **`gestion_coloris`.** New permission letting someone add a coloris to an *existing* client
reference without `gestion_references` or `gestion_tarifs`. Surfaces as a single affordance:
"Ajouter un coloris" at the foot of the §31 coloris drawer, shown only in edit mode and only
when the user lacks `gestion_references` (that dialog already manages coloris). Opens a new
`AddColorisDialog`. Because such a user can't set a tarif, the new rows must inherit the terms
already in force — which only exist if the ref is uniform: every coloris on tarif standard, all
sharing one `lst_tranche`. Otherwise it refuses with "Merci de demander à un utilisateur ayant
le droit d'éditer les tarifs pour ajouter ce coloris." Mirrored server-side in
`POST /clients/:id/references/:did/coloris` (gate skipped for `gestion_tarifs` holders, who can
fix the tarif after). Archived `ref_client_colori` rows are revived rather than duplicated, and
are included in the uniformity audit so a revived contract can't slip past it. `syncRccRows`
now returns its add/remove delta.

(2) **Five tab-scoped permissions** in Gestion client: `edit_client_info` (the whole Info tab,
including the *Client interne* toggle), `edit_client_rapport_qualite` (the lone *Inclure
rapports contrôle* toggle, grantable on its own), `edit_client_commercial`,
`crud_client_contacts`, `crud_client_adresses`. Each tab gets `isEditing && <key>`, so without
the right it renders exactly like view mode. `PUT /clients/:id` saves the whole client in one
request, so instead of 403-ing the save each scope contributes its own SET clauses only when
held — columns outside the caller's scopes are never named and keep their stored value (no
read-back, no re-encode). New generic `requirePermission(req, res, key)`;
`requireDeleteClientPermission` delegates to it. **Breaking for existing non-admins**: contacts,
adresses, info and commercial editing were previously ungated — grant the new keys in
Paramètres > Utilisateurs. `nom` stays ungated (it lives in the detail header, not a tab).

(3) **Notifications — new subsystem.** Paramètres > Utilisateurs gains a **Notifications** tab.
Deliberately *not* permissions: separate catalog (`lib/notification-keys.ts`), separate store
(`lib/notifications.ts` → `data/notifications.json`), and **no admin bypass** — nobody receives
an email they didn't opt into. Delivery reuses the `user-emails.json` mapping; the tab warns
when a subscriber has no address on file. Two types: `notif_coloris_ajoute` (any coloris
addition, via either the full *Référence client* dialog or the restricted button; removals made
in the same save are reported as context) and `notif_coloris_refuse` (fires when a blocked user
clicks *Prévenir le responsable* — an explicit action, not an automatic send on dialog open,
which would fire on every idle open). The blocked dialog keeps its checklist live so the request
names what's wanted, adds an optional note, and reports honestly: "un email a été envoyé au
responsable" only when a send actually succeeded, else "personne n'est abonné" / "l'envoi a
échoué". `lib/notify.ts` never throws — the addition sites fire `void notify(...)` after
`res.json()` and short-circuit before any HFSQL read when there are no subscribers; only the
request endpoint awaits, because its UI must report the real outcome.

(4) **Branded HTML notification emails** (`lib/notification-email.ts`): navy header band with the
gold "M" badge and MPS / ETS MALTERRE lockup, a 3px accent rule (gold = info, amber = alert),
label/value detail table, optional gold-edged note block and amber callout. Tables + inline
styles only, `cid:` logo, no external assets. HTML and its text/plain twin render from one
content object so they can't drift. `sendMail` gained `bodyHtml` — it previously *generated* the
HTML part from the plain text and could not render this — and no longer drops inline images when
there's no signature (this template carries a cid logo with no signature). `gmail.test.ts`
updated: the "drops inline images when the signature is absent" assertion encoded the old
contract and was replaced by two tests plus a `bodyHtml` test. `src/scripts/dump-notification-emails.ts`
renders every notification to standalone HTML for offline review — no DB, no Gmail. The design is
now an ecosystem skill, `malterre_email_report` in `etsmalterre/my_skills`; keep the two in sync.

(5) **Info tab cleanup.** Removed the Téléphone / Fax / % AJEOL rows (the draft still round-trips
the stored values, so a save never blanks those columns). `KVText`'s edit input widened 200 →
220px to line up with `PopoverSelect` / `SearchableCombobox` at `size="sm"` (§11bis), so every
row in Général and Facturation shares one column. `TogglePill`'s disabled state no longer reacts
to hover and dims its label — a read-only toggle that lit up under the cursor read as clickable
and silently swallowed the click.
## 2026-07-27 — feat/dossier-qualite
Qualité › **Dossiers** (`/qualite/dossiers`) — the non-conformity dossier screen, porting
legacy `FI_Dossier_QualitéV2`. **Classeur** layout (§39): left list of the 166 `dossier_qualite`
rows (N° · client · défaut · date · référence, search, En cours / Terminé / **Tous** — Tous is
the default because dossiers close as soon as the FNC round-trip completes, so the open bucket
is empty nearly always and "En cours" would open on a blank list), center master tabs
**Dossier** / **Traçabilité**, right sidebar tabs **Journal** / **Documents** / **FNC**, binary
`terminé` status footer pill (§29.3). Left-list urgency (§41) keys on `echéance` with a
screen-specific rule: a *missing* échéance is NOT urgent (unlike §30) because legacy leaves it
null on almost every row; red = échéance atteinte/dépassée, amber = dans les 3 jours, each with
its own counter pill next to the search. Gated on the existing `responsable_qualite` permission
(description extended to cover this screen); without it the screen is read-only — no Modifier,
no Nouveau, no status toggle.

**Traçabilité tab** rebuilds the legacy bottom panel and is the substantive new capability:
from the dossier's affectation it walks `stock_ecru` (by `numero`) back to the yarns and forward
to the two subcontract orders — `IDordre_fabrication → asso_fil_of → stock_fil →
ref_fil`/`colori_fil` + `ref_fil_commande → commande_fil` (fournisseur, n° commande, date, and
the `ged` docs on that purchase order) for the **Fil** sub-tab; `IDref_commande_source` → lcsst
`type=1` for **Tricotage**; `IDref_commande_affectation` → lcsst `type=2` (+ its `suivilot` lots
and `ged` BLs) for **Ennoblissement**. `Type_Reference` is a *string* discriminator on the
free-text `reference` column ('1' = numéro de pièce, '2' = lot de fil, anything else = none;
`IDreference` is dead, always 0), surfaced as an Affectation type picker.

**FNC model, reverse-engineered from the data**: `messageFNC` is what the responsable qualité
reports; `reponseFNC` stores `"<résolution libellé>\r\n<commentaires>"` — the responding company
picks a `resolution_qualite` row and types a note, and legacy concatenates the two. The FNC tab
splits it into a Résolution picker + comment box on read and rejoins on write, so the column
stays readable to the legacy app. `IDSociétéFNC` is a **1-based index into the non-ETM societes**
(1 → Tricotage Malterre, 2 → Malterre Confection), not the `societe` PK — every existing row is
`1` and legacy renders "Tricotage Malterre", the only mapping consistent with the data. Print
renders a branded **Fiche de non-conformité** PDF (`lib/pdf/FncPdf.tsx`, ports `ETAT_FNC`):
destinataire card + client/défaut/date metadata, observation block, pièces-affectées chips,
réponse block (verdict line + free text, "En attente de réponse" when unanswered), signature
rules. Email is the §18.A-bis placeholder for now.

**HFSQL — new write pattern worth knowing.** `dossier_qualite` has six accented columns
(`echéance`, `résolution`, `defaut_qualité`, `terminé`, `IDaction_qualité`, `IDSociétéFNC`) that
the Linux bridge cannot name in SQL at all, but an **ASCII PK**. Rather than the
`references-fil.ts` delete-the-whole-set shape, writes are **split**: the 13 ASCII columns take a
normal named `UPDATE` on both platforms, and only a change to `terminé` / `echéance` /
`IDSociétéFNC` triggers `patchAccented()` — named `SET` on Windows, and on Linux a full-row
**positional rewrite keyed on the ASCII PK** (read via `queryB64Text` so accents survive →
`DELETE WHERE IDdossier_qualite` → positional `INSERT` with the same PK so `doc_qualite` /
`asso_lot_dq` FKs survive), with a best-effort restore if the insert throws. Reads are always
`SELECT *` + a `readCol()` resolver that matches the real name, its accent-truncated twin, or a
case-insensitive fallback (reserved-word `DATE` comes back uppercased). Column order and
accent/NULL fidelity of the rewrite are guarded by `apps/api/src/scripts/test-dq-positional-rewrite.ts`
(read → DELETE → positional INSERT → read back → field-by-field compare); it passes on the dev DB.
CLAUDE.md's accented-identifier rule now documents this variant.

**Known gap — Documents tab.** `doc_qualite` has an accented PK *and* an accented dossier FK
(`IDdoc_qualité`, `IDdossier_qualité`), so on the Linux bridge there is no way to scope a query
to one dossier, and a `SELECT *` would drag ~87 MB of photo blobs across it. The tab is fully
functional on the Windows/ODBC path (list + inline viewer; images render via `<img
object-contain>` on a dark backdrop instead of an unscaled iframe, since most attachments are
phone photos); on the bridge the endpoint returns `{ documents: [], degraded: true }` and the tab
says the attachments are only viewable in the legacy app rather than silently claiming there are
none. Fixing it for prod needs a product decision: store new quality docs in `ged` under a
dedicated `type_doc`, or add an ASCII FK column to `doc_qualite` in the WinDev analysis.

Verified: `pnpm build` + `pnpm test` green; endpoints exercised against the live dev DB
(list/detail/create/update/status/delete/traçabilité/documents/PDF, accents round-tripping); the
§28 unsaved-changes guard manually exercised end-to-end (row switch pops the dialog, Annuler
preserves the draft, Abandonner discards without writing, route navigation blocked).
## 2026-07-27 — feat/ref-diverses
Divers › **Références** (`/divers/references`) — the `ref_divers` catalog, ported from the
legacy `FI_Ref_Divers.wdw`. Divers is no longer a placeholder: the nav entry gains a
`Références` submenu and `/divers` redirects to it. **Fiche** layout — left list with the
`En cours` / `Archivé` segmented filter, center cards (Identification / Variations / Tarifs /
Observations), right sidebar with `Stock` + `Commandes` tabs. Full edit mode, unsaved-changes
guard, archive toggle, guarded delete, `+ Nouveau` with auto-edit. The WinDev sources are
PCS-compressed, so the model was reverse-engineered from the HFSQL data (the list footer
reproduces legacy's "123 Références" exactly). **Variation model**: `ref_divers.sTypeVariation1/2`
name up to two *axes* (`Aucun` | `Couleur` | `Taille` | `Reference` — no accent on the stored
`Reference`); `ref_divers_variation` holds the *values*, with `niveau` = which axis. The 294
`niveau = 0` rows are pre-`niveau` leftovers on refs whose axes are both `Aucun` (unreachable
in the legacy UI) and are surfaced as a read-only "valeurs héritées" note. **Price model**:
no axis → flat `ref_divers.prix_unitaire`; with axes → `tarif_divers`, where a single
`(0, 0)` row means "one price for every combination" (legacy's "Saisie du prix: Global") and
rows keyed on variation ids mean per-combination pricing. The mode is **derived, not stored**.
Switching it (`POST /:id/tarif-mode`) is destructive both ways so it goes through
`ConfirmDialog`; seeding `detail` mode fills combinations from the previous global price but
**skips above 200 rows** (Tissu Voltige is 19 couleurs × 29 tailles = 551) rather than firing
hundreds of INSERTs at the shared HFSQL server — the grid then opens blank and each cell
upserts its own row on blur, rehydrating the detail cache via `setQueryData` (§31.6). Price
cells are deliberately **not** part of the header save. Referential guards return 409 with a
French message rather than orphaning data: disabling a populated axis, deleting a variation
value still used by stock / commandes / expéditions, and deleting a reference used anywhere
("Archivez-la plutôt" — variations + tarifs cascade). New API route
`apps/api/src/routes/references-divers.ts` (`GET ?archived=0|1`, `GET/POST/PUT/DELETE /:id`,
`/:id/archive` + `/unarchive`, `/:id/variations[/:vid]`, `PUT /:id/tarifs`,
`POST /:id/tarif-mode`, two lookups). **HFSQL**: `ref_divers.archivé` is accented and is never
named in SQL — reads go through `SELECT *` + `pickKey(/^archiv/i)`, the archive flip is a named
`UPDATE` on Windows and a delete + positional reinsert on Linux (`REF_DIVERS_PHYSICAL_COLS`),
and the create INSERT omits the column entirely; `ligne_commande_client.TYPE` /
`ligne_devis_etm.TYPE` are aliased; all list summaries are batched grouped queries, never
per-row. Unit enum is the shared one but Divers labels `4` as **Pièce** (the legacy Divers
combo), and out-of-enum legacy values (`255`) render as `—` and round-trip untouched. Verified
end to end against the dev DB: create → variations → tarif-mode both directions → cell upsert →
archive → unarchive → delete, with accents round-tripping (`Bleu foncé`, `Note avec accents:
éàü`) and zero residue left behind. Docs updated in `implemented_screens.md` (full variation +
price model), `CLAUDE.md` nav, `navigation_mapping.md`, `project_structure.md`.

## 2026-07-27 — feat/commande-client
Clients › Commandes — **lignes de commande "Divers" become shippable**, porting the legacy
Commandes › Expédition tab for type-3 lines and the `FEN_Expéditions_Groupées` modal. A
divers line names a catalog article (`ref_divers` narrowed by up to two variation axes,
`ligne_commande_client.IDVariation1/2` → `ref_divers_variation`, axis names from
`ref_divers.sTypeVariation1/2`) instead of stock rolls, and ships through the
`expedition_divers` ledger whose header back-points at the order
(`expedition_divers.IDcommande_client` — previously always written 0 by ETM):
`expédition → ligne_expedition_divers` (a CARTON) `→ ref_divers_expedie` (ref + variations
+ qty + prix). **Line drawer** (`DiversLineDrawer`, click a Divers line in view mode, §31
in-screen drawer): article card with the two variations, Commandé / Expédié / Reste, *Stock
disponible* from `stock_divers` (green/amber/red vs. the remainder, "non suivi" when the
combo has no ledger row) and prix unitaire; a per-line shipments table (N° / date /
conteneur / quantité / facturée + BL print + email, reusing `/expeditions/divers/:id/pdf`
and `/email`); and a footer ship bar prefilled with `min(reste, stock)` whose *Expédier*
appends to the order's open (non-facturée) expédition — creating it and `CARTON 1` if none
— which is the legacy "Quelle quantité voulez-vous expédier" prompt. **Grouped shipment**
(`ExpeditionGroupeeDialog`, new `Boxes` header icon-button left of print/email, rendered
only when the order has a divers line): expédition picker + "＋", Date / Référence client /
Transporteur / Adresse de livraison (text+date save on blur, selects on change, so the
modal never holds unsaved work), carton list with add/rename/delete, and the selected
carton's article table (Référence / Variation 1 / Variation 2 / Quantité / Total) with
inline quantity edit, delete, and an add-article picker sourced from **the order's own
divers lines** showing each one's `reste` and `stock` and prefilling the quantity; footer
prints the existing BL divers. Facturée or soldée ⇒ read-only with a lock banner. New API:
`GET/POST /commandes-client/:id/expeditions-divers`, `GET /:id/lignes/:ligneId/divers`,
`POST /:id/lignes/:ligneId/expedier-divers`; the detail endpoint now reads
`IDVariation1/2`, resolves their labels and computes divers `expedie` by matching
`(IDref_divers, v1, v2)` across the order's shipments (line cards gained the Expédié stat +
a shipped gauge; the ligne form gained the two variation pickers — without them a
ETM-created divers line could never match stock or shipment items). **`stock_divers` is
now written** (user-confirmed legacy parity, since both apps share the live DB):
`adjustDiversStock()` in `expeditions.ts` is the single owner of the ledger and is wired
into `ref_divers_expedie` create/update/delete **and** the carton/expédition cascade
deletes — so Clients › Expéditions keeps divers stock in sync too, which it previously did
not. ETM never *creates* a `stock_divers` row (legacy `FEN_Gestion_Stock_Divers` opens
them on receipt); an untracked combo is a no-op and surfaces as "non suivi". Verified live
end-to-end on commande 3690: ship 3 → expédition + CARTON 1 created, stock 5→2; add a
carton + 4 articles from the modal → stock 4→0; delete carton → 0→4; edit qty 3→1 → 2→4;
expédition deleted afterwards, DB left as found.

## 2026-07-27 — feat/issue-tracker
Tickets — **"Mes tickets" hides closed tickets behind a drawer, and the header trigger gets a
red unread badge. LIVA ticket widget bumped to feature version 1.1.0.** (1) The list view now
splits on `isClosedStatus` (new in `tickets/types.ts`, covering `resolu` / `ferme` /
`ne_sera_pas_corrige`): open tickets render directly, closed ones collapse behind a single
`bg-zinc-100/80` row carrying the total count and a rotating chevron (§23 collapsible-section
language). The row list moved into a shared `TicketRow` component so both sections render
identically. (2) **Unread tracking with no DB change**, which was the open question: the LIVA
tracker has no per-user read state and no webhook, but `GET /bugs` turns out to return *full*
bug objects (`comment`, `fixed_in_version`, `resolved_at`, `updated_at`), so one poll of the
existing list endpoint is enough. New `useTicketNotifications.ts` derives a per-ticket
*signature* from the fields a reporter actually cares about (`status | comment |
fixed_in_version | resolved_at`) and stores the last-seen value in `localStorage` under
`mps.tickets.seen.<IDutilisateur>`. Deliberately **not** `updated_at`: that also moves on
assignee / internal-title churn and would badge tickets that explain nothing when opened. The
store is **seeded silently on first run** (adopt every current signature, show zero unread),
otherwise every user's first load would badge their whole history. Unread rows get the gold
attention frame plus a dot, opening a detail clears that ticket, "Tout marquer comme lu"
clears the rest, and the drawer **auto-expands when it holds unread tickets** so a
just-resolved ticket is not hidden exactly when the badge sends the user looking for it.
(3) Plumbing: the list fetch moved out of `useTickets` into a React Query query
(`['my-tickets', userId]`, `per_page=100` so the drawer and the count see the whole history
instead of page 1) shared by the header badge and the modal, backed by a module-level
seen-store with `useSyncExternalStore` (plus a cross-tab `storage` listener) so the two
surfaces can never disagree. Polling is 5 min + on window focus, and stops **permanently** on
400 / 401 / 503 (no mapped email, no session, tracker unconfigured) since none of those heal
by retrying and each poll costs a session lookup. `markSeen` also writes the fresher detail
object back into the list cache, otherwise a stale cached signature relights the badge on the
next render. `useTickets` keeps only the write side (submit / detail / attachments) and now
exports `ticketFetch` / `mapTicket` / `listMyTickets`. Verified in the browser: silent
seeding, correct count after tampering with stored signatures, drawer auto-expansion, and the
badge decrementing when a detail is opened. (4) The `issue_tracker_integration` skill (in
`C:\dev\claude_config`) was versioned in the same pass: CONTRACT.md gains a **§ Read state**
with the binding rules for this pattern, the two new UX invariants, and the `GET /bugs`
full-object / `per_page=100` findings; SKILL.md gains a **§ Feature version** with a
changelog, the "record the version marker in the host repo" rule, and an upgrade path for
projects still on 1.0.0. The marker lives at the top of `TicketModal.tsx` and in the Tickets
row of `CLAUDE.md`. Note: this branch had **no API changes** and no HFSQL schema change.

## 2026-07-27 — feat/expe
Email — **Cci (bcc) support app-wide + auto-copy of the sous-traitants holding the shipped
rolls.** (1) `SendEmailDialog` gains a Cci field alongside Cc, and both are now **collapsed
by default**: two small `Cc` / `Cci` toggle pills sit at the right of the "À" label row
(gold-active, §5 segmented-filter language) and the inputs render only when toggled on — the
reclaimed height goes to the message textarea. Closing a toggle clears that field's value, so
a hidden field can never smuggle recipients into a send. A field the server pre-filled opens
**automatically** on hydration. Contract: `EmailDefaults.bcc?: string[]` +
`SendPayload.bcc: string[]` in `lib/email.ts`; `postEmail` forwards `bcc` when non-empty.
API side: `bcc: z.array(z.string().email()).optional()` added to all 11 email schemas and
threaded to `sendMail` at all 13 send sites (expeditions ×2, commandes client ×2 / fil / sst
×2, devis, factures, clients tarifs, entreprises, études coloris ×2, transferts) —
`lib/gmail.ts` already emitted the `Bcc:` header, so the MIME builder was untouched. (2)
Expéditions formelle (`/expeditions/formelle/:id/email-defaults`, shared by Clients ›
Expéditions **and** the Clients › Commandes expedition tab) now returns a pre-filled `bcc`:
the sous-traitants **physically holding the rolls being shipped**, so they know what to send
out. Resolution is by **magasin**, not by production chain — the expedition header has no sst
FK, so rolls are read from `stock_fini.IDligne_expedition` + `stock_ecru.IDligne_expedition_ETM`,
their distinct `IDmagasin` (→ `sous_traitant.IDsous_traitant`; **0 = à l'usine → nothing**)
resolved to contacts flagged `envoi_bl = 1` (visible, valid mail, deduped lowercase). New
helpers `loadExpeditionMagasinSstIds()` + `loadSstBlEmails()` in `expeditions.ts`. Bcc
addresses are included in the `envoi_email` audit rows alongside To/Cc. The **divers** bucket
gets no auto-fill (no stock link ⇒ no magasin) — the field is still there for manual entry.
Verified against the dev DB over the 15 most recent expeditions: MATEL → `mct.celine@…`,
Société Bontemps → its two BL contacts, factory-held shipments → empty.

## 2026-07-24 — feat/transfert
Transferts › Rouleaux + Fils — **the Transferts placeholder becomes two real screens**
(`/transferts/rouleaux`, `/transferts/fils`), porting legacy `FEN_Bons_de_transfert` /
`FEN_Gestion_d_un_bon_de_transfert` / `ETAT_Bon_de_transfert`. Data model (established by
live introspection — `bon_transfert`/`piece_transfert` were undocumented): header
`bon_transfert` (`type_matiere` 1=pièces / 2=fil discriminates the screens; `DATE` is a
reserved word; `commentaire` is PLAIN text; `est_valide` is dead since 02/2025 — written 0,
never shown) + polymorphic lines `piece_transfert` (`IDpiece_ecru`/`IDpiece_fini`/
`IDstock_fil`, exactly one non-zero). "Magasins" are `sous_traitant` rows with **0 = Ets
Malterre** (the actual `magasin` table is broken/unused); stock location =
`stock_ecru.IDmagasin` / `stock_fini.IDmagasin` / `stock_fil.IDMagasin` (capital M). New
API cluster `apps/api/src/routes/transferts.ts` (`/api/transferts`): infinite list, detail
with enriched lines, create (defaults destination address to the sst's default; `IDadresse
= 1` for Ets Malterre), update, delete, `available` stock at the source (TOP 200 most
recent + server-side `?q=` — magasins hold 30k+ legacy rolls; stock_fil reads follow
stock.ts's IS_WINDOWS split + terminé-by-prefix), bulk piece add / remove. **Stock moves
immediately** (user-confirmed legacy semantics): add → roll/lot's magasin = destination;
remove/delete → back to source; source/destination therefore lock (400 `magasins_locked`)
once lines exist. PDF `BonTransfertPdf.tsx` renders the "Bordereau de livraison N° X"
(per-référence bands with designation - composition — fini composition comes from the
parent écru ref —, Coloris/Numéro/Lot/Poids/Métrage columns, gold grand-total; fils
variant Lot/Référence/Coloris/Poids/Fournisseur). Email pair (`email-defaults` + `email`)
targets the destination sous-traitant's contacts (`envoi_bl` → selected); no `envoi_email`
audit row (the type_doc catalog has no "bon de transfert" entry). Web: shared
`pages/transferts/TransfertsScreen.tsx` (Fiche master-detail) behind thin
`TransfertsRouleaux`/`TransfertsFils` wrappers — piece cards with TM/Fini/Bobine icons +
2e-choix badge, totals footer (pièces · kg · Ml), §31 in-screen picker drawer (TM/Fini
tabs, search, checkbox multi-select, "Tout sélectionner", works in view mode since adds
are immediate), sidebar Info/Adresse/Commentaire cards (magasin PopoverSelects use a +1 id
offset so Ets Malterre id 0 survives the empty-sentinel), Nouveau dialog (source defaults
Ets Malterre, transporteur defaults Divers), unsaved guard, ConfirmDialog, SendEmailDialog.
Verified end-to-end on the dev DB: full add/remove/delete cycles for both kinds with
magasin flips checked in-table, PDFs rendered against real legacy bons, CSV TAD & legacy
"Transport" button intentionally omitted.

## 2026-07-24 — feat/cmd-client
Clients › Commandes — **Affectation drawer UX overhaul + left-list color standard.**
(1) Roll état pills: shared `EtatPill` gains a `variant` prop — `soft` (pastel, tables)
vs new `solid` (saturated bg, white text; same hue map, single source) — and roll cards
anchor the solid pill at the FAR RIGHT of the row (the one element present on every row
gets the edge; conditional icons/buttons flow in on its left). Redundant per-roll coloris
dropped (drawer is already line-scoped). (2) Batch affectation: per-row "Affecter"
buttons replaced by checkbox multi-select in Stock disponible (same checkbox UX as the
quick-ship selection); the two selections are mutually exclusive and drive ONE bottom
action bar — appears only when ≥1 roll ticked, shows Tout/Aucun + count + summed qty,
button flips Expédier ↔ Affecter per selection source. New all-or-nothing endpoint
`POST /:id/lignes/:ligneId/pieces/:kind/affecter` (validates every roll with the per-roll
PUT rules before any UPDATE, returns refreshed payload). (3) Left list: cards now
NEUTRAL by default (delivery-urgency red/amber removed from list cards); amber liseré =
commande non affectée (`phase a_affecter`); amber counter pill flush right of the search
input (SST-pill recipe: hidden at 0, tinted → solid when armed, toggle narrows the list,
auto-disarms on empty bucket). (4) Info tab reordered: metadata, Commentaire, Journal,
Tombé de métier commandé, Fiche client. Design system: mps_designer §37 rewritten
(two-variant état table + far-right anchor rule), new §41 (neutral-by-default left-list
liseré + search-bar counter-pill standard, per-screen color registry), §30.5 reconciled.
Tooling (from the 2026-07-24 node-sweep incident): vite dev `strictPort: true` (a
squatted port can no longer silently shift a server onto the next slot's port),
`up.mjs --restart` aborts naming a foreign port owner instead of spawning a zombie
behind a port-based "UP", `/serve-main` failure-modes documents the LIVA-tracker-on-3000
squat and warns against blanket node kills.

## 2026-07-24 — feat/finis
Finis › Références — **print menu: fiche technique + fiche tarifs PDFs.** The view-mode
header gains the §42 `DocMenuButton` contextual print menu (pattern recorded in
`mps_designer` §42 — renumbered from §41 at rebase, cmd-client took §41 — cross-ref in
§6.1) with two documents. (1) **Fiche technique**
(`GET /api/references-fini/:id/pdf`, `FicheTechniquePdf.tsx`): ports the legacy
ETAT_Fiche_technique to the MalterreDocument frame — caractéristiques (référence /
désignation / contexture via `ref_ecru.IDcontexture→contexture.nom`, min-moy-max grid for
laize HT / laize utile / poids), composition computed from `composition_ecru` (rows scoped
to the ref's `IDcolori_ecru`, falling back to the generic `IDcolori_ecru=0` rows) ×
`asso_fil_matiere` × `matiere_premiere` (both have accented column NAMES — `SELECT *` +
`pickKey(/^idmati/i)`, never named in SQL; `matiere_premiere`'s accented PK also blocks
fixEncoding so libellés repair via U+FFFD→é), stabilités/allongements, conditionnement,
observations, static douane/provenance lines (60062100 / C.E.E oui / FRANCE — no DB field
anywhere, static in the legacy report too), five ISO care symbols as inline SVGs (wash tub
shows `temp_lavage`), legacy footnotes, and the création/modification dates pinned
bottom-right (`marginTop:'auto'`). (2) **Fiche tarifs**
(`GET /api/references-fini/:id/tarifs/pdf?rlx15=0|1&rlx30=0|1`): standard (non-negotiated)
price grid for ALL coloris of the ref, reusing `TarifsClientPdf` + `calcTarifRefFini` —
coloris priced sequentially (never Promise.all — bridge flood), unpriceable ones skipped,
columns chunked 4 per grid. The menu row opens a small options Dialog with two independent
§35 pill switches ("Inclure la tranche 15 rouleaux" / "30 rouleaux", both off by default =
the standard ≤10-rouleaux grid) before generating. Both endpoints follow the
build/render-buffer split + helmet header strip; `dump-fiche-technique-pdf.ts` renders a
ref against the dev DB for inspection.

## 2026-07-24 — feat/commande-client
Clients › Commandes — **Historique tab surfaces legacy "envoyée" confirmations.** The
legacy WinDev app never writes `envoi_email` for commandes client; it only flips the
accented boolean `commande_client.envoyé_client` (no date, no recipient). The historique
endpoint now also reads that flag (`SELECT *` + `pickKey(/^envoy/i)` — the accented column
is never named in SQL, safe on Windows ODBC and the Linux bridge) and appends an undated
`{kind:'legacy'}` event when set. If a dated ETM confirmation send exists for the
commande, the legacy card is suppressed (the dated card is strictly more informative).
Frontend renders the legacy event as a muted-icon card titled "Confirmation de commande"
with the italic sub-line "Envoyée depuis l'ancienne application"; ETM sends keep their
gold icon + timestamp + recipients. Known one-way limitation (documented, unchanged):
sends from ETM cannot set `envoyé_client` through the Linux bridge, so the legacy app
still shows those as not sent. Investigation context: the original "card missing after
send" report was the pre-v0.1.1 stale-cache UI (fixed by the historique auto-refresh
invalidation deployed 2026-07-23); prod writes were verified intact. Also adds the
diagnostic script `apps/api/src/scripts/probe-historique-cmd-client.ts` (dumps recent
type-7 `envoi_email` rows + replays the historique SELECT for a given commande).

## 2026-07-24 — feat/expe
Clients › Expéditions — **delete now completes in the UI.** Clicking "Supprimer" in the
confirm modal deleted the expedition server-side but the screen froze on the open modal:
`deleteMut.onSuccess` read the list cache as a flat `ExpeditionListRow[]` and called
`.filter()` on it, but the expéditions list is a `useInfiniteQuery`, so the cache entry is
`{ pages, pageParams }` — the `TypeError` aborted the handler before it could close the
dialog, exit edit mode, or invalidate the list (handler predates the list's conversion to
infinite pagination; SousTraitantsCommandes, the only other infinite-list screen, was
already correct). Fix in `ClientsExpeditions.tsx`: read the cache as
`{ pages: ExpeditionListRow[][] }` and flatten before filtering. Post-delete behavior now
lands as designed: modal closes, edit mode exits, selection moves to the first remaining
expedition or the empty placeholder if none. Verified live through the browser (created a
throwaway expedition via the API, deleted it through the UI; no console errors).

## 2026-07-24 — feat/facturation
Clients › Facturation — **"Faire un avoir" from a definitive facture.** New icon-only
`FileMinus2` button in the detail header (leftmost of the Imprimer/Email trio; definitive
non-avoir factures only, `edit_factures` permission) opens a light confirm, then
`POST /factures/def/:id/avoir` creates a proforma Avoir prefilled from the facture: billing
header copied as-is (client, adresse, mode de paiement, échéance, TVA, n° TVA, code
comptable), `TYPE = 2`, DATE = today, every line duplicated into `ligne_facture_prov` with
positive amounts (credit sign stays presentational) and `IDligne_expedition` carried over
for traceability — the original facture still references those lines, so deleting the avoir
never reopens an expedition. 409 if the source is itself an avoir. On success the UI jumps
to the new avoir in the Proforma bucket in edit mode (clears search, relaxes a
'Factures'-only type filter so auto-select can't steal the selection), where the user trims
the lines to reimburse and later converts it like any proforma.

## 2026-07-23 — feat/responsive
App-wide (17 master-detail screens) — **phone/stacked mode no longer auto-jumps into the
first row's detail, and "Retour" works.** Root cause: every master-detail screen auto-selects
the first list row whenever nothing is selected (a desktop convention — the detail pane sits
beside the list). Below 1240px `MasterDetailLayout` stacks (list OR detail), so a null
selection IS the list view: the effect force-navigated to the first row's detail on arrival
and re-selected it the instant "Retour" set the selection back to null. Fix: new shared hook
`apps/web/src/hooks/useAutoSelectFirst.ts` — reproduces the historical behavior verbatim in
full/compact modes, but in stacked mode never picks a row on its own, and when the selection
drops out of a filtered list it falls back to null (return to the list) instead of jumping to
another row's detail. Two behaviors: `'fill'` (load-once auto-select: SettingsUtilisateurs,
Entreprises, FilsGestion, SousTraitantsGestion, FilsReferences, FinisReferences) and `'sync'`
(the mps_designer §5 canonical stillVisible reselect: ClientsGestion, ClientsCommandes,
ClientsFacturation, ClientsDevis, ClientsExpeditions, EtudesColoris, FilsCommandes,
ProspectsDemandes, QualiteSuiviLots, TombeMetierReferences), with `suspended` carrying each
screen's existing isEditing/isFetching/autoEditForId guards. SousTraitantsCommandes keeps its
lastAppliedListKey filter-reset logic and gets the same stacked gate inline via
`useResponsiveLayout`. Table-centric screens (FilsStock, FinisStock) were never affected.
Verified live at 390px (Utilisateurs, Fils › Commandes land on the list; Retour sticks) and
at 1920px (first row still auto-selected, 3-panel layout unchanged).

## 2026-07-23 — feat/issue-tracker
App-wide — **ticket widget: instant modal open, background screenshot capture.** The
header "Envoyer un ticket" button used to rasterize the whole page with `html-to-image`
(with `cacheBust: true`, re-downloading every image on the page) BEFORE opening the
modal — a multi-second spinner on the header button. Now the modal opens immediately and
the capture runs in the background: `cacheBust` is dropped, and the capture's `filter`
excludes any element carrying `data-dialog-root` (the marker our `Dialog` puts on its
portal) so the ticket modal never appears in its own screenshot — safe because dialog
overlays cover the header button, so no other dialog can be open at click time.
`TicketModal` gains a `capturingScreenshot` prop: while capturing, the "Capture d'écran"
attachment button shows a spinner + "Capture en cours..." and is disabled, becoming
clickable once the file arrives (capture failure leaves it disabled, as before).

## 2026-07-23 — feat/app-wide
App-wide — **app versioning + refresh from the profile menu.** The monorepo root
`package.json` `version` (currently 0.1.0) is now the single source of truth for the app
version: `apps/web/vite.config.ts` reads it and injects it as the `__APP_VERSION__`
constant (mirrored in `vitest.config.ts` so unit tests resolve it; declared for TS in the
new hand-written `apps/web/src/vite-env.d.ts`, which needed a `.gitignore` negation
against the stale-artifact `apps/web/src/**/*.d.ts` rule). The header profile menu
(avatar, top right) gains two items below "Changer d'utilisateur": an **"Actualiser
l'application"** button (RefreshCw icon, spins while pending) that calls
`registration.update()` on all service workers then reloads — with the PWA's
`autoUpdate` registration this pulls a fresh deploy without closing the app — and a
**"Version X.Y.Z"** footer line under a divider. Release convention documented in
CLAUDE.md §Versioning: bump the root package.json version, deploy; per-package versions
in `apps/*` are not displayed and need no syncing.

## 2026-07-23 — feat/facturation
Clients › Facturation — **one-off prod data backfill: legacy invoices marked "envoyée".**
The list derives `est_envoye` from the `envoi_email` audit log (`IDtype_doc = 19`,
`IDreference = IDfacture`), so the 3 293 of 4 870 definitive factures/avoirs issued or
sent outside the app (n°4300, Oct 2020 → n°9174, Jul 2026; 488 avoirs) had no log row and
showed the red "non envoyée" border. New script
`apps/api/src/scripts/backfill-factures-envoyees.ts` (dry-run / `--apply`, same pattern as
`migrate-journal-rtf-to-plain.ts`) inserts ONE marker `envoi_email` row per unsent facture
(empty `adresse`, `notes = 'backfill marque envoyee 2026-07-23'`) — idempotent, skips
anything already logged. **Executed against prod HFSQL (10.10.20.2, prod creds from the
API server env) on 2026-07-23: 3293/3293 inserted, 0 failures, verification pass reports
0 unsent.** Undo: `DELETE FROM envoi_email WHERE IDtype_doc = 19 AND notes = 'backfill
marque envoyee 2026-07-23'`. Side effect: each backfilled facture's Historique tab shows
one recipient-less "Document envoyé" event dated 2026-07-23. New invoices still show the
red border until actually emailed.

## 2026-07-23 — feat/commande-client
Clients › Commandes — **instant Donation toggle.** The center panel (lignes view vs
"Pièces en donation" view) used to switch on the *saved* `commande.donation` flag, so
flipping the Donation toggle in edit mode required Enregistrer + Modifier before the
layout followed. `DetailMain` now receives the `editDonation` draft and, while editing,
drives the layout from it — the panel swaps instantly on toggle. Because lignes and
donation pieces are written to the DB immediately while the flag itself only persists
on Enregistrer, content mutations are gated while the draft differs from the saved
value (`donationPending`): the "Ajouter une ligne" / "Ajouter des pièces" affordances
are replaced by a French hint ("Enregistrez la commande pour pouvoir ajouter des
lignes/pièces.") until the user saves, so cancelling an edit can never leave orphaned
lignes on a donation order or orphaned pieces on a normal one.

## 2026-07-22 — feat/issue-tracker
App-wide — **in-app bug/feature ticket reporting wired to the LIVA issue tracker**
(liva-holding.com/issues, product `etm-erp`). (1) **Proxy** `apps/api/src/routes/tickets.ts`
(`/api/tickets/*`): injects the company API key + product slug from server-side env
(`ISSUE_TRACKER_URL` / `_API_KEY` / `_PRODUCT_SLUG` — **must be added to the prod API env
before deploy**, they're in dev `.env.development` only, gitignored) and resolves reporter
identity from the session cookie — name from `utilisateur`, email from the admin-managed
Paramètres › Utilisateurs mapping (`user-emails.json`, same as Gmail send; users without a
mapped email get the same French 400). List/detail are ownership-scoped by `reporter_email`;
tracker 401 remaps to 502 (never confusable with an expired MPS session); missing config →
503; timeout → 504. Attachment uploads stream multipart through after an ownership check.
(2) **Widget** `apps/web/src/components/tickets/` + trigger in `Header.tsx` (MessageSquarePlus
icon left of fullscreen): clicking captures a screenshot of the page **before** the modal
opens (lazy `html-to-image` — new web dep), then a three-view modal (form / Mes tickets /
détail) with Bug↔Fonctionnalité tabs, per-category severity pills (fixed semantic palette
shared with the tracker), title/description, attachment zone (pre-captured screenshot toggle
+ file picker, 5×5 Mo, thumbnails + lightbox), and auto-captured navigation context
("Menu › Sous-menu (path)" from the router). Attachment failure after create is non-fatal
(warning, ticket still reported with its human n°). Verified end-to-end against the prod
tracker (test ticket n°1014 with screenshot, since closed).

## 2026-07-22 — feat/stock-fini
Finis › Stock — **granular edit sub-permissions, field-scoped search chips, Excel export,
plus dev-resilience fixes.** (1) **Sub-permissions**: `PERMISSION_KEYS` entries may now
carry `parent: '<key>'`; Paramètres › Utilisateurs renders those indented under the parent
toggle, visible only while it's granted (toggling the parent ON grants every child, OFF
removes them). Storage stays flat, so gated routes must check parent AND child.
`edit_stock_fini` gained four: `_stockage` (emplacement/conteneur/pointage), `_etat`
(2ᵉ choix, IDetat), `_affectation` (don/déstockage), `_notes` (observations/observation
sous-traitant) — enforced per field-group on `PATCH /stock/fini/:id`, and on
`PATCH /stock/fini/batch` which **was entirely ungated** (no auth, no permission check).
The drawer only renders inputs + the gold edit highlight for granted sections, sends only
those field groups, and hides "Modifier" when none are granted; Édition groupée hides
un-granted fields and its button. **Migration note**: users who already had
`edit_stock_fini` see nothing editable until sub-keys are granted — toggle the parent off
and on to grant all four. The permission tab's category cards are now **collapsed by
default** with a `granted/total` badge. (2) **Field-scoped search chips**: typing in the
Finis › Stock search opens a suggestion popover ("« bd » — toutes les colonnes" + one row
per column); picking one converts the term into a chip (`Emplacement : BD`) restricting it
to that column. Chips AND-combine with each other and the free text; × or Backspace
removes. Fixes the real complaint that searching "BD" for emplacement BD also matched every
lot/observation containing "bd" (14 rows → 13 correct ones). Free typing is unchanged.
(3) **Excel export**: icon-only toolbar button opening the same column-picker dialog as
Rapport sst (20 columns, per-user localStorage memory), exporting exactly the visible rows
(chips + search + sort) via lazy SheetJS; real date cells, numeric poids/métrage.
(4) **Magasin**: `IDmagasin = 0` (at the factory) now displays **"Malterre"** instead of an
em dash, normalized in the query `select` so table, drawer, sort and the Magasin chip agree.
(5) **Dev resilience** — a wedged native `odbc.connect()` poisons the whole API process
(in-process retries all time out while a fresh process connects in <1s); `hfsql.ts` now
counts consecutive connect timeouts and, in dev, **touches `src/index.ts` to force a tsx-watch
restart** (`process.exit()` does NOT work — tsx watch only reruns on file change). Verified by
reproducing the wedge. UserPicker drops to `retry: 1` + a "Réessayer" button so this surfaces
as an error in ~30s instead of a ~50s silent spinner. Also: the 7 baseline `@mps/api` tsc
errors are **fixed** (`tsc --noEmit` is now clean — the dead `params` arg was removed from all
three query layers since HFSQL rejects `?` placeholders), and `vitest.config.ts` scopes
`include` to `src/**` + `passWithNoTests` so `pnpm --filter @mps/web test` no longer always
fails by collecting the Playwright e2e specs.
## 2026-07-22 — feat/gestion-client
Clients › Gestion — **tarif print/email search, tabbed Référence client dialog, view/edit
tarif split.** (1) **TarifsSelectionDialog search** (Isabelle's request): the "Imprimer /
Envoyer les tarifs" ref×coloris picker gains an auto-focused, accent-insensitive search
field (matches ref client / ref interne / coloris); Tous/Aucun operate on the filtered
rows and selection survives filter changes so multi-ref picks work. (2) **RefSettingsDialog
is now tabbed** (Informations / Tarifs): fixes the July-16 regression where closing the
coloris drawer on edit-mode entry made TarifModeDialog unreachable for users with
`gestion_references`. The Tarifs tab lists the ref's saved coloris with their TarifModeTag;
click opens TarifModeDialog (with `gestion_tarifs`) or the read-only TarifDialog, stacked
over the settings dialog. Settings state stores the ref **id** and re-derives from the live
`client-references` query (tarif saves refresh the tab in place), while form hydration keys
on the id so refetches never clobber the draft; Tarifs tab disabled on create. `dialog.tsx`
now supports stacking: Escape closes only the topmost `[data-dialog-root]` and body scroll
stays locked until the last dialog closes. (3) **View/edit tarif split**: TarifDialog is
pure consultation (removed the inline gold Modifier 15/30 panel and "Dupliquer le
contrat" — renewal = "Nouveau contrat" in the edit dialog); TarifModeDialog gains a
"Tranches négociées" section (15/30 rlx toggle pills with Ml · €/Ml info from the shared
`client-tarif` query, hidden in contrat mode) whose save rides along the tarif-mode PUT
(separate `/tranches` PUT only when changed).

## 2026-07-21 — feat/commande-client (2)
Clients › Commandes — **invoice auto-surfaced in Docs, affecté gauge de-doubled, drawer
metrage total.** (1) **Facture in the Docs tab**: new `GET /commandes-client/:id/factures`
walks commande → `expedition.IDcommande_client` → `ligne_expedition` →
`ligne_facture(_prov).IDligne_expedition` and returns the definitive factures/avoirs plus
open facturation proformas covering the order's shipments (`facture.IDcommande_client` is
always 0 in live data — the chain is the only reliable link; pre-link legacy rows simply
aren't found). The Docs tab renders them as read-only cards (gold `ReceiptText`, "Facture
N°9097 · Facture définitive · date") above the ged documents, opening the facturation PDF
(`/factures/:kind/:id/pdf`) in the chrome-free viewer; orphaned `ligne_facture_prov` rows
are naturally excluded by the header lookup. (2) **Affecté gauge fix**: the per-line
"Affecté X / Y Ml" aggregate (`lineReservationAggregates`) counted écru rolls that had
already been dyed into `stock_fini` rolls — the same fabric twice (commande 3643 showed
4 404,8 / 1 635,0 Ml; truth is 1 866,0). The écru leg now carries the same
`NOT EXISTS (stock_fini.IDstock_ecru = se.IDstock_ecru)` guard as the available-écru
pools, so écru only counts while still écru (at the dyer). Restores real under-coverage
signals (two 3643 lines went from green to amber). (3) **Affectation drawer**: the
"Affecté à la commande (N)" heading now also shows the summed quantity of the listed
rolls in the line's dim — "(42 · 1 866,0 Ml)" — deliberately summing the displayed rolls,
not `affecte_total` (which also counts écru at the dyer + tricotage planning).

## 2026-07-21 — feat/facturation
Clients › Facturation — **XImport accounting export + "non envoyé" red urgency on the
Définitives list.** (1) **XImport**: new `apps/api/src/lib/ximport.ts` renders the Sage
fixed-width `XImport.txt` (142-char CRLF records, Latin-1) for one day's definitive
invoices — 3 écritures per facture (client tiers TTC / compte de vente HT / TVA), journal
`VT`, pied `O2003`, accents ASCII-flattened. Column layout reverse-engineered
byte-for-byte from two legacy WinDev files and pinned by `ximport.test.ts` (byte-identical
reproduction incl. the avoir case: **avoir = D/C reversed on all 3 lines + no échéance
date**; exonération keeps its 3rd line with an empty compte and 0.00). Échéance dates
reuse `computeDateEcheance`, falling back to the invoice date for TYPE-1 ("à réception")
rules, matching legacy output. Routes: `GET /factures/ximport/summary?date=` (preview
counts + total TTC) and `GET /factures/ximport?date=` (download, Latin-1). UI: an
**XImport button pinned above the list footer, Définitives bucket only** (read-only → no
permission gate), opening a dialog with a date picker (default today), a live summary
card (factures / avoirs / total TTC), and a download button disabled on empty days.
(2) **Non envoyé**: list rows now carry `est_envoye` (definitive only — batched `DISTINCT
IDreference` probe of `envoi_email` on `IDtype_doc` 19; `IDreference` = `IDfacture`,
verified to be the same convention legacy writes, so WinDev-sent invoices read as sent).
Unsent definitive cards get the §30 red urgency frame (inset left strip, red hover +
selection ring); a number-only **red count pill next to the search bar** (same design as
the SousTraitantsCommandes urgency pills) toggles filtering the view to just the unsent
ones, hides at zero, and auto-releases when the last red row leaves. Emailing a facture
invalidates the list so the frame clears live; auto-select drives off the filtered rows;
the pill resets on bucket switch; proformas never flag (they don't log sends —
id-collision rule in the file header).

## 2026-07-21 — feat/dev-resilience
Dev tooling — **spin-up paths tell the truth about whether the app actually works.**
Motivated by a session lost to two silent failures. (1) **Wedged HFSQL connect**: an API
whose cached `connectionPromise` never resolved served `/api/health` 200 while every data
route hung forever with nothing logged — an infinite loading screen on a server the tooling
reported `UP`. `hfsql.ts` (Windows dev path) now races `odbc.connect()` against
`HFSQL_CONNECT_TIMEOUT_MS` (default 15s) and clears the cached promise on failure, so the
next request retries instead of inheriting one hung connect for the process lifetime —
matching the self-healing respawn the Linux bridge already had. (2) **Readiness vs
liveness**: new `GET /api/health?db=1` runs a real query and returns 503 when HFSQL is
unreachable; `up.mjs` and `serve-main.mjs` both probe it, plus a `checkCors()` that sends a
real `Origin` header (a plain `curl` sends none, so CORS breakage is invisible from the
terminal while the browser fails). An API predating `?db=1` reports `not checked`, never a
false `UNREACHABLE`. (3) **The main checkout got the same preflight as worktrees** — it was
the only spin-up path with no dependency install and no CORS wiring, so on a fresh machine
`/serve-main` died as an instant "NOT UP" whose real cause (no `node_modules`) sat unread in
a log. `ensureDeps()` (non-interactive: `confirmModulesPurge=false`) and `ensureCorsOrigin()`
(rewrites `CORS_ORIGIN` from `DEV_WEB_ORIGINS` rather than trusting a gitignored per-machine
file) now live in `lib.mjs` and run on both paths; `tailLog()` makes a failed start print its
own cause. (4) **`up.mjs --restart`** reuses an existing tree's slot/ports/env, killing and
respawning it — previously the create path aborted on an existing dir and hand-rolled spawn
scripts were the only way back up. Docs corrected at the source: `dev_setup.md` was itself
prescribing the single-origin `CORS_ORIGIN=http://localhost:5174` that caused the breakage.

## 2026-07-21 — feat/commande-client
Clients › Commandes — **"Expédition" wording + Commandé/Expédié on line cards.**
(1) **Terminology**: every user-facing "livraison / date de livraison" around the client
order date now reads "expédition" — line-card labels and the two "Date d'expédition" form
inputs in ClientsCommandes, the confirmation PDF's lines-table column header
(LIVRAISON → EXPÉDITION in `CommandeClientPdf.tsx`), and the per-line recap in the
confirmation email body (`- expédition <date>`). DB columns (`date_livraison`) and the
delivery-address labels ("Adresse de livraison") are untouched. (2) **Per-line shipped
quantity**: `lineReservationAggregates` in `commandes-client.ts` now also sums shipped
rolls (fini: `IDetat_stock_fini = 4` or `IDligne_expedition > 0`; écru:
`IDligne_expedition_ETM > 0`, with the same rendement conversion) into
`exp_metrage`/`exp_poids`, exposed on detail lines as `expedie` in the line's dim —
no extra queries, just added columns on existing selects. (3) **Line card redesign**:
the old `qty × prix → montant` shorthand row is replaced by a labeled stat row mirroring
the PDF table vocabulary — Commandé · Expédié · Prix u. · Montant, with the Expédition
date pinned right keeping its urgency color (new `LineStat` micro label/value block,
CardKV language). Expédié turns green when fully shipped; the affectation gauge counter
is now labeled "Affecté … / …" so reserved vs shipped can't be confused. Divers lines
skip Expédié but share the same row shape.

## 2026-07-21 — feat/signature
**Structured signature template + Malterre design + Paramètres › Utilisateurs master tabs.**
Signatures are no longer pasted HTML blobs — they render server-side from per-user fields
through one company template. New `apps/api/src/lib/signature-template.ts`:
`SignatureFields { displayName, fonction, telFixe, email }`, `renderSignatureHtml()`
(email-client-safe tables + inline styles), `hasSignatureContent()`, and the logo as either
a `cid:` inline MIME part (outgoing mail — instant display, no remote fetch) or a data: URI
(in-app previews), from the new `assets/logo-m-email.png` badge (240px, 32px corner radius).
Approved design: 96px logo, 3px gold vertical bar exactly matching the logo height, 20px
bold name, fonction alone in blue uppercase (no "— ETS MALTERRE" suffix), single
"Tél. :" line (the Mobile field was removed everywhere), blue mailto link. `gmail.ts`
gains `inlineImages` support — the alternative pair wraps in multipart/related with
Content-ID parts (shared `base64Lines` helper); `sendMail()` resolves signature + inline
images together via `getSignatureForEmail()` which now returns `{ html, inlineImages }`.
`user-profiles.ts` stores structured `signature` fields (legacy `signatureHtml` still
honored until fields are saved, then superseded); router adds
`POST /user-profiles/signature-preview` (renders the exact template for the admin form) and
`PUT /users/:id/signature` now takes fields (Zod-validated). Frontend
(SettingsUtilisateurs): SignatureEditor becomes a 4-field form (Nom affiché / Fonction /
Téléphone / Email affiché) with a debounced live server-rendered preview + legacy-signature
warning; the whole center panel is restructured into the **Classeur** master-tab pattern
(§39) — "Profil" tab (email / photo / signature cards) and "Permissions" tab (admin notice +
category toggle cards), tab resets to Profil on selection change. Tests:
`signature-template.test.ts` (render/escape/plain-fallback) + extended `gmail.test.ts`.

## 2026-07-20 — feat/signature
**User profiles: photo + HTML email signature, "Mon profil" modal, auto-signature on
outgoing emails.** New JSON side-store `apps/api/src/lib/user-profiles.ts` (mirrors
`user-emails.ts`; the HFSQL `utilisateur` table has no photo/signature columns) keeping
`signatureHtml` in `data/user-profiles.json` and photos as disk files under
`data/user-photos/<id>.<ext>`. New router `user-profiles.ts` at `/api/user-profiles`:
`GET /me`, admin `GET /users`, `GET /users/:id/photo` (self-or-admin; CORP cross-origin +
immutable cache keyed by `?v=<photoVersion>`), admin `PUT /users/:id/signature` (raw HTML,
200 KB cap, empty clears), `PUT /users/:id/photo` (multipart, 5 MB, jpeg/png/webp/gif),
`DELETE /users/:id/photo`. **Email integration in one place**: `gmail.ts sendMail` resolves
the sender's signature from the `from` address via `getSignatureForEmail()` and
`buildMimeMessage` appends it to BOTH alternative parts (raw HTML after the escaped body
div; `signatureToPlain()` conversion in text/plain) — zero changes to the ~13 send call
sites; no signature → byte-identical output. Covered by `gmail.test.ts` (first vitest suite
in apps/api). Frontend: header avatar shows the photo when set (Avatar now resets its
error state on src change); user dropdown gains a "Mon profil" item for everyone opening a
view-only modal (`components/profile/ProfileModal.tsx` — prénom/nom, email from
`/user-emails/me`, photo, signature rendered in the new sandboxed-iframe
`ui/signature-preview.tsx`); Paramètres › Utilisateurs gains two admin cards under the
email card — PhotoEditor (immediate multipart upload via raw fetch + credentials, delete,
5 Mo client pre-check) and SignatureEditor (raw-HTML textarea + live preview, EmailEditor
draft pattern); SendEmailDialog shows a read-only "Signature — ajoutée automatiquement à
l'envoi" preview strip under the Message field when the sender has one.

## 2026-07-20 — feat/commande-client
Clients screens — **UX/permission fixes batch.** (1) **Historique refreshes instantly after
email sends**: `onSend` now invalidates the matching historique query after `postEmail`
(`facture-historique` in ClientsFacturation, `commande-client-historique` in ClientsCommandes
— confirmation AND proforma —, `devis-historique` in ClientsDevis), mirroring the
SousTraitantsCommandes pattern; previously the tab only updated on reload. (2) **Empty-list
selection clear**: every master-detail "keep the selection valid" effect now clears
`selectedId` (→ placeholder) when the visible list settles empty — e.g. search narrowed to
one commande then "Clôturer" moves it out of the bucket; previously the stale detail stayed.
Server-filtered screens (ClientsCommandes/Facturation/Devis/Expeditions) gate the clear on
`isFetching` (newly destructured where missing) so an in-flight search refetch never wipes a
valid selection; client-filtered screens (EtudesColoris, FilsCommandes, ClientsGestion,
ProspectsDemandes, QualiteSuiviLots, TombeMetierReferences) clear directly. (3) **Line-card
affectation gauge compacted**: single row — bar left (flex-1), `affecté / commandé` +unit
right at `text-xs` — the "Affecté" label row is gone. (4) **New permission
`cloture_commande_client`** ("Clôturer / rouvrir une commande", Commandes client category):
`PUT /commandes-client/:id/etat` now 403s without it and the StatusFooter pill hides its
toggle button (pill stays as read-only display). (5) **New permission `deverrouiller_tarifs`**
("Déverrouiller les tarifs"): the LineFormDialog price padlock only renders with it, and
without it the Prix input is read-only for tariff-priced types (écru/fini; divers stays
manual) — UI-level gating, line endpoints still accept `prix` under `edit_commandes_client`.
(6) **Tricobot tariff nudge**: the next-tranche commercial nudge is now a Tricobot speech
bubble (`/tricobot/tricobot-wave.png` avatar, gold bubble with tail + "✨ Tricobot" label),
and `pricing-ligne-client.ts geom()` treats a quantity within 1% of a roll of a clean
multiple as **exact rounded to the NEAREST roll count** (users type whole Ml against
fractional roll sizes) — fixes 1402 Ml reading "> 24 Rouleaux" and "Plus que 0 Ml" nudges;
exact quantities get the better tranche price and never show the nudge (`!priceInfo.exact`
guard added client-side too). Verified against live tariff data (078A@1402 exact 6,77 €;
138A@1255 still nudges 29 Ml → 3,49 €; 138A@1284 exact 3,49 €).

## 2026-07-17 — feat/commandes-client
Clients › Commandes — **print/email contextual menus + on-the-fly Facture proforma.**
The detail-header Printer and AtSign buttons are now `DocMenuButton` popover menus
(ClientsExpeditions `PrintMenuButton` pattern) choosing between "Confirmation de commande"
(existing flow, unchanged) and a new "Facture proforma" generated straight from the
commande header + lines — NEVER persisted to facturation (no `facture_prov` row, no
proforma sequence consumed). Rendering reuses `FacturePdf` with `isProforma: true` (bank
card, proforma title) extended with optional `remise`/`fraisPort` totals rows (TVA on net
HT; regular factures unaffected) and an optional `refCommande` "N° commande" meta row.
**Numbering: proforma numero = 1_000_000 + commande numero** (`PROFORMA_NUMERO_OFFSET`,
e.g. 3658 → N°1003658) — deterministic, purely numeric, and structurally collision-free
vs facturation's sequences (facture.numero ≈ 9k, IDfacture_prov ≈ 13k). Endpoints on
`commandes-client.ts`: `GET /:id/proforma/pdf` (filename `proforma-<numero>.pdf`),
`GET /:id/proforma/email-defaults` (same `envoi_commande=1` recipient logic, proforma
subject/body), `POST /:id/proforma/email` (proforma PDF attached, **no CGV** — matches
facturation; logs `envoi_email` with `notes='proforma'`). `/:id/historique` now reads
`notes` and labels events "Facture proforma" vs "Confirmation de commande" (grouping key
= timestamp + kind). Data builder `buildProformaPdfData` reuses `buildClientPdfData` +
client `num_tva`/client `IDtva` rate (fallback ETM default), dated at generation time,
échéance date via `computeDateEcheance`/`loadEcheanceRule` (now exported from
`factures.ts`). Frontend: `emailDoc` state parameterizes the single `SendEmailDialog`
(endpoints, attachment label with mirrored offset, CGV chip confirmation-only); donation
commandes hide the proforma menu entry (donations never invoice).

## 2026-07-17 — feat/stock-ecru
Tombé Métier › Stock — **responsive rollout step 3 (tablet / Z Fold / phone).** Same §40
treatment as Fils/Finis Stock, all changes additive (desktop + tablet proven pixel-identical
at `maxDiffPixels: 0` after every edit). (1) e2e coverage first: stock-ecru fixtures captured
from the live dev API (28-row list with défauts/observations/2ᵉ choix/magasin variety,
detail + provenance for the first-sorted row, trimmed refs/magasins lookups), mock routes,
`tombe-metier-stock.spec.ts` desktop baselines blessed on the untouched screen, then
`tombe-metier-stock-responsive.spec.ts` (13 mobile tests across fold-open-717 / phone-390 /
fold-cover-345). (2) Below `md` the 13-column table becomes a card list (`StockEcruCard`
in-file, shared `CardKV`/`MobileSortRow`): ref + coloris + 2ᵉ/Teinture badges,
numéro/poids/lot/magasin/cmd/client grid, red défauts line, observations + date footer;
memo'd with the edit-mode checkbox CSS-driven via `data-editing` (zero re-renders on mode
toggle); multi-select taps work on cards. (3) Drawer `w-full max-w-[440px]` + `md:hidden` X
close; outside-click selector widened to `[data-stock-row]`; the three dialogs (create, cut,
batch) get `max-h-[90dvh] overflow-y-auto`, create grid collapses to 1 column below `sm`;
one-line totalizer below `sm`. (4) **New toolbar rule (user-flagged at ~620px):** `order-*`
swaps alone don't pin the actions top-right when the toolbar has more than a checkbox —
flex-wrap only wraps on overflow, so the `w-40` statut select could share row 1 and push
the buttons off the corner. Fix: the select + checkbox live in an
`order-4 w-full … sm:contents` wrapper (forced full-width row 2 below `sm`, dissolved at
`sm`+). Recorded in `mps_designer` §40.5 + §40.1. Remaining table-centric port:
RapportCommandesSst.

## 2026-07-17 — feat/facturation
Clients › Facturation — **batch convert + lifecycle/PDF/email polish** on the existing
proforma/définitive screen. (1) **Conversion is now a MOVE**: `POST /prov/:id/convert`
copies the header + lines into `facture`/`ligne_facture` (fresh definitive numero) then
DELETES the proforma — the `IDexpedition_divers` converted-marker scheme and all its UI
("Converti → N°", "Voir la facture" button, converted locks) are removed; expeditions stay
`est_facture=1` because their lines are now referenced by `ligne_facture` (the batch-delete
reopen logic checks that ledger). DB had zero converted rows, so nothing was orphaned.
(2) **"Convertir des factures"** — third batch button on the proforma list (between Générer
and Supprimer) opening a pick-and-convert dialog; new `POST /prov/convert-batch {ids}`
converts each via the shared `convertProforma()` helper and returns
`{converted:[{prov_id, IDfacture, numero, client_nom}], skipped}`; the delete and convert
pickers share one generic `ProformaPickDialog`, results render in `BatchResultDialog`
("Proforma N°X → N°Y · client"). (3) **Frais de port in `/prov/generate`** — legacy rule
reverse-engineered from the live ledger: ONE line "Frais de port" (qty 1, unite '', prix =
`commande_client.frais_port`, `IDligne_expedition=0`) per contributing commande with
`frais_port > 0`, charged on EVERY invoicing run, never multiplied by the number of
expeditions (facture 4952 = 5 avis / 1 port line; commande 3329 = port on 4 successive
factures). (4) **Bank coordinates card on ALL facture PDFs** (was proforma-only).
(5) **Email default body** now "Bonjour, / Veuillez trouver ci-joint notre {facture|avoir}
N°X. / Bonne réception, / Belle journée,". (6) **Per-line domain icons**: API resolves
`stock_kind` ('fini'|'ecru'|'divers') per line via `ligne_expedition →
ligne_commande_client.TYPE`; LineCard shows FiniRollIcon / TmRollIcon / Package (same
glyphs as ClientsExpeditions). Verified E2E on the local dev DB (20-check script: convert
deletes prov, batch convert, port-line generation with rollback, PDF text extraction);
inspect/verify scripts kept under `apps/api/src/scripts/`.

## 2026-07-16 — feat/stock-fil
Fils › Stock + Finis › Stock — **responsive rollout step 1+2 (tablet / Z Fold / phone) +
Playwright screenshot-regression harness.** (1) New e2e harness in `apps/web/e2e/`
(@playwright/test, chromium-only, own vite server on port 3200 with `VITE_API_URL=/api`):
the whole `/api/` layer is fixture-mocked (`support/mock-api.ts`, unmocked endpoints 500
loudly), `Date.now()` frozen via `page.clock`, baselines committed per-machine (system-ui
fonts — policy in `e2e/README.md`). 6 viewport projects: desktop-1920/1366 + tablet-768 run
the table specs, fold-open-717 / phone-390 / fold-cover-345 run the `*-responsive` specs.
Workflow: bless desktop baselines on the UNTOUCHED screen first, then every responsive edit
must keep them green (proven at `maxDiffPixels: 0`). Scripts: `test:e2e`, `test:e2e:update`
(NOT in turbo test). (2) Both stock screens are now responsive, all changes additive
(desktop pixel-identical): below `md` the split tables become card lists sharing the same
rows/sort/selection/guard state (`StockLotCard` / `StockFiniCard` in-file; shared `CardKV`
+ generic `MobileSortRow` in `components/stock/StockCardParts.tsx`); FinisStock's edit-mode
multi-select works on cards with the checkbox CSS-driven via a `data-editing` group
attribute (zero re-renders on mode toggle); drawers are `w-full max-w-[440px]` with a
mobile-only X close routed through the unsaved guard; outside-click selector widened to
`[data-stock-row]`; all dialogs get `max-h-[90dvh] overflow-y-auto` + `grid-cols-1
sm:grid-cols-2` + `col-span-full`; the dialog primitive gained `p-4`. (3) Phone toolbar
rules (user-confirmed): primary actions stay top-right via `order-*` swaps, text buttons
collapse to icon-only (`hidden sm:inline` label + `title`), the Mode édition badge takes
its own row; FinisStock totalizer stays on ONE line at 345px (labels hidden below `sm`,
kg/Ml units carry the meaning), selection summary on its own row. (4) Doctrine recorded in
`mps_designer` §40 (+ §15/§27 refreshed). Remaining table-centric ports: TombeMetierStock,
RapportCommandesSst.

## 2026-07-16 — feat/expe
Clients › Expéditions — **Rapport de contrôle + Info matières PDFs, tickable email
attachments, print menu.** Two new branded documents port the legacy reports
(`ETAT_RapportQualité` / `ETAT_Info_Matiere`): `RapportControlePdf.tsx` (per-lot 5-column
table LOT · PARAMÈTRE · MIN · MAX · RELEVÉE; tolerances from `ref_fini`
laizeHT/poids/stab columns, relevé = in-house `suivilot.*_tirelle`, colored green/red
within/out of tolerance like legacy) and `InfoMatieresPdf.tsx` (per-article traceability:
Tissu Fini = ennoblisseur via suivilot + ged type-3 docs; Tombé de métier = tricoteur via
`stock_ecru.IDref_commande_source` (lcsst type 1 — affectation is the ennoblisseur!) +
ged type 4; Fil = fournisseur via asso_fil_of→stock_fil, certifs `ref_fil_certif`→
`certificat`, ged type 6 on `IDcommande_fil`, pays from `origine_matiere`/adresse).
Endpoints: `GET /expeditions/formelle/:id/rapport-controle/pdf` + `/info-matieres/pdf`
(404 when no fini lines). Email flow: `SendEmailDialog` gained `optionalServerAttachments`
— checkbox chips previewable even unticked; visibility + defaults come from
`email-defaults.optional_attachments` (RC pre-ticked when `expedition.inclureRapportQualite
OR client.inclureRapportQualite`; IM always unticked; omitted for écru-only/divers). POST
gains `attach_rapport_controle`/`attach_info_matieres` (400 if ticked but unavailable);
`logEnvoiEmails` now records the attachment set in `notes` ("BL+RC+IM"), still type_doc
14/16. Fix: both expedition INSERTs seeded `inclureRapportQualite` 0 — now copied from the
client. UI: formelle print button is a 3-entry popover menu (avis / RC / info matières);
new "Rapport de contrôle" ToggleSwitch in the sidebar Info tab (edit mode). HFSQL traps
discovered (memories saved): `stock_fil` SELECT * OR any list containing `certif_bio`
silently returns 0 rows on Windows — name ASCII columns without the certif block; suivilot
has no allongement columns. Probe/dump scripts: `probe-rc-info-matieres.ts`,
`dump-rapport-controle-pdf.ts`, `dump-info-matieres-pdf.ts` (synthetic + `--exp` live).
Verified live on exp 11669 (PDFs vs legacy samples RC12162/Info_Matière, defaults,
gating, notes logging, 404s, divers untouched).

## 2026-07-16 — feat/commandes-client
Clients › Commandes — **Affectation tab notes-as-icons + gated observation editing + 2 new
permissions.** (1) Roll cards in the line drawer's Affectation tab (and the shared RollRow
used by the enno/tricotage lists) no longer render the full-width blue/red `RollNotes`
banners; instead compact top-right icons appear only when content exists — red AlertTriangle
for the defect report (`observation_sst` and/or "2e choix"), blue MessageSquare for
`observations` — each with a styled left-side Tooltip that sizes to its content (`w-max`
capped at 320px, so short notes stay on one line). Défauts tooltip: only the title +
"2e choix" tag are red, the body text is default black. `RollNotes` itself is untouched
(SousTraitantsCommandes still uses it). (2) The observation icon is now the single edit
affordance (the per-roll pencil is gone): gray frameless ghost to add when no obs, blue
framed when filled; editing is armed by a "Modifier les observations" toggle that rides the
first section heading row of the Affectation tab (title left / action right, gold pill when
active; falls back to the "Stock disponible" heading when no rolls are affected yet, hidden
on soldée). (3) New permission `edit_observations_rouleaux` ("Commandes client") gates that
toggle in the UI and the `PUT .../pieces/:kind/:stockId/observations` endpoint (403 without
it). (4) New permission `edit_commandes_client` ("Commandes client") — without it the gold
"Modifier" and the list-footer "+ Nouvelle" buttons are hidden (screen read-only; view-mode
workflows — affectation, expédier, état pill, print/email, documents — stay open) and a
`requireEditFactures`-style `requireEditCommandes` guard 403s the six write paths:
`POST /commandes-client`, `PUT /:id`, `DELETE /:id`, `POST /:id/lignes`,
`PUT /lignes/:lineId`, `DELETE /lignes/:lineId`.

## 2026-07-16 — feat/gestion-client (3rd landing)
Clients › Gestion — **Negotiated 15/30-rouleaux tranches + expired-contract view/duplicate
+ coloris drawer edit-mode close.** The Tarif dialog now honors
`ref_client_colori.lst_tranche`: standard/coefficient modes only show the enabled tranche
rows (default = up to 10 rlx, indices 0..6 — shared `parseLstTrancheIdx()` helper in
`clients.ts`, also consumed by the Fiche Tarifs PDF path; new-coloris creation default
fixed from all-9 to 0..6). A gold "Modifier" button under the table (permission
`gestion_tarifs`, hidden in contrat mode) opens a "Tranches négociées" panel with two §35
toggle pills (15 / 30 rouleaux, each showing its Ml + computed €/Ml); saving goes through
the new `PUT /clients/:id/coloris/:rccId/tranches` (permission-gated, preserves base
indices, ASCII-safe write). GET `.../tarif` now returns `tranche_idx`. Expired contract:
the Tarif dialog shows the old contract read-only (dates + tranche table, "expiré" chip)
under the red banner, plus a "Dupliquer le contrat" button (gestion_tarifs) that opens the
Mode de tarification dialog hydrated from it as a NEW contract (same tranche grid, début =
today, no IDcontrat_tarif → renewal keeps history). Références tab: entering edit mode
(with gestion_references) now closes the in-screen coloris drawer (§31.3 — the card click
is reserved for the settings dialog there). Probe script
`inspect-tarif-tranche-flags.ts` dumps lst_tranche value distribution.

## 2026-07-16 — feat/commande-client
Clients › Commandes — **"Confirmation de commande" rename + CGV always attached + a batch
of drawer/sidebar UX fixes.** Rename: the client order document is now "Confirmation de
commande" everywhere the legacy "Accusé de réception" appeared — email subject/body
(`email-defaults`), PDF header (split across the type/reference header rows as
CONFIRMATION DE / COMMANDE N°X so no word is stranded), PDF title + attachment/download
filename (`confirmation-commande-N.pdf`), Historique tab label, docs empty-state copy.
CGV: new `CgvPdf.tsx` renders the Conditions Générales de Vente (verbatim legal text
provided 2026-07-16, sections I–X — the single source of truth; legacy `ETAT_CGV*.wde`
are PCS-compressed and unextractable) as a one-page two-column branded document
(I–VII left / VIII–X right, hand-balanced split); served by `GET /commandes-client/cgv/pdf`
(process-cached buffer) and **always attached** as `CGV - ETS Malterre.pdf` to every
confirmation email. The shared `SendEmailDialog` gained `extraServerAttachments` —
non-removable, previewable chips (used here for the CGV). PDF headers: uppercase accented
É renders badly in the header font, so documentType drops accents on purpose (Avis
d'expedition ×2, Conditions Generales de Vente); formelle BL header reference is now
`N°X` (no "BL"). Line drawer: Expédition tab trimmed to just the two tables (shipment-info
strip removed) and each expedition row gained per-row Imprimer / @ buttons reusing the
Clients › Expéditions endpoints (`/expeditions/formelle/:id/...`, BL PDF + SendEmailDialog);
Affectation tab roll cards are now click-anywhere-to-select (inner buttons stop
propagation). Line cards use the standard domain icons (TmRollIcon / FiniRollIcon / Box)
instead of Layers. Sidebar: Donation toggle hidden entirely once lignes exist (reappears
when all deleted; donation orders keep the pieces lock), Réf. client edit input flexes to
the full row width, donation section's Ajouter/Modifier buttons are edit-mode-only.
Verified live on the dev API: CGV render, email-defaults wording, PDF headers, BL 11525.

## 2026-07-16 — feat/gestion-client (2nd landing)
Clients › Gestion — **Associated refs + retour marchandise + 2 permissions + sidebar card
polish.** (1) Associated refs (legacy model reverse-engineered from data:
`ref_fini.associee` = messy CSV of associated IDref_fini defined in Finis › Références;
checking one in the legacy "Référence client" modal creates a hidden `designation_client`
child — designation "Reference Associée", `caché=1`, `unite=0`, no coloris rows — whose id
is stored in the parent's `associee` CSV): the refs list now filters `caché=1` (the "Reference
Associée 027A" ghost cards are gone), returns `associees: IDref_fini[]` per ref (link-icon
count on the card), new lookup `GET /clients/lookups/refs-associees?ref_fini=X`, and the
settings dialog gets a "Références associées" checklist (between Coloris and Fils, legacy
order) synced by `syncAssociees()` (delete unchecked children / insert checked / keep parent
CSV in sync). Verified with a full uncheck/recheck DB round-trip on 224A (client 111).
(2) Marchandise expédiée: "Reprendre des pièces" button (bottom right) enters a selection
mode — checkbox column + select-all + Shift-click range selection, gold action bar with
count/kg + Annuler + "Remettre en stock" (ConfirmDialog) → new
`POST /clients/:id/marchandise/retour-stock` unlinks rolls (`IDligne_expedition=0`) and
appends "Récupéré chez {client} le {dd/MM/yyyy}" to `observations` (read repaired via
fixEncoding, written via sqlText; scope-guarded to rolls actually shipped to that client).
Tab restructured: table scrolls internally with sticky header, bars are flex siblings (fixes
the overlapping sticky bar). (3) Two new permissions in "Gestion client":
`gestion_references` (gates references POST/PUT + settings dialog/add button — without it
edit mode behaves like view mode on the tab) and `retour_marchandise` (gates the whole
reprendre flow + endpoint); both verified 403 for a non-admin. (4) Contacts/Adresses sidebar
cards livened: initials avatar (gold for principal), gold star Principal(e) badge pinned top
right, hue-coded doc chips (Commande sky / BL teal / Facture orange / Soumission amber),
tel/mailto links, address icon box follows type (Truck teal / Receipt orange / MapPin gold).

## 2026-07-16 — feat/expe
Clients › Expéditions — **Print + email for expéditions diverses (previously "En
developpement" placeholders) + Ml label fix on the formelle BL.** New
`BonLivraisonDiversPdf.tsx`: "Avis d'expédition / BL divers N°X" in the shared
MalterreDocument frame — delivery-address + metadata cards (client, réf. client,
transporteur), one section per carton (free-text label, framed items table: désignation
with variation labels, quantité with pluralized unit, P.U. €, total €, per-carton totals
row), gold grand-total box (cartons · articles · total €). Price columns auto-hide when
every item's prix is 0 (free-sample shipments). API (`expeditions.ts`):
`buildBlDiversPdfData`/`renderBlDiversPdfBuffer` + `GET /divers/:id/pdf` (iframe header
strip), `GET /divers/:id/email-defaults` (client contacts split by `envoi_bl`),
`POST /divers/:id/email` (PDF re-render + user attachments, logs `envoi_email` with
`IDtype_doc=16` "avis expedition diver" — `logEnvoiEmails` now takes the typeDoc as a
param). Web: Imprimer opens `/expeditions/{bucket}/{id}/pdf` for both buckets; divers gets
the real `SendEmailDialog` (attachment `BL-divers-{id}.pdf`); the local `PlaceholderDialog`
was deleted. Also: formelle BL PDF's métrage column/units corrected `(M)` → `(ML)`/`Ml`
(métrage is always Ml), and an em-dash sweep on strings touched (formelle email subject,
From display name, BL total labels) per Vincent's preference. New synthetic render harness
`dump-bl-divers-pdf.ts`. Verified live: expedition 597 PDF (2 pages), email-defaults, and a
dev-skip send writing the type-16 audit row.


## 2026-07-16 — feat/gestion-client
Clients › Gestion — **"Classeur" layout (3rd gold-standard layout) + ref-level settings
(legacy "Référence client" window) + References tab UX overhaul (search + coloris drawer).**
Layout: the center panel's three stacked collapsible sections became master tabs
(Références / Historique des commandes / Marchandise expédiée) styled like the header
submenu pills on the natural background, landing on Références at every selection; adopted
into `mps_designer` as the **Classeur** layout (§39) and the three layouts got names
(Fiche / Tableau / Classeur). Ref settings: cards enriched with the catalog designation +
Kg badge + amber "À soumettre" pill; edit-mode card click opens a settings dialog mirroring
the legacy window — nom commercial, finition Tombé de métier / Ennobli, référence interne
(searchable, catalog switches with finition), unité Ml/Kg, soumission toggle, coloris made
available to the client, fils facturés (stored inverted in accented `fil_non_facturé` CSV);
"Ajouter une référence" creates one. API (`clients.ts`): references GET enriched with
`designation` + `fil_non_facture[]`; POST/PUT `/clients/:id/references(/:did)` write
`designation_client` via positional INSERT (accented `archivé`/`caché`/`fil_non_facturé`
never named; verified column order + datetime literal), updates delete+re-insert preserving
PK; `ref_client_colori` availability diff-sync archives/unarchives rows (tarif history
preserved) and inserts new ones with the 9-tranche default; new
`GET /clients/lookups/composition-fils` (composition_ecru yarns); refs-ecru lookup now
returns `designation`. References tab UX: accent-insensitive multi-criteria search
(every space-separated term must match ref/designation/coloris); coloris chips replaced by
the §31 in-screen drawer — selecting a ref docks it alone in a one-card band under the
search bar and the drawer below shows the coloris as a 2/3-column grid of white cards
(label + tarif mode, hover euro/pencil opening the tarif / tarif-mode dialogs); edit-mode
card click opens the settings dialog instead (drawer is view-mode-opened). Also fixed the
Classeur overflow-clip cropping focus rings (§31.5 padding) and synced the skill snippet.

## 2026-07-16 - feat/commandes-client
Clients > Commandes - **Order-confirmation email hardening: recap in body + bold 48h
tacit-acceptance clause + HTML email support.** Customers were not verifying the attached
accuse de reception, so mistakes slipped through. The default email body now includes (1) a
"Recapitulatif" bullet per order line (ref - coloris : quantite unite - livraison date),
built from `buildClientPdfData` so it always matches the attached PDF (best-effort: recap is
skipped on error), and (2) a bold clause asking the client to check references/coloris/
quantites/delais and report any anomaly within 48 hours, after which the order is considered
accepted as-is. To render bold, `gmail.ts sendMail` now always emits a multipart/alternative
body (text/plain + text/html) - nested in multipart/mixed when attachments are present - with
lightweight `**bold**` markup: HTML part renders `<strong>`, plain part strips the markers.
This benefits every email endpoint app-wide. `buildMimeMessage` is now exported for testing.
`SendEmailDialog` gained a hint under the Message textarea explaining the `**` syntax.
Also removed em-dashes from the commande-client email subject, recap separators, and From
display name (user preference: no em-dashes in user-facing text).

## 2026-07-16 — feat/bugs
Finis › Stock — **Fix: saving a roll's notes failed silently when the text contained accented
characters** (bug report from Isabelle, 2026-07-10: some pieces' comments could be edited, others
not — the difference was whether the existing Observations already held an accent like
"Pièce"/"N°"). Root cause: `PATCH /api/stock/fini/:id` wrote `observations`, `observation_sst`,
`emplacement` and `conteneur` as raw `'${esc(...)}'` quoted literals, so any non-ASCII text hit
the Linux bridge's `[HY090]` UTF-8 corruption and the request 500'd — the batch endpoint had
already been converted to `sqlText()` but the single-roll endpoint was missed. Since the drawer
resends the whole Observations text on save, any roll with pre-existing accented notes was
un-editable even to add ASCII text. Fix: the four text fields now go through `sqlText()`
(Latin-1 hex literal for accented values). Companion UI fix in `FinisStock.tsx`: the drawer's
save mutation previously had no `onError`, so a failed save looked like a dead Enregistrer
button; it now shows the standard AlertCircle destructive banner in the drawer header
("L'enregistrement a échoué…"), cleared on retry and on entering edit mode.

## 2026-07-15 — feat/gestion-client
Clients › Gestion — **Tarif modes per référence×coloris (standard / coefficient fixe / contrat)
+ permission « Gestion des tarifs » + historique divers fix + Ml label sweep.**
Reverse-engineered the legacy model: mode lives on `ref_client_colori` — *coefficient fixe* is a
`tranche_tarifaire` row (`coefficient` %, `IDcontrat_tarif=0`) replacing the degressive
COEFFICIENT_V2 margin on every tranche; *contrat* is `rcc.contrat=1` + `contrat_tarif` rows
(date_debut/date_expiration, renewals kept as history) + `tranche_tarifaire` rows carrying the
negotiated €/Ml (`prix_saisi`) per `nb_rouleaux` linked via `IDcontrat_tarif`. API: references
endpoint enriched with per-coloris mode info; `GET /clients/:id/coloris/:rccId/tarif` (mode-aware
PrixDeVente); `PUT .../tarif-mode` gated by new `gestion_tarifs` permission key;
`calcTarifRefFini` gained an `opts.coefficient` override. UI: mode tags on coloris chips
(Coef n / Contrat → date / Contrat expiré), mode-aware TarifDialog (contrat: only contracted
tranches shown as "N et plus", detail on the legacy 15-roll cost basis with the coefficient
derived from the contract price — verified byte-for-byte against legacy: revient 11,87, coef 13,
PV 4,06 €/Ml on 029A/0512), TarifModeDialog editor in edit mode (radio cards, contract editor
with tranche rows + history). Expired contract = ref unavailable everywhere (no standard
fallback): dialog notice, PDF drops the coloris, selection dialog disables the row. Fiche Tarifs
PDF honors both modes. Historique des commandes: divers lines (type 3) now resolve
`ref_divers.designation` + `ref_divers_variation` (couleur/taille) instead of the literal
"Divers"; unité 4 shows "unité". Métrage displays app-wide corrected to "Ml"
(ClientsGestion, FinisReferences, FinisStock, SousTraitantsCommandes).

## 2026-07-15 — feat/pwa
App-wide — **PWA identity renamed to "ETM" + missing install icons created** (`apps/web/vite.config.ts`,
`apps/web/index.html`, `apps/web/public/favicon.svg`, `apps/web/public/icons/*`). The manifest previously
referenced `icons/icon-192.png` / `icon-512.png` / `apple-touch-icon.png` that did not exist in `public/`,
so Chrome never offered the install prompt. Generated all three (gold "ETM" wordmark on primary blue
`#143D6B`, sized inside the maskable safe zone since `icon-512.png` doubles as the maskable icon —
`logo-small.png` at 80px was too low-res to composite). Manifest `name`/`short_name` are now `ETM`,
`lang: 'fr'` added, `theme_color` moved from the old `#00243E` navy to brand primary `#143D6B` (also in
the `index.html` meta). Tab title is now `ETM`; favicon.svg redrawn as ETM in brand colors. Removed the
phantom `favicon.ico` from `includeAssets` (never existed). Note: the install prompt only appears on
production builds (`vite preview` / prod) — vite-plugin-pwa serves no manifest in dev, and `devOptions`
was deliberately left off to keep the service worker out of the dev loop.

## 2026-07-15 — feat/permissions
Paramètres › Utilisateurs + Clients › Facturation — **new `edit_factures` permission
("Édition des factures", new "Facturation" catalog section between "Commandes client" and
"Gestion client")** (`apps/api/src/lib/permission-keys.ts`, `apps/api/src/routes/factures.ts`,
`apps/web/src/pages/ClientsFacturation.tsx`). Without the grant, Clients › Facturation is
strictly read-only: the UI hides « Nouveau », « Modifier », « Convertir en facture » and the
proforma batch block (« Générer les factures » / « Supprimer des factures »); list, detail,
print PDF and email stay open. Server-side, a shared `requireEditFactures()` guard (401 unauth /
403 without grant, effective-admin bypass via `userHasPermission`) gates every write endpoint:
`POST /:kind` (create), `PUT`/`DELETE /:kind/:id`, line CRUD (`POST /:kind/:id/lignes`,
`PUT`/`DELETE /:kind/lignes/:lineId`), `POST /prov/generate`, `POST /prov/delete-batch`,
`DELETE /prov/all`, `POST /prov/:id/convert`. Frontend gating threads one
`useHasPermission('edit_factures')` read down as `canEdit` props to `FactureList` and
`DetailHeader`.


## 2026-07-15 — feat/facturation
Clients › Facturation — **proforma display number = PK (legacy convention), PDF header/mention
cleanup, computed date d'échéance** (`apps/api/src/routes/factures.ts`,
`apps/api/src/lib/pdf/FacturePdf.tsx`, `apps/web/src/pages/ClientsFacturation.tsx`).
**(1) Proforma number.** The legacy app shows a proforma's `IDfacture_prov` (PK) as its number —
`facture_prov.numero` is a vestigial internal sequence (verified live: legacy "proforma 13521" =
IDfacture_prov 13521, numero 3). New `displayNumero()` helper routes every user-facing surface
(list, detail, PDF, email defaults/filename, generate-summary payload) through the PK for
`kind='prov'`; definitive factures keep their real `numero`. The MAX+1 numero allocator is
unchanged (still used for post-insert id resolution).
**(2) PDF header.** `FacturePdf` passed `reference={"FACTURE PROFORMA N°9"}` so the title
appeared twice in the header band; now `reference={"N°9"}` — title on line 1, number alone on
line 2. The proforma "Document non contractuel — ne tient pas lieu de facture." mention is removed.
**(3) Date d'échéance.** The `echeance` table carries calculation params (`TYPE` reserved-word
column, `nb_jours`, `jour`) and legacy auto-computes the due date from the facture date. Ported as
`computeDateEcheance()`: TYPE 2 = +N days; TYPE 3 = +N days then end of month (verified against
legacy: 15/07/2026 + "45 jours, fin de mois" → 31/08/2026); TYPE 4 = end of month then +N days;
TYPE 5 = TYPE 3 then +`jour` days (the Nth of the next month — best-guess, no live sample);
TYPE 1 (à réception / avant livraison / acomptes) = no date. `loadEcheanceLabel` became
`loadEcheanceRule` (returns libelle + params). The PDF top-right card now shows both rows —
Échéance (phrase, ClockIcon) and Date d'échéance (dd/mm/yyyy, CalendarIcon) — and the detail
response gained `date_echeance`, surfaced as a view-mode KV row in the web Info tab.


## 2026-07-13 — feat/soumission
Sous-traitants › Commandes — **Soumission Lot email defaults: ref commande client in the body,
emdash dropped from the subject** (`apps/api/src/routes/commandes-sous-traitant.ts`,
`buildSoumissionEmailDefaults`). The default body now includes a
`Réf commande client : <commande_client.ref_client>` line after the opening paragraph — the same
field the Soumission Lot PDF shows as "Ref commande client" (fetched with the usual `fixEncoding`
repair; line omitted when the order has no ref_client). The default subject's em dash separator
(`Soumission Lot X — ref`) became a plain ASCII hyphen (`Soumission Lot X - ref`). Defaults only —
the send endpoint and PDF are unchanged.


## 2026-07-13 — feat/devis
Clients › Devis — **Nouvelle ligne dialog: Prix (€) field no longer hidden**
(`apps/web/src/pages/ClientsDevis.tsx`). The Unité `PopoverSelect` in the 3-column
Quantité/Unité/Prix grid was passed `size="sm"`, whose variant forces a fixed `w-[220px]`
width (meant for compact right-panel KV rows). Inside the narrow grid cell that 220px button
overflowed and covered the adjacent Prix input. Dropped the `size="sm"` prop so the select
is `w-full` and fills its own cell — matching the canonical `ClientsCommandes.tsx` new-line
dialog. Pure CSS/layout fix, no behavior change.


## 2026-07-07 — feat/expe
Clients › Expéditions — **Diverses: carton contents (ref_divers_expedie)** + a Bon de Livraison
PDF pagination fix (`apps/api/src/routes/expeditions.ts`, `apps/web/src/pages/ClientsExpeditions.tsx`,
`apps/api/src/lib/pdf/BonLivraisonPdf.tsx`).
**(1) Divers cartons model.** A divers expedition's `ligne_expedition_divers` rows are **cartons/colis**
(`detail_ligne` = label, e.g. "CARTON 3"), and their real content lives in **`ref_divers_expedie`**
(FK `IDligne_expedition_divers`): one row per article = `ref_divers` catalog ref + up to two variation
axes (`IDVariation1/2` → `ref_divers_variation`, niveau 1↔`sTypeVariation1`, niveau 2↔`sTypeVariation2`,
∈ Couleur|Taille|Reference|Aucun) + quantite/unite + prix (frozen at ship time from the `tarif_divers`
grid keyed on (ref, v1, v2), (0,0)=base, fallback `ref_divers.prix_unitaire`). Verified against live
expedition 597 (4 cartons, 12 items). The previous code treated these lignes as free-text only — it
surfaced none of the article data. **API**: divers detail GET now returns each carton's `items[]` with
resolved ref + variation labels (batched `repairAliased`); new item CRUD
(`POST /divers/lignes/:id/items`, `PUT`/`DELETE /divers/items/:id`, all honoring the facturée lock)
and lookups (`GET /divers/lookups/refs` [`SELECT *` + `pickKey` for the accented `archivé` col],
`.../refs/:refId/variations`, `.../prix?ref&v1&v2`). Carton and expedition deletes now cascade to
`ref_divers_expedie` (previously orphaned rows). `stock_divers` intentionally untouched (legacy
movement semantics unverified). **UI**: each carton card lists its articles (désignation · variations
| qté | PU | total €) with a per-carton total; a pinned footer totals cartons/articles/€ for the
expedition; edit mode adds add/edit/delete per item via a dialog with a searchable ref picker,
variation dropdowns labeled by the ref's own axis names, and grid-auto-filled (editable) unit price.
List cards now read "N cartons". **(2) BL PDF fix**: `minPresenceAhead={70}` moved off the whole lot
`View` onto the "Lot :" label — on the block, react-pdf's keep-with-next semantics pushed an entire
snugly-fitting lot to the next page, blanking page bottoms (seen on prod BL 12112, whose first lot fell
on a nearly-empty page 1). On the label it just keeps the header + ~2 rows together; also added
`minPresenceAhead={100}` to the article identity block so a heading can't be stranded. Verified with a
12112-shaped render (6 pages → 4, first lot now on page 1).


## 2026-07-07 — feat/facturation
Clients › Facturation — **Facture/Proforma PDF redesign + proforma print & email**
(`apps/api/src/lib/pdf/FacturePdf.tsx`, `MalterreDocument.tsx`, `theme.ts`,
`apps/api/src/routes/factures.ts`, `apps/web/src/pages/ClientsFacturation.tsx`,
`apps/api/src/scripts/dump-facture-pdf.ts` [new], `mps_designer` SKILL §38).
**(1) PDF body redesign**: the facture/avoir lines table is now a squared ledger — muted
header band with a 2pt gold rule beneath, hairline row separators, and a matching 2pt gold
rule closing the table (no rounded box, no navy fills). The totalizer is condensed (tight
3.5pt rows, hairline between HT and TVA) with TOTAL TTC on the light `bgTotal` band, gold
top-rule, navy bold text. **(2) Header icon alignment fix**: the top-right meta-card labels
(N° TVA / Mode de paiement / Échéance) were floating above their center-aligned SVG icons
because the Text inherited the content area's `lineHeight: 1.45`; fixed with a tight
per-Text `lineHeight` (same latent bug fixed in `CommandeSoustraitantPdf.tsx`). Codified as
`mps_designer` §38 (meta-row icon alignment rule + financial-document ledger conventions).
**(3) Proforma print & email**: proformas can now be emailed as well as printed (previously
definitive-only). `GET/POST /factures/:kind/:id/email(-defaults)` accept both kinds; the
proforma attachment is named `proforma-<n>.pdf` and the subject/body say "Facture proforma".
`envoi_email` history stays definitive-only (prov/def share an id space on the same
`IDtype_doc`) — proforma sends are simply not logged, and their `/historique` returns [].
**(4) Bank card (proforma only)**: the proforma PDF prints a "COORDONNÉES BANCAIRES" card
(Titulaire / IBAN / BIC, from `company.bank` in `theme.ts`) pinned to the bottom of the last
page just above the footer via a flex spacer + `wrap={false}`, new `LandmarkIcon` in the
shared frame. Verified with `dump-facture-pdf.ts` (renders both a definitive and a proforma
variant with synthetic data, no DB).


## 2026-07-07 — feat/gestion-client (delete/archive + tarifs email + PDF redesign)
Clients › Gestion — a second round on the same screen: **delete-or-archive a client**, the
tarifs **email** path, a sidebar tidy-up, and a **Fiche Tarifs PDF redesign**.
**(1) Delete / archive** (`apps/api/src/lib/permission-keys.ts`, `apps/api/src/routes/clients.ts`,
`apps/web/src/pages/ClientsGestion.tsx`). New permission `delete_client` ("Supprimer / archiver
un client") in a new **"Gestion client"** category (renders below "Commandes client" in
Paramètres › Utilisateurs). The bin moved out of the view-mode header into **edit mode only** and
is permission-gated; its icon now reflects deletability fetched on entering edit mode — a **bin**
(destructive) when the client has no commandes/marchandise, an **archive box** when it has activity
(deletion impossible → archive instead), and an **unarchive** button when already archived. The
confirm dialog goes straight to the matching action (no "deletion impossible" explanation). New API:
`GET /clients/:id/deletability` (counts `commande_client` by `IDclient` + `stock_fini` by
`IDProprietaire` — verified those are client ids), `POST /clients/:id/archive` + `/unarchive`, and
`DELETE /clients/:id` now permission-gated, re-checks activity server-side (**409
`client_has_activity`**), and cascades `contact`/`adresse` cleanup (guarded on `id > 0` since those
tables store `IDclient = 0` for other parents). Archiving flips `client.archivé`: a named `UPDATE`
on Windows, and on the Linux bridge a `queryB64Text` `SELECT *` → flip → delete + positional
reinsert preserving the PK (the accented column can't be named on the bridge — same shape as
`references-ecru.ts setArchive`; **the Linux path is untested from Windows** — smoke-test one
archive/unarchive after deploy). The detail endpoint now returns an `archive` flag; the header shows
an "Archivé" badge. **(2) Tarifs email**: the header "Envoyer un email" button now opens the same
(référence × coloris) selector as Print (mode-aware title/footer) → **Envoyer par email** hands the
generated PDF to the shared `SendEmailDialog` pre-attached; the "En développement" placeholder was
removed. **(3) Sidebar**: dropped the count numbers next to the Contacts/Adresses tabs. **(4) Fiche
Tarifs PDF redesign** (`apps/api/src/lib/pdf/TarifsClientPdf.tsx`, new dev preview
`apps/api/src/scripts/dump-tarifs-pdf.ts`) to the ETM document design language shared with
Devis/Commande/Facture: cream gold-left **section header cards** (Tag icon + French-blue reference +
muted contexture, with right-aligned Laize/Poids metric tiles and the BIO chip), a consolidated
top **conditions card** (HT · €/mètre linéaire + validity — replacing the per-section repetition and
the fixed bottom note), and **tinted quantity "axis" columns** in the price grid so the tranche axis
reads apart from the price matrix. Data builder untouched (both Print and Email paths get the new
look); verified end-to-end against live data (client THUASNE, 3 pages).


## 2026-07-07 — feat/gestion-client
Clients › Gestion — **Fiche Tarifs: selection-driven print & email** (`apps/api/src/lib/pdf/TarifsClientPdf.tsx`
[new], `apps/api/src/routes/clients.ts`, `apps/api/src/lib/pricing-fini-tarif.ts`,
`apps/web/src/pages/ClientsGestion.tsx`) + a cross-screen amber-bar design fix.
**(1) Fiche Tarifs** ports the legacy `Choix_Matiere_Tarif` → "Fiche Tarif" report. The header
Printer button opens a selection dialog listing every (référence × coloris) pair of the client
with checkboxes + Tous/Aucun; **Imprimer** opens the PDF, **Envoyer par email** opens the shared
`SendEmailDialog` with the PDF pre-attached. New API: `GET /clients/:id/tarifs/pdf?items=<rccIds>`,
`GET /clients/:id/tarifs/email-defaults` (recipients from client contacts — `envoi_soumission`
flag first, else the default contact), `POST /clients/:id/tarifs/email?items=…`. Prices reuse
`calcTarifRefFini` (PrixDeVenteV4 port); `ref_client_colori.lst_tranche` selects which of the 9
quantity tranches print; italic knit label from `contexture.nom` via `ref_ecru.IDcontexture`, BIO
chip from `ref_ecru.bio`, Laize/Poids from `ref_fini.laizeHT_Moy`/`poids_Moy`. PDF uses
`MalterreDocument` (no italic face — bundled Lato has none; @react-pdf hard-fails on it), one
section per référence, two per page via tight explicit lineHeights. Écru-only désignations (no
`IDref_fini`) are greyed out / skipped (no PrixDeVente tarif). Verified value-for-value against the
legacy `Fiche Tarif049A.pdf` sample for client 1083. **(2) Shared engine fix**: `calcTarifRefFini`'s
`qte_ml` now uses the **unrounded** rendement (legacy prints 355 Ml for 4 rolls of 124A where the
2dp-rounded rendement gave 354; prices keep the rounded value and still match). This also corrects
the in-app Tarif dialog quantities. **(3) Design fix**: 4 screens
(`ClientsGestion`, `ClientsExpeditions`, `ClientsFacturation`, `TombeMetierReferences`) rendered
the neutral item-card left amber edge as a **static** `className` string (`… border-l-4 border …
border-l-amber-400/60`), which skips twMerge's border-conflict resolution and draws a thick 4px
bar instead of the standard thin edge. Switched all to `cn(base, 'border-l-amber-400/60')` matching
the `FilsCommandes.tsx` `LineCard` reference; documented the symptom in `mps_designer` §7.


## 2026-07-07 — feat/facturation
Clients › Facturation — **pick-and-delete proformas + cross-screen expedition cache sync**
(`apps/api/src/routes/factures.ts`, `apps/web/src/pages/ClientsFacturation.tsx`).
**(1) "Supprimer des factures" selection dialog** replaces the blanket "Supprimer toutes les
factures" confirm: lists every OPEN proforma (converted ones excluded; independent of the panel's
search/type filters), checkbox per row + "Tout sélectionner" header (indeterminate on partial),
rows show N°/client/date/type-chip/TTC; the destructive "Supprimer (N)" footer button IS the
confirmation. **(2) API `POST /prov/delete-batch`** (`{ids}`, zod, ≤500): the old delete-all body
is factored into a shared `wipeOpenProformas()` used by both `/prov/all` and the new endpoint,
upgraded for subset deletes — an expedition only reopens (`est_facture=0`) when none of its lines
remain referenced by a definitive `ligne_facture` OR a *surviving* proforma's `ligne_facture_prov`.
Converted/unknown ids are skipped (counted in `kept_converted`), never errors. **(3) Cache sync**:
generate + batch-delete mutations now invalidate the `['expeditions']` / `['expedition']` query
families, so Clients › Expéditions reflects `est_facture` flips without a hard reload (the global
5-min staleTime kept it stale before); post-delete selection is recomputed from the pre-invalidation
cache (§25.2) so the detail pane never points at a deleted proforma.

## 2026-07-07 — feat/cmd-client
Clients › Commandes — **Donation orders: attach stock pieces instead of lignes**
(`apps/api/src/routes/commandes-client.ts`, `apps/api/src/routes/stock-ecru.ts`,
`apps/web/src/pages/ClientsCommandes.tsx`). Ports the legacy WinDev "Donation" tab: a donation
commande (`commande_client.donation = 1`) carries no `ligne_commande_client` rows — individual
stock pieces point at it via `stock_ecru.IDcommande_donation` / `stock_fini.IDcommande_donation`
(only tombé-de-métier écru + fini participate; `stock_divers` has no such column). **(1) API**:
`GET /:id/donation-pieces` (attached écru+fini, polymorphic coloris via `avec_teinture`, écru
défauts summary); `GET /:id/donation-candidates?kind=ecru|fini` (full eligible stock — in stock,
not shipped, not reserved to a client line, not at a dyer, not claimed by another donation — plus
pieces already attached to THIS commande so they stay visible/detachable even once shipped);
`PUT /:id/donation-pieces {kind, ids}` replace-set semantics per kind, re-validating adds so a
piece claimed elsewhere since the dialog opened is skipped not stolen, returning the refreshed
attached payload. Guards: the `donation` flag can only flip ON while the order has no lignes and
OFF while no pieces remain (both 409); `POST /:id/lignes` refuses on a donation order (409);
commande DELETE releases attached pieces (`IDcommande_donation = 0`) alongside line rolls; detail
now returns `nb_donation_pieces`. Exported `DefautQualite` / `defautSummary` / `fetchDefectsByEcru`
from `stock-ecru.ts`, reused `repairAliased` / `repairAllJoins` from `stock-fini.ts`. **(2) UI**:
`DetailMain` swaps the lignes panel for a `DonationSection` when `donation = 1` — a grouped
"Pièces tombé de métier" / "Pièces fini" table (legacy columns + totals footer, kg/ml) with an
"Ajouter / Modifier" button opening `DonationPickerDialog` (gold-pill Tombé/Fini tabs over the
full stock, search, pre-checked checkboxes, selection totals, Valider applies the replace-set
PUTs and hydrates the attached cache directly). The permission-gated Donation toggle in the Info
tab now locks (with an explanatory hint) once the order has lignes (can't turn ON) or attached
pieces (can't turn OFF), mirroring the API guards. Dev scripts: `probe-donation-stock.ts` /
`probe-donation-stock2.ts` (schema + eligibility investigation).

## 2026-07-07 — feat/expe
Clients › Expéditions — **Bon de Livraison PDF pagination/layout hardening + candidate-line
simplification** (`apps/api/src/lib/pdf/BonLivraisonPdf.tsx`, `apps/api/src/lib/pdf/MalterreDocument.tsx`,
`apps/api/src/routes/expeditions.ts`, `apps/web/src/pages/ClientsExpeditions.tsx`).
**(1) BL PDF**: tighter meta cards (padding 14→10, row padding 3→1.5, explicit lineHeights so rows
stop inheriting the body's 1.45); fixed-height table header (24pt, lineHeight 1.2) fixing two
`fixed`-repeat artifacts on continuation pages (blank gap above the gold rule, dropped column
labels); `clean()` trims whitespace-only legacy address columns; `N° commande` rendered raw (no
thousands separator); lot pagination hardened — `minPresenceAhead={70}` per lot block and last
piece row glued to the totals row in `wrap={false}` so totals are never orphaned. **(2) Shared
`MalterreDocument`**: header band + card/meta spacing tightened (consumed by BL / CmdSst / Facture
PDFs); `HEADER_HEIGHT` 92→96 so repeated fixed table headers never paint into the band.
**(3) API**: pieces sorted with natural-numeric `Intl.Collator('fr')` ("3386/87" before
"3386/100"); embedded CR/LF in legacy `ref_client` collapsed to spaces. **(4) UI**: the
collapsible "Autres lignes de la commande" group is replaced by derived `visibleCandidates` —
unshipped lines show only when the expedition owns no lines yet, or for the line whose roll
drawer is open. Dev script: `dump-bl-pdf.ts` (renders a synthetic multi-page BL to eyeball layout).

## 2026-07-07 — feat/facturation
Clients › Facturation — **batch proforma generation & wipe from expeditions**
(`apps/api/src/routes/factures.ts`, `apps/web/src/pages/ClientsFacturation.tsx`).
**(1) `POST /prov/generate`** ports legacy `FI_Facturation_ETM`: scans formelle ETM expeditions
(`IDsociete=1`, `est_facture` null/0), groups by client, creates one proforma per client. Lines
mirror expedition lines — designation from the article catalog (fini vs écru honoring
`avec_teinture`), `V/ref` / commande / `Avis` lines, quantity = summed shipped Kg/Ml from rolls,
price+unit from `ligne_commande_client`; contributing expeditions flip `est_facture=1`. Skips
clients internes, donations, and roll-less expeditions (left open); returns `{created, skipped}`.
Chunked `IN` lookups (500), catalog caches, `fixEncoding`, numero-collision retry ×3.
**(2) `DELETE /prov/all`** deletes every OPEN proforma (`IDexpedition_divers=0`) + lines, keeps
converted proformas as history, resets `est_facture=0` only on expeditions without a definitive
`ligne_facture` link; registered before the generic `/:kind/:id` route. Shared
`clientBillingDefaults()` extracted (used by manual create + generator). **(3) UI**: two batch
buttons pinned above the proforma list footer ("Générer les factures" / "Supprimer toutes les
factures", prov bucket only, disabled in edit mode), each behind a `ConfirmDialog`, with a
`BatchResultDialog` summarizing created proformas and skip counts (internes / donations / sans
marchandise) or deletion results.

## 2026-07-07 — feat/cmd-client
Clients › Commandes — **permission-gated Donation flag + CommandeClient PDF layout rework**
(`apps/api/src/lib/permission-keys.ts`, `apps/api/src/routes/commandes-client.ts`,
`apps/api/src/routes/expeditions.ts`, `apps/web/src/pages/ClientsCommandes.tsx`,
`apps/api/src/lib/pdf/CommandeClientPdf.tsx`, `apps/api/src/lib/pdf/MalterreDocument.tsx`).
**(1) Donation**: new `donation_commande_client` permission key (category "Commandes client");
`GET /:id` returns `donation`, `PUT /:id` accepts it but enforces the permission only when the
value actually changes (echoing the unchanged flag is fine). The UI shows a `TogglePill`
"Donation" switch in the Info tab (edit mode, permission-gated; field omitted from the save
payload when unprivileged). Donation propagates downstream: `POST /:id/lignes/:ligneId/expedier`
and formelle expedition creation now default the shipment's `donation` to the parent order's flag
(previously hardcoded 0 / explicit-only), so donation orders never spawn proformas.
**(2) PDF**: the acknowledgement's right "combo" card is split — payment terms move to the top
row next to the client card; the livraison address becomes its own card pinned to the bottom of
the last page (`wrap={false}`, grows into leftover space). Shared compact cream `card` style,
`lineHeight: 1` on icon-adjacent text (also in `MalterreDocument` card title/meta styles),
and a `pushLine` helper that trims HFSQL single-space "empty" address columns. Dev scripts:
`render-cc-pdf.ts` (render a commande's PDF to file by numero), `probe-donation-flag.ts`
(one-off donation-column probe).

## 2026-07-06 — feat/cmd-sst
Sous-traitants › Commandes — **per-lot tooltip on the totals-footer "Ml reçus"**
(`apps/api/src/routes/commandes-sous-traitant.ts`, `apps/web/src/pages/SousTraitantsCommandes.tsx`).
The detail endpoint's received-rolls aggregate now also reads each `stock_fini` roll's `lot`
(`fixEncoding` keyed on `IDstock_fini`) and returns a per-line `fini_lots: {lot, nb, metrage}[]`
(lot-less rolls group under `''`). The frontend merges `fini_lots` across lines (`finiLotsMerged`
useMemo in `LignesSection`); the green "· X Ml reçus" span in the totals footer gains a
`FiniRollIcon` + `cursor-pointer` and, on hover, the shared `Tooltip` (side top) titled
"Métrage reçu par lot" listing "Lot <n> — N rouleaux · X Ml" per lot ("Sans lot" for empty).
Falls back to the plain span when no breakdown exists. Verified against dev commande 8607
(4 rolls sans lot · 107 Ml + 3 rolls MA1234 · 25 Ml = 132 Ml total, matches
`total_metrage_fini_recu`).

## 2026-07-06 — feat/suivilot
Qualité › Suivi des lots — **"Pièces du lot" table footer now totals Poids & Métrage**
(`apps/web/src/pages/QualiteSuiviLots.tsx`, `RecapSection`). The read-only per-roll sub-table
previously showed only a single "Moyenne" row spanning the first 4 columns with the average Rdt.
It now shows a `Total` label with the summed `poids` (` Kg`) and `metrage` (` Ml`) in their own
columns (client-side `pieces.reduce`, `p.poids || 0` / `p.metrage || 0` guards), while the
existing average Rdt is preserved — its "Moyenne" label moved to the Magasin column, right-aligned
before the Rdt value in `text-accent`. Presentation-only; no API/data changes.

## 2026-07-03 — feat/expe
Clients › Expéditions — **facture lock model + Factures tab + Avis d'expédition PDF + email**
(`apps/api/src/routes/expeditions.ts`, `apps/api/src/lib/pdf/BonLivraisonPdf.tsx`,
`apps/web/src/pages/ClientsExpeditions.tsx`). **(1) Legacy validé/dévalider RETIRED**: an expedition
is either "non facturée" (fully editable) or "facturée" (fully locked). Lock = `est_facture=1` OR a
definitive facture actually references it — formelle via `ligne_facture.IDligne_expedition` →
`ligne_expedition`, divers via the `facture.IDexpedition_divers` header back-pointer
(`facture_prov.IDexpedition_divers` deliberately excluded — repurposed as the converted-proforma
marker). Every write path 409s `expedition_facturee`; `POST /:kind/:id/validate` removed; `est_valide`
is never read (still zero-filled on INSERT for legacy). UI: status footer pill removed (derived state
→ header badge Facturée/Non facturée per mps_designer §29.6), list pills recolored, Modifier hidden
when locked. **(2) Factures tab**: right panel now tabbed Info | Factures; detail returns `factures[]`
(numero/date/type incl. Avoir) + `locked`. **(3) Legacy-parity line list** (verified vs expedition
11644 / commande 6677, 12 lines across ~15 expeditions): only lines with a `ligne_expedition` row on
THIS expedition belong to it; other commande lines render as a collapsed "Autres lignes de la
commande" candidates group, only while editable — a locked expedition shows exactly the legacy view.
**(4) Roll icons**: FiniRollIcon / TmRollIcon per stock kind on line cards + roll drawer. **(5) Avis
d'expédition PDF** (`GET /expeditions/formelle/:id/pdf`, byte-matched vs legacy BL 11645): MalterreDocument
frame, livraison address + meta cards, the two fixed legacy quality notices, per-article identity block
(ref - coloris, designation, finition label from the WinDev `gtaFinition` enum {1: OUVERT AU LARGE,
2/3: TUBULAIRE…}, `V/réf.` from `designation_client`), per-lot pieces tables (obs column gated on
`affiche_observations`, prints `stock_fini.observations` NOT `observation_sst`), lot/article/avis
totals; écru lines supported via `IDligne_expedition_ETM`. **(6) Email**: `GET/POST
/formelle/:id/email-defaults|email` per the §32 pattern — contacts split by `envoi_bl`, Gmail DWD send,
BL PDF attachment, `envoi_email` audit with `IDtype_doc=14` ("avis expedition"; 16 = divers, reserved);
`SendEmailDialog` mounted on the Textile bucket (divers keeps placeholders for print + email). Also
fixed `loadContactName` (missing `IDcontact` in SELECT silently disabled fixEncoding accent repair).

## 2026-07-03 — feat/cmd-client
Clients › Commandes — line drawer **supply accuracy pass + Tricotage/Ennoblissement order creation +
Expédition tab + quick-ship** (`apps/api/src/routes/commandes-client.ts`, `commandes-sous-traitant.ts`,
`apps/web/src/pages/ClientsCommandes.tsx`). **(1) Supply semantics fixed against legacy (commande 3686,
validated to the cent)**: Ennoblissement "affecté" counts only écru rolls reserved to THIS client line;
the Tricotage grid reads the `affectation_cmd_tricotage` planning table (affecté = allocation to this
line, dispo = quantité − ALL allocations, métrage = affecté × rendement) instead of produced stock_ecru;
the "Stock de fil disponible" panel subtracts yarn still needed by open `ordre_fabrication`s
(`asso_fil_of`, `est_termine=0`: remaining × pourcentage — factored as `openOfPendingByLot`). Legacy
WinDev sources are PCS-compressed — all formulas reverse-engineered from HFSQL data. **(2) Combined
affecté gauge**: `lineReservationAggregates` now sums stock_fini rolls + stock_ecru rolls × rendement +
tricotage allocations (fixes 0/800 → 854,5/800 Ml); exposed as `affecte_total` on the `/pieces` payload
and used by the line bar, drawer, and modal footers (shared `AffecteGauge` w/ full-width progress bar).
"Ml" (mètres linéaires) capitalized app-wide. **(3) Knit-order creation** (legacy "Commande de Tricotage
Malterre" modal): per-tricoteur "Nouvelle commande" launcher on the stock-fil location bands
(`is_tricoteur` flag via IDtype_sst=1); modal has affecté/stock kg inputs with live Ml hints, net yarn
stock + pending yarn orders (`ref_fil_commande.etat=0`) tables; POST creates commande + line (unite=1,
prix via `trmLinePrix`) via exported `createKnitOrder` — TRM gets Attente_Delai + cross-ledger mirror,
external tricoteurs get Non_Envoye and no mirror — plus `affectation_cmd_tricotage` (input may be
negative, legacy parity) and one `asso_fil_lignecmdsst` per composition yarn against the knitter's lot.
**(4) Tricotage row-click modal** adjusts the (sst line, client line) allocation via new
`PUT …/supply/tricotage/:sstLineId/affectation` (over-allocation guarded). **(5) Expédition tab**:
expeditions carrying the line (`ligne_expedition`) with Facturée/Non facturée pill, per-expedition roll
list + transporteur/adresse info via new `GET …/lignes/:ligneId/expeditions`. **(6) Quick-ship**:
checkbox-select affected unshipped rolls in the Affectation tab → Expédier (ConfirmDialog) → new
`POST …/lignes/:ligneId/expedier` creates the expedition (address from commande, carrier from client,
est_valide=0) + `ligne_expedition` + points the rolls at it, then jumps to the Expédition tab.
**(7) Terminée = read-only Affectation tab**: lock banner, no available pool / affect / remove / ship /
observation edits (obs endpoint gained the missing `refuseIfSoldee`). All flows exercised end-to-end
against live HFSQL with test rows cleaned up afterwards; probe scripts under `apps/api/src/scripts/`.

## 2026-07-02 — feat/expe
Clients › Expéditions — filter + labelling + pagination pass (`apps/web/src/pages/ClientsExpeditions.tsx`,
`apps/api/src/routes/expeditions.ts`). **(1) Bucket labels**: the two category tabs "Formelles"/"Diverses"
now read **"Textile"/"Diverses"** (the internal `Kind` codes `formelle`/`divers` are unchanged; only the
French display strings + the create-modal Type toggle label). **(2) Invoiced filter**: the left-list state
filter was "Toutes / Brouillons / Validées" (on `est_valide`) and is now **"Non facturées / Facturées"**
(on `est_facture`), defaulting to **Non facturées**; "Toutes" was dropped and the two buttons split the row
50/50 with `whitespace-nowrap` so "Non facturées" stays on one line. API `?state=` accepts `facture` /
`nonfacture` (non-facturées guarded as `est_facture IS NULL OR est_facture = 0` per the HFSQL empty-flag=0
rule); legacy `all` still accepted but the UI never sends it. This matches the legacy app, where only 4
diverses are not-yet-invoiced (595/596/599/600). **(3) Load-more pagination**: the list was hard-capped at
`TOP 200`; it now pages via `useInfiniteQuery` (200/page) with a cursor `?before=<lastId>` (`IDexpedition <
before`, ignored while searching), a ghost "Charger plus" button under the last card when a full page came
back, and a `200+` footer count. Fixes the Textile/Facturées view showing exactly 200 when far more exist.
Verified `tsc --noEmit` clean on web (API baseline errors only, none in expeditions.ts).

## 2026-07-02 — feat/cmd-client
Clients › Commandes — line-item **Affectation drawer** upgrades plus supply-view accuracy fixes
(`apps/api/src/routes/commandes-client.ts`, `apps/web/src/pages/ClientsCommandes.tsx`). **(1) Roll cards
now show the fini/écru domain icon** (`FiniRollIcon` green box for fini lines, `TmRollIcon` for écru) instead
of a generic box, mirroring the sst pieces drawer. **(2) Défauts + observations are visible on each roll** via
the new shared `apps/web/src/components/shared/RollNotes.tsx` (blue observation banner / red défaut banner) —
extracted from `SousTraitantsCommandes.tsx` (which now imports it; its local copy was deleted). The `/pieces`
payload gained `observation_sst` (the ennoblisseur's defect report). **(3) Observations are editable** per roll
via a pencil → dialog, saved through new `PUT /commandes-client/:id/lignes/:ligneId/pieces/:kind/:stockId/observations`
(guards ref match + line ownership, writes via `sqlText()` for Linux-bridge-safe accents). **(4) Shipped rolls
are locked** — the "Retirer" button is hidden when a roll is expédié (fini état 4 or `IDligne_expedition` set;
écru `IDligne_expedition_ETM` set), and both unlink `DELETE` endpoints refuse with 409 server-side. **(5) New
"Stock de fil disponible" panel in the Tricotage tab** (`GET …/supply/tricotage/stock-fil`): yarn on hand usable
to knit the line's écru, scoped by `composition_ecru`, aggregated per holding location (`stock_fil.IDMagasin` →
sous_traitant), with métrage potentiel = poids / (pourcentage/100) × rendement. Composition pairs with no
on-hand lot still render under a synthetic "Sans stock" group so the full composition is always visible.
**(6) Tricotage orders now filter by écru coloris** — `buildTricotage` gained an `IDColoris IN (…)` restriction
(same `ennoInputColoriIds` rule as the écru-disponible pool) so a 029/gris-anthracite knitting order no longer
leaks into a line that needs 029/ecru (matches legacy; verified on commande 3686 / sst 8524). **(7) Supply tables
harmonized** — the enno location groups and the new stock-fil list now use the same table grammar as
"Commandes … en cours" (shared `GroupBandRow`, zinc band headers, right-aligned tabular numbers, bold métrage).
**(8) `KnitIcon`** (`apps/web/src/components/icons/KnitIcon.tsx`) — filled in the knit-mesh lattice: the hidden
`opacity="0"` connector was made visible and the missing rows-2→3 vertical connectors added, so the icon reads
as a closed diamond mesh rather than one filled loop.

## 2026-07-02 — feat/bug-pierrot
Sous-traitants › Reprise / Qualité › Suivi Lots (`apps/api/src/routes/commandes-sous-traitant.ts`) —
**correcting a roll's lot number in the Reprise modal now migrates the suivilot tracking** (bug reported by
Pierre-Emmanuel: Tricobot received commande 8801 under the truncated lot "MA"; after a reprise re-reception
with the right number, the "MA" lot stayed stuck "En reprise" with zero pieces in Qualité while the corrected
lot never appeared there at all). Root cause: `suivilot` is keyed on (ligne, lot), but the reprise PATCH only
updated `stock_fini.lot` and then synced `IDetatLot` against the NEW lot value (matching zero rows);
`upsertSuivilot()` only ran on the reception POST. New `migrateSuivilotLot()` runs on every lot-changing
PATCH: while rolls remain under the old lot it just ensures the new lot is tracked; when the last roll leaves,
the old suivilot is renamed onto the new lot. When old and new rows both exist, whichever carries
operator-entered contrôles survives (`suivilotHasControles()`, ASCII columns only) and a data-less placeholder
is deleted — so the modal's one-PATCH-per-roll batch ends with a single row that preserves measurements, and
operator input is never destroyed (worst case both rows survive + console.warn). Verified end-to-end on the
local DB (commande 8518, 7 rolls, suivilot with contrôles). Deployed to prod 2026-07-02 + one-shot data
repair: ligne 8776 rolls normalized `"MA 108715"`→`MA108715`, suivilot #5810 re-keyed MA→MA108715 état 2→1.

## 2026-07-02 — feat/cmd-client
Clients › Commandes line-drawer accuracy pass + shared état pill. **(1) `EtatPill`**: the stock_fini état
pill (green Validé / amber Contrôle / orange Reprise / red Refusé) is now a shared component in
`apps/web/src/lib/etat-stock-fini.tsx` (file renamed from `.ts`); the Affectation-tab roll rows in
`ClientsCommandes.tsx` (previously a plain grey outline Badge), `FinisStock.tsx` (table + drawer) and
`SousTraitantsGestion.tsx` all render it — rule recorded as mps_designer §37. **(2) `IDcommande_donation`
availability guard**: écru/fini rolls reserved to a donation-type commande client are no longer counted as
available anywhere — Affectation drawer (écru + fini pools), Ennoblissement per-location totals +
create-order roll picker (`fetchEnnoLocations`/`fetchEnnoAvailableRolls`), `buildEnnoblissement` (donation →
affecté bucket), create-order defensive filter, the sst écru picker in `commandes-sous-traitant.ts`, and
Tombé Métier/Stock "Disponible" (`stock-ecru.ts`; still visible under "Tous"). Verified: ref 040 phantom
44.7 kg gone, legacy-validated ref 029 totals unchanged. **(3) Wash-only enno input coloris** (user-found):
for `ref_fini.avec_teinture=0` the line's IDcolori IS a colori_ecru id, so the Ennoblissement écru pool
filters to that exact coloris (e.g. 040A/gris8985 ← écru 040/gris8985), not the natural "ecru" base (which
remains correct for dyed finis) — helper `ennoInputColoriIds`; panel title now shows the real coloris via
`ecru_coloris_label`; `computeTombeMetier` (sidebar "Tombé de métier commandé" card) aggregates per
(écru ref, input coloris) instead of hardcoding "/ecru". Verified: cmd 3692 (040A gris8985) now shows an
empty pool titled "040 /gris8985", matching legacy. **(4) Fiche client**: commande detail returns
`client_fiche` (= `client.commentaire`, fixEncoding + defensive stripRtf) and the Info tab shows it in a
read-only ClipboardList card — customer handling procedures visible on every commande like legacy.
**(5) Line commentaire**: `LineCard` renders the line's commentaire with the §24 MessageSquare pattern
(trim-guarded, ml-9, italic muted).

## 2026-07-02 — feat/cmd-sst
Sous-traitants › Commandes (`apps/web/src/pages/SousTraitantsCommandes.tsx`) — **"Couper en deux" is now
available in the Reprise reception modal** (was create-only: the toggle was gated `{!isReprise && …}` with a
comment claiming a reprise can't split rolls). The two-piece editor, preview list (scissors on both halves),
per-piece lot+métrage validation and progress counter were already mode-generic, so the toggle simply renders
in both modes. Submit for a split reprise roll: the existing `stock_fini` row is **PATCHed** into piece 1 —
renamed `<base>-1` (base trimmed to 18 chars for the 20-char numero column), new poids/métrage, état reset to
1 (En contrôle) — and piece 2 **POSTs** as a new roll `<base>-2` through the existing `pieces/fini` create
endpoint, passing the original's `IDstock_ecru`/`IDColoris`/`IDmagasin` explicitly so both halves match apart
from poids/métrage (the POST also inherits the écru's client reservation and upserts the suivilot
idempotently). No API changes — the PATCH already accepted `numero`. Doc updated in
`sous_traitants_status_model.md §Reprise flow`.

## 2026-07-02 — feat/prospect
Prospects › Demandes (`apps/web/src/pages/ProspectsDemandes.tsx`) — **search now auto-selects the top
visible result**. The screen's auto-select effect predated the mps_designer §5 guideline: it ran only on
first load (gated on `selectedId === null`) and against the raw list, so narrowing the search to a single
demande left the previous selection in place and the detail panel never switched. Replaced with the
canonical effect from `FilsCommandes.tsx`/`EtudesColoris.tsx`: it watches the **filtered** list, re-selects
`filtered[0]` whenever the current selection drops out of the visible set, and skips while `isEditing` so
unsaved changes are never discarded. No skill/doc update needed — the behaviour was already recorded in
mps_designer §5.

## 2026-07-02 — feat/cmd-sst
Sous-traitants › Commandes (`apps/web/src/pages/SousTraitantsCommandes.tsx` + `apps/api/src/routes/commandes-sous-traitant.ts`) —
**Tricobot autofill now works in the Reprise reception modal** (was create-only). When rolls "En reprise" are
multi-selected in the Réception tab and reopened via "Reprendre", the Tricobot mascot appears in the
`BatchReceptionDialog` header and pre-fills Lot / Poids / Métrage / Défaut from `data_bl_tricotbot`, matching BL
`num_piece` against the **fini** roll numeros (create mode keeps matching écru numeros) — a reprise sends the same
physical rolls back to the sst, so the corrected BL lists the same piece numbers incl. `-1`/`-2` split suffixes.
Overwrite semantics hardened for both modes: only **non-empty** BL values overwrite a field, so a hole in the BL
can't wipe the reprise pre-fill (or a user-typed value in create mode). API tricobot endpoint now `ORDER BY
IDdata_bl_tricotbot` so when the same num_piece exists twice (original + corrected reprise BL) the frontend's
last-write-wins map deterministically keeps the newest row. Doc updated in `sous_traitants_status_model.md §Reprise`.

## 2026-07-02 — feat/suivilot
Soumission Lot Client — per-coloris "Ref client" fix (`apps/api/src/routes/commandes-sous-traitant.ts`,
`findEligibleLots`). A client can hold SEVERAL `designation_client` rows for the same ref_fini, one per
coloris, each linked to its coloris through `ref_client_colori` (THUASNE has three for ref 1732:
65511008000→coloris 3520 Blanc, 65511227000→3521, 65511019000→3522). The eligibility map keyed only on
`(IDclient, IDref_fini)`, so an arbitrary sibling row overwrote the right one — commande 8500's soumission
PDF printed 65511019000 instead of 65511008000. Fix: also load the non-archived `ref_client_colori` rows for
the soumettre=1 designations and build a per-coloris map `client|ref|coloris → designation` (dye refs link via
`IDref_fini_colori`, wash via `IDcolori_ecru`), consulted first at assembly; the old `(client, ref)` map stays
as fallback for coloris without a `ref_client_colori` row. Flows into the eligible-lot card AND the soumission
PDF/email (shared data). Verified live: probe on 8500 now returns 65511008000 for Blanc 54508/1. Probe scripts
`inspect-soumission-8500-refclient.ts` / `probe-eligible-8500.ts` committed alongside.

## 2026-07-02 — feat/rapport-sst
Rapports › Commandes sous-traitants (`apps/web/src/pages/RapportCommandesSst.tsx`) — the Excel-export
column selection is now remembered **per user**, not per PC: the localStorage key is suffixed with the
logged-in `IDutilisateur` (`mps:rapport-sst:export-columns:<id>`), so users sharing or switching accounts
on one station no longer overwrite each other's choice (reported by an employee as "selection not
memorized"). Loader falls back to the old shared key so existing saved selections carry over; a
`useEffect` re-reads the selection when the logged-in user changes without a remount (user picker /
admin impersonation). Save still happens only on a successful export. Marked temporary — to be replaced
by a server-side per-user preference once proper user management lands post-migration.

## 2026-06-25 — feat/cmd-client
Clients › Commandes (`apps/web/src/pages/ClientsCommandes.tsx` + `apps/api/src/routes/commandes-client.ts`) —
polish + correctness pass on the line affectation drawer's **Ennoblissement** supply tab plus the right-panel
Info tab. **(1) Line pin-to-top drawer**: clicking a ligne now collapses the lines list to that line's height and
smooth-scrolls it to the very top so the affectation drawer always claims the space below it (was using a
max-height CSS transition that clamped the scroll and left the line short; now collapses height instantly and
scrolls to an absolute target). **(2) "Écru disponible" by location — three correctness fixes** in
`fetchEnnoLocations` / `fetchEnnoAvailableRolls`, all validated against the live legacy "029 - écru disponible"
panel (ref_fini 639 "029A" → écru ref 146, cmd 3686): (a) **natural-écru filter** — restrict source écru to the
`colori_ecru.reference = 'ecru'` base (helper `naturalEcruColoriIds`; fallback = whole pool if a ref has no
'ecru' coloris) because color-knitted variants ("Gris clair C5010" etc.) can't be re-dyed; this dropped MATEL
485→256.30 kg; (b) **"à l'usine" group** — dropped the old `IDsociete=1 AND IDmagasin>0` restriction so factory
écru (`IDmagasin=0`) surfaces, grouped by owning company via new `resolveSocieteNames` (1=Ets Malterre, 2=Tricotage
Malterre, 3=Malterre Confection); à-l'usine rows are read-only (no create button, synthetic `IDsous_traitant=-IDsociete`
React key); (c) **orphan-roll filter `IDLigne_Commande_TRM > 0`** — only écru traceable to a TRM knitting order counts,
which legacy applies uniformly (splits Tricotage Malterre 233.30→198.90 while leaving MATEL 256.30 intact; it is NOT a
second_choix filter — MATEL's 256.30 includes a 2nd-choix roll). **(3) UI polish on the location table**: larger/bolder
poids+métrage values with a gold icon box; the per-row button is now a ghost-accent "+ Nouvelle commande" matching the
left-list "+ Nouvelle"; the section title reads "{écru} /ecru — tombé de métier disponible" via a new `ecru_ref_label`
payload field. **(4) Info tab**: new "Tombé de métier commandé" card listing total écru kg ordered per écru ref
(`computeTombeMetier`: Kg lines count quantite, Ml lines convert kg = ml / rendement; fini lines trace through
`ref_fini.IDref_ecru`); and fixed Mode-paiement/Échéance showing "—" in view mode by removing the `enabled: isEditing`
gate on the two enum lookups (they're needed to resolve the labels outside edit mode).
## 2026-06-25 — feat/expeditions
Clients › Expéditions (`apps/web/src/pages/ClientsExpeditions.tsx` + `apps/api/src/routes/expeditions.ts`,
registered at `/api/expeditions`) — new screen combining the legacy `FEN_Gestion_expédition_ETMV2` (formal,
order-tied) and `FEN_Expéditions_diverses` (miscellaneous) windows into one master-detail with a **Formelles |
Diverses** bucket toggle (same `Kind`/`TBL` config shape as factures). **Formelle** = `expedition` +
`ligne_expedition`, tied to a `commande_client`: full create (pick a commande; transporteur + livraison
address auto-filled from client/order) / edit / **roll picking** — clicking a commande line opens an in-screen
drawer (mps_designer §31) to assign/free received rolls. Rolls point BACK at the shipment line via
`stock_fini.IDligne_expedition` (fini lines, type 2) or `stock_ecru.IDligne_expedition_ETM` (écru lines,
type 1); the `ligne_expedition` row is created **lazily** on first assign and deleted when emptied; deleting a
shipment frees all its rolls first. **Diverses** = `expedition_divers` + `ligne_expedition_divers` (no
`IDsociete` column; recipient = a registered `IDclient` or free-text `ref_client`), free-text `detail_ligne`
lines (RTF via stripRtf/wrapRtf). A sidebar **status-footer pill** drives `est_valide` (Brouillon → Validée);
a validated shipment is locked (header/line/roll writes return 409, like a definitive facture) but its lines
still open read-only to view shipped rolls. HFSQL footguns baked in: `date` is reserved (write/read as `DATE`);
`expedition.envoyé_client`/`envoyé_sst` are accented → never named (explicit column lists omit them, INSERT
zero-fills); empty FK = 0 not NULL; `expedition` has **no `numero`** (document № = PK; new-id resolved via
MAX-before + `TOP 1 > before DESC`); `IDsociete=1` on formelle reads/writes only. Per-line **dispo count is
per the line's own stock kind** — écru rolls merely *reserved* to a fini line (ennoblissement dyeing input)
are NOT shippable finished goods (bug found + fixed during build). Print / Email are "En developpement"
placeholders for V1 (real Bon de Livraison PDF + Gmail send — `envoi_email` type_doc 14, contact flag
`envoi_bl` — deferred; this screen also unblocks Facturation's génération-auto-from-expeditions). No conflict
with the `facture_prov.IDexpedition_divers` overload (that's a column on `facture_prov`, never a real
`expedition_divers` row). Verified end-to-end on local HFSQL — full formelle (create → assign/unassign roll →
delete, rolls freed) and divers (create → line CRUD → validate-lock 409 → reopen → delete) write roundtrips,
all reverted cleanly; web + api `tsc --noEmit` clean (api shows only the known baseline errors).

## 2026-06-25 — feat/facturation
Clients › Facturation (`apps/web/src/pages/ClientsFacturation.tsx` + `apps/api/src/routes/factures.ts` +
`apps/api/src/lib/pdf/FacturePdf.tsx`) — added the **proforma vs definitive** two-table model on top of the
existing manual-invoicing screen. The API routes are now generalized over a `Kind` config (`TBL` map) and
moved under `/factures/:kind/...` (`kind` = `prov` → `facture_prov`/`ligne_facture_prov`, `def` →
`facture`/`ligne_facture`); the list is `GET /factures?status=prov|def`. Each table keeps an **independent
`numero` sequence** (MAX+1 per table, retry loop). A proforma is fully editable; converting it
(`POST /factures/prov/:id/convert`) copies the header + lines into `facture` with a fresh definitive numero.
Because `facture_prov` has no spare flag, a converted proforma is marked by **overloading
`facture_prov.IDexpedition_divers`** (else always 0) as a back-pointer to the resulting `facture.IDfacture`
(`0` = open/editable, `>0` = converted/locked). Write-path **locks** (server 409 `DEF_LOCK` / `PROV_CONVERTED`,
FE hides the buttons): definitive is read-only AND non-deletable; a converted proforma is read-only. **Email +
historique are definitive-only** (prov/def share the `envoi_email` `IDtype_doc` 19 + a numeric id space, so
emailing a proforma would cross-contaminate histories). Proforma still prints via a `FacturePdf` `isProforma`
variant ("Facture proforma" title + "Document non contractuel" mention; no italic — bundled Lato has no italic
face). FE: the create dialog now picks `prov`/`def`; the detail header shows a Proforma/Définitive/Converti
badge, a "Convertir en facture" action on open proformas, and a "Voir la facture N°…" jump on converted ones.
**Left-panel redesign** (this session's ask): the proforma/definitive selector is now a prominent bordered
segmented control (`Proforma | Définitives` — renamed from "Factures" to kill the collision with the type
filter's "Factures"), and the type filter below it (`Tous | Factures | Avoirs`) uses the standard left-list
filter button group, so the category switch reads as dominant and the filter as subordinate. Verified end-to-end
on local HFSQL; web `tsc --noEmit` clean.

## 2026-06-25 — feat/gestion-client
Clients › Gestion (`apps/web/src/pages/ClientsGestion.tsx`) — right-panel reorganization (UI only, no
API/data changes). The master-data form that previously lived in the **center** panel was moved into the
right sidebar as two new tabs, so the sidebar now reads **Info / Commercial / Contacts / Adresses**:
- **Info** tab (new) holds Général (téléphone, fax, remise %, % AJEOL, secteur, activité, the *client
  interne* / *inclure rapports contrôle* toggles), Facturation (mode de paiement, échéance, TVA, N° TVA,
  code comptable, compte client), and Commentaire — rendered as `InfoCard` + `KVRow` (label-left /
  value-right; `size="sm"` `SearchableCombobox`/`PopoverSelect` in edit mode) wired straight through the
  existing `draft`/`onPatch` state, so the unsaved-changes guard and Enregistrer/Annuler flow cover it.
- **Commercial** tab (new) holds Dernier contact + Journal commercial (same `draft`/`onPatch` plumbing).
- The **center** panel is now purely the read-only history collapsibles (Références / Historique /
  Marchandise); `DetailMain` lost its now-unused `draft`/`onPatch`/lookup props.
The sidebar root width went `w-96` → `w-[26rem]` (one-off for this screen, not recorded in mps_designer)
to fit four tabs, and the per-tab count **pill** was replaced with a compact inline number so "Contacts"
and "Adresses" labels stop truncating against `flex-1` equal widths. Removed the now-dead `Field`,
`SelectField`, and `SectionCard` helpers.

## 2026-06-25 — feat/devis
Clients › Devis PDF (`apps/api/src/lib/pdf/DevisEtmPdf.tsx`) — CONDITIONS header card redesign (follow-up to
the 2026-06-24 header-height work). Three fixes: (1) **icon alignment** — every `flexDirection:'row'`+
`alignItems:'center'` icon+title row in this file rendered the Svg visually *below* its text, because the
content area inherits `lineHeight:1.45`, inflating each line box so glyphs sit at the top while the icon
centers in the tall box. Added tight `lineHeight:1` on the meta labels/values and the card/livraison/
commentaire titles so icons center against the real glyphs. (2) **relevant, distinct icons** — the old card
reused a chat bubble for Réf. client and the calendar for both Validité and Échéance, so at ~10px they read
as identical rectangles; now tag (réf. client) / calendar (validité) / credit-card (paiement) / clock
(échéance), built from a typed `metaItems` array. (3) **vertical space** — conditions moved from 4 full-width
stacked rows to a compact **2×2 grid** (icon beside a stacked caps-label + value), so the conditions card no
longer drives the header height (the client address does). Added a dev script
`apps/api/src/scripts/dump-devis-pdf.ts` (mirrors `dump-soumission-pdf.ts`/`dump-sst-pdf.ts`) that renders a
devis PDF from synthetic data for offline layout inspection. Pure PDF layout — no API/data changes.

## 2026-06-25 — feat/stock-finis
Finis › Stock table (`apps/web/src/pages/FinisStock.tsx`) — cosmetic weight fix. The Poids column cell in
`StockRow` carried a `font-medium` class that bolded every weight value relative to the surrounding columns.
Removed it so the Poids values render at normal weight, consistent with the rest of the table row.

## 2026-06-25 — feat/cmd-client
Clients › Commandes — Ennoblissement supply tab: affectation modal, état pills, and the **create-ennoblisseur-order
from a client line** flow (`apps/web/src/pages/ClientsCommandes.tsx` + `apps/api/src/routes/commandes-client.ts`).
The line-drawer Ennoblissement/Tricotage supply tables gained **N°** + **Date** columns and a solid-hue
`SupplyEtatPill` (En cours / Attente délai / Non envoyé), and single-clicking an ennoblisseur row opens
`EnnoblissementAffectationDialog` (two-panel transfer) to reserve a dyer's input écru rolls to the client fini line
— with a coloris-match fix on `buildEnnoblissement` (`lcs.IDColoris = ctx.coloriId`) so a dye order for a different
coloris of the same ref_fini no longer leaks in. New this branch: below the in-progress orders table, an
**EnnoLocationTable** ports the legacy "029 - écru disponible" panel — tombé-de-métier (écru) of this fini's écru ref
(`ref_fini.IDref_ecru`) available, aggregated by sous-traitant location and grouped **Chez les ennoblisseurs**
(IDtype_sst=2) vs **À l'usine** (other ssts), each row showing Poids (kg) + Métrage potentiel (poids×raw-rendement).
Only ennoblisseur rows carry a gold **Commande** button that opens a location-scoped `CreateEnnoblisseurOrderDialog`
("Disponible chez X" rolls, all pre-selected, Shift-range + Tout/Aucun, date commande/livraison). Creating commissions
a `commande_sous_traitant` + one `type=2` line (IDreference=ref_fini, IDColoris=coloris, quantite=Σpoids×rendement Ml,
unite=0, sstatut=Non_Envoye — INSERT shapes copied verbatim from commandes-sous-traitant.ts), affects the chosen écru
rolls (`stock_ecru.IDref_commande_affectation`), auto-reserves the FREE ones to the client line
(`IDligne_commande_client`, guarded so rolls reserved elsewhere keep their reservation), and auto-prices via
`calcTarifSST` (€/Kg, best-effort). **Affect-only** — `IDmagasin` untouched (physical shipment stays a separate step).
Backend endpoints (all scoped to a fini client line): `GET …/supply/ennoblissement/available-by-location`
(`fetchEnnoLocations` + `resolveSousTraitantTypes`; factory `IDmagasin=0` excluded — only sous-traitant locations),
`GET …/available-rolls[?magasin=<id>]` (`fetchEnnoAvailableRolls`; coloris NOT filtered — dyer dyes any source coloris;
`reserved_elsewhere` surfaced not excluded; available = ref match + not-dyer-affected + not-shipped + not-consumed-by-fini),
`GET/PUT/DELETE …/supply/ennoblissement/:sstLineId/rolls[/:stockId]` (`fetchEnnoRollsPayload`), and
`POST …/supply/ennoblissement/orders` (`ennoOrderBody`). Ennoblisseurs are external → no TRM mirror / no bridge-storm.
Reads verified live (cmd 6899/ligne 12648/040A → MATEL 2 rolls / 26.26 kg / 63 ml). (Memory:
project_clients_line_supply_tabs.)

## 2026-06-24 — feat/devis
Clients › Devis PDF (`apps/api/src/lib/pdf/DevisEtmPdf.tsx`) — header height reduction + delivery-address
relocation. The delivery address (`ADRESSE DE LIVRAISON`) was removed from the top-right combo card and now
renders as its own gold-accent box pinned to the **bottom** of the page, just above the footer band — pushed
down by a `flexGrow` `bottomSpacer`. The top row was reorganized into two tighter cards (`CLIENT` left,
`CONDITIONS` right) sharing a compact `headerCard` style (padding 14→10, tighter line-height, conditions as
a tight label/value grid with 10px icons) so the header band is noticeably shorter. The old `comboCard`/
`AddressCard` usage was dropped in favor of local compact card markup; `buildClientAddress` now returns a
plain `{ name, lines }` shape. No API/data changes — pure PDF layout.
Rapports › Commandes sous-traitants — Excel export date-sort fix (`apps/web/src/pages/RapportCommandesSst.tsx`).
The five date columns (Date commande, Délai initial, Délai actuel, Délai client, Relance) were exported as
French **text** strings (`"24/06/2026"`), so Excel sorted them lexically (by day-of-month) instead of
chronologically. New `dateVal()` helper parses the HFSQL `YYYYMMDD` string into a real JS `Date` (local
midnight; empty/invalid → `null` for a blank cell). Export columns gained a `kind?: 'date'` flag; the date
columns now emit `Date` values and `handleExport` builds the sheet with `aoa_to_sheet(aoa, { cellDates: true })`
so SheetJS writes true date cells (`t:'d'`). Each date cell then gets `z = 'dd/mm/yyyy'` so it still *displays*
in French format while the underlying serial makes the column sortable/filterable in Excel. Quantity/day
columns were already real numbers and unaffected.

## 2026-06-24 — feat/gestion-client
Clients › Gestion (`apps/web/src/pages/ClientsGestion.tsx` + `apps/api/src/routes/clients.ts`, wired in
`router.tsx` replacing the placeholder and `index.ts` under `/api/clients`) — the legacy "Gestion Client"
screen. Master-detail over the `client` table (32 cols) with an **Info / Contacts / Adresses** identity
side and commercial sub-views **Références (catalogue) / Historique (commandes) / Marchandise (expéditions)
/ Tarif (PrixDeVente)**. Contacts/adresses are the shared polymorphic tables keyed on `IDclient`. **HFSQL
rules baked in**: `SELECT * FROM client` returns 0 rows on the Windows ODBC driver, so Windows names an
explicit non-accented column list and reads the archive flag via a separate `WHERE archivé = 1` query
(WHERE tolerates the accent); Linux uses `SELECT *` and reads the truncated key (`archiv`/`bloqu`) off the
row. We NEVER name `archivé`/`bloqué` in a SELECT list. Accented text VALUES (client names like "Amalthée",
"37 Degrés") are written as Latin-1 hex literals via `sqlText()`. INSERT sets `IDsociete = 1` (ETM);
`archivé`/`bloqué` left to HFSQL defaults. Reused the proven client-read pattern from `etudes-coloris.ts` /
`commandes-client.ts` and mirrored `fournisseurs.ts` for CRUD + contacts/adresses. The expedition /
designation_client / ref_client_colori columns were reconstructed from the legacy schema. (Memory:
`project_clients_gestion_screen.md`.)

## 2026-06-24 — feat/suivilot (graphique d'évolution + freinte)
Qualité › Suivi des lots — freinte corrections, end-customer in the récap, and a new
"Graphique" trend modal. **(1) Freinte fixes**: the main-area spec-banner *Freinte* showed
`freinte_demandee` raw (`0,12 %`) — it's a stored fraction like `ref_fini.freinte`, now ×100
(→ 12 %). The computed `freinte_sst` (`1 − (poids_sst·laize_sst/100000)·moyenne_rdt`) was
**removed from the Sous-Traitant Contrôles panel** — it's only an internal-consistency check
between three measurements of the same fabric (≈0 when measured correctly, ambiguous otherwise),
not a real yield loss; the API still computes/returns it (unused by the UI — do not re-add). **(2)
Récap**: *Récapitulatif de la commande* now shows **Client final** (end customer) when the sst
order links to a `commande_client` → `client` (data already plumbed; no backend change). **(3)
Graphique modal**: a `LineChart` icon button left of Modifier (view mode, visible to all — read-only,
not gated on `responsable_qualite`) opens a self-contained SVG line chart (no charting dependency).
New endpoint `GET /suivi-lots/:id/serie?sst=<id>` (suivi-lots.ts) scoped to **same `IDref_fini`** +
a **selectable sous-traitant** (`?sst`, defaults to the lot's own); `SELECT TOP 200 * FROM suivilot
… ORDER BY DATE DESC` reversed to oldest→newest, SELECT * + prefix-regex extraction (never names
accented `*_demandée` cols). **Granularity differs by parameter**: *Rendement* is plotted **per roll**
(each `stock_fini` rdt = metrage/poids, with the lot's target as a reference line), *Laize / Poids /
Stab H / Stab L* **per lot** (SST + Tirelle + Demandé). Response returns `points[]` (per-lot),
`rolls[]` (per-roll, capped 200), and `sous_traitants[]` (every sst that worked on the réf, for the
selector — shown only when >1). Chart UI: param tabs × series toggles × window (50/100/200 = rolls
for rendement, lots otherwise); `0 = non mesuré` omitted; current lot's point(s) cerclé(s) en or when
viewing its own sst. `keepPreviousData` avoids flicker on sst switch. See memory
`project_suivilot_graph_freinte`.

## 2026-06-24 — feat/suivilot
Qualité › Suivi des lots — workflow reform + Contrôles UX, plus a cross-screen cache fix.
**(1) Header cleanup**: removed the non-functional print + email (@) buttons (and their placeholder
dialog) from the lot detail header. **(2) Tolerance gauges**: each Contrôles measurement (Laize, Poids,
Stab H/L, in both Sous-Traitant and Tirelle cards) now renders a tolerance gauge under the value — a
green min→max band with a colored needle at the measured value (green in-band, red out, hidden when not
yet measured), with min/max labels under the band edges; **stab** is a 0-centered ±band (the ref_fini
figure `-5` means ±5 %, mostly shrink) labelled `-5 · 0 · +5`. An unmeasured value renders blank (no "0").
The Rendement row was dropped from both cards. **(3) Quality workflow reform** (see
`project_quality_workflow_reform`): replaces the legacy two-role model with a single `responsable_qualite`
permission (new catalog entry, category "Qualité", per-user in Paramètres › Utilisateurs; effective admin
bypasses). Non-holders get the screen **read-only** (no Modifier, no status change). Backend gates
`PUT /suivi-lots/:id` + `POST /suivi-lots/:id/etat` via `userHasPermission`. The footer is now a **two-verdict**
control — **Valider** (→3) / **Reprendre** (→2) only; `POST /etat` rejects any état ≠ {2,3}; **Reprendre** also
flags the lot's `stock_fini` rolls to `IDetat_stock_fini = 2` so they queue in the Sous-traitants reprise
flow (2→1 happens via the existing re-réception sync). Sending a soumission on Sous-traitants › Commandes
now **auto-sets** the matching `suivilot` to état **5**. État 5 renamed "Attente décision" → **"Attente Client"**
(UI-only — HFSQL `etat_stock_fini` label untouched for legacy), recolored violet, icon changed from HelpCircle
to **User** (person). **(4) Cross-screen cache sync** (see `project_react_query_stale_cross_screen`): new
`apps/web/src/lib/cache-sync.ts` → `invalidateLotQualityCaches(qc)` invalidates both the Qualité and
Sous-traitants query families; wired into `QualiteSuiviLots` `etatMut` and `SousTraitantsCommandes`
`invalidateAll` + soumission-email success, so a change on either screen refreshes the other (the global
5-min React Query `staleTime` previously served stale cache until a hard reload).

## 2026-06-24 — feat/facturation
Clients › Facturation (`apps/web/src/pages/ClientsFacturation.tsx` + `apps/api/src/routes/factures.ts` +
`apps/api/src/lib/pdf/FacturePdf.tsx`, registered `/api/factures`, route wired in `router.tsx`) — the manual
client-invoicing screen (legacy "Détail facture" / "Nouvelle facture"), mirroring Clients/Commandes
(MasterDetailLayout, header Print/Email/Modifier trio, unsaved guard, auto-edit-after-create, SendEmailDialog,
ConfirmDialog) **minus** stock affectation and the status footer (a facture has no lifecycle/paid flag).
Browse/search/filter (Tous / Factures / Avoirs), view + create + edit + delete over `facture`/`ligne_facture`
(ETM scope `IDsociete=1`), free-text line editor (`designation` / `quantite` / free-text `unite` / `prix`),
and computed **HT / TVA / TTC** — no stored totals: HT = Σ(qty×prix), TVA = HT × `tva.valeur`, TTC = HT+TVA.
**`type` 1=Facture / 2=Avoir** as a category chip; an Avoir reads negative in the list + footer (ledger sign),
positive in the grid. `facture` has **no accented columns** (SELECT * safe) but `date`/`type` are reserved
words → written uppercase `DATE`/`TYPE` (same trick as `envoi_email.DATE`). `numero = MAX+1 WHERE IDsociete=1`
with a retry loop. **Create auto-fills billing defaults from the client row** (`num_tva`, `IDtva`,
`IDmode_paiement`, `IDecheance`, `IDcode_comptable` + the `est_defaut_facturation` adresse). PDF (Facture/Avoir,
Malterre frame) + Gmail send (`contact.envoi_facture`, type_doc 19, type-aware subject) + envoi historique.
Sidebar tabs: Info (client, type toggle, date, mode, échéance, TVA select, N° TVA, billing-address picker) +
Historique. **Deferred (Phase 2 — blocked on the not-yet-built Transport/Expéditions module):** legacy
"Génération automatique" + "Factures provisoires" (`facture_prov`, empty in prod) which build invoices from
un-invoiced `expedition` rows, plus the "Factures → Compta" export. No Docs tab (legacy facture detail has
none; `ged` has no IDfacture FK). Verified end-to-end on local HFSQL (list / detail / create-autofill / lines
CRUD / PDF / email-defaults / historique / delete + reserved DATE/TYPE + accent round-trip); web tsc + vite
build clean.

## 2026-06-24 — feat/devis
Clients › Devis (`apps/web/src/pages/ClientsDevis.tsx` + `apps/api/src/routes/devis.ts` + `apps/api/src/lib/pdf/DevisEtmPdf.tsx`, registered at `/api/devis`, route `/clients/devis`) — the ETM client quotations screen (`devis_etm`/`ligne_devis_etm`), ported from the legacy `FI_Devis_ETM`. Mirrors Clients › Commandes (master-detail, Info/Adresses/Docs/Historique tabs, En cours/Soldé footer pill, PDF, Gmail send, ged documents, unsaved-guard) but a devis never reserves stock, so there is **no affectation drawer**. Key model facts (verified against live HFSQL): scope is **`IDprospect = 0`** (client devis; `devis_etm` has **no `IDsociete`**); `numero` = global `MAX(numero)+1`; **`date` is a reserved column** (reads back as `DATE`, written bare) plus a real **`date_expiration`** (drives list urgency); **`remise` is a fraction** (0.05 = 5%), shown/edited as a % and applied as `Σ(qty×prix)×(1−remise)+frais_port`; lines are type 2=fini / 3=divers (with `IDref_ecru` resolved from the fini ref and stored so the legacy app still reads them); never name accented `archivé`/`delai_annoncé`/`déverrouiller`. **Pricing**: a `GET /devis/pricing/suggest` endpoint reuses the ported `PrixDeVenteV4` (`calcTarifRefFini`) to auto-fill an empty line price (editable hint, finished refs only); the client-contract `contrat_tarif`/`tranche_tarifaire` layer is deferred. **Passer en commande**: `POST /devis/:id/convert` creates a `commande_client` + lines, marks the devis soldé, and back-links `devis_etm.IDcommande_ETM` (re-convert blocked). Documents/historique/email key on **`type_doc = 28`** ("devis"); ged docs discriminate on `IDreference=devisId AND IDtype_doc=28` (collision-free, no devis FK on `ged`); email "selected" bucket = `contact.envoi_soumission`. Deferred: read-only "Stock disponible" panel and the full contract-pricing layer. Verified end-to-end (list matches the legacy 7 open devis exactly, N°178 total 803.04 € identical, full create→line→convert→delete round-trip cleaned up). New file `apps/web/src/pages/ClientsDevis.tsx`; replaced the `ClientsDevisPage` placeholder in `router.tsx`.
## 2026-06-24 — feat/rapport
Rapports › Commandes sst (`apps/web/src/pages/RapportCommandesSst.tsx` + `apps/api/src/routes/rapports.ts`) —
added a **Journal** column and corrected the **Commentaire** column source. **(1) Journal column**: surfaces
the commande sst header `journal` field (`commande_sous_traitant.journal`, plain text since the 2026-05-26 RTF
migration; still `stripRtf()`'d defensively). Added to the report row payload (`journal: hdr?.journal || ''`),
the sortable table (new `journal` SortKey + 220px column), the Excel export column catalog (so it appears as a
toggle in the "Colonnes à exporter" picker), and the search haystack/placeholder. **(2) Commentaire column
fix**: repointed it from the per-line `ligne_commande_sous_traitant.commentaire` (with header fallback) to the
commande sst **header** `commentaire` only. Legacy stored unrelated notes on the line comment (e.g. the literal
word "journal"), so a line comment was shadowing the order's real header note; the column now consistently
shows the commande-level commentaire. Both note columns are now header-level (commande sst), matching the
report's per-commande mental model. Note: the export defaults to all-columns only for first-time users — anyone
with a previously-saved selection ticks **Journal** once in the picker to include it.

## 2026-06-24 — feat/cmd-client
Clients › Commandes — line-item creation, pricing, and supply-chain visibility on the existing screen
(`apps/web/src/pages/ClientsCommandes.tsx` + `apps/api/src/routes/commandes-client.ts`, new
`apps/api/src/lib/pricing-ligne-client.ts`). **(1) Nouvelle commande modal**: address pickers now render the
full address (street · CP ville · pays) under each name via `PopoverSelect`'s `description` (canonical
`adresseOption` mapper, designer §11bis); selecting a client **prefills** Mode paiement + Échéance from the
client sheet (`client.IDmode_paiement`/`IDecheance`, now returned by `/lookups/clients`) and the billing/
delivery addresses from their `est_defaut_*` flags. **(2) Clients lookup scoping**: `/lookups/clients` now
filters `IDsociete = 1` (was leaking 27 TRM + 4 Confection clients into the ETM picker). **(3) "Note interne"
→ "Journal"** UI label rename (field `commentaire_interne` unchanged). **(4) Nouvelle ligne modal**: fixed the
Unité dropdown overflowing the Prix input (dropped `size="sm"` → fills its grid cell); `unite=4` label "U" →
"unité" (frontend + `uniteLabel`). **(5) Buyable-ref filter**: the line Référence dropdown is restricted to
the refs assigned to the client in `designation_client` (`/lookups/refs-ecru|refs-fini?client=`, `assignedRefIds`
prunes `archivé`/`caché` in JS via `pickKey` — never named in SQL). **(6) Auto-pricing + roll note** (PrixDeVenteV4
port, `calcLignePriceClient` + `/lookups/line-price`): typing a quantity on an écru/fini line auto-fills the unit
price (€/Ml or €/Kg) for the roll-count tariff tranche, with a padlock to override (session-only). A roll-count
note shows green when the quantity is a whole-roll multiple, amber `>` when it overshoots (roll size =
`poids × round2(rendement)`). A **commercial nudge** appears when the quantity is within 15% of the next cheaper
tranche ("Plus que X Ml pour atteindre N rouleaux → Y €/Ml (−Z%)"). Fini path validated EXACT vs legacy
(040A/beige2585 10 rolls → 10,43 €); écru path derived (fil + tricotage ÷ margin ÷ port), unvalidated. Used
`keepPreviousData` to stop the note collapsing/reflowing on each keystroke, gated on current form inputs so it
clears on a fresh dialog. **(7) Coloris-aware affectation**: the line affectation drawer's "stock disponible"
and the link endpoints now filter/guard by the line's coloris (`stock_fini.IDColoris` / `stock_ecru.IDcolori_ecru`
= line `IDcolori`), so e.g. a beige line no longer offers gris rolls. **(8) Supply tabs**: the affectation drawer
became tabbed (designer §31.4) — Affectation + **Ennoblissement** (fini lines) + **Tricotage** (écru/fini),
showing in-progress sous-traitant orders feeding the line via new `GET /:id/lignes/:ligneId/supply`. Ennoblissement
disponible/affecté (ml) = input écru (`stock_ecru.IDref_commande_affectation`) split by client-affectation × raw
fini rendement (validated EXACT: 240,60 kg × 3,548387 = 853,74 ml); Tricotage affecté/disponible (kg) = output écru
committed to clients / `quantité − affecté` (validated 6388/4000 kg), métrage potentiel = dispo × rendement.
`invalidateAll` now also refreshes the `commande-client-pieces` and `commande-client-supply` caches after line/
affectation edits. The legacy right-side stock panels (écru-by-location, fil-by-tricoteur) were not built.

## 2026-06-23 — feat/suivilot
Qualité › Suivi des lots — enhancements to the existing screen (`apps/web/src/pages/QualiteSuiviLots.tsx`
+ `apps/api/src/routes/suivi-lots.ts`). **(1) RTF commentaire**: the commande's `commentaire` (RTF in
`commande_sous_traitant`) is now run through `stripRtf()` so the Récap shows plain text, not raw `{\rtf…}`.
**(2) Pièces conformity**: each received roll (`stock_fini`) gets a rendement-validity flag via the legacy
`gxRendementMini`/`gxRendementMaxi` model — bounds computed from `ref_fini.poids_Min/Max · laizeHT_Min/Max ·
freinte · rendement` and `suivilot.rendement_demande`; a new **Conforme** column (far-left was moved to a
dedicated far-right **Qualité** column) shows green check / red triangle, and the header shows the valid Rdt
range. **(3) Per-roll quality history**: a new far-right **Qualité** column shows a comment/defect icon
(MessageSquare, or amber AlertTriangle when a defect exists) with a hover tooltip aggregating each roll's
quality stages — Tricotage (source `stock_ecru.observations` + `visiteur`), Défaut tricotage
(`defaut_qualite` Type_Reference=2 keyed on écru + Type_Reference=1 keyed on the écru's `piece_production`),
Ennoblisseur (`stock_fini.observation_sst`), Contrôle fini (`stock_fini.observations`); all accent-repaired,
NUL-padding stripped via `cleanText`. **(4) Contrôle conformity markers**: Laize / Poids / Stab H / Stab L
in both Sous-Traitant and Tirelle cards are flagged conforme/non-conforme live (view + edit) against
`ref_fini` bounds shipped as `ref_bounds` — laize `min≤val≤max`, poids `min≤val≤max`, stab `val ≥
stab_hauteur/largeur`; suppressed when no ref or value not measured. **(5) Freinte SST computed**: the
Sous-Traitant Freinte is now the legacy computed value `1 − (poids_sst·laize_sst/100000)·moyenneRdt`
(was wrongly showing `freinte_demandee`), displayed as a rounded percentage. **(6) En cours / Terminé
filter fix**: the left-list status filter now keys off lot état (`IDetatLot = 3` "Validé" = Terminé),
matching legacy (34 en cours / ~5114 terminé) — it previously keyed off `fin_archivage`, which is actually
the sample-disposal date, not a status. **(7) Archive concept removed**: dropped the bogus "archived"
status (card marker, header badge + toggle button, `POST /:id/archive`, `isArchived`) since `fin_archivage`
is just the disposal date — it remains as the editable "Fin d'archivage" field in the Observations card.
Also fixed a `fixEncoding` aliasing bug (the list selected `st.nom AS sous_traitant_nom` then repaired the
non-existent aliased column, so `Société` rendered mangled — now selects real `nom` and renames in JS), and
gave état 5 "Attente décision" a distinct violet hue so it no longer reads like the gray archived icon.

## 2026-06-23 — feat/ref-tm
Tombé Métier › Références (`apps/web/src/pages/TombeMetierReferences.tsx` + `apps/api/src/routes/references-ecru.ts`) refinements + a new **Coût de tricotage** breakdown. **Jauge/Diamètre** are stored as 1-based ordinals indexing legacy combos (`gtaJauge`: 2→14, 3→18, 4→20, 5→28, no unit — needles/inch; `gtaDiametreMachine`: 2→26", 3→30") — both now display the real value and edit via dropdowns (the raw ordinal is never shown; ordinal 1/`-1`/0 = unset). **Search** is multi-criteria (space-separated AND across reference, désignation, contexture, jauge, diamètre — list endpoint now returns `Jauge`/`diametre`); the footer count tracks the filtered list. Identification header subtitle falls back to contexture when no désignation; Composition/Coloris cards collapse by default per selection. **"+ Nouveau"** auto-generates the next free 3-digit zero-padded reference server-side; duplicate references are rejected on rename (409); fixed the create-selection race (new card stays selected + scrolls into view) and stale-detail-after-delete. **Safeguards**: composition must total 100 % to leave edit mode (empty allowed); the composition AND five fabric-defining header fields (contexture, jauge, diamètre, bio, recyclé) are **frozen** once rolls (`stock_ecru`) or tricoteur orders (`ligne_commande_sous_traitant` type 0/1) exist — UI locks + backend 409/silent-keep; a coloris can't be deleted while affected to a roll, order, or its own composition (per-coloris in-use flags drive a greyed lock affordance + 409 guard). Statistiques gained "Rouleaux créés" + "Poids total" (Σ `stock_ecru.poids`); "Réglages par métier" "+" now opens a modal (`MachineFormDialog`); "Tombé du métier" is a Rouleaux/Plis dropdown. **Coût de tricotage**: refactored `apps/api/src/lib/pricing-trm.ts` to expose `prixDeRevientTRMDetail()` (full per-component breakdown — Frais de structure / Frais de production / Main d'œuvre — with `prixDeRevientTRM`/`trmLinePrix` as thin wrappers, line pricing byte-identical, regression `test-prix-revient-trm.ts` still 9/10); new `GET /api/references-ecru/:id/cout-tricotage?qty=` (default 1000) + a sidebar card and read-only modal with an editable debounced quantity, the three sections, subtotals, and the totals chain (coût → prix de vente ×1/0.7 → prix plancher → prix retenu).
## 2026-06-23 — feat/ref-fini
Finis › Références — added a **Tarif** tab to the detail sidebar plus three small left-list/label
refinements. **Tarif tab** ports the legacy `FI_Tarifs` / WLanguage `PrixDeVenteV4` cost-price
algorithm (the `nType_Ref=2` finished-ref path). New `apps/api/src/lib/pricing-fini-tarif.ts` →
`calcTarifRefFini(IDref_fini, IDcoloris)`, exposed via `GET /api/references-fini/:id/tarif?coloris=<id>`
(added to `references-fini.ts`; defaults to the ref's first coloris when omitted; returns
`tranches: []` rather than erroring when rendement=0 / no coloris / no écru). For a ref+coloris it
builds 9 order-quantity tranches (`<1,1,2,3,4,5,10,15,30` rolls; `PoidsRef = ref_ecru.poids*rollMult+1`)
each with the full breakdown: **fil** (`Σ pourcentage×yarn €/Kg`, preferring `colori_fil.prix_kg`),
**tricotage** (`ref_ecru.prix`, −5%/−10% at 15/30 rolls), **traitement** (per `traitement_ref_fini`,
band price ×1.05 packaging, ×`multiplicateurMatel` for IDtraitement∈{298,285,302}), **teinture**
(dye band ×MATEL mult ×1.05 +GOTS, only `avec_teinture≠0`) → **revient** → vente Kg/Ml via
`venteKg = round(revient/(1-CoefficientV2[i])/(1-tauxPort),2)` (port 5%, 3% at 30 rolls;
`CoefficientV2=[0.60,0.50,0.45,0.40,0.35,0.30,0.27,0.22,0.17]`). All ennoblissement prices read
`tranche_tarif_ennoblissement` rows with **`IDsous_traitant=0`** (the company's own copied-from-MATEL
tariff — no supplier picker); reuses `multiplicateurMatel`/`MATEL_BANDS` from `pricing-sst.ts`. The
legacy `.wdw` is a compressed binary (not extractable); the algorithm came from the WLanguage source
the user supplied, with the output shape confirmed by the Android transpile (`STPrixDétaillé`). UI
(`FinisReferences.tsx`): the single-button sidebar header became a 2-tab bar (Informations | **Tarif**,
`BadgeEuro`); the Tarif tab has a coloris `SearchableCombobox`, a clickable volume-tier grid
(Qté Rlx / Qté Ml / Prix/Ml) and a gold-banded cost breakdown for the selected tranche, all read-only.
Bridge-safe throughout: flat queries + JS merge (no JOIN+CONVERT), `fixEncoding` for label text,
integer-only filters, idField always selected (no `WHERE col=NaN` storm). **Also in this branch**:
left-list search is now multi-criteria (space-separated terms AND-matched across reference+designation);
the footer count reflects the filtered list; and the teinture indicator distinguishes **Simple teinture**
(`avec_teinture=1`, one droplet) vs **Double teinture** (`=2`, two droplets) vs Écru/lavage. Full algo
+ reuse notes in memory `project_prixdevente_v4`.

## 2026-06-23 — feat/cmd-client
Clients › Commandes — new master-detail screen (`apps/web/src/pages/ClientsCommandes.tsx` +
`apps/api/src/routes/commandes-client.ts` mounted at `/api/commandes-client` + PDF
`apps/api/src/lib/pdf/CommandeClientPdf.tsx`; the `router.tsx` placeholder was replaced). First
real Clients screen. Mirrors `FilsCommandes` (§28 unsaved guard, §29 binary status footer, §30
deadline urgency, §31 in-screen drawer, §32 email, §34 ged docs) and the sous-traitant commande
flow. **Data/semantics**: `commande_client` / `ligne_commande_client`. ETM scope on every
read/write = `IDsociete=1 AND IDcommande_ETM=0` (IDsociete=2 rows are TRM mirrors owned by the
sister company — this route is NOT the TRM-mirror writer, so none of that machinery is carried).
numero allocator = `MAX(numero)+1 WHERE IDsociete=1` with retry. **Centerpiece = stock
affectation**: each line reserves rolls via `stock_ecru.IDligne_commande_client` /
`stock_fini.IDligne_commande_client` (distinct from the sst `IDref_commande_affectation`); the
in-screen drawer shows "Stock affecté" ↔ "Stock disponible" with a unit-aware progress gauge.
**Line polymorphism** (`ligne_commande_client.TYPE`, reserved word → `TYPE AS type_kind`, write
uppercase; `IDcolori` is lowercase not IDColoris): 1=écru (`ref_ecru`+`colori_ecru`), 2=fini
(`ref_fini`+coloris by `avec_teinture`), 3=divers (`ref_divers.designation`, display-only, no
affectation). **`unite` enum** (hardcoded, verified empirically): 1=Kg→sum roll `poids`, 3=Ml→sum
roll `metrage`, 4=U, 5=m² — écru rolls carry `metrage=0` so écru (unite=1) gauges on poids.
Available fini = `IDref_fini` match, not reserved, not on a shipment (`IDligne_expedition` 0/NULL),
`IDetat_stock_fini<>4` (Expédié); available écru = `IDref_ecru`, `IDsociete=1`, not shipped
(`IDligne_expedition_ETM` 0/NULL), not reserved, not at a dyer (`IDref_commande_affectation` 0/NULL),
not consumed into a stock_fini. **Real bon-de-commande PDF + Gmail email** (§32, `type_doc 7`
"commande client" for the envoi_email log + ged discriminator `IDcommande_client=id AND
IDcommande_sous_traitant=0`); TVA from the `IDsociete=1` default `tva` row (≈20%). Manual pricing
(montant = quantite×prix; no auto-pricing — devis/facture cost-price lives elsewhere). Computed list
phase = a_affecter / partielle / terminee. **HFSQL footguns honoured**: `SELECT * FROM client`
returns 0 rows → explicit columns only, and clients are filtered by `est_visible=1` only (NOT
IDsociete); accented cols never named (`archivé`/`expedié`/`envoyé_client`, line
`delai_annoncé`/`déverrouiller`); accent-safe writes via `sqlText()` (Latin-1 hex); `echeance` /
`mode_paiement` label col = `libelle`; flat-query resolution (no CONVERT-in-JOIN); batched
`fixEncoding`. Verified end-to-end on local HFSQL (list/detail/CRUD/affectation link-unlink/PDF/
email-defaults/historique).

## 2026-06-23 — feat/stock-ecru
Tombé Métier › Stock — new table-centric screen (`apps/web/src/pages/TombeMetierStock.tsx` +
`apps/api/src/routes/stock-ecru.ts`, mounted at `/api/stock`; the `router.tsx` placeholder was
replaced). Mirrors finis/stock: split sortable table, single fuzzy search, status filter,
multi-select edit mode, right slide-in drawer edit, batch edit ("Édition groupée"), cut-roll, and
Nouveau create. **Data/semantics**: `stock_ecru` (écru/tombé-de-métier fabric rolls). The "in
stock" base population every view operates on = `IDsociete=1` (ETM only — TRM rolls belong to the
sister company) AND `IDligne_expedition_ETM=0` (not shipped out) AND no `stock_fini` child (not yet
dyed/consumed into a finished roll) — this bounds ~52k historical rows to the ~1.5k live working
set, without which "Tous" would time out hydrating. Status filter = Disponible
(`IDref_commande_affectation=0`) / En teinture (`>0`) / Tous, plus a 2ᵉ-choix toggle.
(`IDligne_expedition_TRM` records TRM→ETM provenance, NOT a stock signal — don't filter on it.)
**Columns**: Référence (ref_ecru), Coloris (colori_ecru), Numéro, Poids (kg), Lot, Magasin
(sous_traitant via IDmagasin), N° Cmd + Client (IDligne_commande_client → ligne_commande_client →
commande_client → client, resolved as flat queries merged in JS), Date saisie, 2ᵉ choix, Visiteur
(free-text column, not an FK), Observations, Défauts (defaut_qualite Type_Reference=2). Provenance
drawer card reuses finis's resolvers — `resolveSstLine`/`resolveProvenanceFils` are now **exported**
from `stock-fini.ts` — via `GET /api/stock/ecru/:id/provenance` → Fils (ref_fil · fournisseur ·
Commande N°) + Tricotage (knitter · Commande N°); no ennoblissement row (dyeing is the écru's
destination, not its origin). **Permissions** (`permission-keys.ts`, category Tombé Métier):
`create_stock_ecru` (Nouveau), `cut_stock_ecru` (Couper), and `edit_stock_ecru` "Édition rouleau(x)"
— the edit permission gates the drawer "Modifier" AND the "Édition groupée" batch button, plus the
backend `PATCH /ecru/:id` and `PATCH /ecru/batch` (401/403, effective admins bypass); the top-right
edit-mode "Modifier" shows only when the user can edit OR cut. HFSQL footguns honoured throughout:
accent-safe reads (batched `repairAliased`/`fixEncoding`), writes via `sqlText()` (Latin-1 hex), no
CONVERT-in-JOIN, integer-only `IN` lists, empty text → `''` not NULL, and every named column
verified to exist (no bridge-storm risk).

## 2026-06-23 — feat/rapport
Rapports › Commandes sous-traitants — added a column-picker dialog to the Excel export on the
table-centric `apps/web/src/pages/RapportCommandesSst.tsx` report (no API change). Clicking
"Exporter Excel" now opens a modal (`mps_designer §18.A` basic-form Dialog: gold `Columns3`
title icon, "Colonnes à exporter") instead of exporting immediately. The 18 export columns were
extracted into a single `EXPORT_COLUMNS` catalog (stable `key`, label, value getter, Excel
`wch` width); the export builds headers/rows/widths from whichever columns are selected, always
in canonical order regardless of click order. The modal lists each column as a plain checkbox
(multi-select, per `§35.4`) with a live count and "Tout sélectionner / Tout désélectionner"
shortcuts, plus Annuler + a primary Exporter button (spinner while writing, disabled when no
column is selected). The selection is persisted to `localStorage`
(`mps:rapport-sst:export-columns`) on a successful export and restored on load — since user
identity is station-based, per-browser localStorage is effectively per-user. The loader is
defensive: drops unknown keys, preserves canonical order, and falls back to "all columns" on
missing/corrupt data or privacy-mode errors. Export still operates on the currently visible
(search-filtered + sorted) rows; quantity FP-noise rounding (`qty1`) was hoisted to module scope
and reused.

## 2026-06-23 — feat/stock-fini
Finis › Stock — enrichment pass on the existing table-centric stock_fini screen
(`apps/web/src/pages/FinisStock.tsx` + `apps/api/src/routes/stock-fini.ts`). Five changes:
(1) **New `edit_stock_fini` permission** — appended to `permission-keys.ts` (category Finis),
gates the `PATCH /api/stock/fini/:id` route (401/403 like `create_stock_fini`) and hides the
detail-drawer "Modifier" button via `useHasPermission`; effective admins bypass. (2) **État is
now read-only** in the detail drawer — the Statut `<select>` was removed (always renders the
read-only pill); dropped the now-dead `editEtat` state, the `etats` lookup in the drawer, and
`IDetat_stock_fini` from the PATCH payload + dirty-check (table-level "Édition groupée" batch
still edits emplacement/observations, unaffected). (3) **Drawer header + provenance rework** —
the bold title is now the roll number (`numero`, e.g. 3465/99); ref/coloris/lot moved to the
subtitle. New read-only endpoint `GET /api/stock/fini/:id/provenance` traces the origin chain:
stock_fini.IDstock_ecru → stock_ecru.IDref_commande_source (tricoteur sst line) → its
`asso_fil_lignecmdsst` yarn lots → stock_fil → ref_fil (designation) + fournisseur + commande_fil
(order N°); stock_fini.IDref_commande_source = the dyeing (ennoblisseur) sst line. The Provenance
card lists each fil (designation · supplier · Commande N°), the Tricotage origin (knitter ·
Commande N°), and the Ennoblissement origin (dyer · Commande N°, hidden when same commande as
tricotage). Removed the "Rouleau écru source" field; renamed "Date saisie" → "Date réception";
replaced `#` id prefixes with `N°`. (4) **Legacy columns restored on the table** — added
Contexture (ref_fini → ref_ecru → contexture.nom), Grammage (ref_fini.poids_Moy, g/m²), Client
(IDligne_commande_client → commande_client → client.nom) and N° Cmd (commande_client.numero) via a
new batched `enrichListExtras()` helper; columns reordered to mirror the legacy WinDev grid (kept
the app's État column + existing totals footer). Contexture/Client also searchable. (5) **Denser
table** — body text `text-sm`→`text-xs`, cell padding `px-3 py-2`→`px-2 py-1.5`, headers
normal-case (no uppercase/tracking) that wrap at spaces (not mid-word), "N° Cmd" abbreviated to
stay one line. HFSQL footguns honoured throughout: `STOCK_FINI_SELECT`/`JOINS` left untouched
(shared with detail+label endpoints) — all new joins done as batched flat queries + JS merge with
integer-only `IN` lists (no CONVERT-in-JOIN collapse, no bridge-storm risk); accented name columns
(sous_traitant/fournisseur/contexture/client `.nom`, ref_fil.reference) read raw + repaired via
`fixEncoding`, never named in a WHERE.

## 2026-06-23 — feat/rapport (refinements)
Polish pass on Rapports › Commandes sous-traitants (`/rapports/commandes-sst`, screen base
landed earlier same day). Changes: (1) removed the page-title `<h1>` — table-centric screens
take no screen-name heading (identity comes from the nav/submenu tab); codified this in
`mps_designer` §27.1 + §27.7 checklist so it isn't re-added. (2) Dropped the "Actualiser"
button; the report query now uses `staleTime: 0` so it refetches on every mount (each consult)
with `refetchOnWindowFocus: false` to spare the shared HFSQL bridge. (3) Shrank the table body
to `text-[13px]` with tighter cell padding (`px-2.5 py-2`) to fit more rows on screen. (4) Added
an "Exporter Excel" button (top-right of the toolbar) that builds the `.xlsx` client-side via a
lazy `await import('xlsx')` (keeps SheetJS out of the main bundle), exporting the currently
visible (search-filtered + sorted, soldées-toggle-aware) rows across all 18 columns; quantities
rounded to 1 decimal but kept numeric so Excel can sum them. Frontend-only — no API changes.

## 2026-06-23 — feat/suivilot
Qualité › Suivi Lots — new quality-control lot-tracking screen (first real Qualité screen;
the menu's other 3 submenus — Dossiers, Actions, Analyse — remain placeholders). Also adds the
4 Qualité submenus to the sidebar + router (`/qualite/suivi-lots` real, the rest placeholders).
Master-detail screen over the `suivilot` table (one row per (ligne_commande_sous_traitant, lot),
created on reception by `upsertSuivilot()` in commandes-sous-traitant.ts): left list with search +
En cours / Terminé / Tous filter (Terminé = archived via `fin_archivage`); center "Récapitulatif
de la commande" (date commande, N°, référence, coloris via the `avec_teinture` wash/dye rule,
spec banner Laize/Poids/Freinte/Rendement/Stab) + read-only "Pièces du lot" sub-table sourced from
`stock_fini` with per-roll Rdt = metrage/poids and a Moyenne footer; right sidebar tabs Contrôles
(editable SST + Tirelle measurements, observations, emplacement, fin d'archivage) / Documents
(read-only, reuses the commande-sst `ged` endpoints) / Défauts (read-only, `defaut_qualite`
aggregated over the lot's source écrus) / Client. A multi-state état footer pill (En contrôle /
En reprise / Validé / Expédié / Attente, persisted immediately) and a header archive/lock button.
Full Modifier→Enregistrer edit flow wired into the shared unsaved-changes guard. New API route
`apps/api/src/routes/suivi-lots.ts` (`/api/suivi-lots`: list, detail, PUT controls, POST etat,
POST archive, GET defauts). HFSQL footguns honoured: editable columns are all ASCII so writes are
Linux-bridge-safe; the only accented write (`approuvé_qualité`) is gated on `IS_WINDOWS` with
`IDetatLot` carrying validation state on the bridge; accented spec columns read via `SELECT *` +
pickKey; magasin resolved without `alias.*`. Permissions deferred to a later session. Known
flagged-but-deferred: SST "Freinte" shows `freinte_demandée` (no `freinte_sst` column exists); the
legacy Tricotage/Ennoblissement/Visiteur bottom block was not ported (no backing `suivilot`
columns — low-confidence mapping left for follow-up).

## 2026-06-23 — feat/rapport
Rapports › Commandes sous-traitants — new read-only report screen at
`/rapports/commandes-sst`, porting the legacy `FEN_Rapport_commandes_sous_traitants.wdw`
(which is non-decompilable — WinDev stores WLanguage in a proprietary encrypted blob, so the
screen was reconstructed from the production screenshot + the already-migrated ETM
sous-traitant domain model). Also adds the three Rapports submenus (Commandes clients,
Commandes sst, Commandes fils) to the nav + router; clients/fils are placeholders for now.
The screen is a flat, table-centric grid (FilsStock pattern, no master-detail/drawer): one
row per `ligne_commande_sous_traitant`, with Statut, Numéro, Sous-traitant, Référence,
Coloris, Qté commandée/affectée/réceptionnée, Date commande, Délai initial/actuel/client,
Retard, Marge, Client, Relance, Commentaire. Sortable sticky-header columns (17, horizontal
scroll), French search across statut/n°/sous-traitant/réf/coloris/client/commentaire, a "Voir
les commandes soldées" toggle, an "Actualiser" button, and a totalizer (line count + late/
soon counts). Statut renders as polished ETM pills (`LINE_STATUT_META`, friendly labels +
solid colors) from the per-line `sstatut`; rows tint red (late) / amber (soon) per ETM
urgency language (attente_delai anchors on `date_notif`, else on `date_livraison`). Key
column derivations (verified against local HFSQL): **Marge = Délai Client − Délai Actuel in
DAYS** (not €); Délai Actuel = `lcs.date_livraison`, Délai Initial = frozen `lcs.date_delai`;
**Délai Client = `ligne_commande_client.date_livraison`** reached via
`stock_fini.IDref_commande_source` / `stock_ecru.IDref_commande_affectation` →
`IDligne_commande_client` → `commande_client` → `client.nom` (earliest valid lcc per line);
the bell column = `commande_sous_traitant.date_notif` (relance); Qté affectée sums
`stock_ecru.metrage` (ennoblisseur, Ml) or `poids` (tricoteur, Kg), Qté réceptionnée sums
`stock_fini.metrage` (type 2) or produced `stock_ecru.poids` (type 1/0). Backend:
`apps/api/src/routes/rapports.ts` (`GET /commandes-sst?soldees=0|1`) — entirely bulk,
set-based, chunked `IN(...)` queries (CHUNK 400, cap 2000 commandes), bounded query count with
no per-line fan-out (HFSQL bridge-storm safety). The reusable pure sst primitives (esc, n,
dateDigits, addWorkingDays, lineStatutRank, STATUT_* constants, IS_WINDOWS) were extracted to
`apps/api/src/lib/sst-shared.ts` and are now imported by both `rapports.ts` and
`commandes-sous-traitant.ts` (no copy-paste drift). Registered in `index.ts`. Frontend:
`apps/web/src/pages/RapportCommandesSst.tsx`. Permissions deferred (to be added later).

## 2026-06-23 — feat/stock-fini
Finis › Stock — new "Surteinture" (over-dye) multi-select action, porting the legacy
`FEN_Surteinture` window. In edit mode the user selects finished rolls of the **same ref +
coloris** (1 or more) and clicks the Paintbrush button; a wide two-table modal shows the
finished pieces to delete (left, rendered struck-through in muted red) and their source
tombé-de-métier écru rows to modify (right, read-only display of numéro/réf/coloris/poids/
magasin + the auto-generated trace observation). Validating appends
`"<lot> - <ref> - <coloris> a surteindre"` to each linked `stock_ecru.observations` and
deletes the finished `stock_fini` rows, so the écru returns to available stock for a fresh
dyeing cycle with a record of where it came from. The écru's coloris and magasin are left
untouched (no editable fields — earlier iterations had pickers; removed per spec). New
dedicated permission `surteindre_stock_fini` (added to `permission-keys.ts`, auto-surfaces in
Paramètres › Utilisateurs and gates both the button and the API). Backend adds two endpoints
to `stock-fini.ts`: `POST /fini/surteindre/preview` (drives the modal — resolves each roll's
linked écru via `stock_fini.IDstock_ecru`, plus ref_ecru/colori_ecru/magasin/client labels via
flat `IN(...)` queries + `fixEncoding`, never JOIN+CONVERT; builds the trace observation
server-side so preview and write can't drift; flags rolls with no écru as `skipped`) and
`POST /fini/surteindre` (gated; per valid non-shipped roll: appends the trace via `sqlText`,
then deletes the fini). Shares a `loadSurteintFiniRows` helper that reuses the list's
SELECT/JOIN/repair path so coloris labels match. Frontend is `SurteindreDialog` in
`FinisStock.tsx`, following the existing `CutRollDialog`/`BatchEditDialog` pattern; on success
invalidates `['stock-fini']` and exits edit mode.

## 2026-06-23 — feat/stock-ecru
Tombé Métier › Références screen — new master-detail screen for écru (loom-output) knitting-fabric
references (`ref_ecru`), porting the legacy WinDev `FI_Ref_TombéMetier.wdw`. Also adds the two
Tombé Métier submenus (Références + Stock placeholder) to the nav. New API router
`apps/api/src/routes/references-ecru.ts` (`/api/references-ecru`): list (En cours / Archivé filter),
full detail, create, update (auto-stamps `date_maj_ft`), archive/unarchive, deep **duplicate**
(copies composition + coloris + machine grid + liage diagram with id remapping), guarded delete,
plus sub-resource CRUD for composition (`composition_ecru`, base `IDcolori_ecru=0`), coloris
(`colori_ecru`), the per-machine technical grid (`ref_ecru_machine`), and the binding diagram
(`chute_liage` + `schema_liage`), and lookups (contextures, clients, refs-fil, machines, symboles).
New page `apps/web/src/pages/TombeMetierReferences.tsx`: 3-panel `MasterDetailLayout` with header
trio (Imprimer/Email placeholders + Dupliquer + Archiver + gold Modifier), editable Identification /
Composition / Coloris cards, and a 3-tab technical area — **Données Technique** (LFA-tour, pignons,
machine grid with computed Compteur Saisie/Calculé, écarteur/laize/rendement/vitesse/poids,
maille-d'ouverture/ouvert-au-large/sonneter pills, observations), **Obs OF** (read-only
`obs_ref_ecru`), and a paint-style **Schéma de liage** editor (chutes × symbol cells, custom inline
SVG knit glyphs). Full unsaved-changes guard (header draft + per-key sub-form dirty registry) and
ConfirmDialogs. Reverse-engineered formulas (memory `project_tombe_metier_references`):
**Coût/kg** = `ref_ecru.prix` + Σ(`composition_ecru.pourcentage` × `ref_fil.prix_kg`)/100 over the
base composition; **Compteur Saisie** = `round((trs_10kg_chute/nb_chutes) × (poids/20) / 10) × 10`
(Compteur Calculé = 0, needs an OF). HFSQL footguns honoured: `ref_ecru` accented column names
(`archivé`/`diamètre`/`recyclé`) read via `SELECT *`+`pickKey`, written named on Windows / archive via
positional reinsert on Linux; `colori_ecru` explicit columns only; no `IDsociete` on `ref_ecru`;
`client` has no `ville`. Out of scope this pass: permissions, Circulaire/Rectiligne filter,
Print/Email (placeholders), Obs OF editing.

## 2026-06-23 — feat/etude-coloris
Finis › Études coloris — search auto-select fix. The left-list auto-select effect only
fired on first load (gated on `selectedId === null`), so narrowing the list via the search
bar to a single result never selected it — unlike every other master-detail screen. Replaced
it with the canonical pattern (from `FilsCommandes.tsx`): an effect driven off the
search-filtered `filteredEtudes` array that re-selects the first visible row whenever the
current selection drops out of the results, skipped while editing so unsaved changes are never
discarded. Typing e.g. "2012 marin 63403" down to one match now auto-selects it. Also
documented this as a mandatory convention in the `mps_designer` skill's Search Bar section
(canonical effect snippet + the `selectedId === null` anti-pattern to avoid), since the bug was
a missing cross-screen convention rather than a one-off.

## 2026-06-23 — feat/gestion-sst
Sous-traitants/Gestion: tricoteur yarn-lots, ennoblisseur tariff editor, info relayout, shared type chip.
(1) **Tricoteur lots de fil** — new "Lots de fil présents sur le site" table shown for tricoteur
sous-traitants (`IDtype_sst = 1`), mirroring the ennoblisseur rolls table: every `stock_fil` lot with
`IDMagasin = sst AND stock > 0` (ref/coloris/fournisseur/lot/lot frs/stock kg/entrée), searchable +
sortable with a count·total-kg footer. Backed by `GET /api/sous-traitants/:id/rolls`'s sibling
`GET /:id/yarn-lots` (explicit ASCII columns, batched ref_fil/colori_fil/fournisseur label lookups, no
JOIN+CONVERT collapse). (2) **Ennoblisseur tariff editor** — a center-panel segmented toggle
"Rouleaux sur le site | Tarifs" (ennoblisseur only) reveals a two-pane editor over
`tranche_tarif_ennoblissement` (`apps/web/src/pages/sous-traitants/TariffsSection.tsx`): left lists
every dye (4) + treatment (20) + existing combinations; right edits that subject's quantity bands
(min/max/prix €/Kg) with an "au-delà"=999999 toggle, inline add/edit, `ConfirmDialog` deletes, server-side
overlap guard. Full combination support incl. a new-combination dialog (dye context + multi-treatment
checklist) and re-scope; a "Copier" dialog seeds an empty ennoblisseur from another sst or the
`IDsous_traitant=0` default catalog (9 of 12 ennoblisseurs start empty). New endpoints on
`sous-traitants.ts`: GET (grouped catalog), POST band, PUT band, DELETE band, PUT `/combinaison/rescope`,
POST `/copier`. This is the exact table `pricing-sst.ts` reads, so edits flow into auto-pricing of NEW
order lines (existing lines not retro-repriced; matches legacy). Confirmed: table is 8 ASCII columns,
PK auto-increments; combos keyed on `(IDteinture, sorted ListeTraitements)`. (3) **Info relayout** — the
center "Coordonnées" card is gone; Type + Statut moved into the right sidebar's Info tab (a new
"Informations" card above Commentaire); the zombie `tel`/`fax` fields are hidden in the UI but still
round-tripped on save so existing values aren't blanked. Non-ennoblisseur/non-tricoteur types now show a
"info is in the right panel" placeholder instead of a bare card. (4) **Shared type chip** — the
hue-per-type sous-traitant chip (Ennoblisseur=sky, Tricoteur=amber, Confectionneur=teal, Autre=stone)
was extracted from Commandes into `apps/web/src/lib/sst-type.tsx` (`sstTypeTagClasses` + `<SstTypeTag>`)
and adopted in Gestion (list card, header, Info row), replacing the grey secondary Badge; documented as
mps_designer §36.

## 2026-06-22 — feat/gestion-sst
Sous-traitants/Gestion screen enhancements. (1) Left-list status filter: a 3-way
segmented control (Actifs / Inactifs / Tous, default Actifs) under the search field,
filtering on `est_visible`; the auto-select-first effect now reads the filtered list.
The "Inactif" tag moved to the top-right corner of each list card as a red destructive
badge. (2) New "Rouleaux présents sur le site" table shown only for ennoblisseur
sous-traitants (`IDtype_sst = 2`): lists every fabric roll physically located at that
subcontractor — "tombé métier" (écru) rolls awaiting dyeing + finished (fini) rolls not
yet shipped back — in one unified, searchable, sortable table with a Tous/Tombé
métier/Finis filter and a count + total-kg footer. Backed by a new
`GET /api/sous-traitants/:id/rolls` endpoint: location resolved via
`stock_ecru.IDmagasin` / `stock_fini.IDmagasin` → `sous_traitant.IDsous_traitant`
(updated on physical transfer); écru already dyed into a fini are dropped to avoid
double-counting; fini already shipped (IDligne_expedition set or état 4) are hidden;
fini coloris obeys the `ref_fini.avec_teinture` rule by reusing the now-exported
`repairAliased`/`repairAllJoins` helpers from `stock-fini.ts`. The fini "État" renders
as the same pill tag used in Finis/Stock — its colour logic was extracted to the shared
`lib/etat-stock-fini.ts` and now maps "Validé" (and Disponible/Prêt) to green in both
screens. Also: documented the canonical left-list filter-button group pattern in the
mps_designer skill.

## 2026-06-22 — feat/stock-fini
Finis › Stock enhancements. (1) **Dymo étiquette printing**: a new white icon-only Printer button in the roll drawer header (view mode, left of "Modifier") opens an 89×36 mm label PDF in a new tab to print to the Dymo. New `StockFiniLabelPdf.tsx` (@react-pdf/renderer, built-in Helvetica, rotated `logo-malterre.png` band + N°/Réf./Col./Poids/Métrage/Lot lines, reproducing legacy `ETAT_Etiquette_SP.wde` from a physical sample) and a read-only `GET /api/stock/fini/:id/label` endpoint reusing the detail route's SELECT/JOINs/repair. (2) **Édition groupée**: a Pencil icon button appears in the edit-mode toolbar when >1 roll is selected, opening a modal to batch-set `emplacement` and/or `observations` (each gated by a toggle so one field can be set without wiping the other) across all selected rolls via a new `PATCH /api/stock/fini/batch` endpoint (accented-safe `sqlText()`, registered before `/fini/:id`). (3) **Shift-click range deselect**: shift-clicking an already-selected row now removes the inclusive range, not just adds. (4) **Performance**: stabilized `handleClose`/`handleRowClick` on `guard.guardAction` (was `[guard]`, a fresh object each render that busted the `StockRow` memo); removed `isEditing` from per-row props so the edit-mode toggle re-renders zero rows (view↔edit presentation now CSS-driven via `data-editing` on `<tbody className="group">` + `group-data-` variants, click unified into one stable `onRowClick` reading an `isEditingRef`); cached one `Intl.Collator` for sorting; `useDeferredValue` on the search term. Eliminates the ~1s edit-mode lag and the general re-render thrash on a ~1.4k-row table.

## 2026-06-22 — feat/ref-fini
Finis › Références screen (`/finis/references`) — the technical datasheet (fiche technique) for finished-fabric references (`ref_fini`, 43 cols). New `apps/web/src/pages/FinisReferences.tsx` (master-detail mirroring `FilsReferences`) + `apps/api/src/routes/references-fini.ts` (mounted `/api/references-fini`), replacing the router placeholder. Full CRUD on the ASCII datasheet fields (designation, conditionnement, rendement, freinte, temp. lavage, poids/laize HT/laize utile min·moy·max, stability & elongation, SST control flags, observations/technique/commercial, responsable, en_developpement) plus an écru picker (`IDref_ecru`). Coloris (polymorphic by `avec_teinture`: dye→`ref_fini_colori` / wash→`colori_ecru`), traitements (`traitement_ref_fini`) and stock aggregate (`stock_fini`) are READ-ONLY; `avec_teinture`/`archivé`/`catalogue_privé`/dates are read-only (structural / accented-write-unsafe). Archived refs filtered out of the list in JS. Notable HFSQL footguns handled: `ref_fini` accented column NAMES (`dateCréation`/`archivé`/`catalogue_privé`) resolved by prefix regex, never named in SQL; `SELECT *` FAILS on `ref_fini_colori`/`colori_ecru` so those are read with explicit columns only; list accent-repair is batched (one `CONVERT … WHERE id IN (…)` per column) to avoid the Linux-bridge N+1 storm. Verified: web tsc + vite build clean, full CRUD round-trip over HTTP, accented write/read round-trips exactly at the DB layer.
## 2026-07-22 — feat/profile-cache-fix
Hotfix — **"Mon profil" showed the previous user's email signature on shared PCs.**
The `user-profile-me` / `user-email-me` React Query keys were static; within the
global 5-min staleTime a user switch served the prior user's cached profile
(signature, header avatar photo, SendEmailDialog signature preview). Keys are now
scoped by `IDutilisateur` in Header, ProfileModal and SendEmailDialog. The
prefix-matching `invalidateQueries` calls in SettingsUtilisateurs are unaffected.
