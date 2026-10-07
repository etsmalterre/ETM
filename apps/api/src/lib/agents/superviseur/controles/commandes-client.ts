// Agent « Superviseur » — checks on open ETM client orders (IDsociete 1, not
// the TRM mirrors, not donations):
//   - couverture: a line due within 21 days is not covered by rolls or planned
//     knitting → pièces à affecter / production à lancer;
//   - ennoblissement: écru reserved to a fini line is not at a dyer while the
//     délai approaches → ennoblissement à lancer.
// Both read the same open lines once per run (chargerLignes, memoised on the
// run's nowMs). The reservation gauge is the screen's own
// (lineReservationAggregates: donations and dyed écru excluded, planned
// knitting included), so a finding matches what Clients › Commandes shows.

import { query } from '../../../hfsql-auto.js'
import { consumedEcruIds } from '../../../fini-sources.js'
import { lineReservationAggregates } from '../../../../routes/commandes-client.js'
import type { Constat, ContexteControle, Controle } from '../types.js'
import { ACCORDS_LIVRAISON_PARTIELLE, COUVERTURE_RETARD_MAX_J, delaiTexte, evaluerCouverture, evaluerEnnoblissement, evaluerRetard, fmt, messageRetard, raisonCouverture, raisonEnnoblissement, raisonRetard, RETARD_URGENT_J } from './regles.js'
import { FINI_EXPEDIABLE_SQL } from '../../../fini-expediable.js'
import { noms } from './noms.js'

interface LigneOuverte {
  id: number
  commandeId: number
  numero: number
  clientId: number
  client: string
  typeKind: number
  refId: number
  coloriId: number
  reference: string
  quantite: number
  unite: number
  dateLivraison: string
  affecte: number
  expedie: number
}

const CHUNK = 300

async function lire(): Promise<LigneOuverte[]> {
  const cmds = await query<{ IDcommande_client: number; numero: number; IDclient: number; donation: number | null }>(
    `SELECT IDcommande_client, numero, IDclient, donation FROM commande_client
     WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND est_soldee = 0`,
  )
  const ouvertes = cmds.filter((c) => Number(c.donation) !== 1)
  const parId = new Map(ouvertes.map((c) => [Number(c.IDcommande_client), c]))
  const ids = [...parId.keys()]
  const lignes: Array<Record<string, unknown>> = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    // TYPE is a reserved word → alias; never name the accented delai_annoncé.
    lignes.push(...(await query<Record<string, unknown>>(
      `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind, IDreference, IDcolori, quantite, unite, date_livraison
       FROM ligne_commande_client WHERE IDcommande_client IN (${ids.slice(i, i + CHUNK).join(',')})`,
    )))
  }
  const rouleaux = lignes.filter((l) => [1, 2].includes(Number(l.type_kind)))
  const agg = new Map<number, { total_metrage: number; total_poids: number; exp_metrage: number; exp_poids: number }>()
  for (let i = 0; i < rouleaux.length; i += CHUNK) {
    const m = await lineReservationAggregates(rouleaux.slice(i, i + CHUNK).map((l) => ({
      id: Number(l.IDligne_commande_client), typeKind: Number(l.type_kind), refId: Number(l.IDreference),
    })))
    for (const [k, v] of m) agg.set(k, v)
  }
  const [clients, finis, ecrus] = await Promise.all([
    noms('client', ouvertes.map((c) => Number(c.IDclient))),
    noms('ref_fini', rouleaux.filter((l) => Number(l.type_kind) === 2).map((l) => Number(l.IDreference))),
    noms('ref_ecru', rouleaux.filter((l) => Number(l.type_kind) === 1).map((l) => Number(l.IDreference))),
  ])
  return rouleaux.map((l) => {
    const id = Number(l.IDligne_commande_client)
    const c = parId.get(Number(l.IDcommande_client))!
    const typeKind = Number(l.type_kind)
    const unite = Number(l.unite) || 0
    const a = agg.get(id)
    const refId = Number(l.IDreference) || 0
    return {
      id,
      commandeId: Number(c.IDcommande_client),
      numero: Number(c.numero) || 0,
      clientId: Number(c.IDclient) || 0,
      client: clients.get(Number(c.IDclient)) || `Client #${c.IDclient}`,
      typeKind,
      refId,
      coloriId: Number(l.IDcolori) || 0,
      reference: (typeKind === 2 ? finis : ecrus).get(refId) || '',
      quantite: Number(l.quantite) || 0,
      unite,
      dateLivraison: typeof l.date_livraison === 'string' ? l.date_livraison : '',
      affecte: a ? (unite === 3 ? a.total_metrage : a.total_poids) : 0,
      expedie: a ? (unite === 3 ? a.exp_metrage : a.exp_poids) : 0,
    }
  })
}

