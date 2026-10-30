// Yarn reserved for a client order line (decision Vincent 2026-10-23).
//
// Why: a line waiting for yarn ordered from a supplier read « à lancer » (3911: the bleu 1721 was
// ordered the same day as the client order, 660 kg due 05/11, but nothing tied the two, so the line
// went amber, and red from 06/11, while Malterre had already done its part). Reserving makes the
// wait a fact: the line reads « attente fil », neutral until the supplier's date, red once it passes
// (relancer le fournisseur).
//
// One reservation row, three homes over its life (state derived from the columns, etatReservation):
//   commande   on a yarn ORDER line still to receive (idref_fil_commande, no lot yet)
//   lot        the lot was created from that order line on TRM Fils › Stock (ordi visitage), or
//              linked to it on ETM Fils › Commandes: the reservation moved onto the lot, earliest
//              client délai first, split when the lot covers it only in part (basculerSurLot)
//   consommee  the knitting order launched from the client line took the lot: it holds the yarn as
//              its own asso_fil_lignecmdsst row (lib/lancement-tricotage.ts), which « Réservé »
//              already counts — never counted twice
//   liberee    the order line was closed with less received than reserved: the remainder is
//              released, kept for the line's history (« 100 kg de fil manquants »)
// A knitting order never takes yarn still on order: it goes out with its lots or not at all
// (lib/lancement-tricotage.ts), so the line waits « attente fil » until the lot is in.
// « Réservé » of a yarn (lib/fil-etat.ts) = asso rows + the open reservations (commande, lot).
// An order line reads « reçue » by itself from 95 % received (SEUIL_RECEPTION); the ORDER is never
// closed automatically: a person closes it after checking (Vincent).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { lotsLibres } from './lancement-tricotage.js'

/** An order line counts as received from this share of its quantity (weights vary a little). */
export const SEUIL_RECEPTION = 0.95

export type EtatReservation = 'commande' | 'lot' | 'consommee' | 'liberee'

export interface ReservationFil {
  id: number
  idligne_commande_client: number
  idref_fil: number
  idcolori_fil: number
  quantite: number
  idref_fil_commande: number
  idstock_fil: number
  idligne_commande_sous_traitant: number
  idasso_fil_lignecmdsst: number
  liberee_le: Date | null
  motif_liberation: string | null
  cree_le: Date
  cree_par: string | null
}

export function etatReservation(r: Pick<ReservationFil, 'liberee_le' | 'idligne_commande_sous_traitant' | 'idasso_fil_lignecmdsst' | 'idstock_fil'>): EtatReservation {
  if (r.liberee_le) return 'liberee'
  if (r.idligne_commande_sous_traitant > 0) return 'consommee'
  return r.idstock_fil > 0 ? 'lot' : 'commande'
}

/** Counted in the yarn's « Réservé » (the consumed ones are counted through their asso row). */
export function compteDansReserve(e: EtatReservation): boolean {
  return e === 'commande' || e === 'lot'
}

/** Still waiting for the yarn to arrive (the client line reads « attente fil »). */
export function attendLeFil(e: EtatReservation): boolean {
  return e === 'commande'
}

const round2 = (x: number) => Math.round(x * 100) / 100

export interface Candidat {
  id: number
  quantite: number
  /** the client line's délai, YYYYMMDD or null (served last) */
  delai: string | null
}

/** Pure: how a lot of `kg` serves the waiting reservations, earliest délai first (no délai last,
 *  then oldest reservation). A reservation the lot covers only in part takes what is left. */
export function repartirSurLot(candidats: readonly Candidat[], kg: number): { id: number; kg: number; reste: number }[] {
  const tries = [...candidats].sort((a, b) =>
    (a.delai ?? '99999999').localeCompare(b.delai ?? '99999999') || a.id - b.id)
  const out: { id: number; kg: number; reste: number }[] = []
  let dispo = round2(kg)
  for (const c of tries) {
    if (!(dispo > 0)) break
    const pris = round2(Math.min(c.quantite, dispo))
    if (!(pris > 0)) continue
    out.push({ id: c.id, kg: pris, reste: round2(c.quantite - pris) })
    dispo = round2(dispo - pris)
  }
  return out
}

