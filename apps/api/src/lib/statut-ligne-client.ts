// Clients › Commandes: the computed status of a client order line (ETM).
//
// Why (2026-10-08): ligne_commande_client.commentaire was used as a hand-typed status (« soldé » 965,
// « PAE » 872, « en STT » 297, « en tricotage » 21…), out of date as soon as the goods moved. The status
// is now read from the facts; the commentaire stays free text and is never written here. Measured on the
// 102 open lines carrying a typed status: 83 agree, 6 more where the comment was simply stale, 4 on order
// 3802 typed « soldé » with nothing shipped (42 validated rolls at MATEL, reserved to no line), 5 where the
// knitting / stock was never linked to the line, 3 at 86–89 % shipped. `screen_notes.md` § 3.
//
// One ladder, most advanced first; each step names the fact that proves it:
//   soldee       commande_client.est_soldee = 1 (closed by hand, whatever shipped)
//   expediee     shipped ≥ SEUIL_EXPEDIE of the quantity
//   pae          shipped + ready (validated fini roll état 3, or for an écru line the écru in stock) ≥ seuil
//   ennoblisseur écru reserved to the line and to a dyer line, not dyed yet; a fini roll of the line still
//                En Contrôle / En Reprise / Attente de décision (they sit at the dyer, MATEL magasin 9); or a
//                dyer order launched from the line and still open
//   tricotage    affectation_cmd_tricotage on a knitting sst line not done, on an order not soldée
//   a_lancer     none of the above
// Divers lines (type 3) carry no rolls: a_lancer / expediee only, partial shown by the shipped share.

import { query } from './hfsql-auto.js'
import { consumedEcruIds } from './fini-sources.js'

/** A line counts as shipped from 90 % of its quantity: what people do when they type « soldé » (39 of 44
 *  open lines, 803 of 859 closed ones). Shared with the espace client (lib/espace-commandes.ts). */
export const SEUIL_EXPEDIE = 0.9

export type EtatLigneClient = 'soldee' | 'expediee' | 'pae' | 'ennoblisseur' | 'tricotage' | 'a_lancer'

export interface FaitsLigneClient {
  quantite: number
  /** commande_client.est_soldee */
  soldee: boolean
  /** in the line's unit */
  expedie: number
  /** in the line's unit: validated fini rolls not shipped (écru line: écru in stock, not shipped) */
  pret: number
  nbPret: number
  /** fini rolls of the line still in control at the dyer (états 1, 2, 5) */
  nbControle: number
  /** écru pieces reserved to the line and to a dyer line, not dyed yet */
  nbChezEnnoblisseur: number
  /** open dyer orders launched from the line */
  nbCommandesEnnoblisseur: number
  /** one of the line's open dyer lines is « Soumis au client » */
  soumisClient: boolean
  /** kg planned on a knitting sst line not done */
  kgTricotage: number
}

export interface StatutLigneClient {
  etat: EtatLigneClient
  /** shipped share of the quantity, 0..n (null when the quantity is 0) */
  part: number | null
  /** what proves the état, French, one short sentence per fact */
  preuves: string[]
}

const fmt = (x: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: 1 })
const pluriel = (n: number, mot: string, pl = `${mot}s`) => `${n} ${n > 1 ? pl : mot}`

