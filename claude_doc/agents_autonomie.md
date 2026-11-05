# Doctrine — compétences, supervision et autonomie des agents IA

Décidé avec Vincent le 2026-11-05 (chantier « Flux Ennoblisseur »). S'applique à
tout agent IA de Malterre, pas seulement à Flux Ennoblisseur. Code :
`apps/api/src/lib/agents/competences.ts` (règles pures, testées) ; l'agent
« Flux Ennoblisseur » en est le premier client.

## 1. On délègue à un agent comme à un nouvel employé

- Un agent a des **compétences** (Flux Ennoblisseur : BL, Délais, Contrôles).
  Chaque compétence a **son mode et ses mesures**. Le BL peut être bien rodé
  pendant que Délais démarre.
- Un nouvel agent, ou une nouvelle compétence, **commence toujours supervisé**.

## 2. Les modes d'une compétence

| Mode | Ce qu'il fait |
|---|---|
| `off` | Rien. |
| `essai` | Lit et décide, n'écrit RIEN. Sert à la mise au point, sur le corpus. |
| `supervise` | **Propose, n'écrit rien** : chaque exécution attend qu'une personne la valide, et c'est « Valider » qui écrit (révisé 2026-11-05 : rien ne change dans ETM — Point, couleurs, cycle — avant qu'une personne en ait pris la responsabilité). |
| `autonomie` X % / N exécutions | Sur chaque bloc de N exécutions, X % (arrondi) sont tirées **au hasard** pour être faites seules — **écrites tout de suite** —, les autres sont supervisées (proposées). 10 % / 10 = 1 exécution seule sur 10. |

- Le tirage est aléatoire : un « 1 sur 10 » fixe ferait toujours passer seuls
  les mêmes créneaux, donc les mêmes types de mails.
- **Un doute garde la priorité** : une exécution tirée « seule » où l'agent
  doute passe quand même la main.
- Une compétence déclare les modes qu'elle offre. Le BL s'arrête à `supervise` :
  c'est la réception, faite par une personne, qui valide le pré-remplissage.
- On ne vise pas 100 % d'autonomie. Rien dans le code ne l'interdit, mais on en
  reparlera.
- Monter d'un cran est la décision d'une personne. L'écran affiche le critère
  (§5) ; il ne monte jamais tout seul. Une erreur en autonomie **propose** de
  redescendre ; c'est aussi une personne qui décide.

## 3. Ce que l'agent décide, ce qu'une personne en dit

Une exécution produit des **points**. L'unité est le point, jamais le mail : un
« s 49 » qui répond pour 5 commandes donne 5 points. Pour chaque point,
l'agent prend une de ces trois décisions :

- **saisie** : il écrit une valeur (un délai sur une ligne) ;
- **rien** : il a lu et n'a rien trouvé à écrire (ce choix est jugé, lui aussi) ;
- **aide** : il n'écrit pas, explique pourquoi et **propose quand même une valeur**
  quand il en a une (« je pense le 02/12, mais… »). Ce qu'il n'a pas pu lire
  reste vide (« ? »), jamais un 0 ; « Appliquer ma proposition » n'est offert
  que pour une proposition complète.

Le doute vient du **code** (contrôles : commande inconnue, réponse qui n'est pas
une semaine ou une date…) et d'un champ explicite « je ne sais pas » renvoyé par
le modèle. Il ne vient jamais d'un score de confiance chiffré par le modèle : ce
score n'est pas calibré.

## 4. Les trois mesures

Elles se calculent par compétence, sur la version en cours, et se lisent
**ensemble** : un agent qui demande toujours de l'aide a 100 % de fiabilité, un
agent qui ne demande jamais a 100 % d'autonomie.

