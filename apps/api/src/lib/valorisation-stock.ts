// ── Valorisation du stock — les quatre types de l'inventaire légataire ────
//
// Port des quatre états d'inventaire WinDev (`ETAT_InventaireFil.wde`,
// `ETAT_InventaireTM.wde`, `ETAT_InventaireFini.wde`) qui alimentaient
// `inventaire_compta`. Ils produisent les deux chiffres que le bilan porte
// ensuite en *production stockée* et *provision pour dépréciation des stocks* —
// les deux que `upload_compta`, donc l'Analyse financière, ne voit pas.
//
// POURQUOI C'EST ICI
//
// `inventaire_compta` (un arrêté mensuel par type, `prix_achat` brut +
// `valeur_deprecie` net) **s'est arrêté d'être écrit le 28/06/2025**. Avant ça
// il se rapprochait du bilan à l'euro près. Reconstitution vérifiée sur les
// quatre inventaires imprimés au 27/12/2024, qui reproduisent EXACTEMENT la
// ligne `inventaire_compta` du 28/12/2024 :
//
//     Fil          199 090 / 122 891        TM dispo      56 372 / 27 937
//     TM en cours   44 236 /  43 469        Fini         331 978 / 179 142
//
// Et la boucle se ferme jusqu'au bilan 2025 : les quatre types donnent
// brut 581 921 / net 312 793, le stock hors ERP (escrime, voir la note de
// périmètre plus bas) 57 600 / 13 935, total 639 521 / 326 728 — les chiffres
// exacts du bilan.
//
// ⚠️ PÉRIMÈTRE — L'ESCRIME N'EST PAS COUVERT
//
// Il n'existe pas d'inventaire escrime dans l'ERP : ces articles vivent hors des
// quatre types ci-dessous. Fin 2025 ils pesaient **57 600 € brut / 13 935 € net**
// (l'écart entre le total des quatre inventaires et le bilan). C'est donc le
// montant qui manque, et il est connu plutôt qu'inconnu. À intégrer plus tard —
// décision Vincent, 2026-08-25.
//
// ⚠️ NE PEUT DÉCRIRE QUE MAINTENANT
//
// Les populations se lisent sur des colonnes d'ÉTAT COURANT
// (`IDetat_stock_fini`, `IDligne_expedition`, `IDref_commande_affectation`,
// `stock_fil.stock`) et la dépréciation part de la date d'exécution. Un arrêté
// passé n'est donc pas rejouable — c'est aussi pourquoi les 14 mois manquants
// d'`inventaire_compta` ne sont pas récupérables : il faut repartir d'ici.
//
// HFSQL : requêtes plates + jointures en JS. `asso_fil_matiere` et
// `matiere_premiere` portent des identifiants ACCENTUÉS (`IDMatière`,
// `IDmatière_première`) que le pont Linux refuse — d'où `SELECT *` + résolution
// des clés par préfixe (`pickKey`), jamais de colonne accentuée nommée en SQL.
// À l'inverse `stock_fil` porte des memos binaires : `SELECT *` y renvoie
// 0 ligne sur Windows, donc ses colonnes sont nommées explicitement.

import { query } from './hfsql-auto.js'
import { n } from './sst-shared.js'

/** YYYYMMDD depuis ce que le driver renvoie pour une colonne date.
 *
 *  ⚠️ PAS `sst-shared.dateDigits` : `stock_fini.date_saisie` revient en
 *  TIMESTAMP (`"2020-10-04 00:00:00.000"`) et `dateDigits` exige `/^\d{8}$/`,
 *  donc renvoie `''` sur toutes les lignes. Une chaîne vide perd toute
 *  comparaison `>` et rangeait tout le stock dans « plus de 2 ans » à 90 % —
 *  un chiffre plausible, pas un plantage. */
function d8(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8)
}

/** Première valeur dont la clé matche `re`. Obligatoire sur les tables à
 *  identifiants accentués : le pont Linux mange l'accent, donc le nom exact de
 *  la clé n'est pas connu à l'avance. */
function pick(row: Record<string, unknown>, re: RegExp): unknown {
  for (const k of Object.keys(row)) if (re.test(k)) return row[k]
  return undefined
}

