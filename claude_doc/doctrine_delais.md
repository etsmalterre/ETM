# Doctrine des délais

> Décidée avec Vincent le 2026-10-27. **Codé à ce jour : la date de lancement saisie à la main** (§5, 2026-10-28, `apps/api/src/lib/lancement-ligne.ts`) la date unique par ligne avec son engagement (§5 bis, même jour) et le statut « En préparation » / « Valider la commande » (§5 ter, 2026-10-29) ; le reste fixe les règles avant le moteur. Ce fichier est la **source unique** de la doctrine, réglages compris (standards, plafond, réserve). **Révision 2026-10-29** : pas de marge à l'ennoblisseur, réserve 1,5 semaine, marge au tricoteur d'abord (§4). La console Administration (`admin.intra.etsmalterre.com`, section Doctrines) l'affiche en lecture seule pour la direction, embarqué à la compilation : toute modification passe par ce fichier, puis par un déploiement de la console. Les mesures citées viennent de `mps_dev` (méthode en fin de document).

## Pourquoi

Pierrot quitte l'entreprise vers le 26/11/2026 et n'est pas remplacé : plus personne ne décidera « à la main » quand lancer une commande fil, tricotage ou ennoblissement, ni quelle date demander. Aujourd'hui ces dates ne sont écrites nulle part : Pierrot passe toutes les commandes en revue deux fois par semaine. Cas d'origine : la commande Thuasne 3923 (ligne 13360, 1732 / Blanc, 330 Ml, délai 08/01/2027), en attente sans date visible. Elle n'était pas oubliée : Pierrot l'aurait lancée chez MATEL vers le 16/11, en comptant ~4 semaines, Noël, et pour grouper le coloris avec une commande qui arriverait entre-temps (mail du 2026-10-28).

Malterre est un intermédiaire qui met en mouvement filateurs et sous-traitants. Une date doit rester **crédible** : un teinturier à qui l'on demande son délai standard et qui stocke ensuite la matière dix semaines finira par penser que nos dates sont fausses. Et la marge a une valeur pour Malterre : tant que la matière attend en écru, une commande arrivée entre-temps peut grossir la passe d'ennoblissement (moins chère au kilo) ou prendre l'écru.

## 1. Unité : le jour ouvré du partenaire

- Tous les délais se comptent en **jours ouvrés propres à chaque partenaire** : sans les week-ends, les jours fériés ni ses périodes de fermeture.
- Les gens ne voient jamais de « jours ouvrés » : les écrans et les commandes affichent des **dates** (et des semaines).
- Raison : compté en calendaire, le délai MATEL d'une commande passée en juillet vaut 53 jours (médiane) contre 22 sur l'année ; en jours ouvrés, fermeture d'août retirée, il vaut 18 contre 15. Avec les fermetures dans le calendrier, une commande de juillet enjambe août toute seule, sans règle spéciale.
- Chaque partenaire a donc un **calendrier de fermetures** (une à deux lignes par an).

## 2. Les standards

Le standard est le délai que l'on demande à un partenaire quand il n'y a aucune marge. C'est un **objectif** décidé, appuyé sur la mesure : autour de la médiane, jamais au p80 (le p80 annoncerait des délais trop longs, et une marge donnée finit consommée).

| Partenaire | Standard | Mesure (jours ouvrés, médiane / p80) |
|---|---|---|
| Ennoblisseur (MATEL, Bontemps, TAD) | **3 semaines ouvrées** (15 j) | MATEL 15 / 22 (1 455 lignes) ; Bontemps ~10 jours calendaires |
| Tricoteur (Tricotage Malterre), ≤ 500 kg | **1 semaine ouvrée** | < 200 kg 2 / 5 ; 200 à 500 kg 5 / 9 |
| Tricoteur, 500 kg à 1 t | **2 semaines ouvrées** | 7 / 11 |
| Tricoteur, > 1 t | **3 semaines ouvrées** | 13 / 19 |
| Filateur | pas de standard fixe : voir §3 | voir §3 |

- **L'ennoblissement ne dépend presque pas de la quantité** (MATEL : 21 à 26 jours calendaires jusqu'à 1 t, 31 au-delà) : son délai est sa file d'attente, d'où un standard unique.
- **Le tricotage en dépend fortement** (temps machine), d'où trois tranches.