/** Pure: whether an order line reads « reçue » from what its lots weighed in. */
export function ligneRecue(quantite: number, recu: number): boolean {
  return quantite > 0 && recu >= quantite * SEUIL_RECEPTION
}

// ── Reads ───────────────────────────────────────────────────

const COLONNES = `id, idligne_commande_client, idref_fil, idcolori_fil, quantite::float8 AS quantite,
  idref_fil_commande, idstock_fil, idligne_commande_sous_traitant, idasso_fil_lignecmdsst,
  liberee_le, motif_liberation, cree_le, cree_par`

export async function reservationsDesLignes(ligneIds: readonly number[]): Promise<ReservationFil[]> {
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  if (ids.length === 0) return []
  const sql = mpsPg()
  return sql.unsafe<ReservationFil[]>(
    `SELECT ${COLONNES} FROM reservation_fil WHERE idligne_commande_client = ANY($1::bigint[]) ORDER BY id`, [ids as any])
}

export async function reservationsDuFil(refFil: number, coloriFil: number): Promise<ReservationFil[]> {
  const sql = mpsPg()
  return sql.unsafe<ReservationFil[]>(
    `SELECT ${COLONNES} FROM reservation_fil WHERE idref_fil = $1 AND idcolori_fil = $2 ORDER BY id`, [refFil, coloriFil])
}

export interface LigneCommandeFil {
  id: number
  idcommande_fil: number
  idref_fil: number
  idcolori_fil: number
  quantite: number
  /** YYYYMMDD or null */
  date_livraison: string | null
  etat: number
  etat_commande: number
  idfournisseur: number
  /** Σ stock_initial of the lots linked to the line */
  recu: number
}

const ymd = (d: unknown): string | null => {
  if (d instanceof Date && !isNaN(d.getTime())) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  }
  const s = String(d ?? '').replace(/\D/g, '').slice(0, 8)
  return /^\d{8}$/.test(s) && s !== '00000000' ? s : null
}

/** Yarn order lines by id, or the open ones of these (ref, coloris) pairs. */
export async function lignesCommandeFil(filtre: { ids?: readonly number[]; paires?: readonly { refFil: number; coloriFil: number }[]; ouvertes?: boolean }): Promise<LigneCommandeFil[]> {
  const sql = mpsPg()
  const conds: string[] = []
  const params: unknown[] = []
  if (filtre.ids) {
    const ids = [...new Set(filtre.ids.filter((x) => x > 0))]
    if (ids.length === 0) return []
    params.push(ids)
    conds.push(`l.idref_fil_commande = ANY($${params.length}::bigint[])`)
  }
  if (filtre.paires) {
    if (filtre.paires.length === 0) return []
    const parts = filtre.paires.map((p) => {
      params.push(p.refFil, p.coloriFil)
      return `(l.idref_fil = $${params.length - 1} AND l.idcolori_fil = $${params.length})`
    })
    conds.push(`(${parts.join(' OR ')})`)
  }
  if (filtre.ouvertes) conds.push('l.etat = 0 AND c.etat = 0')
  const rows = await sql.unsafe<any[]>(
    `SELECT l.idref_fil_commande AS id, l.idcommande_fil, l.idref_fil, l.idcolori_fil, l.quantite::float8 AS quantite,
            l.date_livraison, l.etat, c.etat AS etat_commande, c.idfournisseur,
            COALESCE((SELECT SUM(s.stock_initial) FROM stock_fil s WHERE s.idref_fil_commande = l.idref_fil_commande), 0)::float8 AS recu
       FROM ref_fil_commande l JOIN commande_fil c ON c.idcommande_fil = l.idcommande_fil
      WHERE ${conds.length ? conds.join(' AND ') : 'true'}
      ORDER BY l.date_livraison NULLS LAST, l.idref_fil_commande`, params as any[])
  return rows.map((r) => ({
    id: Number(r.id),
    idcommande_fil: Number(r.idcommande_fil),
    idref_fil: Number(r.idref_fil),
    idcolori_fil: Number(r.idcolori_fil) || 0,
    quantite: Number(r.quantite) || 0,
    date_livraison: ymd(r.date_livraison),
    etat: Number(r.etat) || 0,
    etat_commande: Number(r.etat_commande) || 0,
    idfournisseur: Number(r.idfournisseur) || 0,
    recu: Number(r.recu) || 0,
  }))
}

