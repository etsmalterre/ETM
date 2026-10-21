# Tombé Métier › Échantillons : analyse et décisions

Branches `feat/echantillon` (ETM : API + écran, TRM : la route). **Construit le 2026-10-21** —
ce qui est livré est décrit dans `screen_notes.md` § 7 ; cette note garde l'analyse et les décisions.

## Le besoin (Vincent)

Dans le legacy, Tombé Métier avait un sous-menu **Échantillons** à droite de Références :
créer des échantillons de référence tombé de métier et suivre leur cycle de vie
indépendamment des références qui tournent. Le cycle se termine soit par un **archivage**,
soit par un **passage en référence tombé de métier**. Séparation voulue, comme prospects /
clients : deux cycles de vie, deux écrans.

## Les données legacy (PostgreSQL `mps`, copie `mps_dev`)

| Table | Contenu | Volume dev |
|---|---|---|
| `ref_echantillon` | `idcontexture`, `jauge`, `diametre` (ordinaux comme `ref_ecru`), `lfa1..4` (double), `commentaire`, `idclient`, `archive` | 53 (n° 1 à 55), 35 en cours, 18 archivés |
| `fil_ref_echantillon` | `idref_fil`, `idcolori_fil`, `pourcentage` **en fraction 0..1** (`composition_ecru` est en 0..100) | 83 lignes / 52 échantillons ; 5 ne totalisent pas 1 (0 ou 0,95) |
| `piece_echantillon` | `numero`, `date`, `idmachine`, `poids`, `longueur`, `laize`, `idref_echantillon` | 15 pièces / 14 échantillons, 12/2022 à 04/2026, beaucoup de « 1/1/1 » de remplissage |

- Pas de nom ni de désignation : l'échantillon est son numéro + son commentaire.
- **Aucun lien vers la référence créée** : trois commentaires le disent à la main
  (7 → « REF 316 », 12 → « DEVENU REF 027 », 52 → « ==> REF 328 »).
- Client = registre **TRM** (`client` 1 « Ets Malterre » société 2 pour 52, A.E.T. pour 1) ;
  pièces tricotées sur les métiers TRM. TRM a déjà une route placeholder
  `tombe-metier/echantillons` (`TmEchantillonsPage` dans `TRM/apps/web/src/router.tsx`).
- Legacy : fenêtres `FI_Echantillon.wdw`, `FEN_piece_echantillon.wdw`, état `ETAT_OF_Echantillon.wde`.

## Décision : tables séparées (pas de booléen « échantillon » sur `ref_ecru`)

Discuté et tranché le 2026-10-20 : fusionner dans `ref_ecru` + un drapeau obligerait chaque
liste de références (une douzaine d'endpoints, dont le site public `lib/webservice-site-data.ts`)
à exclure les échantillons, le piège connu (IDsociete, donations, `filEtmSql()`). Les tables
séparées rendent l'erreur impossible ; volume faible (quelques échantillons par an). On ne
reconsidère la fusion que si les échantillons doivent passer par OF / visitage / stock.

## Proposition retenue (à confirmer sur les questions ouvertes)

- **Écran** Tombé Métier › Échantillons, même grammaire que Références (Classeur, tuiles de
  `pages/tombe-metier/spec-tiles.tsx`) : liste (« E055 », contexture · jauge, début du
  commentaire ; filtre En cours / Devenus référence / Archivés), onglets **Spécifications**
  (contexture · jauge · Ø, client, LFA 1..4, composition, commentaire en grand) et **Pièces
  d'essai** (tableau + saisie), barre latérale (infos, stats pièces, référence créée).
- **Statut** = pastille §29 en pied de barre latérale : En cours → Archiver / Créer la
  référence ; Rouvrir tant que pas devenue référence.
- **Créer la référence** : dialogue qui montre ce qui est repris, crée la `ref_ecru`
  (numéro proposé = prochain libre, modifiable ; contexture, jauge, Ø, client, LFA →
  `lfa_tour_1..4`, composition ×100 → `composition_ecru` base ; désignation à saisir),
  puis clôt l'échantillon et le lie. Nouvelle colonne **`ref_echantillon.idref_ecru`
  DEFAULT 0** (migration append-only `lib/mps-schema.ts`). La fiche de la référence affiche
  « Issue de l'échantillon E052 ». Un seul passage possible.
- Hors v1 : fiche OF échantillon / impression, lien atelier-visitage, email.

## Questions tranchées (Vincent, 2026-10-21)

1. Application : **TRM + ETM**, un seul écran partagé via `@etm` (props, jamais de fork).
2. Numérotation affichée : **« E055 »**.
3. Les trois passages historiques (7→316, 12→027, 52→328) : **reliés par script**.
4. Pièces d'essai : **saisie manuelle** dans l'onglet.

## Dépendance

`feat/tm-references-classeur` (Classeur Références, stock par coloris, fiche technique écru)
est **fusionnée dans master** (2026-10-21) et `feat/echantillon` est rebasée dessus :
`pages/tombe-metier/spec-tiles.tsx` est disponible. Côté TRM, vérifier que la branche TRM
du même nom a bien été fusionnée aussi avant de toucher l'écran partagé.
