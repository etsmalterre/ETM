// Bulk loader behind the website catalogue (lib/webservice-site.ts — the
// replacement of the WinDev REST webservice MPS_WS, claude_doc/webservice_legacy.md).
//
// Every table the catalogue needs is read ONCE, whole, with flat queries, and
// priced in memory through the same pure engine the ERP uses
// (`assembleTarifFini` / `prixFilLines`). Pricing ~470 references × their
// coloris plus ~2 000 client designations one `calcTarifRefFini` at a time
// would be ~10 queries per coloris on the one serialized HFSQL bridge; this is
// ~20 queries for the whole catalogue.
//
// HFSQL rules applied here (CLAUDE.md § HFSQL):
//   • SELECT * only on tables that tolerate it (ref_fini, ref_ecru,
//     designation_client, ref_client_colori, asso_fil_matiere,
//     matiere_premiere, categorie_produit) — accented keys read by prefix;
//   • explicit ASCII column lists on tables holding a blob (ref_fini_colori,
//     colori_ecru, client) — SELECT * returns 0 rows there on Windows;
//   • accented label VALUES repaired with one batched CONVERT per column
//     (`batchRepair`), never per row.

import { query } from './hfsql-auto.js'
import { batchRepair } from './batch-repair.js'
import { pickVal } from './accented-keys.js'
import { parseDtMs } from './production-trm.js'
import { repairMatiereLibelle, type CompositionRow } from './composition-matieres.js'
import type { BandRow } from './pricing-fini-tarif.js'

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string => (v == null ? '' : String(v)).trim()
const flag = (v: unknown): boolean => num(v) === 1
/** `associee` holds a list of associated designations, "0" meaning none —
 *  the legacy service printed "" for that. */
const associee = (v: unknown): string => (str(v) === '0' ? '' : str(v))

export interface RefFiniRow {
  IDref_fini: number
  IDref_ecru: number
  IDcolori_ecru: number
  reference: string
  designation: string
  avec_teinture: number
  poids_Moy: number
  laizeHT_Moy: number
  rendement: number
  associee: string
  archive: boolean
  /** ref_fini.dateModification, epoch ms (0 when empty). */
  modifiedMs: number
}

export interface RefEcruRow {
  IDref_ecru: number
  reference: string
  poids: number
  prix: number
  IDcontexture: number
  bio: boolean
  recycle: boolean
}

export interface ColorisRow {
  id: number
  reference: string
}

export interface RefFiniColoriRow extends ColorisRow {
  IDref_fini: number
  IDteinture: number
  gots: boolean
}

export interface ColoriEcruRow extends ColorisRow {
  IDref_ecru: number
}

export interface DesignationRow {
  IDdesignation_client: number
  IDclient: number
  IDref_fini: number
  IDref_ecru: number
  designation: string
  associee: string
  archive: boolean
  cache: boolean
  /** IDref_fil the client supplies (fil_non_facturé CSV). */
  filExclu: number[]
  modifiedMs: number
}

export interface RccRow {
  IDref_client_colori: number
  IDdesignation_client: number
  IDref_fini_colori: number
  IDcolori_ecru: number
  lst_tranche: string
  contrat: number
  archive: boolean
}

export interface TrancheTarifaireRow {
  IDref_client_colori: number
  IDcontrat_tarif: number
  nb_rouleaux: number
  coefficient: number
  prix_saisi: number
}

export interface ContratRow {
  IDcontrat_tarif: number
  IDref_client_colori: number
  date_debut: string
  date_expiration: string
}

/** The whole catalogue, loaded. Maps are keyed by the table's PK unless noted. */
export interface Catalog {
  loadedAt: number
  refFini: Map<number, RefFiniRow>
  refEcru: Map<number, RefEcruRow>
  contexture: Map<number, string>
  /** By IDref_ecru. */
  compositionByEcru: Map<number, (CompositionRow & { IDcolori_fil: number })[]>
  refFil: Map<number, { reference: string | null; prix_kg: number }>
  coloriFil: Map<number, { reference: string | null; prix_kg: number }>
  /** IDref_fil → its matières (0-1 fractions). */
  assoByFil: Map<number, { matiereId: number; frac: number }[]>
  matiereLibelle: Map<number, string>
  /** By IDref_fini, in traitement.ordre. */
  traitementsByRef: Map<number, { IDtraitement: number; designation: string | null }[]>
  bandsByTraitement: Map<number, BandRow[]>
  bandsByTeinture: Map<number, BandRow[]>
  teinture: Map<number, { label: string | null; prixGots: number }>
  /** By IDref_fini. */
  refFiniColoriByRef: Map<number, RefFiniColoriRow[]>
  refFiniColori: Map<number, RefFiniColoriRow>
  /** By IDref_ecru. */
  coloriEcruByEcru: Map<number, ColoriEcruRow[]>
  coloriEcru: Map<number, ColoriEcruRow>
  designation: Map<number, DesignationRow>
  /** By IDdesignation_client. */
  rccByDesignation: Map<number, RccRow[]>
  /** By IDref_client_colori. */
  tranchesByRcc: Map<number, TrancheTarifaireRow[]>
  contratsByRcc: Map<number, ContratRow[]>
  client: Map<number, { IDsociete: number }>
  /** Default contact's email by IDclient. */
  clientEmail: Map<number, string>
  categories: { IDCategorie: number; Label: string; Ordre: number }[]
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}

