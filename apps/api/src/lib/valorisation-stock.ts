// ── Valorisation du stock fini ────────────────────────────────────────────
//
// Port of the legacy devaluation query (supplied by Vincent 2026-08-25, itself
// the query behind `ETAT_InventaireFini.wde`). It answers the two figures the
// annual bilan books as *production stockée* and *provision pour dépréciation
// des stocks* — the two things the Analyse financière widget structurally
// cannot see, because `upload_compta` carries neither.
//
// WHY IT LIVES IN THE APP AT ALL
//
// `inventaire_compta` is the legacy monthly snapshot (one row per stock type,
// `prix_achat` gross + `valeur_deprecie` net). It reconciles to the accountant's
// bilan **to the euro** — at 2024-12-28 it computes a 258 238 € provision where
// the 2024 bilan books 258 237 € — and it **stopped being written on
// 2025-06-28**. Fourteen months later nothing had replaced it, which is why a
// stock ageing from a 37 % to a 49 % provision rate went unseen.
//
// SCOPE — FINISHED ROLLS ONLY, AND THAT IS ON PURPOSE
//
// `inventaire_compta` covers four types (Fil / TM dispo / TM en cours / Fini).
// Only the *Fini* devaluation rules have been recovered so far, so this module
// computes that one and the UI says so. At 2024-12-28 fini was 179 142 € of a
// 373 439 € net total — under half. Do NOT present this as "the stock value".
// Adding a type = a new `TypeValorisation` entry + its own rules; the response
// shape already carries the type so the widget needs no reshaping.
//
// VALIDATION (see `scripts/check-valorisation-stock.ts`)
//
// Against the printed inventory at 31/12/2025 (21 039 kg / 283 526 € brut /
// 125 555 € net), the reconstruction lands at 20 966 kg and 287 945 € brut —
// **+1,6 %**. The residual is expected and not a formula error: the legacy query
// filters on `IDetat_stock_fini` and `IDligne_expedition`, which are
// CURRENT-STATE columns, and depreciates relative to `SYSDATE`. It is therefore
// a snapshot of *now* and cannot be replayed at a past date — which is also why
// the fourteen missing months of `inventaire_compta` are not recoverable.
//
// HFSQL discipline: flat queries + joins in JS. The legacy SQL is a nest of
// LEFT JOINs and correlated sub-queries that the Linux bridge would not survive.

import { query } from './hfsql-auto.js'
import { n } from './sst-shared.js'

/** YYYYMMDD from whatever the driver hands back for a date column.
 *
 *  ⚠️ NOT `sst-shared.dateDigits`: `stock_fini.date_saisie` comes back as a
 *  TIMESTAMP string (`"2020-10-04 00:00:00.000"`), and `dateDigits` only strips
 *  dashes then demands `/^\d{8}$/` — so it returns `''` for every single row.
 *  Silently, and an empty string loses every `>` comparison, which parked all
 *  1 157 rolls in the "plus de 2 ans" bucket at a flat 90 % provision. Strip all
 *  non-digits and take the leading date instead. */
function d8(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8)
}

/** Rolls in this état are the ones the legacy inventory counts. */
const ETAT_EN_STOCK = 3

/** The legacy query freezes the ennoblissement tariff bracket at this quantity
 *  when a roll carries no real ordered price. Its own comment says
 *  "Approximation" — so this is a forfait, not a measured cost. */
const TRANCHE_QUANTITE = 200

/** `IDclient` of ETS Malterre on `stock_fil` — yarn owned by anyone else is
 *  customer-supplied and costs us nothing, so it never counts as missing data. */
const CLIENT_ETM = 1

export interface AgeBucket {
  /** Machine key, stable for the UI. */
  key: 'second_choix' | 'moins_1_an' | 'de_1_a_2_ans' | 'plus_2_ans'
  label: string
  /** Depreciation applied, 0..1. */
  taux: number
  rouleaux: number
  poids: number
  brut: number
  net: number
}

export interface ValorisationStock {
  /** YYYYMMDD the valuation was computed at — the age rules are relative to it. */
  date: string
  type: 'fini'
  rouleaux: number
  poids: number
  /** Σ poids × (coût fil + tricotage + ennoblissement). */
  brut: number
  /** Brut minus the per-roll depreciation. */
  net: number
  /** brut − net. */
  provision: number
  /** provision / brut, 0..1. Null when brut is 0. */
  taux_provision: number | null
  buckets: AgeBucket[]
  /** Rolls whose ETM-owned yarn carries no purchase order, so their fil cost is
   *  understated. The legacy query exposes the same flag (`filNull`). */
  pieces_incompletes: number
}