/** `stock_fini.IDetat_stock_fini` compté par l'inventaire fini. */
const ETAT_EN_STOCK = 3
/** Tranche de quantité que la requête légataire fige pour le forfait
 *  d'ennoblissement. Son propre commentaire dit « Approximation ». */
const TRANCHE_QUANTITE = 200
/** `stock_fil.IDclient` d'Ets Malterre. Le fil des autres clients est confié :
 *  il est dans nos murs mais pas à notre bilan. */
const CLIENT_ETM = 1
/** Seuil de la règle « petit lot » du barème fil. */
const PETIT_LOT_KG = 100

export type TypeStock = 'fil' | 'tm_dispo' | 'tm_en_cours' | 'fini'

export interface Bucket {
  key: string
  label: string
  /** Dépréciation appliquée, 0..1. */
  taux: number
  lignes: number
  poids: number
  brut: number
  net: number
}

export interface ValorisationType {
  type: TypeStock
  label: string
  lignes: number
  poids: number
  brut: number
  net: number
  provision: number
  /** provision / brut, 0..1. `null` si brut nul. */
  taux_provision: number | null
  buckets: Bucket[]
  /** Lignes dont le coût est incomplet (fil ETM sans prix d'achat connu) —
   *  leur valeur est sous-estimée. Le drapeau `filNull` de la requête légataire. */
  incompletes: number
}

export interface ValorisationStock {
  /** YYYYMMDD de calcul — les règles d'âge sont relatives à cette date. */
  date: string
  types: ValorisationType[]
  total: {
    poids: number
    brut: number
    net: number
    provision: number
    taux_provision: number | null
  }
}

const LABELS: Record<TypeStock, string> = {
  fil: 'Fil',
  tm_dispo: 'Tombé de métier disponible',
  tm_en_cours: 'Tombé de métier en ennoblissement',
  fini: 'Rouleaux finis',
}

