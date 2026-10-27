# Doctrine des délais

> Décidée avec Vincent le 2026-10-27. **Rien n'est codé** : ce document fixe les règles avant le moteur. Elle sera la première page de la section Doctrines de la console Administration (`admin.intra.etsmalterre.com`), où ses réglages (standards, plafond, réserve) deviendront modifiables. Les mesures citées viennent de `mps_dev` (méthode en fin de document).

## Pourquoi

Pierrot quitte l'entreprise vers le 26/11/2026 et n'est pas remplacé : plus personne ne décidera « à la main » quand lancer une commande fil, tricotage ou ennoblissement, ni quelle date demander. Cas d'origine : la commande Thuasne 3923 (ligne 13360, 1732 / Blanc, 330 Ml, délai 08/01/2027), tout simplement jamais lancée.

Malterre est un intermédiaire qui met en mouvement filateurs et sous-traitants. Attendre avant de lancer ne fait que cacher l'échéance : elle vaut plus donnée aux partenaires, qui peuvent alors organiser leur charge. Mais une date doit rester **crédible** : un teinturier à qui l'on demande son délai standard et qui stocke ensuite la matière dix semaines finira par penser que nos dates sont fausses.

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

**La marge** d'une ligne = délai client − aujourd'hui − somme des standards restants − transport et contrôle − réserve Malterre.

- **Plafond : 4 semaines ouvrées de marge par partenaire** (tricoteur, ennoblisseur), en plus de son standard. Au-delà, une commande reste dans les systèmes et se fait oublier ; en deçà, le partenaire a de quoi lisser la charge de son atelier.
- **Partage** : la marge va au tricoteur et à l'ennoblisseur, moitié chacun, chacun dans la limite de son plafond. Jamais au filateur.
- **On rejalonne à chaque lancement** : quand une étape part, sa date souhaitée = son standard + sa part de la marge restante à ce moment-là. Ce qu'une étape amont gagne profite à l'aval, dans la limite du plafond.
- **Une étape amont en retard** : l'aval garde au moins son standard ; c'est la réserve Malterre qui absorbe.
- **La marge au-delà des plafonds devient une date de lancement** (§5) : la prochaine étape ne part pas avant.
- **La réserve Malterre** est placée en fin de chaîne, avant la livraison client, et une seule pour toute la chaîne (les avances et les retards des étapes se compensent). Elle se dimensionne sur la variabilité des partenaires, l'écart médiane → p80 : ~7 jours ouvrés pour MATEL. Le standard tricoteur est déjà proche de son p80, il n'y ajoute presque rien.

**Marge nulle ou négative** : on demande les standards seuls, et la ligne est signalée dès la saisie (orange ou rouge, à développer plus tard : c'est l'avertissement « délai intenable », §6).

### Exemple

Ligne fini de 400 kg, fil à acheter, délai client dans 20 semaines ouvrées. Hypothèses : fil estimé 4 semaines (p80), transport et contrôle 1 semaine, réserve 1,5 semaine.

- Standards : fil 4 + tricotage 1 + ennoblissement 3 + transport 1 + réserve 1,5 = 10,5 semaines. Marge = 9,5.
- Tricoteur et ennoblisseur prennent 4 semaines chacun (plafonds) ; reste 1,5 semaine : **date de consultation fil = dans 1,5 semaine**.
- À la consultation, le filateur retenu annonce 3 semaines au lieu de 4 : la semaine gagnée ne peut aller ni au tricoteur ni à l'ennoblisseur (déjà au plafond), elle repousse la **date de lancement du tricotage** d'une semaine après l'arrivée du fil.
- Le tricotage part avec une date souhaitée de 1 + 4 = 5 semaines ; s'il rend l'écru en 2, l'ennoblisseur reçoit quand même au plus 3 + 4 = 7 semaines, et l'écru attend chez nous jusqu'à la date de lancement de l'ennoblissement.

## 5. Les dates de lancement : un seul mécanisme d'attente