/** What a client line waits for: its reservations still on an open order line, with the
 *  supplier's date (statut « attente fil », and red once the date has passed). */
export async function filAttenduParLigne(ligneIds: readonly number[]): Promise<Map<number, { kg: number; date: string | null; commande: number }[]>> {
  const out = new Map<number, { kg: number; date: string | null; commande: number }[]>()
  const res = (await reservationsDesLignes(ligneIds)).filter((r) => attendLeFil(etatReservation(r)) && r.idref_fil_commande > 0)
  if (res.length === 0) return out
  const lignes = new Map((await lignesCommandeFil({ ids: res.map((r) => r.idref_fil_commande) })).map((l) => [l.id, l]))
  for (const r of res) {
    const l = lignes.get(r.idref_fil_commande)
    // A closed order line no longer brings anything: the reservation is (or will be) released.
    if (!l || l.etat !== 0 || l.etat_commande !== 0) continue
    const arr = out.get(r.idligne_commande_client) ?? []
    arr.push({ kg: r.quantite, date: l.date_livraison, commande: l.idcommande_fil })
    out.set(r.idligne_commande_client, arr)
  }
  return out
}

// ── Writes ──────────────────────────────────────────────────

export class RefusReservation extends Error {
  constructor(public code: string, message: string) { super(message) }
}

/** kg of an order line not yet promised: what is still to receive minus its waiting reservations. */
export async function libreSurLigneCommande(ligne: LigneCommandeFil, sql: Sql = mpsPg()): Promise<number> {
  const [{ kg }] = await sql<{ kg: number }[]>`
    SELECT COALESCE(SUM(quantite), 0)::float8 AS kg FROM reservation_fil
     WHERE idref_fil_commande = ${ligne.id} AND idstock_fil = 0 AND liberee_le IS NULL`
  return round2(Math.max(0, ligne.quantite - ligne.recu) - Number(kg))
}

/** A line may hold up to its need + 10 % of a yarn (decision Vincent 2026-10-26: taking a whole
 *  660 kg supplier order for a 650 kg need is fine, a 2 400 kg stock purchase is not). */
export const DEPASSEMENT_RESERVATION = 0.10

/** The most a line may hold of a yarn whose need is `besoin` kg. */
export function plafondReservation(besoin: number): number {
  return round2(besoin * (1 + DEPASSEMENT_RESERVATION))
}

function refuserAuDelaDuBesoin(kg: number, max: number | undefined): void {
  if (max === undefined || kg <= max + 0.05) return
  throw new RefusReservation('au_dela_du_besoin', max > 0.05
    ? `La ligne ne peut réserver que ${max.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kg de plus de ce fil (besoin + ${DEPASSEMENT_RESERVATION * 100} %).`
    : `La ligne réserve déjà son besoin en ce fil + ${DEPASSEMENT_RESERVATION * 100} %.`)
}

/** Reserve kg of a yarn order line for a client line. The caller checked the yarn is in the
 *  line's composition; `max` = what the line may still take of this yarn (never reserve beyond). */