export function statutLigneClient(f: FaitsLigneClient, unite: string): StatutLigneClient {
  const q = f.quantite
  const part = q > 0 ? f.expedie / q : null
  const preuves: string[] = []
  if (f.expedie > 0) preuves.push(`${fmt(f.expedie)} ${unite} expédiés${q > 0 ? ` sur ${fmt(q)}` : ''}`)
  if (f.nbPret > 0) preuves.push(`${pluriel(f.nbPret, 'pièce')} prête${f.nbPret > 1 ? 's' : ''} (${fmt(f.pret)} ${unite})`)
  if (f.nbControle > 0) preuves.push(`${pluriel(f.nbControle, 'rouleau', 'rouleaux')} en contrôle chez l’ennoblisseur`)
  if (f.nbChezEnnoblisseur > 0) preuves.push(`${pluriel(f.nbChezEnnoblisseur, 'pièce')} écru chez l’ennoblisseur`)
  if (f.nbCommandesEnnoblisseur > 0 && f.nbChezEnnoblisseur === 0) preuves.push(`${pluriel(f.nbCommandesEnnoblisseur, 'commande')} ennoblisseur ouverte${f.nbCommandesEnnoblisseur > 1 ? 's' : ''}`)
  if (f.soumisClient) preuves.push('Soumis au client')
  if (f.kgTricotage > 0) preuves.push(`${fmt(f.kgTricotage)} kg planifiés en tricotage`)

  const seuil = q * SEUIL_EXPEDIE
  let etat: EtatLigneClient
  if (f.soldee) etat = 'soldee'
  else if (q <= 0 ? f.expedie > 0 : f.expedie >= seuil) etat = 'expediee'
  else if (f.pret > 0 && f.expedie + f.pret >= seuil) etat = 'pae'
  else if (f.nbControle > 0 || f.nbChezEnnoblisseur > 0 || f.nbCommandesEnnoblisseur > 0 || f.soumisClient) etat = 'ennoblisseur'
  else if (f.kgTricotage > 0) etat = 'tricotage'
  else if (f.pret > 0) etat = 'pae' // ready but short of the quantity: the remainder is launched nowhere
  else etat = 'a_lancer'
  return { etat, part, preuves }
}

// ── Facts (I/O) ─────────────────────────────────────────────

export interface LigneClientMeta {
  id: number
  /** ligne_commande_client.TYPE: 1 écru, 2 fini, 3 divers */
  typeKind: number
  refId: number
  /** 3 = Ml, anything else = Kg (lineDim) */
  unite: number
  quantite: number
  soldee: boolean
  /** divers lines only: shipped quantity, already known by the caller (expedition_divers ledger) */
  expedieDivers?: number
}

const CHUNK = 400
async function queryIn<T>(ids: readonly number[], sql: (inList: string) => string): Promise<T[]> {
  const u = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  const out: T[] = []
  for (let i = 0; i < u.length; i += CHUNK) out.push(...(await query<T>(sql(u.slice(i, i + CHUNK).join(',')))))
  return out
}

const num = (v: unknown) => Number(v) || 0
const isTermine = (s: unknown) => String(s ?? '').startsWith('Termin')

function vide(l: LigneClientMeta): FaitsLigneClient {
  return {
    quantite: l.quantite, soldee: l.soldee, expedie: 0, pret: 0, nbPret: 0, nbControle: 0,
    nbChezEnnoblisseur: 0, nbCommandesEnnoblisseur: 0, soumisClient: false, kgTricotage: 0,
  }
}

