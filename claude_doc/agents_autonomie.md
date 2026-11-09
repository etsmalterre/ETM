# Doctrine — compétences, supervision et autonomie des agents IA

Décidé avec Vincent le 2026-11-05 (chantier « Flux Ennoblisseur »). S'applique à
tout agent IA de Malterre, pas seulement à Flux Ennoblisseur. Code :
`apps/api/src/lib/agents/competences.ts` (règles pures, testées) ; l'agent
« Flux Ennoblisseur » en est le premier client.

## 0. Deux principes, pour tous les agents

**Le droit de ne pas savoir** (Vincent, 2026-11-05). Un agent a toujours le
droit de demander l'intervention d'une personne. Quand une valeur est absente,
ambiguë ou incertaine, il ne la devine pas : il la laisse vide, dit pourquoi,
et propose ce qu'il aurait fait quand il en a une idée (une **aide**, §3). Le
prompt de chaque agent le dit en toutes lettres, et son format de sortie le
permet (une valeur `null`, un `certain: false` avec sa raison) ; le code fait
d'un « je ne sais pas » une aide, jamais une saisie. Demander est ce qui rend
l'agent mesurable (§4) : **une autonomie basse n'est pas un défaut**, c'est un
agent qui a encore besoin d'informations et de l'expérience des personnes pour
mieux servir. Il progresse par les retours ; on le juge d'abord sur sa
fiabilité et son discernement. Le discernement est le contrepoids : le droit de
demander, mais une demande qui sert.

**Le modèle lit, le code vérifie** (Vincent, 2026-11-05). Lire un mail, un PDF,
une réponse rédigée par un partenaire, c'est le travail du modèle, guidé par
**un prompt par compétence** qui dit exactement ce qu'on attend (les délais,
les stabilités, le poids…, leurs unités et les règles de la maison) et le
format à rendre (un schéma JSON). Il le déduit de tout mail, quel que soit le
partenaire ou sa mise en forme. On n'écrit pas d'expressions régulières par
partenaire : un nouveau partenaire ou un format qui change ne demande pas de
développeur, seulement un prompt qui se spécialise au fil des retours, publié
depuis l'écran (Agents IA › Prompt, une version par compétence, rejouée sur les
exécutions passées avant d'être publiée). Le **code garde le dernier mot** sur
tout ce qui ne dépend pas du format : la citation doit se trouver dans le mail,
la valeur doit être lisible et vraisemblable (délai passé, à plus de 6 mois,
ligne déjà datée autrement, commande ou lot non demandé, lot introuvable ou
déjà validé), et quand une forme connue (« s 49 », « laize = 156 ») se relit
sans doute, le code la relit et un désaccord avec le modèle devient une aide.
Reste du travail de développeur : une nouvelle compétence, un nouveau champ à
écrire, une nouvelle règle de vérification, une nouvelle source.

## 1. On délègue à un agent comme à un nouvel employé

- Un agent a des **compétences** (Flux Ennoblisseur : BL, Délais, Contrôles).
  Chaque compétence a **son mode et ses mesures**. Le BL peut être bien rodé
  pendant que Délais démarre.
- Un nouvel agent, ou une nouvelle compétence, commence en **observation**,
  puis passe **supervisé** : jamais d'écriture sans qu'une personne la valide
  avant d'avoir des mesures.

## 2. Les modes d'une compétence