let memo: { nowMs: number; lignes: Promise<LigneOuverte[]> } | null = null
function chargerLignes(ctx: ContexteControle): Promise<LigneOuverte[]> {
  if (!memo || memo.nowMs !== ctx.nowMs) memo = { nowMs: ctx.nowMs, lignes: lire() }
  return memo.lignes
}

const unite = (u: number) => (u === 3 ? 'Ml' : 'kg')

interface Disponible { qte: number; pieces: number }

/** Unassigned stock of each line's reference + coloris, in the line's unit —
 *  the « Affecter » picker's own pool (routes/commandes-client.ts
 *  fetchAffectationPayload), 1er choix only. v3, from Isabelle on Atelier
 *  Bulle: « tu aurais pu regarder s'il y avait des pièces affectables ». One
 *  flat query per reference family, only for the lines being reported. */
async function stockAffectable(lignes: LigneOuverte[]): Promise<Map<number, Disponible>> {
  const out = new Map<number, Disponible>()
  const refs = (t: number) => [...new Set(lignes.filter((l) => l.typeKind === t && l.refId > 0).map((l) => l.refId))]
  const [ecru, fini] = [refs(1), refs(2)]
  type Piece = { ref: number; col: number; poids: number | null; metrage: number | null }
  const ecrus: Array<Piece & { id: number }> = []
  for (let i = 0; i < ecru.length; i += CHUNK) {
    ecrus.push(...(await query<Piece & { id: number }>(
      `SELECT IDstock_ecru AS id, IDref_ecru AS ref, IDcolori_ecru AS col, poids, metrage FROM stock_ecru
       WHERE IDref_ecru IN (${ecru.slice(i, i + CHUNK).join(',')}) AND IDsociete = 1 AND (second_choix IS NULL OR second_choix = 0)
         AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
         AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)
         AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)`,
    )))
  }
  const consomme = await consumedEcruIds(ecrus.map((p) => Number(p.id)))
  const finis: Piece[] = []
  for (let i = 0; i < fini.length; i += CHUNK) {
    finis.push(...(await query<Piece>(
      `SELECT IDref_fini AS ref, IDColoris AS col, poids, metrage FROM stock_fini
       WHERE IDref_fini IN (${fini.slice(i, i + CHUNK).join(',')}) AND (second_choix IS NULL OR second_choix = 0)
         AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
         AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
         AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> 4)`,
    )))
  }
  const pool = { 1: ecrus.filter((p) => !consomme.has(Number(p.id))), 2: finis } as Record<number, Piece[]>
  for (const l of lignes) {
    const d: Disponible = { qte: 0, pieces: 0 }
    for (const p of pool[l.typeKind] ?? []) {
      if (Number(p.ref) !== l.refId || (l.coloriId > 0 && Number(p.col) !== l.coloriId)) continue
      d.qte += Number(l.unite === 3 ? p.metrage : p.poids) || 0
      d.pieces++
    }
    out.set(l.id, d)
  }
  return out
}

/** What to do about a missing quantity, given the unassigned stock. */
export function quoiFaire(d: Disponible | undefined, u: string): string {
  if (!d || d.pieces === 0) return 'Aucune pièce en stock à affecter : production à lancer.'
  return `En stock non affecté sur cette référence et ce coloris : ${fmt(d.qte)} ${u} (${d.pieces} pièce${d.pieces > 1 ? 's' : ''}) — à affecter.`
}
const titre = (l: LigneOuverte) => `Commande N°${l.numero} — ${l.client}${l.reference ? ` · ${l.reference}` : ''}`
const lien = (l: LigneOuverte) => `/clients/commandes?commande=${l.commandeId}`

