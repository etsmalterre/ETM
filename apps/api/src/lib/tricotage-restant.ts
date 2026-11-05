// Clients › Commandes: what is still to KNIT for a client line, in écru kg (2026-10-26).
//
// affectation_cmd_tricotage is the planning: « knit N kg on this knitting sst line for this client
// line ». It is never cleared once the knitting is done, so reading it as « en tricotage » counted the
// matter twice: once planned, once as the pieces it became (order 3885, 119B: 327 kg on line 9023,
// knitted, dyed into the 15 « Prêt » rolls → gauge 1 346,3 / 761,6 Ml). Measured on prod that day:
// 30 allocations on 18 open orders (11 160 kg) still counted on knitting lines already done.
//
// One rule, read by the line gauge (lineReservationAggregates) and the line status
// (statut-ligne-client.ts), per allocation row:
//   - 0 when the knitting line is done (sstatut « Termin… ») or its order is soldée (knitting lines are
//     rarely closed: 908 « En_Cours », many on soldée orders — the head decides too);
//   - else max(0, poids_affecte − kg of the écru pieces already knitted on that sst line for that client
//     line), the pieces counted whatever became of them (dyed, merged, shipped): they sit in a later
//     stage of the gauge. « For that client line » = reserved to it, or free and due to it by the
//     split of lib/repartition-tricotage.ts (LIVA #1350). A TRM piece carries the ETM sst line only once TRM ships it (handoverSets):
//     until then it is still at the knitter, so still « en tricotage ».

import { query } from './hfsql-auto.js'
import { allocationsParLigneTricot, repartir } from './repartition-tricotage.js'

export interface AllocationTricotage {
  /** IDligne_commande_client */
  lcc: number
  /** IDligne_commande_sous_traitant (the knitting line) */
  lsst: number
  poids: number
}

const cle = (lsst: number, lcc: number) => `${lsst}|${lcc}`

/** Pure part: kg still to knit per client line. `ouvertes` = knitting lines not done on an order not
 *  soldée; `tricote` = kg of écru knitted per (sst line, client line), keyed by `${lsst}|${lcc}`. */
export function resteATricoter(
  allocations: readonly AllocationTricotage[],
  ouvertes: ReadonlySet<number>,
  tricote: ReadonlyMap<string, number>,
): Map<number, number> {
  // Several rows may plan the same pair: the knitted kg is deducted once from their sum.
  const prevu = new Map<string, { lcc: number; lsst: number; kg: number }>()
  for (const a of allocations) {
    if (!ouvertes.has(a.lsst)) continue
    const k = cle(a.lsst, a.lcc)
    const p = prevu.get(k) ?? { lcc: a.lcc, lsst: a.lsst, kg: 0 }
    p.kg += a.poids
    prevu.set(k, p)
  }
  const out = new Map<number, number>()
  for (const [k, p] of prevu) {
    const reste = Math.max(0, p.kg - (tricote.get(k) ?? 0))
    if (reste > 0) out.set(p.lcc, (out.get(p.lcc) ?? 0) + reste)
  }
  return out
}

const CHUNK = 400
const num = (v: unknown) => Number(v) || 0
async function queryIn<T>(ids: readonly number[], sql: (inList: string) => string): Promise<T[]> {
  const u = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  const out: T[] = []
  for (let i = 0; i < u.length; i += CHUNK) out.push(...(await query<T>(sql(u.slice(i, i + CHUNK).join(',')))))
  return out
}

/** Écru kg still to knit per client line (absent = nothing). Flat queries, merged in JS. */
export async function kgATricoterParLigne(lineIds: readonly number[]): Promise<Map<number, number>> {
  const rows = await queryIn<{ lcc: number; lsst: number; poids_affecte: number | null }>(lineIds, (inl) =>
    `SELECT IDligne_commande_client AS lcc, IDligne_commande_sous_traitant AS lsst, poids_affecte
     FROM affectation_cmd_tricotage WHERE IDligne_commande_client IN (${inl})`)
  const allocations = rows
    .map((r) => ({ lcc: num(r.lcc), lsst: num(r.lsst), poids: num(r.poids_affecte) }))
    .filter((a) => a.lcc > 0 && a.lsst > 0 && a.poids > 0)
  if (allocations.length === 0) return new Map()

  const lignes = await queryIn<{ id: number; cmd: number; sstatut: string | null }>(allocations.map((a) => a.lsst), (inl) =>
    `SELECT IDligne_commande_sous_traitant AS id, IDcommande_sous_traitant AS cmd, sstatut
     FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant IN (${inl})`)
  const soldees = new Set((await queryIn<{ cmd: number; est_soldee: number | null }>(lignes.map((l) => num(l.cmd)), (inl) =>
    `SELECT IDcommande_sous_traitant AS cmd, est_soldee FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${inl})`))
    .filter((r) => num(r.est_soldee) === 1).map((r) => num(r.cmd)))
  const ouvertes = new Set(lignes
    .filter((l) => !String(l.sstatut ?? '').startsWith('Termin') && !soldees.has(num(l.cmd)))
    .map((l) => num(l.id)))

  // Knitted for a client line = the pieces reserved to it from that knitting line PLUS the free pieces
  // of the knitting line that would go to it (lib/repartition-tricotage.ts, LIVA #1350). Counting only
  // the reserved ones left 307 Ml « en tricotage » on order 3905 for knitting that was done: 6 of the
  // 7 pieces of order 9126 had arrived free. Every client line of the knitting line takes part in the
  // split, not only the asked ones, so two lines never both count the same free piece.
  const tricote = new Map<string, number>()
  const lsstOuvertes = [...new Set(allocations.filter((a) => ouvertes.has(a.lsst)).map((a) => a.lsst))]
  if (lsstOuvertes.length > 0) {
    const [parLsst, pieces] = await Promise.all([
      allocationsParLigneTricot(lsstOuvertes),
      queryIn<{ id: number; lcc: number | null; lsst: number; poids: number | null }>(lsstOuvertes, (inl) =>
        `SELECT IDstock_ecru AS id, IDligne_commande_client AS lcc, IDref_commande_source AS lsst, poids
         FROM stock_ecru WHERE IDref_commande_source IN (${inl})`),
    ])
    for (const l of lsstOuvertes) {
      const siens = pieces.filter((p) => num(p.lsst) === l).map((p) => ({ id: num(p.id), poids: num(p.poids), lcc: num(p.lcc) }))
      for (const [lcc, kg] of repartir(parLsst.get(l) ?? [], siens).tenu) tricote.set(cle(l, lcc), kg)
    }
  }
  return resteATricoter(allocations, ouvertes, tricote)
}