| Mesure | Question | Calcul |
|---|---|---|
| **Fiabilité** | Quand il agit, a-t-il raison ? | saisies et « rien » validés ÷ saisies et « rien » jugés (validé, corrigé, supprimé, omission) |
| **Autonomie** | Agit-il sans demander ? | (saisies + « rien ») ÷ tous les points |
| **Discernement** | Quand il demande, était-ce utile ? | aides que la personne dit justifiées ÷ aides tranchées. **Demandé à la personne**, jamais déduit de la valeur retenue (révisé 2026-11-05 : une proposition juste peut quand même valoir d'être demandée). |

Ce que fait la personne, et ce que ça compte :

| Geste | Fiabilité | Autonomie | Discernement |
|---|---|---|---|
| Valide la saisie telle quelle | 1/1 | 1/1 | — |
| Modifie ou supprime la saisie (avec pourquoi) | 0/1 | 1/1 | — |
| Confirme « rien à saisir » | 1/1 | 1/1 | — |
| **Omission** : « il y avait quelque chose dans ce mail » | 0/1 | 1/1 | — |
| Tranche une aide (appliquer sa proposition / saisir autre chose / ne rien saisir), puis « Avais-je raison de demander ton avis ? » **Oui** | non compté | 0/1 | 1/1 |
| … **Non**, avec pourquoi (obligatoire : ce qu'il apprend pour décider seul) | non compté | 0/1 | 0/1 |

- **L'omission est l'erreur la plus dangereuse**, parce qu'elle est invisible :
  pas de saisie, donc pas de carte rouge. Les mails « lus sans rien saisir »
  et les aides qui ne s'accrochent à aucune commande ni aucun lot se revoient
  côté pilote, dans la console Agents IA (exécutions « à vérifier ») — jamais
  par un second compteur sur l'écran de travail : le rouge suffit (Vincent,
  2026-11-05).
- Un point **autonome** n'attend personne. S'il est corrigé plus tard (la ligne
  modifiée à la main), c'est un échec de fiabilité. Tant que personne n'y touche,
  il est « non revu » : affiché à part, jamais compté comme une réussite.
- Modifier à la main une valeur que Tricobot a écrite et qui attendait sa
  validation compte comme une correction (« modifiée depuis la ligne »).
- Le score reste binaire par point, comme partout ailleurs (`retours.ts`) : un
  seul champ faux suffit pour un échec.

## 5. Monter, descendre

- **Proposer de monter d'un cran** : au moins `MONTEE_MIN_JUGES` points jugés sur
  la version (30), et une fiabilité ≥ `MONTEE_FIABILITE` (95 %) sur les 30
  derniers. Les crans sont : supervisé → 10 % → 25 % → 50 % → 75 %.
- **Proposer de redescendre** : un échec de fiabilité sur un point autonome
  depuis le dernier changement de mode.
- Une nouvelle version (nouveau prompt ou nouveau comportement) repart de zéro,
  comme aujourd'hui.

## 6. Couleurs (règle rouge / ambre Malterre)

- Une saisie supervisée qui attend sa validation = **rouge** : c'est une action
  Malterre à faire maintenant. Sur la carte, Tricobot dans un rond cerclé de
  rouge prend la place de l'icône, à gauche du numéro et du sous-traitant ; la
  commande compte dans le **compteur rouge** à côté de la recherche, qui la
  fait apparaître (`computeUrgencyBuckets`). Le liseré de la carte garde sa
  propre urgence.
- **Tricobot est une entité qui vient par-dessus le logiciel** (Vincent,
  2026-11-05), pas un panneau de plus : en ouvrant la commande, le **détail** se
  voile (en-tête, lignes, colonne de droite) — la liste des cartes reste
  utilisable pour passer à une autre commande. Tricobot se tient en bas à
  gauche, en grand, et sa bulle sort de sa bouche, avec les gestes. À droite, à
  la place de la colonne Info, **le mail qu'il a lu**, les mots retenus surlignés
  (écran étroit : « Voir le mail » en dialogue). Pas de « Plus tard » : il reste
  là tant que la personne n'a pas répondu (elle peut ouvrir une autre carte).
  Rien n'est éclairé dans l'écran : la bulle nomme la valeur. **« Regarder le détail »**
  (Vincent, 2026-11-05) : un clic sur le voile (une indication le dit, en bas du voile) fait
  partir voile, bulle et mail ; Tricobot attend dans une pastille « Tricobot
  attend ta validation · Reprendre » en bas à gauche, et le détail se lit et
  défile librement, **en lecture seule** : tout geste qui écrirait (Modifier,
  une action en haut à droite, la pastille de statut, un champ) n'a pas lieu et
  Tricobot revient. Défiler, survoler et changer d'onglet restent libres (un
  bouton qui ne fait que lire se marque `data-tricobot-lecture`). Composant
  `TricobotPriseEnMain` ; l'écran marque la zone à ne pas voiler
  (`data-tricobot-liste`) et la valeur (`data-tricobot-cible="<id>"`, qui place
  la bulle juste en dessous). À réutiliser pour toute compétence qui écrit dans
  un écran.
