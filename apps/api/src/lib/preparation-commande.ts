// Clients › Commandes: an ETM order is « En préparation » until « Valider la commande » (doctrine des
// délais §5 ter, Vincent 2026-10-28, migration 0045). While it is prepared everything is free — lines,
// matter, dates (no report, no engagement) — and nothing leaves: no partner order, no « Planifier », no
// confirmation, no shipment, not in the espace client. It is red from its creation: preparing it is
// Malterre's to do now. Validation checks every line has its date and freezes the engagements
// (delai_annonce = date_livraison); afterwards moving a date is a report (lib/report-ligne-client.ts).

import type { Response } from 'express'
import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

/** The ETM orders of `ids` still being prepared. */
export async function commandesEnPreparation(ids: readonly number[]): Promise<Set<number>> {
  const u = [...new Set(ids.filter((x) => x > 0))]
  if (u.length === 0) return new Set()
  const rows = await mpsPg().unsafe<{ id: number }[]>(
    `SELECT idcommande_client AS id FROM commande_client
      WHERE idcommande_client = ANY($1::bigint[]) AND idsociete = 1 AND validee_le IS NULL`, [u as any])
  return new Set(rows.map((r) => Number(r.id)))
}

export async function estEnPreparation(id: number): Promise<boolean> {
  return (await commandesEnPreparation([id])).has(id)
}

/** A freshly created ETM order (or one born from a devis) starts « En préparation ». */
export async function mettreEnPreparation(id: number): Promise<void> {
  await mpsPg()`UPDATE commande_client SET validee_le = NULL, validee_par_id = 0, validee_par = NULL WHERE idcommande_client = ${id}`
}

/** 409 on a route that must wait for the validation (partner orders, Planifier, confirmation, shipping). */
export async function refuseSiEnPreparation(res: Response, commandeId: number, quoi: string): Promise<boolean> {
  if (!(await estEnPreparation(commandeId))) return false
  res.status(409).json({ error: 'commande_en_preparation', message: `La commande est en préparation : validez-la avant ${quoi}.` })
  return true
}

export interface Validation { validee_le: string | null; validee_par: string | null }

export async function validation(id: number): Promise<Validation> {
  const [r] = await mpsPg()<{ v: Date | null; par: string | null }[]>`
    SELECT validee_le AS v, validee_par AS par FROM commande_client WHERE idcommande_client = ${id}`
  return { validee_le: r?.v ? new Date(r.v).toISOString() : null, validee_par: r?.par ?? null }
}

/** « Valider la commande »: refused while a line has no date; then every date becomes the engagement. */
/** `auPlusTot`: the earliest date (YYYYMMDD) a line without a date takes (lib/delai-au-plus-tot.ts). */
export async function validerCommande(id: number, parId: number, par: string | null, auPlusTot: ReadonlyMap<number, string> = new Map()): Promise<{ ok: true } | { ok: false; message: string }> {
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    const lignes = await tx<{ id: number; d: Date | null }[]>`
      SELECT idligne_commande_client AS id, date_livraison AS d FROM ligne_commande_client WHERE idcommande_client = ${id}`
    if (lignes.length === 0) return { ok: false as const, message: 'La commande n’a aucune ligne.' }
    for (const l of lignes) {
      const d = auPlusTot.get(Number(l.id))
      if (l.d || !d) continue
      await tx`UPDATE ligne_commande_client SET date_livraison = ${`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`}::date WHERE idligne_commande_client = ${l.id}`
      l.d = new Date()
    }
    const sansDate = lignes.filter((l) => !l.d).length
    if (sansDate > 0) return { ok: false as const, message: `${sansDate} ligne${sansDate > 1 ? 's n’ont' : ' n’a'} pas encore de date « Prête le ».` }
    await tx`UPDATE ligne_commande_client SET delai_annonce = date_livraison WHERE idcommande_client = ${id}`
    await tx`UPDATE commande_client SET validee_le = now(), validee_par_id = ${parId}, validee_par = ${par} WHERE idcommande_client = ${id}`
    return { ok: true as const }
  })
}

/** Why the order can no longer go back to « En préparation » (something left or was launched), or null. */
export async function blocageRetourPreparation(id: number): Promise<string | null> {
  const sql = mpsPg()
  const [sst] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commande_sous_traitant WHERE idcommande_client = ${id}`
  if (sst.n > 0) return 'une commande partenaire a été passée depuis cette commande'
  const [trico] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM affectation_cmd_tricotage a JOIN ligne_commande_client l ON l.idligne_commande_client = a.idligne_commande_client
     WHERE l.idcommande_client = ${id}`
  if (trico.n > 0) return 'une part de commande de tricotage lui est affectée'
  const [exp] = await sql<{ n: number }[]>`
    SELECT (SELECT count(*) FROM stock_fini f JOIN ligne_commande_client l ON l.idligne_commande_client = f.idligne_commande_client
             WHERE l.idcommande_client = ${id} AND f.idligne_expedition > 0)
         + (SELECT count(*) FROM stock_ecru e JOIN ligne_commande_client l ON l.idligne_commande_client = e.idligne_commande_client
             WHERE l.idcommande_client = ${id} AND e.idligne_expedition_etm > 0) AS n`
  if (Number(exp.n) > 0) return 'des pièces ont été expédiées'
  return null
}

/** « Repasser en préparation »: only while nothing was launched nor shipped; engagements given stay. */
export async function repasserEnPreparation(id: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const blocage = await blocageRetourPreparation(id)
  if (blocage) return { ok: false, message: `Impossible de repasser en préparation : ${blocage}.` }
  await mettreEnPreparation(id)
  return { ok: true }
}