export async function reserverSurCommande(p: { ligneClient: number; ligneCommandeFil: number; kg: number; max?: number; parId: number; par: string | null }): Promise<number> {
  const kg = round2(p.kg)
  if (!(kg > 0)) throw new RefusReservation('quantite', 'La quantité doit être positive.')
  refuserAuDelaDuBesoin(kg, p.max)
  const [l] = await lignesCommandeFil({ ids: [p.ligneCommandeFil] })
  if (!l) throw new RefusReservation('introuvable', 'Ligne de commande de fil introuvable.')
  if (l.etat !== 0 || l.etat_commande !== 0) throw new RefusReservation('commande_fil_close', 'Cette ligne de commande de fil est déjà reçue ou close.')
  const sql = mpsPg()
  return sql.begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`SELECT pg_advisory_xact_lock(hashtext('reservation_fil'), ${p.ligneCommandeFil}::int)`
    const libre = await libreSurLigneCommande(l, tx)
    if (kg > libre + 0.005) {
      throw new RefusReservation('libre_insuffisant', `Il ne reste que ${libre.toLocaleString('fr-FR')} kg libres sur cette commande de fil.`)
    }
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idref_fil_commande, cree_par_id, cree_par)
      VALUES (${p.ligneClient}, ${l.idref_fil}, ${l.idcolori_fil}, ${kg}, ${l.id}, ${p.parId}, ${p.par})
      RETURNING id`
    return Number(row.id)
  })
}

/** Reserve kg of a lot in stock for a client line (state « lot »: the yarn is there, the line
 *  reads « à lancer », and the launch dialog ticks this lot first). Free = the lot's `libre`
 *  (lib/lancement-tricotage.ts) minus what this line already holds on it. */
export async function reserverSurLot(p: { ligneClient: number; stockFil: number; kg: number; max?: number; parId: number; par: string | null }): Promise<number> {
  const kg = round2(p.kg)
  if (!(kg > 0)) throw new RefusReservation('quantite', 'La quantité doit être positive.')
  refuserAuDelaDuBesoin(kg, p.max)
  const sql = mpsPg()
  const [lot] = await sql<{ ref: number; col: number; magasin: number }[]>`
    SELECT idref_fil AS ref, idcolori_fil AS col, idmagasin AS magasin FROM stock_fil WHERE idstock_fil = ${p.stockFil}`
  if (!lot) throw new RefusReservation('introuvable', 'Lot de fil introuvable.')
  return sql.begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`SELECT pg_advisory_xact_lock(hashtext('reservation_fil_lot'), ${p.stockFil}::int)`
    const [l] = (await lotsLibres({ magasin: Number(lot.magasin) || 0, ligneClient: p.ligneClient,
      paires: [{ refFil: Number(lot.ref), coloriFil: Number(lot.col), pourcentage: 100 }] }, tx))
      .filter((x) => x.id === p.stockFil)
    const dispo = round2((l?.libre ?? 0) - (l?.reserveLigne ?? 0))
    if (kg > dispo + 0.005) {
      throw new RefusReservation('libre_insuffisant', `Il ne reste que ${Math.max(0, dispo).toLocaleString('fr-FR')} kg libres sur ce lot.`)
    }
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idstock_fil, cree_par_id, cree_par)
      VALUES (${p.ligneClient}, ${Number(lot.ref)}, ${Number(lot.col)}, ${kg}, ${p.stockFil}, ${p.parId}, ${p.par})
      RETURNING id`
    return Number(row.id)
  })
}

/** The client line's open reservation on one source: a supplier order line (still waiting on it)
 *  or a lot (in stock, not taken by a knitting order). */
async function reserveSurSource(sql: Sql, ligneClient: number, source: { kind: 'lot' | 'commande'; id: number }): Promise<{ id: number; quantite: number }[]> {
  return source.kind === 'lot'
    ? sql<{ id: number; quantite: number }[]>`
        SELECT id, quantite::float8 AS quantite FROM reservation_fil
         WHERE idligne_commande_client = ${ligneClient} AND idstock_fil = ${source.id}
           AND liberee_le IS NULL AND idasso_fil_lignecmdsst = 0 ORDER BY id DESC`
    : sql<{ id: number; quantite: number }[]>`
        SELECT id, quantite::float8 AS quantite FROM reservation_fil
         WHERE idligne_commande_client = ${ligneClient} AND idref_fil_commande = ${source.id}
           AND idstock_fil = 0 AND liberee_le IS NULL ORDER BY id DESC`
}

/** Sets what the client line holds on one source to `kg` (the Fil tab's row dialog): more =
 *  a new reservation for the difference (capped by `max`, what the line still needs, and by
 *  what is free on the source); less = the newest rows shrink or go; 0 = nothing left on it. */