export const controleCouverture: Controle = {
  id: 'couverture',
  domaine: 'commandes_client',
  libelle: 'Pièces à affecter / production à lancer',
  description:
    'Ligne de commande client dont le délai tombe dans les 21 jours (ou est dépassé depuis moins de 30 jours) et qui n’est pas couverte à 90 % par des pièces affectées ou du tricotage prévu. Urgent à 7 jours.',
  raisonAbsent: 'Commande soldée, ou ligne supprimée.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const aSignaler: Array<{ l: LigneOuverte; r: NonNullable<ReturnType<typeof evaluerCouverture>> }> = []
    for (const l of await chargerLignes(ctx)) {
      const r = evaluerCouverture(l, today)
      if (!r) { ctx.raison(`couverture:${l.id}`, raisonCouverture(l, today)); continue }
      aSignaler.push({ l, r })
    }
    const stock = await stockAffectable(aSignaler.map((x) => x.l))
    const out: Constat[] = []
    for (const { l, r } of aSignaler) {
      const u = unite(l.unite)
      // A client who agreed to receive what is available: worth knowing, not a point to handle.
      const accord = ACCORDS_LIVRAISON_PARTIELLE.get(l.clientId)
      out.push({
        cle: `couverture:${l.id}`,
        controle: 'couverture',
        domaine: 'commandes_client',
        gravite: accord ? 'info' : r.gravite,
        titre: titre(l),
        message: `Délai ${delaiTexte(l.dateLivraison, r.jours)} : ${fmt(l.affecte)} ${u} affectés sur ${fmt(l.quantite)} ${u} commandés, il manque ${fmt(r.manque)} ${u}. ${accord ? `Pour information (${accord}).` : quoiFaire(stock.get(l.id), u)}`,
        lien: lien(l),
      })
    }
    return out
  },
}

/** Pieces that can leave today, reserved to each line and not shipped: a
 *  Validé fini roll (isFiniExpediable), or an écru piece of an écru line in
 *  stock (not at a dyer, not dyed, not donated). In the line's unit. */
async function piecesPretes(lignes: LigneOuverte[]): Promise<Map<number, { qte: number; pieces: number }>> {
  const out = new Map<number, { qte: number; pieces: number }>()
  const parId = new Map(lignes.map((l) => [l.id, l]))
  const ajouter = (lid: number, poids: number | null, metrage: number | null) => {
    const l = parId.get(lid)
    if (!l) return
    const d = out.get(lid) ?? { qte: 0, pieces: 0 }
    d.qte += Number(l.unite === 3 ? metrage : poids) || 0
    d.pieces++
    out.set(lid, d)
  }
  const finis = lignes.filter((l) => l.typeKind === 2).map((l) => l.id)
  const ecrus = lignes.filter((l) => l.typeKind === 1).map((l) => l.id)
  for (let i = 0; i < finis.length; i += CHUNK) {
    const rows = await query<{ lid: number; poids: number | null; metrage: number | null }>(
      `SELECT IDligne_commande_client AS lid, poids, metrage FROM stock_fini
       WHERE IDligne_commande_client IN (${finis.slice(i, i + CHUNK).join(',')}) AND ${FINI_EXPEDIABLE_SQL}
         AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)`,
    )
    for (const r of rows) ajouter(Number(r.lid), r.poids, r.metrage)
  }
  const rowsEcru: Array<{ id: number; lid: number; poids: number | null; metrage: number | null }> = []
  for (let i = 0; i < ecrus.length; i += CHUNK) {
    rowsEcru.push(...(await query<{ id: number; lid: number; poids: number | null; metrage: number | null }>(
      `SELECT IDstock_ecru AS id, IDligne_commande_client AS lid, poids, metrage FROM stock_ecru
       WHERE IDligne_commande_client IN (${ecrus.slice(i, i + CHUNK).join(',')})
         AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)
         AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)`,
    )))
  }
  const consomme = await consumedEcruIds(rowsEcru.map((r) => Number(r.id)))
  for (const r of rowsEcru) if (!consomme.has(Number(r.id))) ajouter(Number(r.lid), r.poids, r.metrage)
  return out
}

