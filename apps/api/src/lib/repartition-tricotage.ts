// Clients › Commandes: the écru knitted on a knitting order goes to the client lines that reserved it
// (LIVA #1350, decision Vincent 2026-11-05).
//
// A client line reserves knitting on a knitting order (affectation_cmd_tricotage: « knit N kg on this
// knitting sst line for this client line »). The point of reserving there is to find the knitted
// pieces ALREADY reserved afterwards: until this rule, the pieces arrived free and someone had to tick
// them by hand in « Réserver du tombé de métier » (order 3905: 6 of the 7 pieces of order 9126 left
// free, the gauge still counted 307 Ml « en tricotage » for knitting that was done).
//
// Each allocation says how its quantity is meant (`toute_commande`, chosen first in the Tricotage tab
// dialog, Vincent 2026-11-05):
//   - « Quantité exacte » (0): the line takes pieces until it holds its kg; the last piece may go past
//     it (a piece is never cut). Several exact lines are served earliest délai first.
//   - « Toute la commande » / « Tout le reste » (1): the line takes every piece the exact lines do not,
//     surplus included; its kg = the order's quantity less the other lines'. One such line at most per
//     knitting line. Without one, what is knitted beyond the exact lines goes to free stock.
// Arrival order = piece id.
//
// A piece is reserved as soon as it is ETM's: when TRM ships it to Ets Malterre (stampShippedPieces,
// expeditions-trm.ts) or when an outside knitter's roll is received on ETM's side (pieces-fil). A piece
// already reserved (by hand or before) is never moved; one at a dyer, dyed, donated or shipped is left
// alone. The same split, run over every knitted piece, gives the gauge what is still to knit
// (lib/tricotage-restant.ts): a free piece counts as knitted for the line it would go to.

import { query } from './hfsql-auto.js'
import { consumedEcruIds } from './fini-sources.js'

export interface AllocationRepartition {
  /** IDligne_commande_client */
  lcc: number
  /** kg reserved for the line on the knitting line */
  poids: number
  /** « Toute la commande » */
  toute: boolean
  /** the client line's délai, YYYYMMDD ('' = none: last) */
  delai: string
}

export interface PieceRepartition {
  id: number
  poids: number
  /** client line it is reserved to, 0 = free */
  lcc: number
}

const EPS = 0.01

/** Allocations in the order pieces are handed out: earliest délai first, no délai last, then the line id. */
export function ordreAllocations(allocations: readonly AllocationRepartition[]): AllocationRepartition[] {
  return [...allocations].sort((a, b) => {
    const da = /^\d{8}$/.test(a.delai) ? a.delai : '99999999'
    const db = /^\d{8}$/.test(b.delai) ? b.delai : '99999999'
    return da.localeCompare(db) || a.lcc - b.lcc
  })
}

/** Pure: which free pieces go to which line, and the kg each line then holds from this knitting line.
 *  `pieces` = every piece knitted on the knitting line; only the free ones in `libres` may be handed out
 *  (the others count where they already are). Several rows for one client line add up. */
export function repartir(
  allocations: readonly AllocationRepartition[],
  pieces: readonly PieceRepartition[],
  libres: ReadonlySet<number> = new Set(pieces.filter((p) => p.lcc === 0).map((p) => p.id)),
): { attribution: Map<number, number>; tenu: Map<number, number> } {
  const parLigne = new Map<number, AllocationRepartition>()
  for (const a of allocations) {
    if (!(a.lcc > 0) || !(a.poids > 0)) continue
    const p = parLigne.get(a.lcc)
    parLigne.set(a.lcc, p ? { ...p, poids: p.poids + a.poids, toute: p.toute || a.toute } : { ...a })
  }
  const lignes = ordreAllocations([...parLigne.values()])
  const tenu = new Map<number, number>(lignes.map((a) => [a.lcc, 0]))
  for (const p of pieces) if (tenu.has(p.lcc)) tenu.set(p.lcc, (tenu.get(p.lcc) ?? 0) + (Number(p.poids) || 0))

  const attribution = new Map<number, number>()
  const file = pieces.filter((p) => p.lcc === 0 && libres.has(p.id)).sort((a, b) => a.id - b.id)
  if (lignes.length === 0 || file.length === 0) return { attribution, tenu }
  // The « exact » lines are served first, by délai, each up to its kg; then the line on « tout le
  // reste » (one at most: the first by délai if the data ever holds two) takes every piece left.
  const reste = lignes.find((a) => a.toute) ?? null
  let i = 0
  const donner = (lcc: number) => {
    const p = file[i++]
    attribution.set(p.id, lcc)
    tenu.set(lcc, (tenu.get(lcc) ?? 0) + (Number(p.poids) || 0))
  }
  for (const a of lignes) {
    if (a === reste) continue
    while (i < file.length && (tenu.get(a.lcc) ?? 0) < a.poids - EPS) donner(a.lcc)
  }
  if (reste) while (i < file.length) donner(reste.lcc)
  return { attribution, tenu }
}