| Mode | Ce qu'il fait |
|---|---|
| `off` | Rien. |
| `essai`, affiché **« Observation »** | L'agent existe mais est **transparent** pour tout le monde (Vincent, 2026-11-05) : il n'écrit RIEN et ne montre rien dans ETM. **Il est jugé sur ce que les personnes font vraiment** (Vincent, 2026-11-09, voir « L'observation pilotée par les personnes » ci-dessous) : une réponse au Point n'est pas lue à son arrivée, elle attend qu'une personne y réagisse ; le passage horaire la lit alors **comme à son arrivée** et compare chaque point à ce que la personne a saisi. Même valeur = accord (validée), une autre = désaccord (corrigée), une valeur saisie que la lecture a manquée = omission ; une aide est tranchée par cette valeur. On mesure un accord avec la personne, pas la vérité. De la donnée métier sans aucun impact : la compétence arrive en supervisé avec ses mesures. |
| `supervise` | **Propose, n'écrit rien** : chaque exécution attend qu'une personne la valide, et c'est « Valider » qui écrit (révisé 2026-11-05 : rien ne change dans ETM — Point, couleurs, cycle — avant qu'une personne en ait pris la responsabilité). |
| `autonomie` X % / N exécutions, affiché **« Autonome »** | Sur chaque bloc de N exécutions, X % (arrondi) sont tirées **au hasard** pour être faites seules — **écrites tout de suite** —, les autres sont supervisées (proposées). 10 % / 10 = 1 exécution seule sur 10. |

### L'observation pilotée par les personnes (Vincent, 2026-11-09)