/** Today as YYYYMMDD, local time (the books are French). */
function todayDigits(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** Depreciation rate for a roll, per the rules printed on the legacy inventory:
 *  second choix −90 % | moins d'un an 0 % | 1-2 ans −50 % | plus de 2 ans −90 %.
 *  Ages are relative to `asOf`, exactly as the legacy `DATEADD(YEAR, -n, SYSDATE)`. */
function bucketOf(secondChoix: boolean, dateSaisie: string, asOf: string): AgeBucket['key'] {
  if (secondChoix) return 'second_choix'
  const y = Number(asOf.slice(0, 4))
  const suffix = asOf.slice(4)
  if (dateSaisie > `${y - 1}${suffix}`) return 'moins_1_an'
  if (dateSaisie > `${y - 2}${suffix}`) return 'de_1_a_2_ans'
  return 'plus_2_ans'
}

const BUCKET_META: Record<AgeBucket['key'], { label: string; taux: number }> = {
  second_choix: { label: '2ᵉ choix', taux: 0.9 },
  moins_1_an: { label: "Moins d'un an", taux: 0 },
  de_1_a_2_ans: { label: '1 à 2 ans', taux: 0.5 },
  plus_2_ans: { label: 'Plus de 2 ans', taux: 0.9 },
}

/** Value the finished-roll stock held right now.
 *  `asOf` exists for the guard script; production always passes today. */
export async function valoriserStockFini(asOf: string = todayDigits()): Promise<ValorisationStock> {
  const [fini, ecru, afo, afst, sfil, rfc, comp, lcs, recru, rfini, trf, tte, rfcol] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT IDstock_fini, IDstock_ecru, IDref_fini, IDColoris, second_choix, date_saisie,
              IDligne_expedition, IDetat_stock_fini, IDref_commande_source
       FROM stock_fini`,
    ),
    query<Record<string, unknown>>(
      `SELECT IDstock_ecru, poids, IDordre_fabrication, IDref_ecru, IDcolori_ecru, IDref_commande_source
       FROM stock_ecru`,
    ),
    query<Record<string, unknown>>(`SELECT IDordre_fabrication, IDstock_fil, pourcentage FROM asso_fil_of`),
    query<Record<string, unknown>>(`SELECT IDstock_ecru, IDstock_fil FROM asso_fil_stock_tm`),
    query<Record<string, unknown>>(`SELECT IDstock_fil, IDcolori_fil, IDref_fil_commande, IDclient FROM stock_fil`),
    query<Record<string, unknown>>(`SELECT IDref_fil_commande, prix_unitaire FROM ref_fil_commande`),
    query<Record<string, unknown>>(
      `SELECT IDref_ecru, IDcolori_ecru, IDcolori_fil, pourcentage FROM composition_ecru`,
    ),
    query<Record<string, unknown>>(`SELECT IDligne_commande_sous_traitant, prix FROM ligne_commande_sous_traitant`),
    query<Record<string, unknown>>(`SELECT IDref_ecru, prix FROM ref_ecru`),
    query<Record<string, unknown>>(`SELECT IDref_fini, IDref_ecru FROM ref_fini`),
    query<Record<string, unknown>>(`SELECT IDref_fini, IDtraitement FROM traitement_ref_fini`),
    query<Record<string, unknown>>(
      `SELECT IDtraitement, IDteinture, IDsous_traitant, quantite_mini, quantite_maxi, prix
       FROM tranche_tarif_ennoblissement`,
    ),
    query<Record<string, unknown>>(`SELECT IDref_fini_colori, IDteinture FROM ref_fini_colori`),
  ])

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
  const teintureOfColoris = new Map<number, number>()
  for (const r of rfcol) teintureOfColoris.set(n(r.IDref_fini_colori), n(r.IDteinture))

  const afoByOf = new Map<number, Record<string, unknown>[]>()
  for (const r of afo) {
    const k = n(r.IDordre_fabrication)
    const list = afoByOf.get(k)
    if (list) list.push(r)
    else afoByOf.set(k, [r])
  }
  const lotsByEcru = new Map<number, number[]>()
  for (const r of afst) {
    const k = n(r.IDstock_ecru)
    const list = lotsByEcru.get(k)
    if (list) list.push(n(r.IDstock_fil))
    else lotsByEcru.set(k, [n(r.IDstock_fil)])
  }
  const compKey = (ref: number, colEcru: number, colFil: number) => `${ref}|${colEcru}|${colFil}`
  const pctByComp = new Map<string, number>()
  for (const r of comp) {
    pctByComp.set(compKey(n(r.IDref_ecru), n(r.IDcolori_ecru), n(r.IDcolori_fil)), n(r.pourcentage))
  }

  // Ennoblissement fallback tariffs — the standard grid (`IDsous_traitant = 0`)
  // at the frozen quantity bracket.
  const tranches = tte.filter(
    (t) =>
      n(t.IDsous_traitant) === 0 &&
      n(t.quantite_mini) <= TRANCHE_QUANTITE &&
      n(t.quantite_maxi) >= TRANCHE_QUANTITE,
  )
  const prixTraitement = new Map<number, number>()
  const prixTeinture = new Map<number, number>()
  for (const t of tranches) {
    const kt = n(t.IDtraitement)
    if (kt) prixTraitement.set(kt, (prixTraitement.get(kt) ?? 0) + n(t.prix))
    const kd = n(t.IDteinture)
    if (kd) prixTeinture.set(kd, (prixTeinture.get(kd) ?? 0) + n(t.prix))
  }
  const traitementsOfRefFini = new Map<number, number[]>()
  for (const r of trf) {
    const k = n(r.IDref_fini)
    const list = traitementsOfRefFini.get(k)
    if (list) list.push(n(r.IDtraitement))
    else traitementsOfRefFini.set(k, [n(r.IDtraitement)])
  }

  /** €/kg of yarn for one écru piece, plus whether its cost is complete.
   *  In-house production reads the OF's actual consumption; a piece bought from
   *  a knitter reads the reference composition applied to the lots allocated to
   *  it. Both price at the PURCHASE ORDER price, never the catalogue. */
  function coutFil(se: Record<string, unknown>): { prix: number; complet: boolean } {
    let prix = 0
    let complet = true
    const markIfOurs = (lot: Record<string, unknown>) => {
      if (n(lot.IDclient) === CLIENT_ETM && !prixCommandeFil.has(n(lot.IDref_fil_commande))) complet = false
    }
    const idOf = n(se.IDordre_fabrication)
    if (idOf !== 0) {
      for (const a of afoByOf.get(idOf) ?? []) {
        const lot = filById.get(n(a.IDstock_fil))
        if (!lot) continue
        prix += (n(a.pourcentage) / 100) * (prixCommandeFil.get(n(lot.IDref_fil_commande)) ?? 0)
        markIfOurs(lot)
      }
      return { prix, complet }
    }
    for (const idLot of lotsByEcru.get(n(se.IDstock_ecru)) ?? []) {
      const lot = filById.get(idLot)
      if (!lot) continue
      const pct = pctByComp.get(compKey(n(se.IDref_ecru), n(se.IDcolori_ecru), n(lot.IDcolori_fil))) ?? 0
      prix += (pct * (prixCommandeFil.get(n(lot.IDref_fil_commande)) ?? 0)) / 100
      markIfOurs(lot)
    }
    return { prix, complet }
  }

  const buckets = new Map<AgeBucket['key'], AgeBucket>()
  for (const key of Object.keys(BUCKET_META) as AgeBucket['key'][]) {
    buckets.set(key, { key, ...BUCKET_META[key], rouleaux: 0, poids: 0, brut: 0, net: 0 })
  }

  let rouleaux = 0
  let poidsTotal = 0
  let brut = 0
  let net = 0
  let incompletes = 0

  for (const roll of fini) {
    if (n(roll.IDligne_expedition) !== 0) continue
    if (n(roll.IDetat_stock_fini) !== ETAT_EN_STOCK) continue
    const se = ecruById.get(n(roll.IDstock_ecru))
    if (!se) continue

    const poids = n(se.poids)
    const { prix: cf, complet } = coutFil(se)
    if (!complet) incompletes++

    // Tricotage: the real façon price when the piece carries its sst line,
    // else the écru reference's standard price (the legacy fallback).
    const idSource = n(se.IDref_commande_source)
    const coutTricotage = prixLcs.has(idSource)
      ? (prixLcs.get(idSource) as number)
      : prixRefEcru.get(refEcruOfFini.get(n(roll.IDref_fini)) ?? 0) ?? 0

    // Ennoblissement: the real ordered price, else the tariff approximation.
    let coutEnnob = prixLcs.get(n(roll.IDref_commande_source)) ?? 0
    if (!coutEnnob) {
      let traitements = 0
      for (const t of traitementsOfRefFini.get(n(roll.IDref_fini)) ?? []) {
        traitements += prixTraitement.get(t) ?? 0
      }
      coutEnnob = traitements + (prixTeinture.get(teintureOfColoris.get(n(roll.IDColoris)) ?? 0) ?? 0)
    }

    const valeurBrute = poids * (cf + coutTricotage + coutEnnob)
    const key = bucketOf(n(roll.second_choix) === 1, d8(roll.date_saisie), asOf)
    const valeurNette = valeurBrute * (1 - BUCKET_META[key].taux)

    const b = buckets.get(key) as AgeBucket
    b.rouleaux++
    b.poids += poids
    b.brut += valeurBrute
    b.net += valeurNette

    rouleaux++
    poidsTotal += poids
    brut += valeurBrute
    net += valeurNette
  }

  return {
    date: asOf,
    type: 'fini',
    rouleaux,
    poids: poidsTotal,
    brut,
    net,
    provision: brut - net,
    taux_provision: brut > 0 ? (brut - net) / brut : null,
    // Fixed order: newest first, second choix last — it is not an age.
    buckets: (['moins_1_an', 'de_1_a_2_ans', 'plus_2_ans', 'second_choix'] as const).map(
      (k) => buckets.get(k) as AgeBucket,
    ),
    pieces_incompletes: incompletes,
  }
}