/** Parse fil_non_facturé ("12,15") into yarn ids. */
export function parseFilExclu(raw: unknown): number[] {
  return [...new Set(str(raw).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0))]
}

export async function loadCatalog(): Promise<Catalog> {
  const loadedAt = Date.now()

  // ── References ───────────────────────────────────────────
  let rfRows = await query<Record<string, unknown>>(`SELECT * FROM ref_fini`)
  rfRows = await batchRepair(rfRows, 'ref_fini', 'IDref_fini', ['reference', 'designation', 'associee'])
  const refFini = new Map<number, RefFiniRow>()
  for (const r of rfRows) {
    const id = num(r.IDref_fini)
    if (!(id > 0)) continue
    refFini.set(id, {
      IDref_fini: id,
      IDref_ecru: num(r.IDref_ecru),
      IDcolori_ecru: num(r.IDcolori_ecru),
      reference: str(r.reference),
      designation: str(r.designation),
      avec_teinture: num(r.avec_teinture),
      poids_Moy: num(r.poids_Moy),
      laizeHT_Moy: num(r.laizeHT_Moy),
      rendement: num(r.rendement),
      associee: associee(r.associee),
      archive: flag(pickVal(r, /^archiv/i)),
      modifiedMs: parseDtMs(r.dateModification) ?? 0,
    })
  }

  const reRows = await query<Record<string, unknown>>(`SELECT * FROM ref_ecru`)
  const refEcru = new Map<number, RefEcruRow>()
  for (const r of reRows) {
    const id = num(r.IDref_ecru)
    if (!(id > 0)) continue
    refEcru.set(id, {
      IDref_ecru: id,
      reference: str(r.reference),
      poids: num(r.poids),
      prix: num(r.prix),
      IDcontexture: num(r.IDcontexture),
      bio: flag(r.bio),
      recycle: flag(pickVal(r, /^recycl/i)),
    })
  }

  let ctxRows = await query<Record<string, unknown>>(`SELECT IDcontexture, nom FROM contexture`)
  ctxRows = await batchRepair(ctxRows, 'contexture', 'IDcontexture', ['nom'])
  const contexture = new Map(ctxRows.map((r) => [num(r.IDcontexture), str(r.nom)]))

  // ── Yarn cost + matière composition ──────────────────────
  const compRows = await query<Record<string, unknown>>(
    `SELECT IDref_ecru, IDcolori_ecru, IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru`,
  )
  const compositionByEcru = new Map<number, (CompositionRow & { IDcolori_fil: number })[]>()
  for (const r of compRows) {
    push(compositionByEcru, num(r.IDref_ecru), {
      IDcolori_ecru: num(r.IDcolori_ecru),
      IDref_fil: num(r.IDref_fil),
      IDcolori_fil: num(r.IDcolori_fil),
      pourcentage: r.pourcentage == null ? null : num(r.pourcentage),
    })
  }

  const filRows = await query<Record<string, unknown>>(`SELECT IDref_fil, reference, prix_kg FROM ref_fil`)
  const refFil = new Map(filRows.map((r) => [num(r.IDref_fil), { reference: str(r.reference) || null, prix_kg: num(r.prix_kg) }]))
  const cfRows = await query<Record<string, unknown>>(`SELECT IDcolori_fil, reference, prix_kg FROM colori_fil`)
  const coloriFil = new Map(cfRows.map((r) => [num(r.IDcolori_fil), { reference: str(r.reference) || null, prix_kg: num(r.prix_kg) }]))

  // asso_fil_matiere / matiere_premiere carry accented column NAMES
  // (IDMatière, IDmatière_première): SELECT * and resolve by prefix.
  const assoRows = await query<Record<string, unknown>>(`SELECT * FROM asso_fil_matiere`)
  const assoByFil = new Map<number, { matiereId: number; frac: number }[]>()
  for (const a of assoRows) {
    const filId = num(a.IDRef_fil)
    const matiereId = num(pickVal(a, /^idmati/i))
    const frac = num(a.pourcentage)
    if (filId > 0 && matiereId > 0 && frac > 0) push(assoByFil, filId, { matiereId, frac })
  }
  const matRows = await query<Record<string, unknown>>(`SELECT * FROM matiere_premiere`)
  const matiereLibelle = new Map<number, string>()
  for (const m of matRows) {
    const id = num(pickVal(m, /^idmati/i))
    const lib = repairMatiereLibelle(m.libelle)
    if (id > 0 && lib) matiereLibelle.set(id, lib)
  }

  // ── Treatments, dyes and their tariff bands (IDsous_traitant 0) ──
  const trtRows = await query<Record<string, unknown>>(`SELECT IDtraitement, designation, ordre FROM traitement`)
  const traitement = new Map(trtRows.map((r) => [num(r.IDtraitement), { designation: str(r.designation) || null, ordre: num(r.ordre) }]))
  const trfRows = await query<Record<string, unknown>>(`SELECT IDref_fini, IDtraitement FROM traitement_ref_fini`)
  const traitementsByRef = new Map<number, { IDtraitement: number; designation: string | null }[]>()
  // Same shape as calcTarifRefFini's `traitement_ref_fini JOIN traitement ORDER BY t.ordre`.
  const trfSorted = trfRows
    .map((r) => ({ IDref_fini: num(r.IDref_fini), IDtraitement: num(r.IDtraitement) }))
    .filter((r) => traitement.has(r.IDtraitement))
    .sort((a, b) => traitement.get(a.IDtraitement)!.ordre - traitement.get(b.IDtraitement)!.ordre)
  for (const r of trfSorted) {
    push(traitementsByRef, r.IDref_fini, { IDtraitement: r.IDtraitement, designation: traitement.get(r.IDtraitement)!.designation })
  }

  const bandRows = await query<Record<string, unknown>>(
    `SELECT IDtraitement, IDteinture, quantite_mini, quantite_maxi, prix
       FROM tranche_tarif_ennoblissement WHERE IDsous_traitant = 0`,
  )
  const bandsByTraitement = new Map<number, BandRow[]>()
  const bandsByTeinture = new Map<number, BandRow[]>()
  for (const r of bandRows) {
    const b: BandRow = {
      IDtraitement: num(r.IDtraitement),
      IDteinture: num(r.IDteinture),
      quantite_mini: num(r.quantite_mini),
      quantite_maxi: num(r.quantite_maxi),
      prix: num(r.prix),
    }
    if (b.IDtraitement > 0) push(bandsByTraitement, b.IDtraitement, b)
    if (b.IDteinture > 0) push(bandsByTeinture, b.IDteinture, b)
  }

  const teiRows = await query<Record<string, unknown>>(`SELECT IDteinture, designation_externe, prix_gots FROM teinture`)
  const teinture = new Map(teiRows.map((r) => [num(r.IDteinture), { label: str(r.designation_externe) || null, prixGots: num(r.prix_gots) }]))

  // ── Coloris ──────────────────────────────────────────────
  let rfcRows = await query<Record<string, unknown>>(
    `SELECT IDref_fini_colori, IDref_fini, reference, IDteinture, gots FROM ref_fini_colori`,
  )
  rfcRows = await batchRepair(rfcRows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])
  const refFiniColori = new Map<number, RefFiniColoriRow>()
  const refFiniColoriByRef = new Map<number, RefFiniColoriRow[]>()
  for (const r of rfcRows) {
    const row: RefFiniColoriRow = {
      id: num(r.IDref_fini_colori),
      IDref_fini: num(r.IDref_fini),
      reference: str(r.reference),
      IDteinture: num(r.IDteinture),
      gots: flag(r.gots),
    }
    if (!(row.id > 0)) continue
    refFiniColori.set(row.id, row)
    push(refFiniColoriByRef, row.IDref_fini, row)
  }

  let ceRows = await query<Record<string, unknown>>(`SELECT IDcolori_ecru, IDref_ecru, reference FROM colori_ecru`)
  ceRows = await batchRepair(ceRows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
  const coloriEcru = new Map<number, ColoriEcruRow>()
  const coloriEcruByEcru = new Map<number, ColoriEcruRow[]>()
  for (const r of ceRows) {
    const row: ColoriEcruRow = { id: num(r.IDcolori_ecru), IDref_ecru: num(r.IDref_ecru), reference: str(r.reference) }
    if (!(row.id > 0)) continue
    coloriEcru.set(row.id, row)
    push(coloriEcruByEcru, row.IDref_ecru, row)
  }

  // ── Client catalogues and their tarif modes ──────────────
  let dcRows = await query<Record<string, unknown>>(`SELECT * FROM designation_client`)
  dcRows = await batchRepair(dcRows, 'designation_client', 'IDdesignation_client', ['designation', 'associee'])
  const designation = new Map<number, DesignationRow>()
  for (const r of dcRows) {
    const id = num(r.IDdesignation_client)
    if (!(id > 0)) continue
    designation.set(id, {
      IDdesignation_client: id,
      IDclient: num(r.IDclient),
      IDref_fini: num(r.IDref_fini),
      IDref_ecru: num(r.IDref_ecru),
      designation: str(r.designation),
      associee: associee(r.associee),
      archive: flag(pickVal(r, /^archiv/i)),
      cache: flag(pickVal(r, /^cach/i)),
      filExclu: parseFilExclu(pickVal(r, /^fil_non_factur/i)),
      modifiedMs: parseDtMs(r.date_modification) ?? 0,
    })
  }

  const rccRows = await query<Record<string, unknown>>(`SELECT * FROM ref_client_colori`)
  const rccByDesignation = new Map<number, RccRow[]>()
  for (const r of rccRows) {
    const row: RccRow = {
      IDref_client_colori: num(r.IDref_client_colori),
      IDdesignation_client: num(r.IDdesignation_client),
      IDref_fini_colori: num(r.IDref_fini_colori),
      IDcolori_ecru: num(r.IDcolori_ecru),
      lst_tranche: str(r.lst_tranche),
      contrat: num(r.contrat),
      archive: flag(pickVal(r, /^archiv/i)),
    }
    if (row.IDref_client_colori > 0) push(rccByDesignation, row.IDdesignation_client, row)
  }

  // tranche_tarifaire.qtéMin/qtéMax and contrat_tarif.archivé are accented —
  // explicit ASCII column lists only (same as lib/tarif-client.ts).
  const ttRows = await query<Record<string, unknown>>(
    `SELECT IDref_client_colori, nb_rouleaux, coefficient, prix_saisi, IDcontrat_tarif FROM tranche_tarifaire`,
  )
  const tranchesByRcc = new Map<number, TrancheTarifaireRow[]>()
  for (const r of ttRows) {
    const row: TrancheTarifaireRow = {
      IDref_client_colori: num(r.IDref_client_colori),
      IDcontrat_tarif: num(r.IDcontrat_tarif),
      nb_rouleaux: num(r.nb_rouleaux),
      coefficient: num(r.coefficient),
      prix_saisi: num(r.prix_saisi),
    }
    if (row.IDref_client_colori > 0) push(tranchesByRcc, row.IDref_client_colori, row)
  }
  const ctRows = await query<Record<string, unknown>>(
    `SELECT IDcontrat_tarif, IDref_client_colori, date_debut, date_expiration FROM contrat_tarif`,
  )
  const contratsByRcc = new Map<number, ContratRow[]>()
  for (const r of ctRows) {
    const row: ContratRow = {
      IDcontrat_tarif: num(r.IDcontrat_tarif),
      IDref_client_colori: num(r.IDref_client_colori),
      date_debut: str(r.date_debut).replace(/\D/g, '').slice(0, 8),
      date_expiration: str(r.date_expiration).replace(/\D/g, '').slice(0, 8),
    }
    if (row.IDref_client_colori > 0) push(contratsByRcc, row.IDref_client_colori, row)
  }

  // client holds a binary memo → explicit columns only.
  const clRows = await query<Record<string, unknown>>(`SELECT IDclient, IDsociete FROM client`)
  const client = new Map(clRows.map((r) => [num(r.IDclient), { IDsociete: num(r.IDsociete) }]))
  const coRows = await query<Record<string, unknown>>(
    `SELECT IDcontact, IDclient, mail FROM contact WHERE IDclient > 0 AND est_defaut = 1`,
  )
  const clientEmail = new Map<number, string>()
  for (const r of coRows.sort((a, b) => num(a.IDcontact) - num(b.IDcontact))) {
    const id = num(r.IDclient)
    const mail = str(r.mail)
    if (id > 0 && mail && !clientEmail.has(id)) clientEmail.set(id, mail)
  }

  // categorie_produit's PK is accented (IDcatégorie_produit), so batchRepair
  // can't key on it; « é » is the only accent in these six labels.
  const catRows = await query<Record<string, unknown>>(`SELECT * FROM categorie_produit`)
  const categories = catRows
    .map((r) => ({ IDCategorie: num(pickVal(r, /^idcat/i)), Label: str(r.nom).replace(/�/g, 'é'), Ordre: num(r.ordre) }))
    .filter((c) => c.IDCategorie > 0)
    .sort((a, b) => a.IDCategorie - b.IDCategorie)

  return {
    loadedAt,
    refFini, refEcru, contexture,
    compositionByEcru, refFil, coloriFil, assoByFil, matiereLibelle,
    traitementsByRef, bandsByTraitement, bandsByTeinture, teinture,
    refFiniColoriByRef, refFiniColori, coloriEcruByEcru, coloriEcru,
    designation, rccByDesignation, tranchesByRcc, contratsByRcc,
    client, clientEmail, categories,
  }
}
