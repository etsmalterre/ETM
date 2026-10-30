// Arbitrage of a yarn order line received short (decision Vincent 2026-10-30).
//
// Several client lines reserve yarn on one supplier order line; the lot comes in short (550 kg for
// 600 reserved). TRM only records the lot. The platform then splits it by client délai, earliest
// first (basculerSurLot, lib/reservation-fil.ts): the last line served waits for the rest on the
// order, or loses it when the line is closed. That split is a PROPOSAL: a person at Malterre checks
// it — keeps it (« Valider la répartition ») or changes it (« Répartir autrement ») — before the order
// can end (an « attente » of lib/cycle-commande-fil.ts, amber: the default is sound, checking it puts
// us ahead, nothing is lost meanwhile).
//
// A line needs the check when it has received at least one lot, some yarn reserved on it is not
// on a lot (still waiting, or released when the line closed) AND at least two client lines share it. A check (append-only arbitrage_fil row)
// holds while the line's received kg is the one it was made on: a new lot asks again.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

const round2 = (x: number) => Math.round(x * 100) / 100

export interface EtatArbitrage {
  /** kg received on the line's lots */
  recu_kg: number
  /** kg reserved on the line that no lot serves (waiting or released) */
  manque_kg: number
  /** a check is due */
  a_arbitrer: boolean
  /** the check in force (same received kg), null = none */
  confirme: { le: string; par: string | null; modifie: boolean } | null
}

export async function etatsArbitrage(ligneIds: readonly number[]): Promise<Map<number, EtatArbitrage>> {
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  const out = new Map<number, EtatArbitrage>()
  if (ids.length === 0) return out
  const sql = mpsPg()
  const [recus, manques, checks, partages] = await Promise.all([
    sql<{ id: number; kg: number }[]>`
      SELECT idref_fil_commande::int AS id, sum(stock_initial)::float8 AS kg
        FROM stock_fil WHERE idref_fil_commande = ANY(${ids as number[]}) GROUP BY idref_fil_commande`,
    sql<{ id: number; kg: number }[]>`
      SELECT idref_fil_commande::int AS id, sum(quantite)::float8 AS kg
        FROM reservation_fil WHERE idref_fil_commande = ANY(${ids as number[]}) AND idstock_fil = 0
       GROUP BY idref_fil_commande`,
    sql<{ id: number; recu_kg: number; modifie: boolean; le: string; par: string | null }[]>`
      SELECT DISTINCT ON (idref_fil_commande) idref_fil_commande::int AS id, recu_kg::float8 AS recu_kg, modifie,
             to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS le, par
        FROM arbitrage_fil WHERE idref_fil_commande = ANY(${ids as number[]})
       ORDER BY idref_fil_commande, le DESC, id DESC`,
    sql<{ id: number; n: number }[]>`
      SELECT idref_fil_commande::int AS id, count(DISTINCT idligne_commande_client)::int AS n
        FROM reservation_fil WHERE idref_fil_commande = ANY(${ids as number[]}) GROUP BY idref_fil_commande`,
  ])
  // One client line alone on the order line: who goes short is not a choice, nothing to arbitrate.
  const nbClients = new Map(partages.map((p) => [p.id, Number(p.n) || 0]))
  const recu = new Map(recus.map((r) => [r.id, Number(r.kg) || 0]))
  const manque = new Map(manques.map((r) => [r.id, Number(r.kg) || 0]))
  const check = new Map(checks.map((c) => [c.id, c]))
  for (const id of ids) {
    const r = round2(recu.get(id) ?? 0)
    const m = round2(manque.get(id) ?? 0)
    const c = check.get(id)
    const valide = c && Math.abs(Number(c.recu_kg) - r) < 0.005 ? { le: c.le, par: c.par, modifie: !!c.modifie } : null
    const enJeu = r > 0.005 && m > 0.05 && (nbClients.get(id) ?? 0) >= 2
    out.set(id, { recu_kg: r, manque_kg: m, a_arbitrer: enJeu && !valide, confirme: enJeu ? valide : null })
  }
  return out
}

export class RefusArbitrage extends Error {
  constructor(public code: string, message: string) { super(message) }
}

async function recuDeLigne(sql: Sql, ligne: number): Promise<number> {
  const [{ kg }] = await sql<{ kg: number }[]>`
    SELECT coalesce(sum(stock_initial), 0)::float8 AS kg FROM stock_fil WHERE idref_fil_commande = ${ligne}`
  return round2(Number(kg) || 0)
}

/** « Valider la répartition »: the split in place is the one Malterre keeps. */
export async function confirmerArbitrage(ligne: number, par: { id: number; nom: string | null }, modifie = false, sql: Sql = mpsPg()): Promise<void> {
  const recu = await recuDeLigne(sql, ligne)
  await sql`INSERT INTO arbitrage_fil (idref_fil_commande, recu_kg, modifie, par_id, par)
            VALUES (${ligne}, ${recu}, ${modifie}, ${par.id}, ${par.nom})`
}

/** « Répartir autrement »: per client line, the kg it takes from the line's lots. The lots' total is
 *  kept (what the reception placed); a client line takes at least what its knitting order already
 *  took and at most what it reserved. The rest of each waits on the order line (still open) or is
 *  released (line closed), as a reception short would have done. Then the check is recorded. */
