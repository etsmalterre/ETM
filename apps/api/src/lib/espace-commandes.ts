// A customer's own orders, as the espace client (etsmalterre-site) shows them — read by
// GET /api/site/espace/clients/:id/commandes[/:idCommande] (routes/webservice-site.ts).
//
// Same data and rules as Clients › Commandes (routes/commandes-client.ts, whose helpers are reused), with two
// differences:
//  - scoped to ONE client: an order of another client is « not found », never an error that tells it exists;
//  - only what the customer may see. Never add: commentaire_interne (« Journal »), observations_facturation,
//    client.commentaire (« Fiche client »), IDdossier, the proforma, tombé de métier, subcontractors (supply tabs),
//    roll reservations / magasins, and the LINE commentaire (staff shorthand: « en stt », « S LE 09/01 » — the
//    confirmation PDF doesn't print it). The ORDER commentaire is the customer-facing one: the PDF prints it.
//
// Status: ETM's only order status is est_soldee, closed by hand. The customer sees what actually shipped
// (statutCommande below). « Expédié » is ETM's own figure (lineReservationAggregates: rolls of the line with
// état Expédié or on a shipment; divers: the expedition_divers ledger). Donation orders are not the customer's.

import { query, fixEncoding } from './hfsql-auto.js'
import { stripRtf } from './rtf-utils.js'
import { withAdresseADefinir, isAdresseADefinir } from './adresse-a-definir.js'
import {
  diversKey,
  diversShippedByArticle,
  lineDim,
  lineReservationAggregates,
  resolveColorisLabel,
  resolveDiversVariations,
  resolveLineLabels,
  resolveRefLabel,
  resolveTransporteurNamesCC,
  uniteLabel,
} from '../routes/commandes-client.js'

// ── Status (pure) ───────────────────────────────────────────

export type StatutCommande = 'en_cours' | 'partielle' | 'expediee' | 'soldee'
/** `soldee`: the order was closed before this line shipped in full (cancelled, delivered short…). */
export type StatutLigne = 'a_venir' | 'partielle' | 'expediee' | 'soldee'

/** A line counts as shipped from 95 % of its quantity: rolls never add up to the exact metre/kilo ordered, and
 *  a 780 ml delivery on an 800 ml line must not read « partiellement expédiée » for ever. */
export const SEUIL_EXPEDIE = 0.95

/** `expedie` null = not measurable (a line in U or m² on rolls): it stays « à venir » until the order is soldée. */
export function statutLigne(quantite: number, expedie: number | null): StatutLigne {
  if (expedie === null || expedie <= 0) return 'a_venir'
  if (quantite <= 0 || expedie >= quantite * SEUIL_EXPEDIE) return 'expediee'
  return 'partielle'
}

export function statutCommande(estSoldee: boolean, lignes: StatutLigne[]): StatutCommande {
  if (estSoldee) return 'soldee'
  if (lignes.length > 0 && lignes.every((s) => s === 'expediee')) return 'expediee'
  if (lignes.some((s) => s === 'partielle' || s === 'expediee')) return 'partielle'
  return 'en_cours'
}

/** HFSQL YYYYMMDD → YYYY-MM-DD; anything else (empty, 0, garbage) → null. */
export function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim().slice(0, 8)
  if (!/^\d{8}$/.test(s) || s === '00000000') return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

const round2 = (v: number) => Math.round(v * 100) / 100

function chunks<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function queryIn<T>(ids: number[], sql: (inList: string) => string): Promise<T[]> {
  const u = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  const out: T[] = []
  for (const c of chunks(u)) out.push(...(await query<T>(sql(c.join(',')))))
  return out
}

// ── Shapes (the portal's, camelCase — the WordPress plugin never reads espace/*) ──

export interface CommandeResume {
  id: number
  numero: number | null
  date: string | null
  /** The customer's own order reference (their PO). */
  refClient: string | null
  statut: StatutCommande
  nbLignes: number
  lignesExpediees: number
  /** Σ quantité × prix, € HT, before remise and frais de port. */
  montantHt: number
  /** Earliest planned ship date of a line not shipped yet (open orders only). */
  prochaineExpedition: string | null
  /** Malterre references on the order, for the portal's search. */
  references: string[]
}