## 3. Le filateur : une date de consultation, jamais de marge

Les filateurs sont des grossistes internationaux, pas des ateliers : leur donner de la marge pour lisser leur charge n'a pas de sens.

1. Quand une ligne client a besoin d'un fil à acheter, l'étape fil reçoit une **date de consultation**, calculée à rebours depuis le délai client (§4) avec, pour le filateur, un **délai estimé avec sécurité** : le **p80 mesuré** de la référence fil, puisqu'on ne sait pas encore quel fournisseur sera retenu (`lib/fil-appro.ts` mesure déjà le délai par coloris).
2. À cette date, on **consulte les filateurs** (prix et délai), on choisit, on commande.
3. On **enregistre le délai annoncé** : c'est la date promise de la ligne de commande fil (`ref_fil_commande.date_livraison`, déjà en place). Il faudra un champ délai sur les offres fil, pour comparer les réponses d'une consultation.
4. Le délai annoncé remplace l'estimation, et la marge restante se jalonne entre tricoteur et ennoblisseur (§4).

- **La date de consultation est une limite, pas une interdiction** : on peut acheter plus tôt, par exemple quand le cours de la matière est avantageux. Le fil attend alors en stock, réservé à la ligne (`reservation_fil`), et les plafonds du §4 repoussent la date de lancement du tricotage.
- **Fil déjà en stock** (stock TRM d'abord) : il n'y a pas d'étape filateur, la première date de lancement porte sur le tricotage.
- Mesures (premier lot reçu, jours calendaires, commandes 2023-01 à 2026-08) : Weber & Heusseur 10 / 15 (117 commandes, 84 % à l'heure), Trifitrofa 17 / 28, Mundifios 16 / 29, Margitex 28 / 32. Les filateurs livrent presque tous en moins de 4 semaines et à peu près à la date promise. Une limite « 4 semaines » pour les filateurs est un **indicateur de qualité fournisseur**, pas une règle de planning.

## 4. Le jalonnement

> Révisé avec Vincent le 2026-10-29 : **plus aucune marge à l'ennoblisseur** (il reçoit toujours son standard), la réserve Malterre est fixée à **1,5 semaine ouvrée**, et le tricoteur reçoit la marge en premier.

**La marge** d'une ligne = date retenue − délai au plus tôt de la ligne (§5 ter) : ce qu'il reste une fois comptés les standards restants (§2), les fermetures (§1), le transport et la réserve Malterre.

- **La réserve Malterre : 1,5 semaine ouvrée, fixe**, placée en fin de chaîne avant la livraison client, une seule pour toute la chaîne (les avances et les retards des étapes se compensent). Elle n'est jamais distribuée.
- **Ordre de répartition de la marge** :
  1. **le tricoteur reçoit jusqu'à 4 semaines ouvrées** en plus de son standard (plafond : au-delà, une commande reste dans ses systèmes et se fait oublier ; en deçà, il a de quoi lisser la charge de son atelier) ;
  2. **le reste devient la date de lancement de l'ennoblissement** (§5) : le tombé de métier attend en stock chez nous, réservé à la ligne, jusqu'à cette date. **L'ennoblisseur reçoit toujours son standard seul**, jamais de marge : sa date est sa file d'attente (§2), une date lointaine ne l'aiderait pas et l'écru se réaffecte facilement tant qu'il n'est pas teint (§5).
- Jamais de marge au filateur (§3).
- **On rejalonne à chaque lancement** : quand une étape part, on recalcule la marge restante ; ce qu'une étape amont gagne (le tricoteur rend l'écru en avance) allonge l'attente de l'écru avant l'ennoblissement, jamais le délai de l'ennoblisseur.
- **Une étape amont en retard** : l'ennoblisseur garde son standard ; la réserve Malterre absorbe, puis la ligne passe en « délai intenable » (§7.4).
- **La date client est la date convenue**, sans avance par client. Un client qui demande sa matière plus tôt que la date qu'il a fixée (Thuasne le fait souvent d'1 ou 2 semaines) n'est pas un cas à structurer : on lui explique que la matière n'est garantie qu'à la date convenue, à lui de demander la bonne date.