export async function fixerReservation(p: {
  ligneClient: number; source: { kind: 'lot' | 'commande'; id: number }; kg: number; max?: number; parId: number; par: string | null
}): Promise<void> {
  const cible = round2(Math.max(0, p.kg))
  const sql = mpsPg()
  const rows = await reserveSurSource(sql, p.ligneClient, p.source)
  const actuel = round2(rows.reduce((s, r) => s + Number(r.quantite), 0))
  if (cible > actuel + 0.005) {
    const plus = round2(cible - actuel)
    if (p.source.kind === 'lot') await reserverSurLot({ ligneClient: p.ligneClient, stockFil: p.source.id, kg: plus, max: p.max, parId: p.parId, par: p.par })
    else await reserverSurCommande({ ligneClient: p.ligneClient, ligneCommandeFil: p.source.id, kg: plus, max: p.max, parId: p.parId, par: p.par })
    return
  }
  let aRetirer = round2(actuel - cible)
  if (!(aRetirer > 0.005)) return
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    for (const r of rows) {
      if (!(aRetirer > 0.005)) break
      const q = Number(r.quantite)
      if (q <= aRetirer + 0.005) {
        await tx`DELETE FROM reservation_fil WHERE id = ${r.id}`
        aRetirer = round2(aRetirer - q)
      } else {
        await tx`UPDATE reservation_fil SET quantite = ${round2(q - aRetirer)} WHERE id = ${r.id}`
        aRetirer = 0
      }
    }
  })
}

/** Waiting reservations of an order line move onto a lot of it (created from the line, or linked
 *  to it), earliest client délai first. Then the line reads « reçue » from SEUIL_RECEPTION, and what it will never bring is released. */
export async function basculerSurLot(ligneCommandeFil: number, stockFilId: number): Promise<{ basculees: number; recue: boolean }> {
  const sql = mpsPg()
  const basculees = await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`SELECT pg_advisory_xact_lock(hashtext('reservation_fil'), ${ligneCommandeFil}::int)`
    const [lot] = await tx<{ stock: number }[]>`SELECT stock::float8 AS stock FROM stock_fil WHERE idstock_fil = ${stockFilId}`
    if (!lot) return 0
    const [{ deja }] = await tx<{ deja: number }[]>`
      SELECT COALESCE(SUM(quantite), 0)::float8 AS deja FROM reservation_fil
       WHERE idstock_fil = ${stockFilId} AND liberee_le IS NULL AND idasso_fil_lignecmdsst = 0`
    const kg = round2((Number(lot.stock) || 0) - Number(deja))
    if (!(kg > 0)) return 0
    const attente = await tx<{ id: number; quantite: number; delai: Date | null }[]>`
      SELECT r.id, r.quantite::float8 AS quantite, l.date_livraison AS delai
        FROM reservation_fil r LEFT JOIN ligne_commande_client l ON l.idligne_commande_client = r.idligne_commande_client
       WHERE r.idref_fil_commande = ${ligneCommandeFil} AND r.idstock_fil = 0 AND r.liberee_le IS NULL`
    const parts = repartirSurLot(attente.map((a) => ({ id: Number(a.id), quantite: Number(a.quantite), delai: ymd(a.delai) })), kg)
    for (const p of parts) {
      if (p.reste > 0) {
        // The rest keeps waiting on the order line, as its own row.
        await tx`
          INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idref_fil_commande,
                                       cree_le, cree_par_id, cree_par)
          SELECT idligne_commande_client, idref_fil, idcolori_fil, ${p.reste}, idref_fil_commande,
                 cree_le, cree_par_id, cree_par
            FROM reservation_fil WHERE id = ${p.id}`
      }
      await tx`UPDATE reservation_fil SET quantite = ${p.kg}, idstock_fil = ${stockFilId} WHERE id = ${p.id}`
    }
    return parts.length
  })
  const recue = await marquerRecueSiComplete(ligneCommandeFil)
  return { basculees, recue }
}

/** A lot unlinked from its order line (a mistake): its reservations from that line wait again.
 *  Those a knitting order already took stay with it: the order went out with that very lot. */
export async function retirerDuLot(ligneCommandeFil: number, stockFilId: number): Promise<void> {
  await mpsPg()`
    UPDATE reservation_fil SET idstock_fil = 0
     WHERE idref_fil_commande = ${ligneCommandeFil} AND idstock_fil = ${stockFilId}
       AND liberee_le IS NULL AND idasso_fil_lignecmdsst = 0`
}

/** From SEUIL_RECEPTION received, the order line reads « reçue » by itself; the order header is
 *  NEVER closed here (a person closes it after checking). Returns whether the line is received. */