export async function repartirLigne(
  ligne: number,
  parts: readonly { idligne_commande_client: number; kg_lot: number }[],
  par: { id: number; nom: string | null },
): Promise<void> {
  const sql = mpsPg()
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`SELECT pg_advisory_xact_lock(hashtext('reservation_fil'), ${ligne}::int)`
    const [l] = await tx<{ etat: number }[]>`SELECT coalesce(etat, 0)::int AS etat FROM ref_fil_commande WHERE idref_fil_commande = ${ligne}`
    if (!l) throw new RefusArbitrage('ligne_introuvable', 'Ligne de commande de fil introuvable.')
    const lots = await tx<{ id: number }[]>`SELECT idstock_fil::int AS id FROM stock_fil WHERE idref_fil_commande = ${ligne} ORDER BY idstock_fil`
    const lotIds = new Set(lots.map((x) => x.id))
    const rows = await tx<{
      id: number; idligne_commande_client: number; idref_fil: number; idcolori_fil: number; quantite: number
      idstock_fil: number; consomme: boolean; liberee: boolean; cree_le: Date; cree_par_id: number; cree_par: string | null
    }[]>`
      SELECT id::int, idligne_commande_client::int, idref_fil::int, idcolori_fil::int, quantite::float8 AS quantite,
             idstock_fil::int, (idligne_commande_sous_traitant > 0 OR idasso_fil_lignecmdsst > 0) AS consomme,
             liberee_le IS NOT NULL AS liberee, cree_le, cree_par_id::int, cree_par
        FROM reservation_fil WHERE idref_fil_commande = ${ligne} ORDER BY id`
    const vivantes = rows.filter((r) => r.idstock_fil === 0 || lotIds.has(r.idstock_fil))
    // What each lot holds for this line today (the consumed rows stay where they are).
    const capacite = new Map<number, number>()
    for (const r of vivantes) if (r.idstock_fil > 0 && !r.consomme && !r.liberee) capacite.set(r.idstock_fil, round2((capacite.get(r.idstock_fil) ?? 0) + r.quantite))
    const totalLots = round2([...capacite.values()].reduce((a, b) => a + b, 0))

    const parClient = new Map<number, { total: number; consomme: number; modele: typeof rows[number] }>()
    for (const r of vivantes) {
      const e = parClient.get(r.idligne_commande_client) ?? { total: 0, consomme: 0, modele: r }
      e.total = round2(e.total + r.quantite)
      if (r.consomme) e.consomme = round2(e.consomme + r.quantite)
      parClient.set(r.idligne_commande_client, e)
    }
    const voulu = new Map(parts.map((p) => [p.idligne_commande_client, round2(Math.max(0, p.kg_lot))]))
    let somme = 0
    for (const [c, e] of parClient) {
      const kg = voulu.get(c) ?? e.consomme
      if (kg < e.consomme - 0.005) throw new RefusArbitrage('sous_le_tricotage', `Une ligne client ne peut pas descendre sous les ${e.consomme} kg déjà partis au tricotage.`)
      if (kg > e.total + 0.005) throw new RefusArbitrage('au_dela_reserve', 'Une ligne client ne peut pas prendre plus que ce qu’elle a réservé.')
      somme = round2(somme + kg - e.consomme)
    }
    if (Math.abs(somme - totalLots) > 0.05) {
      throw new RefusArbitrage('total_lot', `La répartition doit placer exactement ${totalLots} kg sur les lots (${somme} kg placés).`)
    }

    // Rewrite every movable row of the line: lots filled in lot order, the rest waits or is released.
    const mobiles = vivantes.filter((r) => !r.consomme)
    if (mobiles.length > 0) await tx`DELETE FROM reservation_fil WHERE id = ANY(${mobiles.map((r) => r.id)})`
    const restes = [...capacite.entries()].map(([id, kg]) => ({ id, kg }))
    for (const [c, e] of parClient) {
      let aPlacer = round2((voulu.get(c) ?? e.consomme) - e.consomme)
      const m = e.modele
      for (const lot of restes) {
        if (aPlacer <= 0.005) break
        const kg = round2(Math.min(lot.kg, aPlacer))
        if (kg <= 0.005) continue
        lot.kg = round2(lot.kg - kg)
        aPlacer = round2(aPlacer - kg)
        await tx`
          INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idref_fil_commande, idstock_fil, cree_le, cree_par_id, cree_par)
          VALUES (${c}, ${m.idref_fil}, ${m.idcolori_fil}, ${kg}, ${ligne}, ${lot.id}, ${m.cree_le}, ${m.cree_par_id}, ${m.cree_par})`
      }
      const reste = round2(e.total - (voulu.get(c) ?? e.consomme))
      if (reste > 0.005) {
        if (l.etat === 0) {
          await tx`
            INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idref_fil_commande, cree_le, cree_par_id, cree_par)
            VALUES (${c}, ${m.idref_fil}, ${m.idcolori_fil}, ${reste}, ${ligne}, ${m.cree_le}, ${m.cree_par_id}, ${m.cree_par})`
        } else {
          await tx`
            INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idref_fil_commande, liberee_le, motif_liberation, cree_le, cree_par_id, cree_par)
            VALUES (${c}, ${m.idref_fil}, ${m.idcolori_fil}, ${reste}, ${ligne}, now(), 'Fil reçu en partie : reliquat non livré', ${m.cree_le}, ${m.cree_par_id}, ${m.cree_par})`
        }
      }
    }
    await confirmerArbitrage(ligne, par, true, tx)
  })
}