**Marge nulle ou négative** : on demande les standards seuls, et la ligne est signalée (« délai intenable », §7.4).

### Exemple

Ligne fini de 400 kg, fil à acheter, livrée en une fois le D, soit dans 18 semaines ouvrées. Fil estimé 4 semaines (p80), transport 1 semaine.

- Délai au plus tôt : fil 4 + tricotage 1 + ennoblissement 3 + transport 1 + réserve 1,5 = 10,5 semaines. Marge = 7,5.
- Le tricoteur prend 4 semaines (plafond) : il tricote en 1 + 4 = 5 semaines.
- Reste 3,5 semaines : l'écru attend chez nous, **date de lancement de l'ennoblissement** = fin du tricotage + 3,5 semaines ; l'ennoblisseur reçoit ensuite ses 3 semaines standard.
- Si le tricoteur rend l'écru en 2 semaines au lieu de 5, l'écru attend 3 semaines de plus en stock : la date de lancement de l'ennoblissement ne bouge pas.

## 5. Les dates de lancement : un seul mécanisme d'attente

Une ligne porte une **date de lancement de sa prochaine étape**, quel que soit son avancement (commander le fil, lancer le tricotage, envoyer chez l'ennoblisseur). C'est le seul mécanisme d'attente : pas d'état « en attente » par stade.

- **Codé (2026-10-28)** : `ligne_commande_client.date_lancement`, saisie à la main sur la carte de ligne avec motif et historique (`lancement_ligne_client`), lue par `urgenceLigne()` sur une ligne « à lancer » seulement. Le calcul « au plus tard » écrira la même colonne.
- **Avant la date** : la ligne est **neutre** (personne n'a rien à faire). **À la date** : elle devient **rouge**, une action Malterre à faire maintenant. C'est exactement la règle des couleurs (`mps_designer §41`).
- **Date calculée par la doctrine** (« au plus tard ») : agir plus tôt reste libre.
- **Mise en attente manuelle** (« pas avant », **avec un motif**) : client qui demande d'attendre, coloris en attente de validation, risque d'annulation sur un coloris propre au client, « ne pas commencer avant X » demandé par l'ennoblisseur. Elle prend le pas sur le calcul, reste dans l'historique (comme les « Repousser » d'Attente délai), et l'écran signale une action faite avant elle.
- **Où la matière attend** : au stade **écru** (le plus souple : 40 % de l'écru tricoté pour une ligne finit sur une autre, 7,5 % chez un autre client ; presque jamais une fois teint), puisque l'ennoblisseur n'a pas de marge (§4), ou au stade **fil** (ne se périme pas, se réaffecte).
- **Groupage à la date de lancement de l'ennoblissement** : quand une ligne arrive à sa date, l'écran propose les autres lignes de même réf. fini et même coloris dont la date de lancement tombe dans les **4 semaines** suivantes, à lancer dans la même passe, plus un complément pour le stock sur les coloris de gamme (blanc, noir, écru), comme le faisait Pierrot. La passe plus grosse coûte moins cher au kilo (tarif par tranche de poids) et évite de relancer le même coloris quelques semaines plus tard. Lancer une ligne en avance dans un groupage reste libre (« au plus tard », ci-dessus).
- **Affectation souple** : réserver tôt de la matière (fil, écru, fini) à une ligne lointaine ne la gèle pas. Une ligne dont la date de lancement est plus proche peut la reprendre ; la ligne lointaine retrouve alors un besoin à couvrir. On peut donc affecter dès que la matière est là, sans craindre la commande qui arrivera entre-temps (Pierrot n'affectait pas tôt pour cette raison). Un écru vraiment disputé entre deux clients reste rare (~2 % des lignes, 20 sur 962, en hausse : 4 / 5 / 11 en 2024 / 25 / 26) : la ligne la plus proche passe d'abord, le seul arbitrage humain qui reste.

## 5 bis. Une date par ligne, et l'engagement

Décidé avec Vincent le 2026-10-28, **codé le même jour** (migration 0041, `lib/urgence-commande-client.ts`, `lib/report-ligne-client.ts`).

- **Une seule date par ligne, « Prête le » D** (`ligne_commande_client.date_livraison`) : la ligne est prête à expédier le D. Le libellé ne change jamais ; la production vise toujours D, la marge est la réserve Malterre (§7.3), jamais une seconde date.
- **Le départ est celui de CHAQUE LIGNE** (révisé avec Vincent le 2026-10-30, migration 0050 ; l'essai du 2026-10-28 « un départ pour toute la commande » est abandonné) : dans la fenêtre de la ligne, « Départ » = **Dès que prête** (par défaut) ou **Sur appel du client** (`ligne_commande_client.mode_livraison` 0 / 2, `departLigne()` dans `lib/mode-expedition.ts`).

| Départ (ligne) | Ce qui suit « prête » | Couleur une fois prête |
|---|---|---|
| Dès que prête | expédier tout de suite, au plus tard à D | ambre en avance, rouge près de D |
| Sur appel du client | attendre l'appel | relance 120 j après D (ou le délai du client) |

- **La commande ne dit qu'une chose** (Info › Expédition) : **« Expédier toutes les lignes ensemble »** (`expedition_groupee`). Cochée, on choisit UNE date, jamais avant la plus tardive des dates au plus tôt des lignes, écrite sur toutes les lignes restantes (`PUT …/lignes-date`, un seul motif de report si la commande est validée) ; une ligne prête attend les autres. Décochée, les dates restent (ce sont des engagements). Une ligne ajoutée prend la date commune ; si elle ne peut pas la tenir, on repousse la date de toutes. « À la date demandée par le client » n'existe plus : c'est cette date commune.
- Une phrase par ligne : « Expédiée dès que prête » / « Sur appel du client », + « avec toutes les lignes le 22/03 » ; la commande : « Toutes les lignes ensemble, le 22/03 ».
- Pas prête et D passée : rouge, quel que soit le départ. Une ligne sans D : rouge, la donner.
- `date_expedition_prevue` (ligne) et le départ de la commande (`commande_client.mode_expedition`) ne sont plus lus.
- **L'engagement** : la D d'une ligne devient un engagement **à la validation de la commande** (§5 ter) — copiée dans `delai_annonce`, jamais modifiée, jamais rétro-remplie. **Déplacer D ensuite est un report** : motif et imputable obligatoires (Malterre / client / partenaire), journal append-only `report_ligne_client`. Un client qui déplace sa date ne compte pas contre nous. Avant la validation, D bouge librement.
- **Qualité de service** (à construire sur ce journal) : engagement contre date réelle d'expédition (dès que prête, date convenue) ou **date où la ligne est devenue prête** (sur appel, commande complète).

## 5 ter. Préparer une commande, puis la valider

Décidé avec Vincent le 2026-10-28 (déroulé, statut, calcul, ajustement) ; le statut et la validation sont codés le 2026-10-29 (migration 0045, `lib/preparation-commande.ts`), le calcul au plus tôt le même jour (`lib/delai-au-plus-tot.ts`, jours ouvrés `lib/jours-ouvres.ts`) ; l'ajustement (date retenue, « livrer en une fois ») vient ensuite.

Une date est **le résultat d'un calcul, puis d'une décision** ; elle ne devient un engagement qu'une fois donnée au client. D'où le déroulé d'une commande :

1. **Saisir les lignes** (référence, coloris, quantité, prix, commentaire).
2. **Réserver la matière** (onglets de la ligne).
3. **Délai au plus tôt de chaque ligne**, calculé en continu, sans bouton : de l'étape où est la matière réservée (fini en stock → prête ; écru → ennoblissement ; fil en stock → tricotage + ennoblissement ; rien → achat du fil + tricotage + ennoblissement), plus le standard de chaque partenaire restant (§2, réglé par sous-traitant dans Sous-traitants › Gestion, défauts de ce paragraphe), ses fermetures (§1), puis la réserve Malterre (§7.3, fixe). Fil : p80 mesuré de la référence (§3), puis la date annoncée par le fournisseur.
4. **Ajuster**, trois façons, jamais sous le minimum (sinon « délai intenable », §7.4) : ne rien faire (chaque ligne prête à son minimum, partie dès que prête) ; chaque ligne à sa date (≥ son minimum, pour coller au bon de commande du client) ; toutes ensemble à la plus lointaine des dates au plus tôt (ou plus tard). La marge (date retenue − minimum) se répartit ensuite par les dates de lancement (§4, §5).

- **Statut « En préparation »** : une commande naît ainsi (création, devis transformé). Édition entièrement libre, pas d'assistant ni de liste de contrôle (Vincent : rester simple). **Rouge dès sa création** (« commande à préparer ») : il y a quelque chose à faire chez Malterre, maintenant. Bloqué tant qu'elle y est : commandes aux partenaires, « Planifier », envoi de la confirmation, expéditions, espace client.
- **Le calcul codé (v1, 2026-10-29)** : la quantité de la ligne est répartie en cascade sur la matière réservée, la plus avancée d'abord (rouleaux finis → prête ; pièces écru → ennoblissement ; écru encore à tricoter → tricotage + ennoblissement ; fil réservé → à partir de la date du fournisseur la plus tardive, ou aujourd'hui s'il est en stock, puis tricotage + ennoblissement ; le reste → fil estimé à 20 jours ouvrés, puis tricotage + ennoblissement). La date = la portion la plus lente + la réserve Malterre (seulement s'il reste une étape partenaire). Jours ouvrés de chaque partenaire : week-ends, fériés français et ses fermetures. Partenaires v1 : Tricotage Malterre et MATEL ; la tranche du tricoteur se lit sur les kg encore à tricoter de la ligne (conversion inconnue → la plus longue). Une ligne écru n'a pas d'ennoblissement. À venir : le fil mesuré par référence (p80, §3), les partenaires réels de la ligne.
- **Affichage** : la carte d'une ligne sans date montre « Prête au plus tôt le … » (bulle : les étapes, et « Réservez de la matière pour améliorer ce délai » quand une part n'a rien de réservé), neutre en préparation, rouge une fois validée. En préparation, la fenêtre de ligne (création comme modification) affiche le délai au plus tôt, recalculé à chaque changement de référence, coloris, unité ou quantité (`GET /commandes-client/lookups/au-plus-tot`), **jamais enregistré** : il suit les réservations jusqu'à la validation. « Choisir une autre date » ouvre un champ qui part du délai au plus tôt et montre la marge en jours ouvrés ; seule une date choisie est enregistrée. Une date avant le délai au plus tôt est refusée en préparation (409 `delai_intenable`, aussi pour « toutes les lignes » d'Info › Expédition). Sur une commande validée, « Prête le » reste (report) et signale une date avant le délai au plus tôt.
- **La doctrine propose, l'opérateur décide** (Vincent, 2026-10-29) : rien n'est planifié automatiquement. À la préparation il n'y a pas encore de commande au tricoteur où écrire sa part de marge, un plan écrit d'avance périmerait (fil en retard, écru réaffecté) et l'opérateur doit pouvoir faire autrement. La doctrine (1) **calcule son plan** dès qu'une date retenue dépasse le délai au plus tôt : délai à demander au tricoteur (standard + sa part, plafonnée à 20 j), écru en stock chez nous, date d'ennoblissement (`planDoctrine()` dans `lib/delai-au-plus-tot.ts`, codé) ; la bulle de la date n'en montre que la ligne « Marge N j » (Vincent : rester simple, le plan se lit là où il s'applique) ; (2) **pré-remplit** (codé 2026-10-29) : la fenêtre « Tricoter chez … » propose la **date demandée au tricoteur** (son standard + sa part de marge, depuis aujourd'hui dans son calendrier, `tricotageDemande`), écrite dans `ligne_commande_sous_traitant.date_demandee` (migration 0048), jamais dans `date_livraison` : **le tricoteur confirme toujours son délai** (« Attente délai », relances et qualité de service inchangées, Vincent) ; elle s'affiche sur la ligne sst (« demandée : … ») et sur le bon de commande (« Date souhaitée » tant qu'aucun délai n'est donné) ; « Planifier » de l'onglet Ennoblissement s'ouvre sur la date d'ennoblissement du plan quand de la marge reste à l'écru en stock ; (3) **décidera de la couleur** : une ligne « à lancer » neutre jusqu'à la date où il faut lancer au plus tard pour tenir la date retenue (à venir, touche la règle rouge / ambre).
- **« Valider la commande »**, le seul passage : une ligne sans date prend son délai au plus tôt ; les dates deviennent les engagements (`delai_annonce`), tout changement ensuite est un report ; la confirmation peut partir. Les commandes antérieures sont validées.
- **« Repasser en préparation »** : seulement tant que rien n'est lancé chez un partenaire ni expédié ; les engagements déjà donnés restent.
- Ce que montrent les bons de commande clients (contact@, sept.-oct. 2026) : une date par ligne, de réception chez le client ou de départ usine selon le client ; certains refusent d'être livrés en avance (Le Slip Français, Agape) ; un client déplace lui-même sa date (Sigvaris).

## 6. Écarté, et pourquoi

- **Dates calculées à rebours sans plafond** : toute la marge partait au tricoteur. Le plafond de 4 semaines reste ; l'ennoblisseur n'a que son standard, désormais par décision (§4).
- **Partager la marge moitié tricoteur, moitié ennoblisseur** (première version de la doctrine, 2026-10-27) : abandonné le 2026-10-29. Une date lointaine n'aide pas l'ennoblisseur (sa date est sa file d'attente), et l'écru gardé chez nous reste réaffectable.
- **Une avance par client** (Thuasne demande souvent sa matière 1 ou 2 semaines avant la date convenue) : on en parle au client plutôt que de grossir les marges de tout le monde.
- **Dates « standard seulement » envoyées au plus tôt** : l'ennoblisseur reçoit l'écru des semaines avant d'en avoir besoin, le stocke, et ne croit plus nos dates.
- **Une limite de délai par type de matière pour les filateurs** : c'est le fournisseur et la référence qui font le délai, pas la matière.
- **Le p80 comme standard** : délais trop longs, marge consommée ; la sécurité est la réserve Malterre, une seule, en fin de chaîne.

## 7. Points ouverts

1. **Transport et contrôle** entre les étapes : pas encore mesurés.
2. **Les vraies dates de fermeture** de MATEL, Bontemps, TAD et TRM (saisies dans Sous-traitants › Gestion › Info › Fermetures depuis le 2026-10-29 ; comptées dans le calcul au plus tôt et dans la qualité de service). Celles des mesures sont **déduites des trous dans nos réceptions**, qui mêlent la fermeture du partenaire et celle de Malterre (MATEL : fin juillet ou début août à fin août, ~2 semaines à Noël ; TRM : ~3 semaines en août, ~1,5 à Noël).
3. **La réserve Malterre** : fixée à 1,5 semaine ouvrée le 2026-10-29 (l'écart médiane → p80 de MATEL vaut ~7 jours ouvrés), à revoir à l'usage.
4. **Le signalement « délai intenable »** : date de fin au plus tôt (aujourd'hui + standards restants depuis l'étape où en est la ligne) postérieure au délai client. À part des couleurs rouge / ambre, qui gardent leur sens d'action Malterre tant que tout n'est pas automatisé.
5. **Le champ délai sur les offres fil** (§3).
6. **La fenêtre de groupage** (4 semaines) et la liste des coloris de gamme : à confirmer à l'usage ; mesurer l'écart de prix au kilo entre tranches MATEL et la part des passes qui servent plusieurs lignes.
7. **Plus tard** : qualité de service des ennoblisseurs (part des commandes livrées dans les 3 semaines, devenue une exigence puisqu'elles n'ont plus de marge), aide à l'achat de fil au bon cours (historique des prix des offres), points à caler avec MATEL avant de lui envoyer des dates (date confirmée distincte de la nôtre, « ne pas commencer avant X »).

## Méthode des mesures

Base `mps_dev`, le 2026-10-27.

- **Sous-traitance** : lignes de commande sous-traitant commandées du 2024-01-01 au 2026-08-31 ; délai = date de commande → date où 90 % du poids produit par la ligne est saisi (`stock_fini.idref_commande_source` pour l'ennoblissement, `stock_ecru.idref_commande_source` pour le tricotage).
- **Fil** : première ligne de chaque commande fil (`commande_fil` du 2023-01-01 au 2026-08-31), date de commande → premier lot reçu (`stock_fil.date_entree`) ; « à l'heure » = reçu au plus 3 jours après la date promise (règle de `lib/fil-appro.ts`).
- **Jours ouvrés** : sans samedi, dimanche, jours fériés français, ni les fermetures déduites des périodes de 8 jours ou plus sans réception chez le partenaire.