export async function marquerRecueSiComplete(ligneCommandeFil: number): Promise<boolean> {
  const [l] = await lignesCommandeFil({ ids: [ligneCommandeFil] })
  if (!l) return false
  if (l.etat === 0 && ligneRecue(l.quantite, l.recu)) {
    await mpsPg()`UPDATE ref_fil_commande SET etat = 1 WHERE idref_fil_commande = ${l.id} AND etat = 0`
    await libererReliquat(l.id, 'reçue')
    return true
  }
  return l.etat === 1
}

/** The order line will bring nothing more: what still waits on it is released, kept for history. */
export async function libererReliquat(ligneCommandeFil: number, motif: 'reçue' | 'close'): Promise<number> {
  const rows = await mpsPg()`
    UPDATE reservation_fil
       SET liberee_le = now(),
           motif_liberation = ${motif === 'reçue' ? 'Fil reçu en partie : reliquat non livré' : 'Ligne de commande de fil close sans ce fil'}
     WHERE idref_fil_commande = ${ligneCommandeFil} AND idstock_fil = 0 AND liberee_le IS NULL
     RETURNING id`
  return rows.length
}

/** For whom the yarn of a supplier order is held (Fils › Commandes, Vincent 2026-10-30): every
 *  reservation on its lines (still to receive) or on the lots born from them (received), with the
 *  client order it serves. Consumed ones (taken by a knitting order) stay, the yarn is still that
 *  client's; released ones too (« libéré, non livré », kept for history: callers filter by etat). */
export interface ReservationCommandeFil {
  idref_fil_commande: number
  idstock_fil: number
  lot: string | null
  etat: EtatReservation
  kg: number
  idligne_commande_client: number
  idcommande_client: number
  numero: string | null
  client: string | null
  /** the client line's délai (YYYYMMDD), the order the reception serves them in */
  delai: string | null
}

export async function reservationsDeCommandeFil(ligneIds: readonly number[]): Promise<ReservationCommandeFil[]> {
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  if (ids.length === 0) return []
  const rows = await mpsPg().unsafe<{
    idref_fil_commande: number; idstock_fil: number; lot: string | null; idligne_commande_sous_traitant: number; liberee_le: Date | null
    quantite: number; idligne_commande_client: number; idcommande_client: number | null; numero: unknown; client: string | null
    delai: string | null
  }[]>(
    `SELECT r.idref_fil_commande, r.idstock_fil, sf.lot, r.idligne_commande_sous_traitant, r.liberee_le, r.quantite,
            r.idligne_commande_client, l.idcommande_client, c.numero, cl.nom AS client,
            to_char(l.date_livraison, 'YYYYMMDD') AS delai
       FROM reservation_fil r
       LEFT JOIN stock_fil sf ON sf.idstock_fil = r.idstock_fil AND r.idstock_fil > 0
       LEFT JOIN ligne_commande_client l ON l.idligne_commande_client = r.idligne_commande_client
       LEFT JOIN commande_client c ON c.idcommande_client = l.idcommande_client
       LEFT JOIN client cl ON cl.idclient = c.idclient
      WHERE (r.idref_fil_commande = ANY($1::bigint[])
             OR r.idstock_fil IN (SELECT idstock_fil FROM stock_fil WHERE idref_fil_commande = ANY($1::bigint[])))
      ORDER BY r.id`, [ids as any])
  return rows.map((r) => ({
    idref_fil_commande: Number(r.idref_fil_commande) || 0,
    idstock_fil: Number(r.idstock_fil) || 0,
    lot: r.lot != null ? String(r.lot) : null,
    etat: etatReservation({ liberee_le: r.liberee_le, idligne_commande_sous_traitant: Number(r.idligne_commande_sous_traitant) || 0, idasso_fil_lignecmdsst: 0, idstock_fil: Number(r.idstock_fil) || 0 }),
    kg: Number(r.quantite) || 0,
    idligne_commande_client: Number(r.idligne_commande_client) || 0,
    idcommande_client: Number(r.idcommande_client) || 0,
    numero: r.numero != null ? String(r.numero) : null,
    client: r.client ?? null,
    delai: r.delai ?? null,
  }))
}