Ce qui vaut d'être regardé en observation : **combien il a tourné, l'accord avec ce que les
personnes ont saisi, et les écarts**. L'autonomie et le discernement n'y ont pas de sens (personne
n'est interrogé) : l'onglet Score montre à la place **Exécutions**, **Accord** (le critère pour
passer en supervisé, 90 % sur 30 comparés) et **Portée**, puis la liste des écarts (ce qu'il a lu
face à ce qui a été saisi : la matière pour améliorer le prompt).

La donnée n'existe qu'une fois qu'une personne a réagi au mail, ce qui prend du temps. D'où :

1. **À l'arrivée**, une réponse au Point d'une compétence en observation (Délais, Contrôles) n'est
   pas lue : elle attend (`observation_mail`, migration 0066). Rien n'est dépensé pour un mail
   auquel personne ne réagit ; sans réaction en 14 jours, il n'est jamais lu (« sans réaction »).
2. **Quand une personne saisit** un délai sur une ligne, ou les mesures ennoblisseur d'un lot, d'un
   des ennoblisseurs de l'agent, la valeur est gardée avec la ligne / le lot tels qu'ils étaient
   juste avant (`observation_saisie`, depuis les routes de la ligne et de Suivi lots).
3. **Toutes les heures** (planificateur, production), chaque mail en attente auquel une personne a
   réagi est lu **comme à son arrivée** : la ligne / le lot d'avant la saisie, « aujourd'hui » = le
   jour du mail. Il ne voit jamais la réponse : sinon « la ligne a déjà un délai » ferait de chaque
   point une aide. La relecture d'un prompt (« Rejouer ») relit dans ce même contexte.
4. Une valeur saisie qu'aucun mail lu n'explique est **hors de portée** (téléphone, autre boîte) :
   ce n'est pas l'erreur de l'agent, c'est la part du travail qu'il ne voit pas (« Portée »).
   Une valeur saisie plus tard sur une ligne / un lot dont le mail lu parlait, et que sa lecture a
   manquée, est une **omission**.

Le **BL** reste lu à son arrivée (rien n'est encore réceptionné, donc rien ne fuit) ; sa
comparaison avec la réception passe dans le même passage horaire. Code :
`flux-ennoblisseur/observation.ts` (rapprochement pur et testé), `observation-attente.ts`.

- **Un seul interrupteur par compétence** (Vincent, 2026-11-05) : un agent à
  compétences n'a plus de mode à lui. Son mode stocké est déduit des leurs
  (`modeDerive` : « off » si toutes sont à l'arrêt, sinon en marche) et ne sert
  qu'à dire au relevé, au Triage et au planificateur « quelque chose tourne » ;
  ce qui s'écrit, chaque compétence en décide par son propre mode. Un ancien
  mode d'agent (essai, off) qui les bridait est reporté une fois sur chacune au
  premier changement (`changerModeCompetence`). La boîte est lue à partir de la
  première fois qu'une compétence sort de l'arrêt. Dans Agents IA, chaque
  compétence apparaît comme un agent, sous la carte de son groupe, avec son mode
  au pied de son panneau.
- Le **cycle d'autonomie** (N exécutions, X %) se règle dans le panneau de droite
  quel que soit le mode, et se garde (`reglerCycle`) : il s'applique au passage
  en Autonome. Couleurs : supervisé = ambre (une personne valide encore),
  autonome = vert.
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

Le doute vient du **modèle** (son « je ne sais pas » explicite, §0) et du
**code** (citation introuvable dans le mail, commande non demandée, délai
invraisemblable, désaccord avec une forme que le code relit…). Il ne vient jamais d'un score de confiance chiffré par le modèle : ce
score n'est pas calibré.

## 4. Les trois mesures

Elles se calculent par compétence, sur la version en cours, et se lisent
**ensemble** : un agent qui demande toujours de l'aide a 100 % de fiabilité, un
agent qui ne demande jamais a 100 % d'autonomie.

| Mesure | Question | Calcul |
|---|---|---|
| **Fiabilité** | Quand il agit, a-t-il raison ? | saisies et « rien » validés ÷ saisies et « rien » jugés (validé, corrigé, supprimé, omission) |
| **Autonomie** | Agit-il sans demander ? | (saisies + « rien ») ÷ tous les points |
| **Discernement** | Quand il demande, est-ce utile ? | aides que la personne dit justifiées ÷ aides tranchées. **Demandé à la personne**, jamais déduit de la valeur retenue (révisé 2026-11-05 : une proposition juste peut quand même valoir d'être demandée). |

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
  derniers ; depuis l'observation, 90 % d'accord avec ce que les personnes ont
  saisi (`MONTEE_OBSERVATION`). Les crans sont : observation → supervisé → 10 %
  → 25 % → 50 % → 75 %.
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
- **Délais** : les réponses des teinturiers au « Point du JJ/MM ». Depuis la
  v2 (2026-11-05), le modèle lit la réponse entière avec son prompt
  (`flux-ennoblisseur/lecture.ts`) et la liste des commandes que le Point
  demandait : pour chacune, le passage qui y répond (cité mot pour mot), la
  date, s'il en est sûr et pourquoi. MATEL répond section par section et une
  réponse nue (« 5) s 49 ») vaut pour **toutes** les commandes de la section 5 ;
  un autre partenaire peut écrire autrement, c'est au prompt de le dire.
  « s N » = **le mercredi de la semaine ISO N** : c'est ce que Pierre-Emmanuel
  saisit (« s 47 » du 23/10 → 18/11, mesuré sur `delai_sst_evenement`). Le code
  vérifie ensuite (§0) : citation présente dans le mail, relecture des formes
  sûres (« s 49 », « 02/12 ») et désaccord → aide, puis les règles de la ligne.
  La v1 (regex MATEL) reste dans l'historique. La saisie écrit
  `date_livraison` de la ligne par les mêmes règles que l'écran
  (`sstDelaiSets`, `noterDelaiRecu` par Tricobot).
- **Contrôles** : les mesures que l'ennoblisseur donne par lot (MATEL : section
  2, « lot 109579 laize = 156cm poids = 166g/m² stabs h = -3 l = -3 V = 4% »),
  lues par le modèle avec son propre prompt depuis la v2 ; le code relit la
  ligne citée quand elle a la forme MATEL et un écart devient une aide (« h »
  écrit deux fois reste une aide, jamais un choix). Le lot est retrouvé par son numéro
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

- Fait le 2026-11-05 : une version de prompt par compétence. Le BL garde le
  prompt de l'agent ; Délais et Contrôles ont chacune le leur
  (`AgentState.promptsCompetences`), publié et réactivé depuis Agents IA ›
  Prompt, rejoué avant publication sur les dernières exécutions (« Rejouer »,
  rien n'est écrit). Dans Agents IA, la liste de gauche montre le groupe
  (Flux Ennoblisseur) et, dépliées dessous, ses compétences, chacune gérée comme
  un agent : son onglet **Score** (le premier : les trois mesures en grand, sur
  la version choisie, et le cran suivant), ses exécutions, ses retours, son
  prompt, ses coûts, et son mode au pied du panneau de droite.
- Étendre le modèle aux autres agents (Factures Ennoblisseur, Triage…), §0 en
  tête de chaque prompt.
