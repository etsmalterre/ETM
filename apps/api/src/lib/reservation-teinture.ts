// An écru piece on a dyer line AND reserved to a client line — the two must
// describe the same product (LIVA #1261).
//
// `stock_ecru` carries two independent pointers: `IDref_commande_affectation`
// (the ennoblisseur line that dyes it) and `IDligne_commande_client` (the
// client line it is promised to). Nothing kept them consistent: on 2026-09-28
// four Lemahieu pieces reserved to order 3874 (329D écru/écru, dyer order
// 9013) were moved onto a new dyer order 9065 in 329B noir and kept their
// écru/écru reservation. The client order's Ennoblissement tab lists only dyer
// lines of ITS reference + coloris, so it never showed 9065 and the
// reservation could not be released from anywhere.
//
// Rule: while a piece is still écru (not consumed into a fini roll — once dyed
// the pointers are stale history, `consumedEcruIds()`), a reservation next to a
// dyer line must name a FINI client line of the dyer line's reference and
// coloris. Every writer of either pointer checks it; the sst « Affectés » tab
// can release a reservation that does not fit.

import { query } from './hfsql-auto.js'
import { consumedEcruIds } from './fini-sources.js'

export interface DyeLineKey {
  /** ligne_commande_sous_traitant.IDreference (a ref_fini) */
  ref: number
  /** ligne_commande_sous_traitant.IDColoris */
  coloris: number
}

export interface ClientLineKey {
  /** ligne_commande_client.TYPE — 1 écru, 2 fini */
  type: number
  ref: number
  /** ligne_commande_client.IDcolori */
  coloris: number
}

/** A reservation fits the dyer line when it is a fini line of the same
 *  reference and coloris. A 0 coloris on either side (old lines, before
 *  #1215 made it mandatory) does not decide. */
export function reservationFitsDyeLine(client: ClientLineKey, dye: DyeLineKey): boolean {
  if (client.type !== 2) return false
  if (client.ref !== dye.ref) return false
  return client.coloris === dye.coloris || client.coloris === 0 || dye.coloris === 0
}

export interface ReservationMisfit {
  stockEcruId: number
  numero: string
  commandeNumero: string
}

export const RESERVATION_MISFIT_ERROR = 'reservation_autre_article'

/** The message shown to the user, naming the pieces and the client orders. */
export function misfitMessage(misfits: readonly ReservationMisfit[], action: string): string {
  const byCmd = new Map<string, string[]>()
  for (const m of misfits) {
    const list = byCmd.get(m.commandeNumero) ?? []
    list.push(m.numero)
    byCmd.set(m.commandeNumero, list)
  }
  const parts = [...byCmd].map(([cmd, nums]) => `${nums.join(', ')} (commande client ${cmd})`)
  const plural = misfits.length > 1
  return `${action} : ${plural ? 'les pièces' : 'la pièce'} ${parts.join(' ; ')} ${plural ? 'sont réservées' : 'est réservée'} `
    + 'pour une autre référence ou un autre coloris. Retirez d’abord la réservation client.'
}

interface ClientLineRow extends ClientLineKey {
  id: number
  commandeNumero: string
}

/** Brief client lines by id (type, ref, coloris, order number). */
export async function loadClientLineKeys(lineIds: readonly number[]): Promise<Map<number, ClientLineRow>> {
  const out = new Map<number, ClientLineRow>()
  const list = [...new Set(lineIds.filter((x) => x > 0))]
  if (list.length === 0) return out
  // TYPE is a reserved word — always aliased.
  const rows = await query<Record<string, unknown>>(
    `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind, IDreference, IDcolori
       FROM ligne_commande_client WHERE IDligne_commande_client IN (${list.join(',')})`,
  )
  const cmdIds = [...new Set(rows.map((r) => Number(r.IDcommande_client) || 0).filter((x) => x > 0))]
  const numByCmd = new Map<number, string>()
  if (cmdIds.length > 0) {
    const cmds = await query<{ IDcommande_client: number; numero: unknown }>(
      `SELECT IDcommande_client, numero FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`,
    )
    for (const c of cmds) numByCmd.set(Number(c.IDcommande_client), String(c.numero ?? '').trim())
  }
  for (const r of rows) {
    const id = Number(r.IDligne_commande_client) || 0
    out.set(id, {
      id,
      type: Number(r.type_kind) || 0,
      ref: Number(r.IDreference) || 0,
      coloris: Number(r.IDcolori) || 0,
      commandeNumero: numByCmd.get(Number(r.IDcommande_client) || 0) ?? '?',
    })
  }
  return out
}

/** Pieces among `stockEcruIds` whose client reservation would not fit a dyer
 *  line of `dye`. Free pieces and dyed pieces never misfit. */
export async function findReservationMisfits(
  stockEcruIds: readonly number[],
  dye: DyeLineKey,
): Promise<ReservationMisfit[]> {
  const list = [...new Set(stockEcruIds.filter((x) => x > 0))]
  if (list.length === 0) return []
  const rows = await query<{ IDstock_ecru: number; numero: unknown; IDligne_commande_client: number | null }>(
    `SELECT IDstock_ecru, numero, IDligne_commande_client FROM stock_ecru
      WHERE IDstock_ecru IN (${list.join(',')}) AND IDligne_commande_client > 0`,
  )
  if (rows.length === 0) return []
  const consumed = await consumedEcruIds(rows.map((r) => Number(r.IDstock_ecru)))
  const live = rows.filter((r) => !consumed.has(Number(r.IDstock_ecru)))
  const lines = await loadClientLineKeys(live.map((r) => Number(r.IDligne_commande_client) || 0))
  const out: ReservationMisfit[] = []
  for (const r of live) {
    const line = lines.get(Number(r.IDligne_commande_client) || 0)
    // A reservation to a line that no longer exists is not this rule's job.
    if (!line || reservationFitsDyeLine(line, dye)) continue
    out.push({ stockEcruId: Number(r.IDstock_ecru), numero: String(r.numero ?? '').trim(), commandeNumero: line.commandeNumero })
  }
  return out.sort((a, b) => a.numero.localeCompare(b.numero, 'fr', { numeric: true }))
}

/** Pieces still écru on a dyer line — the set a change of the dyer line's
 *  reference or coloris must keep consistent. */
export async function ecruIdsOnDyeLine(dyeLineId: number): Promise<number[]> {
  const rows = await query<{ IDstock_ecru: number }>(
    `SELECT IDstock_ecru FROM stock_ecru WHERE IDref_commande_affectation = ${dyeLineId}`,
  )
  return rows.map((r) => Number(r.IDstock_ecru))
}

/** Pieces among `stockEcruIds` that sit on a dyer line and are still écru —
 *  an ÉCRU client line can never take them (they leave as a fini). */
export async function ecruStillAtDyer(stockEcruIds: readonly number[]): Promise<number[]> {
  const list = [...new Set(stockEcruIds.filter((x) => x > 0))]
  if (list.length === 0) return []
  const rows = await query<{ IDstock_ecru: number }>(
    `SELECT IDstock_ecru FROM stock_ecru WHERE IDstock_ecru IN (${list.join(',')}) AND IDref_commande_affectation > 0`,
  )
  const ids = rows.map((r) => Number(r.IDstock_ecru))
  const consumed = await consumedEcruIds(ids)
  return ids.filter((id) => !consumed.has(id))
}

export const ECRU_AT_DYER_MESSAGE = 'Cette pièce est sur une commande d’ennoblissement : elle ne peut pas être réservée à une ligne écru.'