export interface Adresse {
  nom: string
  lignes: string[]
  cp: string
  ville: string
  pays: string
}

export interface LigneCommande {
  id: number
  type: 'fini' | 'ecru' | 'divers'
  /** Malterre reference (fini / écru) or article name (divers). */
  reference: string
  coloris: string | null
  /** Divers: the variation labels (couleur, taille…). */
  variantes: string[]
  /** The customer's catalogue entry (IDdesignation_client) of this reference, when it has exactly one. */
  idCatalogue: number | null
  quantite: number
  /** Ml, Kg, unité, m² */
  unite: string
  prix: number
  montant: number
  /** Planned ship date (ETM « Expédition »), not a delivery date. */
  expeditionPrevue: string | null
  /** Shipped so far, in the line's unit; null when it can't be measured. */
  expedie: number | null
  statut: StatutLigne
}

export interface Expedition {
  /** The BL number (ETM: the expedition's id). */
  numero: number
  kind: 'formelle' | 'divers'
  date: string | null
  transporteur: string | null
  nbRouleaux: number
  nbColis: number
  metrage: number
  poids: number
}

export interface FactureCommande {
  numero: number | null
  date: string | null
  type: 'facture' | 'avoir'
}

export interface CommandeDetail extends Omit<CommandeResume, 'references'> {
  commentaire: string | null
  adresseLivraison: Adresse | null
  adresseFacturation: Adresse | null
  modePaiement: string | null
  echeance: string | null
  /** € HT */
  remise: number
  fraisPort: number
  /** montantHt − remise + fraisPort */
  netHt: number
  lignes: LigneCommande[]
  expeditions: Expedition[]
  factures: FactureCommande[]
}

// ── Lines → shipped + status ────────────────────────────────

interface LigneRow {
  IDligne_commande_client: number
  IDcommande_client: number
  type_kind: number
  IDreference: number | null
  IDcolori: number | null
  IDVariation1: number | null
  IDVariation2: number | null
  quantite: number | null
  unite: number | null
  prix: number | null
  date_livraison: string | null
}

const LIGNE_COLS = `IDligne_commande_client, IDcommande_client, TYPE AS type_kind, IDreference, IDcolori,
  IDVariation1, IDVariation2, quantite, unite, prix, date_livraison`