- **Un raisonnement se vérifie, il ne se croit pas** (Vincent, 2026-11-05) :
  « s 49 » seul ne dit pas pourquoi la 9132. La bulle a une section « Mon
  raisonnement » en étapes numérotées, la chaîne que le code suit vraiment :
  ① la question (« réponse à notre Point du 02/11, qui demandait en section 5
  le délai de 5 commandes, dont la 9132 »), ② la réponse (« ne nomme aucune
  commande : elle vaut pour les 5 », ou « nomme la commande »), ③ la règle
  (« s 49 = mercredi 02/12 »). Le panneau de droite montre la conversation :
  notre Point (section 5, la commande concernée en rouge) puis la réponse (les
  mots retenus en rouge). Le Point vient d'ETM (`point_sst`), pas de Gmail.
  Toute compétence future expose ainsi sa question, sa réponse et sa règle.
- Une aide = rouge aussi (« Tricobot demande ton avis »).
- Un point autonome = **neutre**, avec une petite icône Tricobot : rien à faire,
  mais on voit qui a écrit, et on peut corriger.

## 7. Flux Ennoblisseur (premier agent sur ce modèle)

Ex-« BL Ennoblisseur ». Le slug `bl-ennoblisseur` est gardé (historique des
runs, libellés Gmail, notification `notif_agent_bl`) ; seul le nom change.

- **BL** : inchangé. Mesures relues sur l'historique : un run « à vérifier » =
  une aide, un run écrit = une saisie jugée à la réception.
- **Délais** : les réponses des teinturiers au « Point du JJ/MM ». MATEL répond
  section par section ; la section 5 (« Pouvez-vous me confirmer les délais… »)
  porte les délais. Une réponse nue (« 5) s 49 ») vaut pour **toutes** les
  commandes de la section 5 de ce Point. « s N » = **le mercredi de la semaine
  ISO N** : c'est ce que Pierre-Emmanuel saisit (« s 47 » du 23/10 → 18/11,
  mesuré sur `delai_sst_evenement`). Toute autre forme (« lundi ou mardi »,
  « fin de semaine », un numéro de commande inconnu) → aide, avec la proposition
  du modèle. La saisie écrit `date_livraison` de la ligne par les mêmes règles
  que l'écran (`sstDelaiSets`, `noterDelaiRecu` par Tricobot).
- **Contrôles** : la section 2 du même mail (« lot 109579 laize = 156cm poids =
  166g/m² stabs h = -3 l = -3 V = 4% »). Le lot est retrouvé par son numéro
  (MA109579, jamais un numéro plus long). Saisie = laize, poids, stabilités et
  vrillage écrits côté ennoblisseur (`suivilot.*_sst`). Aide = lot introuvable,
  ou lot qui porte déjà d'autres mesures (jamais remplacées sans personne).
  « Résultats demain » = rien. Revue dans **Qualité › Suivi lots**, même prise
  en main que les délais (carte rouge « Tricobot : contrôles à valider »,
  compteur rouge, raisonnement : section 2 du Point → ligne de la réponse →
  mesures reportées). Des mesures retapées à la main sur le lot jugent la saisie
  (`lotModifie`). Livré en essai, comme Délais.
- Les sections 3 et 4 de la réponse (avancement : « cde 9094 métrages cet
  aprème ») ne sont pas des délais de ligne : non lues pour l'instant.

## 8. Ce qui reste à faire

- Une version de prompt par compétence (aujourd'hui le prompt versionné de
  l'agent est celui du BL ; Délais porte sa version dans le code,
  `DELAIS_VERSION`).
- Étendre le modèle aux autres agents (Factures Ennoblisseur, Triage…).
