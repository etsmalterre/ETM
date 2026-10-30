// Clients › Commandes: how an order leaves (doctrine des délais §5 bis; revised by Vincent 2026-10-30).
// The ORDER answers one question, Info › Expédition: « Expédier toutes les lignes ensemble »
// (expedition_groupee) — ticked, one date is written on every line still to ship and a ready line waits
// for the others. The DÉPART is each LINE's (ligne_commande_client.mode_livraison): dès que prête (0) or
// sur appel du client (2), read by departLigne(). Every line carries ONE date, « Prête le »
// (date_livraison, the engagement).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { versDatePg } from './lancement-ligne.js'
import { estUnReport, type Imputable } from './report-ligne-client.js'

/** A line's départ: the client calls for it, or it leaves as soon as it is ready (every other stored value). */
export const DEPARTS_LIGNE = ['des_que_prete', 'sur_appel'] as const
export type DepartLigne = (typeof DEPARTS_LIGNE)[number]
export function departLigne(v: unknown): DepartLigne {
  return Number(v) === 2 ? 'sur_appel' : 'des_que_prete'
}
/** The stored value (ligne_commande_client.mode_livraison, the legacy scale). */
export function codeDepartLigne(d: DepartLigne): number {
  return d === 'sur_appel' ? 2 : 0
}

export interface Expedition {
  groupee: boolean
}

export const EXPEDITION_DEFAUT: Expedition = { groupee: false }

/** Each order's expédition (absent ids: the default). */
export async function expeditions(ids: readonly number[]): Promise<Map<number, Expedition>> {
  const u = [...new Set(ids.filter((x) => x > 0))]
  const out = new Map<number, Expedition>()
  if (u.length === 0) return out
  const rows = await mpsPg().unsafe<{ id: number; g: boolean }[]>(
    `SELECT idcommande_client AS id, expedition_groupee AS g FROM commande_client WHERE idcommande_client = ANY($1::bigint[])`, [u as any])
  for (const r of rows) out.set(Number(r.id), { groupee: !!r.g })
  return out
}

/** Writes the order's « ensemble ». */
export async function fixerExpedition(commandeId: number, p: { groupee: boolean }): Promise<void> {
  await mpsPg()`UPDATE commande_client SET expedition_groupee = ${p.groupee} WHERE idcommande_client = ${commandeId}`
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