/** Aujourd'hui en YYYYMMDD, heure locale (les livres sont français). */
function todayDigits(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** Bornes d'âge relatives à `asOf` : `seuil(1)` = il y a un an, etc.
 *  Reproduit le `DATEADD(YEAR, -n, SYSDATE)` de la requête légataire. */
function seuil(asOf: string, ans: number): string {
  return `${Number(asOf.slice(0, 4)) - ans}${asOf.slice(4)}`
}

// ── Barème « pièces » : fini, TM dispo, TM en cours ───────────────────────
// Règles imprimées sur les trois inventaires :
//   2ᵉ choix −90 % | moins d'un an 0 % | 1 à 2 ans −50 % | plus de 2 ans −90 %

const BAREME_PIECE = {
  second_choix: { label: '2ᵉ choix', taux: 0.9 },
  moins_1_an: { label: "Moins d'un an", taux: 0 },
  de_1_a_2_ans: { label: '1 à 2 ans', taux: 0.5 },
  plus_2_ans: { label: 'Plus de 2 ans', taux: 0.9 },
} as const
const ORDRE_PIECE = ['moins_1_an', 'de_1_a_2_ans', 'plus_2_ans', 'second_choix'] as const

function bucketPiece(secondChoix: boolean, dateSaisie: string, asOf: string): keyof typeof BAREME_PIECE {
  if (secondChoix) return 'second_choix'
  if (dateSaisie > seuil(asOf, 1)) return 'moins_1_an'
  if (dateSaisie > seuil(asOf, 2)) return 'de_1_a_2_ans'
  return 'plus_2_ans'
}

// ── Barème « fil » — son propre jeu, plus riche ───────────────────────────
// Règles imprimées sur l'inventaire fil, DANS CET ORDRE (il est signifiant) :
//   1) 100 % Élasthanne          →   0 %   ← prime sur tout le reste
//   2) < 100 kg ET > 1 an        → −90 %   ← avant l'échelle d'âge
//   3) moins d'un an             →   0 %
//   4) 1 à 2 ans                 → −50 %
//   5) 2 à 3 ans                 → −75 %
//   6) plus de 3 ans             → −90 %

const BAREME_FIL = {
  elasthanne: { label: 'Élasthanne (exempté)', taux: 0 },
  petit_lot: { label: 'Petit lot (< 100 kg) > 1 an', taux: 0.9 },
  moins_1_an: { label: "Moins d'un an", taux: 0 },
  de_1_a_2_ans: { label: '1 à 2 ans', taux: 0.5 },
  de_2_a_3_ans: { label: '2 à 3 ans', taux: 0.75 },
  plus_3_ans: { label: 'Plus de 3 ans', taux: 0.9 },
} as const
const ORDRE_FIL = [
  'elasthanne', 'moins_1_an', 'de_1_a_2_ans', 'de_2_a_3_ans', 'plus_3_ans', 'petit_lot',
] as const

function bucketFil(
  estElasthanne: boolean, kgLot: number, dateEntree: string, asOf: string,
): keyof typeof BAREME_FIL {
  if (estElasthanne) return 'elasthanne'
  const moinsDUnAn = dateEntree > seuil(asOf, 1)
  if (kgLot < PETIT_LOT_KG && !moinsDUnAn) return 'petit_lot'
  if (moinsDUnAn) return 'moins_1_an'
  if (dateEntree > seuil(asOf, 2)) return 'de_1_a_2_ans'
  if (dateEntree > seuil(asOf, 3)) return 'de_2_a_3_ans'
  return 'plus_3_ans'
}

// ── Accumulateur ──────────────────────────────────────────────────────────

class Accu {
  private readonly b = new Map<string, Bucket>()
  incompletes = 0
  constructor(
    private readonly type: TypeStock,
    ordre: readonly string[],
    bareme: Record<string, { label: string; taux: number }>,
  ) {
    for (const key of ordre) {
      this.b.set(key, { key, label: bareme[key].label, taux: bareme[key].taux, lignes: 0, poids: 0, brut: 0, net: 0 })
    }
  }
  add(key: string, poids: number, brut: number): void {
    const b = this.b.get(key)
    if (!b) return
    b.lignes++
    b.poids += poids
    b.brut += brut
    b.net += brut * (1 - b.taux)
  }
  result(): ValorisationType {
    const buckets = [...this.b.values()]
    const sum = (k: 'lignes' | 'poids' | 'brut' | 'net') => buckets.reduce((t, x) => t + x[k], 0)
    const brut = sum('brut')
    const net = sum('net')
    return {
      type: this.type,
      label: LABELS[this.type],
      lignes: sum('lignes'),
      poids: sum('poids'),
      brut,
      net,
      provision: brut - net,
      taux_provision: brut > 0 ? (brut - net) / brut : null,
      buckets,
      incompletes: this.incompletes,
    }
  }
}

// ── Le calcul ─────────────────────────────────────────────────────────────

export async function valoriserStock(asOf: string = todayDigits()): Promise<ValorisationStock> {
  const [
    fini, ecru, afo, afst, sfil, rfc, rfil, comp, lcs, recru, rfini, trf, tte, rfcol, afm, mp,
  ] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT IDstock_fini, IDstock_ecru, IDref_fini, IDColoris, second_choix, date_saisie,
              IDligne_expedition, IDetat_stock_fini, IDref_commande_source
       FROM stock_fini`),
    query<Record<string, unknown>>(
      `SELECT IDstock_ecru, poids, date_saisie, second_choix, IDordre_fabrication, IDref_ecru,
              IDcolori_ecru, IDref_commande_source, IDref_commande_affectation, IDligne_expedition_ETM
       FROM stock_ecru WHERE IDsociete = 1`),
    query<Record<string, unknown>>(`SELECT IDordre_fabrication, IDstock_fil, pourcentage FROM asso_fil_of`),
    query<Record<string, unknown>>(`SELECT IDstock_ecru, IDstock_fil FROM asso_fil_stock_tm`),
    // stock_fil : colonnes nommées (SELECT * renvoie 0 ligne sur Windows — memos binaires)
    query<Record<string, unknown>>(
      `SELECT IDstock_fil, IDref_fil, IDcolori_fil, IDref_fil_commande, IDclient, stock, date_entree
       FROM stock_fil`),
    query<Record<string, unknown>>(`SELECT IDref_fil_commande, prix_unitaire FROM ref_fil_commande`),
    query<Record<string, unknown>>(`SELECT IDref_fil, prix_kg FROM ref_fil`),
    query<Record<string, unknown>>(
      `SELECT IDref_ecru, IDcolori_ecru, IDcolori_fil, pourcentage FROM composition_ecru`),
    query<Record<string, unknown>>(`SELECT IDligne_commande_sous_traitant, prix FROM ligne_commande_sous_traitant`),
    query<Record<string, unknown>>(`SELECT IDref_ecru, prix FROM ref_ecru`),
    query<Record<string, unknown>>(`SELECT IDref_fini, IDref_ecru FROM ref_fini`),
    query<Record<string, unknown>>(`SELECT IDref_fini, IDtraitement FROM traitement_ref_fini`),
    query<Record<string, unknown>>(
      `SELECT IDtraitement, IDteinture, IDsous_traitant, quantite_mini, quantite_maxi, prix
       FROM tranche_tarif_ennoblissement`),
    query<Record<string, unknown>>(`SELECT IDref_fini_colori, IDteinture FROM ref_fini_colori`),
    // identifiants accentués → SELECT * + pickKey (le pont Linux refuse `IDMatière`)
    query<Record<string, unknown>>(`SELECT * FROM asso_fil_matiere`),
    query<Record<string, unknown>>(`SELECT * FROM matiere_premiere`),
  ])

  // ── index
  const ecruById = new Map<number, Record<string, unknown>>()
  for (const r of ecru) ecruById.set(n(r.IDstock_ecru), r)
  const prixLcs = new Map<number, number>()
  for (const r of lcs) prixLcs.set(n(r.IDligne_commande_sous_traitant), n(r.prix))
  const prixRefEcru = new Map<number, number>()
  for (const r of recru) prixRefEcru.set(n(r.IDref_ecru), n(r.prix))
  const refEcruOfFini = new Map<number, number>()
  for (const r of rfini) refEcruOfFini.set(n(r.IDref_fini), n(r.IDref_ecru))
  const filById = new Map<number, Record<string, unknown>>()
  for (const r of sfil) filById.set(n(r.IDstock_fil), r)
  const prixCommandeFil = new Map<number, number>()
  for (const r of rfc) prixCommandeFil.set(n(r.IDref_fil_commande), n(r.prix_unitaire))
  const prixCatalogueFil = new Map<number, number>()
  for (const r of rfil) prixCatalogueFil.set(n(r.IDref_fil), n(r.prix_kg))
  const teintureOfColoris = new Map<number, number>()
  for (const r of rfcol) teintureOfColoris.set(n(r.IDref_fini_colori), n(r.IDteinture))

  const afoByOf = new Map<number, Record<string, unknown>[]>()
  for (const r of afo) {
    const k = n(r.IDordre_fabrication)
    const l = afoByOf.get(k)
    if (l) l.push(r); else afoByOf.set(k, [r])
  }
  const lotsByEcru = new Map<number, number[]>()
  for (const r of afst) {
    const k = n(r.IDstock_ecru)
    const l = lotsByEcru.get(k)
    if (l) l.push(n(r.IDstock_fil)); else lotsByEcru.set(k, [n(r.IDstock_fil)])
  }
  const compKey = (ref: number, colE: number, colF: number) => `${ref}|${colE}|${colF}`
  const pctByComp = new Map<string, number>()
  for (const r of comp) pctByComp.set(compKey(n(r.IDref_ecru), n(r.IDcolori_ecru), n(r.IDcolori_fil)), n(r.pourcentage))

  // ── références 100 % élasthanne (règle 1 du barème fil)
  const libMatiere = new Map<number, string>()
  for (const r of mp) libMatiere.set(n(pick(r, /^IDmati/i)), String(pick(r, /^libelle/i) ?? ''))
  /** Accents repliés : le pont peut renvoyer « elasthanne recycl<FFFD> ». */
  const estMatiereElasthanne = (idMat: number) =>
    /elasthanne/i.test((libMatiere.get(idMat) ?? '').normalize('NFD').replace(/[̀-ͯ]/g, ''))
  const compoByRefFil = new Map<number, { mat: number; pct: number }[]>()
  for (const r of afm) {
    const ref = n(pick(r, /^IDRef_fil$/i))
    const l = compoByRefFil.get(ref)
    const e = { mat: n(pick(r, /^IDMati/i)), pct: n(pick(r, /^pourcentage$/i)) }
    if (l) l.push(e); else compoByRefFil.set(ref, [e])
  }
  const refsElasthanne = new Set<number>()
  for (const [ref, l] of compoByRefFil) {
    // `pourcentage` est une FRACTION ici (0.31 = 31 %), pas 0-100.
    if (l.length > 0 && l.every((x) => estMatiereElasthanne(x.mat)) &&
        Math.abs(l.reduce((t, x) => t + x.pct, 0) - 1) < 0.02) {
      refsElasthanne.add(ref)
    }
  }

  /** €/kg de fil d'une pièce écru, et si son coût est complet. Production
   *  interne → consommation réelle de l'OF ; pièce achetée à un tricoteur →
   *  composition de la référence appliquée aux lots qui lui sont affectés.
   *  Prix = celui de la COMMANDE, jamais le catalogue. */
  function coutFilEcru(se: Record<string, unknown>): { prix: number; complet: boolean } {
    let prix = 0
    let complet = true
    const marque = (lot: Record<string, unknown>) => {
      if (n(lot.IDclient) === CLIENT_ETM && !prixCommandeFil.has(n(lot.IDref_fil_commande))) complet = false
    }
    const idOf = n(se.IDordre_fabrication)
    if (idOf !== 0) {
      for (const a of afoByOf.get(idOf) ?? []) {
        const lot = filById.get(n(a.IDstock_fil))
        if (!lot) continue
        prix += (n(a.pourcentage) / 100) * (prixCommandeFil.get(n(lot.IDref_fil_commande)) ?? 0)
        marque(lot)
      }
      return { prix, complet }
    }
    for (const idLot of lotsByEcru.get(n(se.IDstock_ecru)) ?? []) {
      const lot = filById.get(idLot)
      if (!lot) continue
      const pct = pctByComp.get(compKey(n(se.IDref_ecru), n(se.IDcolori_ecru), n(lot.IDcolori_fil))) ?? 0
      prix += (pct * (prixCommandeFil.get(n(lot.IDref_fil_commande)) ?? 0)) / 100
      marque(lot)
    }
    return { prix, complet }
  }

  /** Façon tricotage : le prix réel de la ligne sst, sinon le prix standard de
   *  la référence écru (le repli de la requête légataire). */
  function coutTricotage(se: Record<string, unknown>, refEcru: number): number {
    const idSrc = n(se.IDref_commande_source)
    if (prixLcs.has(idSrc)) return prixLcs.get(idSrc) as number
    return prixRefEcru.get(refEcru) ?? 0
  }

  // Forfaits d'ennoblissement (grille standard, tranche figée)
  const tranches = tte.filter((t) =>
    n(t.IDsous_traitant) === 0 && n(t.quantite_mini) <= TRANCHE_QUANTITE && n(t.quantite_maxi) >= TRANCHE_QUANTITE)
  const prixTraitement = new Map<number, number>()
  const prixTeinture = new Map<number, number>()
  for (const t of tranches) {
    const kt = n(t.IDtraitement); if (kt) prixTraitement.set(kt, (prixTraitement.get(kt) ?? 0) + n(t.prix))
    const kd = n(t.IDteinture); if (kd) prixTeinture.set(kd, (prixTeinture.get(kd) ?? 0) + n(t.prix))
  }
  const traitementsOfRefFini = new Map<number, number[]>()
  for (const r of trf) {
    const k = n(r.IDref_fini)
    const l = traitementsOfRefFini.get(k)
    if (l) l.push(n(r.IDtraitement)); else traitementsOfRefFini.set(k, [n(r.IDtraitement)])
  }

  // ── 1. FIL
  const aFil = new Accu('fil', ORDRE_FIL, BAREME_FIL)
  for (const lot of sfil) {
    const kgLot = n(lot.stock)
    // Le fil confié (autres IDclient) est dans nos murs mais pas à notre bilan.
    if (kgLot <= 0 || n(lot.IDclient) !== CLIENT_ETM) continue
    const pu = prixCommandeFil.get(n(lot.IDref_fil_commande))
    if (pu == null || pu <= 0) aFil.incompletes++
    const prixKg = pu != null && pu > 0 ? pu : prixCatalogueFil.get(n(lot.IDref_fil)) ?? 0
    aFil.add(
      bucketFil(refsElasthanne.has(n(lot.IDref_fil)), kgLot, d8(lot.date_entree), asOf),
      kgLot, kgLot * prixKg,
    )
  }

  // ── 2 & 3. TOMBÉ DE MÉTIER — écru encore en stock, scindé par l'affectation
  //
  // « en stock » = non expédié ET pas encore devenu un rouleau fini (règle ETM
  // de CLAUDE.md). Le partage dispo / en ennoblissement se fait sur
  // `IDref_commande_affectation` : une pièce affectée à un ennoblisseur est
  // partie en traitement. Ce n'est PAS le magasin — MATEL apparaît dans les
  // deux inventaires imprimés, donc le critère lui est orthogonal.
  const ecruConsomme = new Set<number>()
  for (const f of fini) { const s = n(f.IDstock_ecru); if (s > 0) ecruConsomme.add(s) }
  const aDispo = new Accu('tm_dispo', ORDRE_PIECE, BAREME_PIECE)
  const aEnCours = new Accu('tm_en_cours', ORDRE_PIECE, BAREME_PIECE)
  for (const se of ecru) {
    if (n(se.IDligne_expedition_ETM) !== 0) continue
    if (ecruConsomme.has(n(se.IDstock_ecru))) continue
    const poids = n(se.poids)
    const { prix: cf, complet } = coutFilEcru(se)
    // Un écru n'est pas encore ennobli : son coût est fil + façon tricotage.
    const prixKg = cf + coutTricotage(se, n(se.IDref_ecru))
    const accu = n(se.IDref_commande_affectation) !== 0 ? aEnCours : aDispo
    if (!complet) accu.incompletes++
    accu.add(bucketPiece(n(se.second_choix) === 1, d8(se.date_saisie), asOf), poids, poids * prixKg)
  }

  // ── 4. FINI
  const aFini = new Accu('fini', ORDRE_PIECE, BAREME_PIECE)
  for (const roll of fini) {
    if (n(roll.IDligne_expedition) !== 0) continue
    if (n(roll.IDetat_stock_fini) !== ETAT_EN_STOCK) continue
    const se = ecruById.get(n(roll.IDstock_ecru))
    if (!se) continue
    const poids = n(se.poids)
    const { prix: cf, complet } = coutFilEcru(se)
    if (!complet) aFini.incompletes++
    const ct = coutTricotage(se, refEcruOfFini.get(n(roll.IDref_fini)) ?? 0)
    let ce = prixLcs.get(n(roll.IDref_commande_source)) ?? 0
    if (!ce) {
      let traitements = 0
      for (const t of traitementsOfRefFini.get(n(roll.IDref_fini)) ?? []) traitements += prixTraitement.get(t) ?? 0
      ce = traitements + (prixTeinture.get(teintureOfColoris.get(n(roll.IDColoris)) ?? 0) ?? 0)
    }
    aFini.add(bucketPiece(n(roll.second_choix) === 1, d8(roll.date_saisie), asOf), poids, poids * (cf + ct + ce))
  }

  const types = [aFil.result(), aDispo.result(), aEnCours.result(), aFini.result()]
  const t = (k: 'poids' | 'brut' | 'net') => types.reduce((s, x) => s + x[k], 0)
  const brut = t('brut')
  const net = t('net')
  return {
    date: asOf,
    types,
    total: {
      poids: t('poids'),
      brut,
      net,
      provision: brut - net,
      taux_provision: brut > 0 ? (brut - net) / brut : null,
    },
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────
//
// `valoriserStock` lit une douzaine de tables en entier (stock_fini ~45 k
// lignes, stock_ecru, composition_ecru…). C'est acceptable pour un widget qu'on
// ouvre, pas pour deux endpoints finance appelés à chaque affichage d'écran.
// Le stock ne bouge pas à la seconde : 5 minutes de mémoïsation suffisent, et
// c'est le même ordre que le cache des détecteurs de notifications (60 s).

const TTL_MS = 5 * 60_000
let cache: { at: number; jour: string; data: ValorisationStock } | null = null

/** `valoriserStock()` mémoïsé. Le cache est invalidé au changement de JOUR en
 *  plus du TTL : les règles d'âge sont relatives à la date, donc un résultat
 *  calculé hier est faux aujourd'hui même s'il a moins de 5 minutes. */
export async function valoriserStockCache(): Promise<ValorisationStock> {
  const jour = todayDigits()
  if (cache && cache.jour === jour && Date.now() - cache.at < TTL_MS) return cache.data
  const data = await valoriserStock()
  cache = { at: Date.now(), jour, data }
  return data
}