const num = (v: unknown) => Number(v) || 0
const ids = (xs: readonly number[]) => Array.from(new Set(xs.filter((x) => Number.isInteger(x) && x > 0)))

/** The allocations of some knitting lines, with each client line's délai, keyed by knitting line.
 *  Lines of a client order that is soldée are left out (nothing to reserve to them any more). */
export async function allocationsParLigneTricot(lsstIds: readonly number[]): Promise<Map<number, AllocationRepartition[]>> {
  const out = new Map<number, AllocationRepartition[]>()
  const u = ids(lsstIds)
  if (u.length === 0) return out
  const rows = await query<{ lsst: number; lcc: number; poids: number | null; toute: number | null }>(
    `SELECT IDligne_commande_sous_traitant AS lsst, IDligne_commande_client AS lcc, poids_affecte AS poids,
            toute_commande AS toute
       FROM affectation_cmd_tricotage WHERE IDligne_commande_sous_traitant IN (${u.join(',')})`,
  )
  const lccs = ids(rows.map((r) => num(r.lcc)))
  const delai = new Map<number, string>()
  const cmdDe = new Map<number, number>()
  if (lccs.length > 0) {
    for (const l of await query<{ id: number; cmd: number; dl: string | null }>(
      `SELECT IDligne_commande_client AS id, IDcommande_client AS cmd, date_livraison AS dl
         FROM ligne_commande_client WHERE IDligne_commande_client IN (${lccs.join(',')})`,
    )) { delai.set(num(l.id), String(l.dl ?? '').trim()); cmdDe.set(num(l.id), num(l.cmd)) }
  }
  const cmds = ids([...cmdDe.values()])
  const soldees = new Set<number>()
  if (cmds.length > 0) {
    for (const c of await query<{ id: number; s: number | null }>(
      `SELECT IDcommande_client AS id, est_soldee AS s FROM commande_client WHERE IDcommande_client IN (${cmds.join(',')})`,
    )) if (num(c.s) === 1) soldees.add(num(c.id))
  }
  for (const r of rows) {
    const lcc = num(r.lcc)
    if (!cmdDe.has(lcc) || soldees.has(cmdDe.get(lcc)!)) continue
    const a: AllocationRepartition = { lcc, poids: num(r.poids), toute: num(r.toute) === 1, delai: delai.get(lcc) ?? '' }
    const arr = out.get(num(r.lsst)) ?? []
    arr.push(a)
    out.set(num(r.lsst), arr)
  }
  return out
}

/** What reserverPiecesTricotees would do, without writing: client line → its new pieces. */
export async function planReservationTricot(lsstIds: readonly number[]): Promise<Map<number, number[]>> {
  const parLcc = new Map<number, number[]>()
  const allocs = await allocationsParLigneTricot(lsstIds)
  if (allocs.size === 0) return parLcc
  const lsst = [...allocs.keys()]
  const rows = await query<{ id: number; lsst: number; poids: number | null; lcc: number | null; soc: number | null;
    don: number | null; aff: number | null; exp: number | null }>(
    `SELECT IDstock_ecru AS id, IDref_commande_source AS lsst, poids, IDligne_commande_client AS lcc, IDsociete AS soc,
            IDcommande_donation AS don, IDref_commande_affectation AS aff, IDligne_expedition_ETM AS exp
       FROM stock_ecru WHERE IDref_commande_source IN (${lsst.join(',')})`,
  )
  // Only ETM's pieces that nothing else holds: not at TRM, donated, on a dyer line, shipped or dyed.
  const candidats = rows.filter((r) => num(r.lcc) === 0 && num(r.soc) === 1 && num(r.don) === 0 && num(r.aff) === 0 && num(r.exp) === 0)
  const consommes = await consumedEcruIds(candidats.map((r) => num(r.id)))
  const libres = new Set(candidats.map((r) => num(r.id)).filter((id) => !consommes.has(id)))
  if (libres.size === 0) return parLcc

  for (const [l, a] of allocs) {
    const pieces = rows.filter((r) => num(r.lsst) === l).map((r) => ({ id: num(r.id), poids: num(r.poids), lcc: num(r.lcc) }))
    for (const [piece, lcc] of repartir(a, pieces, libres).attribution) {
      const arr = parLcc.get(lcc) ?? []
      arr.push(piece)
      parLcc.set(lcc, arr)
    }
  }
  return parLcc
}

/** Reserves the free knitted pieces of some knitting lines to their client lines (see the header).
 *  Returns how many pieces were reserved. Idempotent: run it again and nothing moves. */
export async function reserverPiecesTricotees(lsstIds: readonly number[]): Promise<number> {
  const parLcc = await planReservationTricot(lsstIds)
  let nb = 0
  for (const [lcc, pieces] of parLcc) {
    // Guarded: a piece reserved meanwhile keeps its reservation.
    await query(
      `UPDATE stock_ecru SET IDligne_commande_client = ${lcc}
        WHERE IDstock_ecru IN (${pieces.join(',')}) AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)`,
    )
    nb += pieces.length
  }
  return nb
}