export const controleRetard: Controle = {
  id: 'retard',
  domaine: 'commandes_client',
  libelle: 'Délai dépassé, pas expédié',
  description:
    `Ligne de commande client couverte mais pas expédiée alors que son délai est passé depuis 1 à ${COUVERTURE_RETARD_MAX_J} jours. Dit ce qui est prêt à partir (rouleaux fini validés, pièces écru en stock) : à expédier, ou prévenir le client et reporter le délai. Urgent à ${RETARD_URGENT_J} jours de retard. Une ligne en retard et pas couverte est signalée par « Pièces à affecter / production à lancer » ; une ligne dont tout ce qui était affecté est parti (reliquat) ne l’est pas.`,
  raisonAbsent: 'Commande soldée, ou ligne supprimée.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const lignes = await chargerLignes(ctx)
    // Ready pieces are read only for the lines the rule could report.
    const candidates = lignes.filter((l) => evaluerRetard({ ...l, pret: 1, piecesPretes: 1 }, today))
    const prets = await piecesPretes(candidates)
    const out: Constat[] = []
    for (const l0 of lignes) {
      const p = prets.get(l0.id)
      const l = { ...l0, pret: p?.qte ?? 0, piecesPretes: p?.pieces ?? 0 }
      const cle = `retard:${l.id}`
      const r = evaluerRetard(l, today)
      if (!r) { ctx.raison(cle, raisonRetard(l, today)); continue }
      // A client who agreed to receive what is available: worth knowing, not a point to handle.
      const accord = ACCORDS_LIVRAISON_PARTIELLE.get(l.clientId)
      out.push({
        cle,
        // A moved délai that passes again is a new delay.
        empreinte: l.dateLivraison,
        controle: 'retard',
        domaine: 'commandes_client',
        gravite: accord ? 'info' : r.gravite,
        titre: titre(l),
        message: `Délai ${delaiTexte(l.dateLivraison, -r.joursRetard)} : ${messageRetard(l, r.pret)}${accord ? ` Pour information (${accord}).` : ''}`,
        lien: lien(l),
      })
    }
    return out
  },
}

export const controleEnnoblissement: Controle = {
  id: 'ennoblissement',
  domaine: 'commandes_client',
  libelle: 'Ennoblissement à lancer',
  description:
    'Ligne fini dont le délai tombe dans les 30 jours alors que de l’écru lui est réservé sans être parti chez le teinturier (ni teint, ni donné). Urgent à 14 jours.',
  raisonAbsent: 'Commande soldée, ou ligne supprimée.',
  async executer(ctx) {
    const today = new Date(ctx.nowMs)
    const finis = (await chargerLignes(ctx)).filter((l) => l.typeKind === 2)
    const ids = finis.map((l) => l.id)
    const rows: Array<{ IDstock_ecru: number; IDligne_commande_client: number; poids: number | null }> = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      rows.push(...(await query<{ IDstock_ecru: number; IDligne_commande_client: number; poids: number | null }>(
        `SELECT IDstock_ecru, IDligne_commande_client, poids FROM stock_ecru
         WHERE IDligne_commande_client IN (${ids.slice(i, i + CHUNK).join(',')})
           AND IDref_commande_affectation = 0
           AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)`,
      )))
    }
    // Dyed écru (own fini child, or component of a merged roll) is represented
    // by its fini roll — never "not sent" (#1188).
    const consomme = await consumedEcruIds(rows.map((r) => Number(r.IDstock_ecru)))
    const kg = new Map<number, number>()
    for (const r of rows) {
      if (consomme.has(Number(r.IDstock_ecru))) continue
      const lid = Number(r.IDligne_commande_client)
      kg.set(lid, (kg.get(lid) ?? 0) + (Number(r.poids) || 0))
    }
    const out: Constat[] = []
    for (const l of finis) {
      const k = kg.get(l.id) ?? 0
      const r = evaluerEnnoblissement(k, l.dateLivraison, today)
      if (!r) { ctx.raison(`ennoblissement:${l.id}`, raisonEnnoblissement(k, l.dateLivraison, today)); continue }
      out.push({
        cle: `ennoblissement:${l.id}`,
        controle: 'ennoblissement',
        domaine: 'commandes_client',
        gravite: r.gravite,
        titre: titre(l),
        message: `Délai ${delaiTexte(l.dateLivraison, r.jours)} : ${fmt(k, 1)} kg d’écru réservés à la ligne ne sont pas partis en teinture. Ennoblissement à lancer.`,
        lien: lien(l),
      })
    }
    return out
  },
}
