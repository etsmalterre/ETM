// Clients › Commandes: how an order leaves (Vincent 2026-10-28, doctrine des délais §5 bis, migration 0044).
// Two simple questions in Info › Expédition, for the whole order (no line has its own mode):
//   « Départ »  who triggers the shipment — des_que_prete (us, as soon as a line is ready),
//               date_client (the date the client asked for, commande_client.date_expedition_client),
//               sur_appel (the client calls)
//   « Expédier toutes les lignes ensemble »  (expedition_groupee) combines with any départ: a ready
//               line waits while another is still in production, the order leaves around the latest D.
// Every line carries ONE date, « Prête le » (date_livraison, the engagement).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { versDatePg } from './lancement-ligne.js'
import { estUnReport, type Imputable } from './report-ligne-client.js'

export const DEPARTS = ['des_que_prete', 'date_client', 'sur_appel'] as const
export type Depart = (typeof DEPARTS)[number]

export interface Expedition {
  depart: Depart
  groupee: boolean
  /** YYYYMMDD, départ « date_client » only (null = not given yet) */
  dateClient: string | null
}

export const EXPEDITION_DEFAUT: Expedition = { depart: 'des_que_prete', groupee: false, dateClient: null }

export function departDe(v: unknown): Depart {
  return DEPARTS[Number(v)] ?? 'des_que_prete'
}

/** Each order's expédition (absent ids: the default). */
export async function expeditions(ids: readonly number[]): Promise<Map<number, Expedition>> {
  const u = [...new Set(ids.filter((x) => x > 0))]
  const out = new Map<number, Expedition>()
  if (u.length === 0) return out
  const rows = await mpsPg().unsafe<{ id: number; m: number; g: boolean; d: string | null }[]>(
    `SELECT idcommande_client AS id, mode_expedition AS m, expedition_groupee AS g, to_char(date_expedition_client, 'YYYYMMDD') AS d
       FROM commande_client WHERE idcommande_client = ANY($1::bigint[])`, [u as any])
  for (const r of rows) {
    const depart = departDe(r.m)
    out.set(Number(r.id), { depart, groupee: !!r.g, dateClient: depart === 'date_client' ? r.d : null })
  }
  return out
}

/** Writes the order's expédition (only the fields given). */
export async function fixerExpedition(commandeId: number, p: { depart?: Depart; groupee?: boolean; dateClient?: string | null }): Promise<void> {
  const sql = mpsPg()
  if (p.depart !== undefined) await sql`UPDATE commande_client SET mode_expedition = ${DEPARTS.indexOf(p.depart)} WHERE idcommande_client = ${commandeId}`
  if (p.groupee !== undefined) await sql`UPDATE commande_client SET expedition_groupee = ${p.groupee} WHERE idcommande_client = ${commandeId}`
  if (p.dateClient !== undefined) await sql`UPDATE commande_client SET date_expedition_client = ${versDatePg(p.dateClient)}::date WHERE idcommande_client = ${commandeId}`
}

/** One « Prête le » written on several lines of the order at once. A line that already had another D is
 *  a report: one why / whom for all, journaled per line; the first D stays the engagement (delai_annonce:
 *  the old D, or this one on a line without). */
export async function appliquerDateLignes(p: {
  commandeId: number; ligneIds: number[]; date: string
  report: { motif: string; imputable: Imputable } | null
  /** false while the order is « En préparation »: dates move freely, no engagement nor report (§5 ter) */
  engager: boolean
  parId: number; par: string | null
}): Promise<{ ok: true; lignes: number } | { ok: false; reportRequis: number }> {
  const datePg = versDatePg(p.date)
  if (!datePg) throw new Error('date invalide')
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    const rows = await tx<{ id: number; d: string | null; e: string | null }[]>`
      SELECT idligne_commande_client AS id, to_char(date_livraison, 'YYYYMMDD') AS d, to_char(delai_annonce, 'YYYYMMDD') AS e
        FROM ligne_commande_client
       WHERE idcommande_client = ${p.commandeId} AND idligne_commande_client = ANY(${p.ligneIds as any}::bigint[])
       FOR UPDATE`
    const reports = p.engager ? rows.filter((r) => estUnReport(r.d ?? '', p.date)) : []
    if (reports.length > 0 && !p.report) return { ok: false as const, reportRequis: reports.length }
    for (const r of rows) {
      if ((r.d ?? '') === p.date) continue
      if (!p.engager) {
        await tx`UPDATE ligne_commande_client SET date_livraison = ${datePg}::date WHERE idligne_commande_client = ${r.id}`
        continue
      }
      const engagement = r.e ?? r.d ?? p.date
      await tx`UPDATE ligne_commande_client SET date_livraison = ${datePg}::date, delai_annonce = ${versDatePg(engagement)}::date
                WHERE idligne_commande_client = ${r.id}`
      if (r.d && p.report) {
        await tx`
          INSERT INTO report_ligne_client (idligne_commande_client, ancienne_date, nouvelle_date, motif, imputable, saisi_par_id, saisi_par)
          VALUES (${r.id}, ${versDatePg(r.d)}::date, ${datePg}::date, ${p.report.motif}, ${p.report.imputable}, ${p.parId}, ${p.par})`
      }
    }
    return { ok: true as const, lignes: rows.length }
  })
}