/** The facts of each line, batched (flat queries, merged in JS). */
export async function faitsLignesClient(lignes: readonly LigneClientMeta[]): Promise<Map<number, FaitsLigneClient>> {
  const out = new Map<number, FaitsLigneClient>()
  for (const l of lignes) {
    const f = vide(l)
    if (l.typeKind === 3) f.expedie = l.expedieDivers ?? 0
    out.set(l.id, f)
  }
  // A closed order's lines need nothing more than what shipped (the état is « soldée » anyway).
  const rolls = lignes.filter((l) => l.typeKind === 1 || l.typeKind === 2)
  if (rolls.length === 0) return out
  const ids = rolls.map((l) => l.id)
  const meta = new Map(rolls.map((l) => [l.id, l]))
  const metrage = (lid: number) => meta.get(lid)?.unite === 3

  // rendement: an écru piece counts poids × rendement on a Ml line (lineReservationAggregates' rule).
  const finiRefs = rolls.filter((l) => l.typeKind === 2).map((l) => l.refId)
  const ecruRefs = rolls.filter((l) => l.typeKind === 1).map((l) => l.refId)
  const [rdtFini, rdtEcru] = await Promise.all([
    queryIn<{ IDref_fini: number; rendement: number | null }>(finiRefs, (inl) => `SELECT IDref_fini, rendement FROM ref_fini WHERE IDref_fini IN (${inl})`),
    queryIn<{ IDref_ecru: number; rendement: number | null }>(ecruRefs, (inl) => `SELECT IDref_ecru, rendement FROM ref_ecru WHERE IDref_ecru IN (${inl})`),
  ])
  const rdtF = new Map(rdtFini.map((r) => [num(r.IDref_fini), num(r.rendement)]))
  const rdtE = new Map(rdtEcru.map((r) => [num(r.IDref_ecru), num(r.rendement)]))
  const rdt = (lid: number) => {
    const l = meta.get(lid)
    if (!l) return 0
    return (l.typeKind === 2 ? rdtF.get(l.refId) : rdtE.get(l.refId)) ?? 0
  }
  const qteEcru = (lid: number, poids: number, m: number) => (metrage(lid) ? (rdt(lid) > 0 ? poids * rdt(lid) : m) : poids)

  const [fini, ecruRaw, le, tricot, sstHeads] = await Promise.all([
    // Donated pieces never keep the line (#1173): filtered anyway, the legacy wrote the two FKs apart.
    queryIn<{ lid: number; metrage: number | null; poids: number | null; etat: number | null; lexp: number | null }>(ids, (inl) =>
      `SELECT IDligne_commande_client AS lid, metrage, poids, IDetat_stock_fini AS etat, IDligne_expedition AS lexp
       FROM stock_fini WHERE IDligne_commande_client IN (${inl}) AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)`),
    queryIn<{ IDstock_ecru: number; lid: number; metrage: number | null; poids: number | null; lexp: number | null; aff: number | null }>(ids, (inl) =>
      `SELECT IDstock_ecru, IDligne_commande_client AS lid, metrage, poids, IDligne_expedition_ETM AS lexp, IDref_commande_affectation AS aff
       FROM stock_ecru WHERE IDligne_commande_client IN (${inl}) AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)`),
    // Legacy shipments put rolls on a shipment line without reserving them first (espace-commandes rule).
    queryIn<{ IDligne_expedition: number; lid: number }>(ids, (inl) =>
      `SELECT IDligne_expedition, IDligne_commande_client AS lid FROM ligne_expedition WHERE IDligne_commande_client IN (${inl})`),
    queryIn<{ lid: number; poids_affecte: number | null; lsst: number }>(ids, (inl) =>
      `SELECT IDligne_commande_client AS lid, poids_affecte, IDligne_commande_sous_traitant AS lsst FROM affectation_cmd_tricotage WHERE IDligne_commande_client IN (${inl})`),
    queryIn<{ IDcommande_sous_traitant: number; lid: number; est_soldee: number | null }>(ids, (inl) =>
      `SELECT IDcommande_sous_traitant, IDligne_commande_client AS lid, est_soldee FROM commande_sous_traitant WHERE IDligne_commande_client IN (${inl})`),
  ])

  // Écru already dyed (own fini child or component of a merged roll) is its fini roll now (#1188).
  const consumed = await consumedEcruIds(ecruRaw.map((r) => num(r.IDstock_ecru)))
  const ecru = ecruRaw.filter((r) => !consumed.has(num(r.IDstock_ecru)))

  // Shipped: reserved rolls shipped, or rolls on the line's shipment lines; the larger of the two.
  const expRes = new Map<number, number>()
  const add = (m: Map<number, number>, k: number, v: number) => m.set(k, (m.get(k) ?? 0) + v)
  for (const r of fini) {
    const lid = num(r.lid)
    const f = out.get(lid)
    if (!f) continue
    const qte = metrage(lid) ? num(r.metrage) : num(r.poids)
    const etat = num(r.etat)
    if (etat === 4 || num(r.lexp) > 0) add(expRes, lid, qte)
    else if (etat === 3) { f.pret += qte; f.nbPret += 1 }
    else if (etat === 1 || etat === 2 || etat === 5) f.nbControle += 1
  }
  for (const r of ecru) {
    const lid = num(r.lid)
    const f = out.get(lid)
    if (!f) continue
    const qte = qteEcru(lid, num(r.poids), num(r.metrage))
    if (num(r.lexp) > 0) add(expRes, lid, qte)
    else if (num(r.aff) > 0) f.nbChezEnnoblisseur += 1
    else if (meta.get(lid)?.typeKind === 1) { f.pret += qte; f.nbPret += 1 }
  }

  const lidParLe = new Map(le.map((r) => [num(r.IDligne_expedition), num(r.lid)]))
  const leIds = [...lidParLe.keys()]
  const [finiBl, ecruBl] = await Promise.all([
    queryIn<{ lexp: number; metrage: number | null; poids: number | null }>(leIds, (inl) =>
      `SELECT IDligne_expedition AS lexp, metrage, poids FROM stock_fini WHERE IDligne_expedition IN (${inl})`),
    queryIn<{ lexp: number; metrage: number | null; poids: number | null }>(leIds, (inl) =>
      `SELECT IDligne_expedition_ETM AS lexp, metrage, poids FROM stock_ecru WHERE IDligne_expedition_ETM IN (${inl})`),
  ])
  const expBl = new Map<number, number>()
  for (const r of finiBl) {
    const lid = lidParLe.get(num(r.lexp)) ?? 0
    if (lid) add(expBl, lid, metrage(lid) ? num(r.metrage) : num(r.poids))
  }
  for (const r of ecruBl) {
    const lid = lidParLe.get(num(r.lexp)) ?? 0
    if (lid) add(expBl, lid, qteEcru(lid, num(r.poids), num(r.metrage)))
  }
  for (const [lid, f] of out) {
    if (meta.has(lid)) f.expedie = Math.max(expRes.get(lid) ?? 0, expBl.get(lid) ?? 0)
  }

  // Subcontractor lines: knitting planned on the line, dyer orders launched from it.
  const openHeads = sstHeads.filter((h) => num(h.est_soldee) !== 1)
  const lidParSst = new Map(openHeads.map((h) => [num(h.IDcommande_sous_traitant), num(h.lid)]))
  const [lsstTricot, lsstEnno] = await Promise.all([
    queryIn<{ id: number; cmd: number; sstatut: string | null }>(tricot.map((t) => num(t.lsst)), (inl) =>
      `SELECT IDligne_commande_sous_traitant AS id, IDcommande_sous_traitant AS cmd, sstatut FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant IN (${inl})`),
    queryIn<{ cmd: number; kind: number; sstatut: string | null }>([...lidParSst.keys()], (inl) =>
      `SELECT IDcommande_sous_traitant AS cmd, TYPE AS kind, sstatut FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant IN (${inl})`),
  ])
  // Knitting lines are rarely closed (908 « En_Cours », many on soldée orders): the order head decides too.
  const tetesSoldees = new Set((await queryIn<{ cmd: number; est_soldee: number | null }>(lsstTricot.map((r) => num(r.cmd)), (inl) =>
    `SELECT IDcommande_sous_traitant AS cmd, est_soldee FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${inl})`))
    .filter((r) => num(r.est_soldee) === 1).map((r) => num(r.cmd)))
  const tricotOuvert = new Set(lsstTricot.filter((r) => !isTermine(r.sstatut) && !tetesSoldees.has(num(r.cmd))).map((r) => num(r.id)))
  for (const t of tricot) {
    const f = out.get(num(t.lid))
    if (f && tricotOuvert.has(num(t.lsst))) f.kgTricotage += num(t.poids_affecte)
  }
  const cmdsOuvertes = new Map<number, Set<number>>()
  for (const r of lsstEnno) {
    if (num(r.kind) !== 2 || isTermine(r.sstatut)) continue
    const lid = lidParSst.get(num(r.cmd)) ?? 0
    const f = out.get(lid)
    if (!f) continue
    const s = cmdsOuvertes.get(lid) ?? new Set<number>()
    s.add(num(r.cmd))
    cmdsOuvertes.set(lid, s)
    if (String(r.sstatut ?? '').startsWith('Soumis')) f.soumisClient = true
  }
  for (const [lid, s] of cmdsOuvertes) out.get(lid)!.nbCommandesEnnoblisseur = s.size
  return out
}