Une ligne porte une **date de lancement de sa prochaine étape**, quel que soit son avancement (commander le fil, lancer le tricotage, envoyer chez l'ennoblisseur). C'est le seul mécanisme d'attente : pas d'état « en attente » par stade.

- **Avant la date** : la ligne est **neutre** (personne n'a rien à faire). **À la date** : elle devient **rouge**, une action Malterre à faire maintenant. C'est exactement la règle des couleurs (`mps_designer §41`).
- **Date calculée par la doctrine** (« au plus tard ») : agir plus tôt reste libre.
- **Mise en attente manuelle** (« pas avant », **avec un motif**) : client qui demande d'attendre, coloris en attente de validation, risque d'annulation sur un coloris propre au client, « ne pas commencer avant X » demandé par l'ennoblisseur. Elle prend le pas sur le calcul, reste dans l'historique (comme les « Repousser » d'Attente délai), et l'écran signale une action faite avant elle.
- **Où la matière attend** : seulement quand l'amont finit en avance, et alors naturellement au stade **écru** (le plus souple : 40 % de l'écru tricoté pour une ligne finit sur une autre, 7,5 % chez un autre client ; presque jamais une fois teint) ou **fil** (ne se périme pas, se réaffecte).

## 6. Écarté, et pourquoi

- **Dates calculées à rebours sans plafond** : toute la marge part au tricoteur, l'ennoblisseur n'a que son standard.
- **Dates « standard seulement » envoyées au plus tôt** : l'ennoblisseur reçoit l'écru des semaines avant d'en avoir besoin, le stocke, et ne croit plus nos dates.
- **Garder l'écru chez Malterre jusqu'au dernier moment comme règle générale** : utile seulement sur les ~2 % de lignes où un écru est disputé entre deux clients (20 lignes sur 962, en hausse : 4 / 5 / 11 en 2024 / 25 / 26) ; là, on réserve l'écru à la ligne la plus proche, le seul arbitrage humain qui reste.
- **Une limite de délai par type de matière pour les filateurs** : c'est le fournisseur et la référence qui font le délai, pas la matière.
- **Le p80 comme standard** : délais trop longs, marge consommée ; la sécurité est la réserve Malterre, une seule, en fin de chaîne.

## 7. Points ouverts

1. **Transport et contrôle** entre les étapes : pas encore mesurés.
2. **Les vraies dates de fermeture** de MATEL, Bontemps, TAD et TRM. Celles des mesures sont **déduites des trous dans nos réceptions**, qui mêlent la fermeture du partenaire et celle de Malterre (MATEL : fin juillet ou début août à fin août, ~2 semaines à Noël ; TRM : ~3 semaines en août, ~1,5 à Noël).
3. **La réserve Malterre** : calée sur l'écart médiane → p80 de l'ennoblisseur (~7 jours ouvrés pour MATEL), à confirmer à l'usage.
4. **Le signalement « délai intenable »** : date de fin au plus tôt (aujourd'hui + standards restants depuis l'étape où en est la ligne) postérieure au délai client. À part des couleurs rouge / ambre, qui gardent leur sens d'action Malterre tant que tout n'est pas automatisé.
5. **Le champ délai sur les offres fil** (§3).
6. **Plus tard** : qualité de service des ennoblisseurs (part des commandes livrées dans les 3 semaines), aide à l'achat de fil au bon cours (historique des prix des offres), points à caler avec MATEL avant de lui envoyer des dates (date confirmée distincte de la nôtre, « ne pas commencer avant X »).

## Méthode des mesures

Base `mps_dev`, le 2026-10-27.

- **Sous-traitance** : lignes de commande sous-traitant commandées du 2024-01-01 au 2026-08-31 ; délai = date de commande → date où 90 % du poids produit par la ligne est saisi (`stock_fini.idref_commande_source` pour l'ennoblissement, `stock_ecru.idref_commande_source` pour le tricotage).
- **Fil** : première ligne de chaque commande fil (`commande_fil` du 2023-01-01 au 2026-08-31), date de commande → premier lot reçu (`stock_fil.date_entree`) ; « à l'heure » = reçu au plus 3 jours après la date promise (règle de `lib/fil-appro.ts`).
- **Jours ouvrés** : sans samedi, dimanche, jours fériés français, ni les fermetures déduites des périodes de 8 jours ou plus sans réception chez le partenaire.