/** Shipped quantity per line id, in the line's own unit (null = not measurable). */
async function expedieParLigne(lignes: LigneRow[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>()
  if (lignes.length === 0) return out
  const agg = await lineReservationAggregates(lignes.filter((l) => Number(l.type_kind) !== 3).map((l) => ({
    id: Number(l.IDligne_commande_client),
    typeKind: Number(l.type_kind) || 0,
    refId: Number(l.IDreference) || 0,
  })))
  const commandesDivers = Array.from(new Set(lignes.filter((l) => Number(l.type_kind) === 3).map((l) => Number(l.IDcommande_client))))
  const divers = new Map<number, Map<string, number>>()
  for (const id of commandesDivers) divers.set(id, await diversShippedByArticle(id))

  // Legacy shipments put rolls on a shipment line without reserving them to the order line first, so the
  // reservation aggregate misses them: count the rolls of the line's shipment lines too, and keep the larger.
  const rollLines = lignes.filter((l) => Number(l.type_kind) !== 3)
  const le = await queryIn<{ IDligne_expedition: number; IDligne_commande_client: number }>(rollLines.map((l) => Number(l.IDligne_commande_client)),
    (ids) => `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDligne_commande_client IN (${ids})`)
  const ligneParLe = new Map(le.map((r) => [Number(r.IDligne_expedition), Number(r.IDligne_commande_client)]))
  const leIds = [...ligneParLe.keys()]
  const [finiExp, ecruExp] = await Promise.all([
    queryIn<{ le: number; metrage: number | null; poids: number | null }>(leIds,
      (ids) => `SELECT IDligne_expedition AS le, metrage, poids FROM stock_fini WHERE IDligne_expedition IN (${ids})`),
    queryIn<{ le: number; metrage: number | null; poids: number | null }>(leIds,
      (ids) => `SELECT IDligne_expedition_ETM AS le, metrage, poids FROM stock_ecru WHERE IDligne_expedition_ETM IN (${ids})`),
  ])
  const surBl = new Map<number, { metrage: number; poids: number }>()
  for (const r of [...finiExp, ...ecruExp]) {
    const lid = ligneParLe.get(Number(r.le)) ?? 0
    if (!lid) continue
    const a = surBl.get(lid) ?? { metrage: 0, poids: 0 }
    a.metrage += Number(r.metrage) || 0
    a.poids += Number(r.poids) || 0
    surBl.set(lid, a)
  }

  for (const l of lignes) {
    const id = Number(l.IDligne_commande_client)
    const unite = Number(l.unite) || 0
    if (Number(l.type_kind) === 3) {
      const key = diversKey(Number(l.IDreference) || 0, Number(l.IDVariation1) || 0, Number(l.IDVariation2) || 0)
      out.set(id, round2(divers.get(Number(l.IDcommande_client))?.get(key) ?? 0))
    } else if (unite === 1 || unite === 3) {
      const a = agg.get(id)
      const b = surBl.get(id)
      const metrage = lineDim(unite) === 'metrage'
      out.set(id, round2(Math.max(a ? (metrage ? a.exp_metrage : a.exp_poids) : 0, b ? (metrage ? b.metrage : b.poids) : 0)))
    } else {
      out.set(id, null)
    }
  }
  return out
}

// ── List ────────────────────────────────────────────────────

/** Every order of the client, newest first. Shipped quantities are only worked out for open orders (a soldée order
 *  is « Soldée » whatever shipped), which keeps a 500-order history to a handful of flat queries. */
export async function listeCommandesClient(idClient: number): Promise<CommandeResume[]> {
  const heads = (await fixEncoding(
    await query<{ IDcommande_client: number; numero: number | null; date_commande: string | null; ref_client: string | null; est_soldee: number | null; donation: number | null }>(
      `SELECT IDcommande_client, numero, date_commande, ref_client, est_soldee, donation FROM commande_client
       WHERE IDclient = ${idClient} AND IDsociete = 1 AND IDcommande_ETM = 0
       ORDER BY IDcommande_client DESC`,
    ),
    'commande_client', 'IDcommande_client', ['ref_client'],
  )).filter((h) => Number(h.donation) !== 1)
  if (heads.length === 0) return []

  const lignes = await queryIn<LigneRow>(heads.map((h) => Number(h.IDcommande_client)),
    (ids) => `SELECT ${LIGNE_COLS} FROM ligne_commande_client WHERE IDcommande_client IN (${ids})`)
  const parCommande = new Map<number, LigneRow[]>()
  for (const l of lignes) {
    const arr = parCommande.get(Number(l.IDcommande_client)) ?? []
    arr.push(l)
    parCommande.set(Number(l.IDcommande_client), arr)
  }

  const ouvertes = new Set(heads.filter((h) => Number(h.est_soldee) !== 1).map((h) => Number(h.IDcommande_client)))
  const [maps, expedie] = await Promise.all([
    resolveLineLabels(lignes.map((l) => ({ IDreference: l.IDreference, IDcolori: l.IDcolori, type_kind: Number(l.type_kind) || 0 }))),
    expedieParLigne(lignes.filter((l) => ouvertes.has(Number(l.IDcommande_client)))),
  ])

  const out: CommandeResume[] = []
  for (const h of heads) {
    const id = Number(h.IDcommande_client)
    const ls = parCommande.get(id) ?? []
    if (ls.length === 0) continue // an order being keyed in, nothing to show yet
    const ouverte = ouvertes.has(id)
    const statuts = ls.map((l) => statutLigne(Number(l.quantite) || 0, ouverte ? (expedie.get(Number(l.IDligne_commande_client)) ?? null) : null))
    let prochaine: string | null = null
    if (ouverte) {
      ls.forEach((l, i) => {
        const d = isoDate(l.date_livraison)
        if (statuts[i] !== 'expediee' && d && (!prochaine || d < prochaine)) prochaine = d
      })
    }
    const references = Array.from(new Set(ls
      .map((l) => resolveRefLabel(maps, Number(l.IDreference) || 0, Number(l.type_kind) || 0).label.trim())
      .filter(Boolean)))
    out.push({
      id,
      numero: h.numero != null ? Number(h.numero) : null,
      date: isoDate(h.date_commande),
      refClient: String(h.ref_client ?? '').trim() || null,
      statut: statutCommande(!ouverte, statuts),
      nbLignes: ls.length,
      lignesExpediees: ouverte ? statuts.filter((s) => s === 'expediee').length : ls.length,
      montantHt: round2(ls.reduce((s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix) || 0), 0)),
      prochaineExpedition: prochaine,
      references,
    })
  }
  return out
}

// ── Detail ──────────────────────────────────────────────────

function adresse(row: any): Adresse | null {
  if (!row) return null
  const t = (v: unknown) => String(v ?? '').trim()
  return {
    nom: t(row.nom),
    lignes: [row.adresse1, row.adresse2, row.adresse3].map(t).filter(Boolean),
    cp: t(row.cp),
    ville: t(row.ville),
    pays: t(row.pays),
  }
}

async function lireAdresse(id: number): Promise<Adresse | null> {
  if (!(id > 0)) return null
  if (isAdresseADefinir(id)) return null
  const rows = await query<any>(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${id}`)
  const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
  return adresse(withAdresseADefinir(fixed[0] ?? null))
}

async function libelle(table: 'mode_paiement' | 'echeance', id: number): Promise<string | null> {
  if (!(id > 0)) return null
  const pk = table === 'mode_paiement' ? 'IDmode_paiement' : 'IDecheance'
  const rows = await fixEncoding(await query<any>(`SELECT ${pk}, libelle FROM ${table} WHERE ${pk} = ${id}`), table, pk, ['libelle'])
  return String(rows[0]?.libelle ?? '').trim() || null
}

/** IDref_fini → the client's IDdesignation_client, when the client has exactly one live designation of it. */
async function designationsParRef(idClient: number): Promise<Map<number, number>> {
  const rows = await query<{ IDdesignation_client: number; IDref_fini: number | null }>(
    `SELECT IDdesignation_client, IDref_fini FROM designation_client WHERE IDclient = ${idClient}`,
  )
  const seen = new Map<number, number[]>()
  for (const r of rows) {
    const ref = Number(r.IDref_fini) || 0
    if (ref > 0) seen.set(ref, [...(seen.get(ref) ?? []), Number(r.IDdesignation_client)])
  }
  return new Map([...seen].filter(([, ids]) => ids.length === 1).map(([ref, ids]) => [ref, ids[0]]))
}

async function expeditionsCommande(idCommande: number): Promise<{ expeditions: Expedition[]; leIds: number[]; diversIds: number[] }> {
  const [heads, diversHeads] = await Promise.all([
    query<{ IDexpedition: number; dexp: string | null; IDtransporteur: number | null }>(
      `SELECT IDexpedition, DATE AS dexp, IDtransporteur FROM expedition WHERE IDcommande_client = ${idCommande} AND IDsociete = 1`,
    ),
    query<{ IDexpedition_divers: number; dexp: string | null; IDtransporteur: number | null }>(
      `SELECT IDexpedition_divers, DATE AS dexp, IDtransporteur FROM expedition_divers WHERE IDcommande_client = ${idCommande}`,
    ),
  ])
  const le = await queryIn<{ IDligne_expedition: number; IDexpedition: number }>(heads.map((h) => Number(h.IDexpedition)),
    (ids) => `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition WHERE IDexpedition IN (${ids})`)
  const leIds = le.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)
  const expParLe = new Map(le.map((r) => [Number(r.IDligne_expedition), Number(r.IDexpedition)]))
  const [fini, ecru, cartons, transporteurs] = await Promise.all([
    queryIn<{ le: number; metrage: number | null; poids: number | null }>(leIds,
      (ids) => `SELECT IDligne_expedition AS le, metrage, poids FROM stock_fini WHERE IDligne_expedition IN (${ids})`),
    queryIn<{ le: number; metrage: number | null; poids: number | null }>(leIds,
      (ids) => `SELECT IDligne_expedition_ETM AS le, metrage, poids FROM stock_ecru WHERE IDligne_expedition_ETM IN (${ids})`),
    queryIn<{ IDexpedition_divers: number }>(diversHeads.map((h) => Number(h.IDexpedition_divers)),
      (ids) => `SELECT IDexpedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers IN (${ids})`),
    resolveTransporteurNamesCC([...heads, ...diversHeads].map((h) => Number(h.IDtransporteur) || 0)),
  ])

  const acc = new Map<number, { n: number; metrage: number; poids: number }>()
  for (const r of [...fini, ...ecru]) {
    const exp = expParLe.get(Number(r.le)) ?? 0
    if (!exp) continue
    const a = acc.get(exp) ?? { n: 0, metrage: 0, poids: 0 }
    a.n += 1
    a.metrage += Number(r.metrage) || 0
    a.poids += Number(r.poids) || 0
    acc.set(exp, a)
  }
  const colis = new Map<number, number>()
  for (const c of cartons) colis.set(Number(c.IDexpedition_divers), (colis.get(Number(c.IDexpedition_divers)) ?? 0) + 1)

  const expeditions: Expedition[] = [
    // A shipment with no roll yet is one being prepared: not the customer's news.
    ...heads.filter((h) => acc.has(Number(h.IDexpedition))).map((h): Expedition => {
      const a = acc.get(Number(h.IDexpedition))!
      return {
        numero: Number(h.IDexpedition),
        kind: 'formelle',
        date: isoDate(h.dexp),
        transporteur: transporteurs.get(Number(h.IDtransporteur) || 0) || null,
        nbRouleaux: a.n,
        nbColis: 0,
        metrage: round2(a.metrage),
        poids: round2(a.poids),
      }
    }),
    ...diversHeads.filter((h) => colis.has(Number(h.IDexpedition_divers))).map((h): Expedition => ({
      numero: Number(h.IDexpedition_divers),
      kind: 'divers',
      date: isoDate(h.dexp),
      transporteur: transporteurs.get(Number(h.IDtransporteur) || 0) || null,
      nbRouleaux: 0,
      nbColis: colis.get(Number(h.IDexpedition_divers)) ?? 0,
      metrage: 0,
      poids: 0,
    })),
  ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.numero - a.numero)
  return { expeditions, leIds, diversIds: diversHeads.map((h) => Number(h.IDexpedition_divers)) }
}

/** Definitive invoices and credit notes of the order's shipments (ETM links them through ligne_facture →
 *  ligne_expedition; divers through facture.IDexpedition_divers). No proforma. Invoices keyed before that link
 *  existed can't be found. */
async function facturesCommande(leIds: number[], diversIds: number[]): Promise<FactureCommande[]> {
  const viaLignes = await queryIn<{ IDfacture: number }>(leIds,
    (ids) => `SELECT IDfacture FROM ligne_facture WHERE IDligne_expedition IN (${ids})`)
  const viaDivers = await queryIn<{ IDfacture: number }>(diversIds,
    (ids) => `SELECT IDfacture FROM facture WHERE IDexpedition_divers IN (${ids})`)
  const rows = await queryIn<{ IDfacture: number; numero: number | null; DATE: string | null; TYPE: number | null; IDsociete: number | null }>(
    [...viaLignes, ...viaDivers].map((r) => Number(r.IDfacture)),
    (ids) => `SELECT IDfacture, numero, DATE, TYPE, IDsociete FROM facture WHERE IDfacture IN (${ids})`)
  return rows
    .filter((r) => Number(r.IDsociete) === 1)
    .map((r): FactureCommande => ({
      numero: r.numero != null ? Number(r.numero) : null,
      date: isoDate(r.DATE),
      type: Number(r.TYPE) === 2 ? 'avoir' : 'facture',
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.numero ?? 0) - (a.numero ?? 0))
}

/** One order of the client, or null — also when it exists but belongs to someone else, or is a donation. */
export async function commandeClient(idClient: number, idCommande: number): Promise<CommandeDetail | null> {
  const rows = await query<any>(
    `SELECT IDcommande_client, IDclient, IDsociete, IDcommande_ETM, numero, date_commande, ref_client, commentaire,
            IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance, remise, frais_port, est_soldee, donation
     FROM commande_client WHERE IDcommande_client = ${idCommande}`,
  )
  const h = (await fixEncoding(rows, 'commande_client', 'IDcommande_client', ['ref_client', 'commentaire']))[0] as any
  if (!h || Number(h.IDclient) !== idClient || Number(h.IDsociete) !== 1 || Number(h.IDcommande_ETM) !== 0 || Number(h.donation) === 1) return null

  const lignesRaw = await query<LigneRow>(
    `SELECT ${LIGNE_COLS} FROM ligne_commande_client WHERE IDcommande_client = ${idCommande} ORDER BY IDligne_commande_client`,
  )
  const lignes = lignesRaw
  const soldee = Number(h.est_soldee) === 1

  const [maps, expedie, designations, variations, livraison, facturation, modePaiement, echeance, exp] = await Promise.all([
    resolveLineLabels(lignes.map((l) => ({ IDreference: l.IDreference, IDcolori: l.IDcolori, type_kind: Number(l.type_kind) || 0 }))),
    expedieParLigne(lignes),
    designationsParRef(idClient),
    resolveDiversVariations(lignes.filter((l) => Number(l.type_kind) === 3).flatMap((l) => [Number(l.IDVariation1) || 0, Number(l.IDVariation2) || 0])),
    lireAdresse(Number(h.IDadresse_livraison) || 0),
    lireAdresse(Number(h.IDadresse_facturation) || 0),
    libelle('mode_paiement', Number(h.IDmode_paiement) || 0),
    libelle('echeance', Number(h.IDecheance) || 0),
    expeditionsCommande(idCommande),
  ])
  const factures = await facturesCommande(exp.leIds, exp.diversIds)

  const lignesOut = lignes.map((l): LigneCommande => {
    const typeKind = Number(l.type_kind) || 0
    const refId = Number(l.IDreference) || 0
    const quantite = Number(l.quantite) || 0
    const prix = Number(l.prix) || 0
    const e = expedie.get(Number(l.IDligne_commande_client)) ?? null
    const type = typeKind === 3 ? 'divers' : typeKind === 1 ? 'ecru' : 'fini'
    return {
      id: Number(l.IDligne_commande_client),
      type,
      reference: resolveRefLabel(maps, refId, typeKind).label.trim(),
      coloris: resolveColorisLabel(maps, Number(l.IDcolori) || 0, typeKind, refId).trim() || null,
      variantes: type === 'divers'
        ? [Number(l.IDVariation1) || 0, Number(l.IDVariation2) || 0].map((v) => (v > 0 ? variations.get(v)?.trim() : '')).filter((v): v is string => !!v)
        : [],
      idCatalogue: type === 'fini' ? (designations.get(refId) ?? null) : null,
      quantite,
      unite: uniteLabel(l.unite),
      prix: Math.round(prix * 10_000) / 10_000,
      montant: round2(quantite * prix),
      expeditionPrevue: isoDate(l.date_livraison),
      expedie: e,
      statut: soldee && statutLigne(quantite, e) !== 'expediee' ? 'soldee' : statutLigne(quantite, e),
    }
  })
  const statuts = lignesOut.map((l) => l.statut)
  const montantHt = round2(lignesOut.reduce((s, l) => s + l.montant, 0))
  const remise = round2(Number(h.remise) || 0)
  const fraisPort = round2(Number(h.frais_port) || 0)
  let prochaine: string | null = null
  if (!soldee) for (const l of lignesOut) if (l.statut !== 'expediee' && l.expeditionPrevue && (!prochaine || l.expeditionPrevue < prochaine)) prochaine = l.expeditionPrevue

  return {
    id: idCommande,
    numero: h.numero != null ? Number(h.numero) : null,
    date: isoDate(h.date_commande),
    refClient: String(h.ref_client ?? '').trim() || null,
    statut: statutCommande(soldee, statuts),
    nbLignes: lignesOut.length,
    lignesExpediees: statuts.filter((s) => s === 'expediee').length,
    montantHt,
    prochaineExpedition: prochaine,
    commentaire: stripRtf(h.commentaire ?? '').trim() || null,
    adresseLivraison: livraison,
    adresseFacturation: facturation,
    modePaiement,
    echeance,
    remise,
    fraisPort,
    netHt: round2(montantHt - remise + fraisPort),
    lignes: lignesOut,
    expeditions: exp.expeditions,
    factures,
  }
}
