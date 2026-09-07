// The ONE owner of the TRM OF queue transitions — Production › OF
// (routes/of-trm.ts), the atelier PWA (routes/atelier.ts) and Visitage
// (routes/visitage-trm.ts) all go through here.
//
// Queue model (ordre_fabrication, per métier):
//  - En cours = est_actif = 1 AND est_termine = 0 — at most one per métier.
//  - Attente  = est_actif = 0 AND est_termine = 0, ranked by priorite (dense
//    1..n after rerankQueue, the active OF first).
//  - Terminé  = est_termine = 1, priorite = 0.
//  - Terminer = est_termine←1, est_actif←0, priorite←0, then the métier's queue
//    is re-ranked and, if its new head asked for it (auto_activation = 1), the
//    head becomes est_actif = 1. Otherwise the régleur starts it by hand from
//    the OF screen (« Passer en cours »). That is the workflow the user
//    described on 2026-09-07 (LIVA #1128), and it is applied to EVERY closing
//    path — web button and phone alike.
//
// ⚠️ Why healHandedOverOfs exists — the legacy handover leaves a half-state.
// The Android bonnetier app (still the one in use on the floor, 2026-09-07:
// its events carry `appareil = 'Terminal N'`) closes an OF with its own
// AutoActivation(): est_actif←0 on the finished OF, est_actif←1 on the next
// one — and NOTHING else. est_termine stays 0, priorite keeps its rank. Until
// the port's atelier.ts was rewired (this file), it reproduced that verbatim.
// The ERP then read that leftover as « En attente » (est_actif 0 / est_termine
// 0), its status pill offered only « Passer en cours » (refused, the métier
// being busy), and Visitage's queue-head query — lowest priorite among the
// open OFs — kept opening the OLD OF while the new one's pieces were only
// reachable as strays. LIVA #1128 (OFs 3565 / 3566, 03/09/2026).
// The signature is unambiguous: no ERP path produces est_actif = 0 with an
// arret_prod on an unfinished OF while another OF runs on the same métier
// (« Interrompre OF » keeps est_actif = 1; « Passer en cours » is refused while
// the métier is busy; Terminer sets est_termine). So it is repaired on read,
// by the same terminerOf every button uses.
import { query } from './hfsql-auto.js'
import { n } from './sst-shared.js'
import { nowDt, parseDtMs } from './production-trm.js'

export interface QueueEntry { id: number; priorite: number; est_actif: number; auto_activation: number }

/** Re-rank a métier's open queue to a dense 1..n (active OF first). Returns the
 *  ranked queue. Priorite semantics recovered from live data: 1 = the running
 *  OF, 2 = next, …; 0 once terminé. */
export async function rerankQueue(machineId: number): Promise<QueueEntry[]> {
  if (machineId <= 0) return []
  const rows = await query<any>(
    `SELECT IDordre_fabrication, priorite, est_actif, auto_activation
     FROM ordre_fabrication WHERE IDmachine = ${machineId} AND est_termine = 0
     ORDER BY est_actif DESC, priorite ASC, IDordre_fabrication ASC`,
  )
  const out: QueueEntry[] = []
  let p = 1
  for (const r of rows) {
    const id = n(r.IDordre_fabrication)
    if (n(r.priorite) !== p) {
      await query(`UPDATE ordre_fabrication SET priorite = ${p} WHERE IDordre_fabrication = ${id}`)
    }
    out.push({ id, priorite: p, est_actif: n(r.est_actif) || 0, auto_activation: n(r.auto_activation) || 0 })
    p++
  }
  return out
}

/** The OF running on a métier (est_actif = 1, est_termine = 0), 0 when none. */
export async function activeOfOnMachine(machineId: number, excludeId = 0): Promise<number> {
  if (machineId <= 0) return 0
  const rows = await query<{ IDordre_fabrication: number }>(
    `SELECT IDordre_fabrication FROM ordre_fabrication
     WHERE IDmachine = ${machineId} AND est_actif = 1 AND est_termine = 0
       AND IDordre_fabrication <> ${excludeId}`,
  )
  return n(rows[0]?.IDordre_fabrication) || 0
}

export interface TerminerResult {
  /** The OF auto-activated by this closing, 0 when the head waits for a hand. */
  activated: number
}

/** Close an OF and hand its métier over — the single closing path.
 *
 *  `stampArret` writes arret_prod = now (the web button); the phone has just
 *  stamped it itself and passes false, so the timestamp stays the one of the
 *  bonnetier's gesture. */
export async function terminerOf(ofId: number, machineId: number, opts: { stampArret: boolean }): Promise<TerminerResult> {
  const arret = opts.stampArret ? `, arret_prod = '${nowDt()}'` : ''
  await query(
    `UPDATE ordre_fabrication SET est_termine = 1, est_actif = 0, priorite = 0${arret}
     WHERE IDordre_fabrication = ${ofId}`,
  )
  let activated = 0
  if (machineId > 0) {
    const queue = await rerankQueue(machineId)
    const head = queue[0]
    if (head && head.est_actif === 0 && head.auto_activation === 1) {
      await query(`UPDATE ordre_fabrication SET est_actif = 1 WHERE IDordre_fabrication = ${head.id}`)
      activated = head.id
    }
  }
  return { activated }
}

export interface OpenOfState {
  id: number
  IDmachine: number
  est_actif: number
  arret_prod: unknown
}

/** The legacy handover leftover: an unfinished OF that is no longer active,
 *  carries an arret_prod, while another OF runs on the same métier. Pure, so
 *  the rule is testable without a base. */
export function handedOverLeftovers(open: OpenOfState[]): OpenOfState[] {
  const activeByMachine = new Set<number>()
  for (const o of open) if (n(o.est_actif) === 1 && n(o.IDmachine) > 0) activeByMachine.add(n(o.IDmachine))
  return open.filter(
    (o) =>
      n(o.est_actif) === 0 &&
      parseDtMs(o.arret_prod) !== null &&
      activeByMachine.has(n(o.IDmachine)),
  )
}

/** Repair the legacy Android handover on read: every leftover (see above) is
 *  closed through terminerOf, arret_prod kept. Scoped to one métier when given.
 *  Returns the ids it closed — empty on a clean base, which is the normal case
 *  (the open queue is ~10 rows, so the read costs nothing). */
export async function healHandedOverOfs(machineId = 0): Promise<number[]> {
  const scope = machineId > 0 ? ` AND IDmachine = ${machineId}` : ''
  const rows = await query<any>(
    `SELECT IDordre_fabrication, IDmachine, est_actif, arret_prod
     FROM ordre_fabrication WHERE est_termine = 0${scope}`,
  )
  const open: OpenOfState[] = rows.map((r: any) => ({
    id: n(r.IDordre_fabrication),
    IDmachine: n(r.IDmachine),
    est_actif: n(r.est_actif),
    arret_prod: r.arret_prod,
  }))
  const healed: number[] = []
  for (const o of handedOverLeftovers(open)) {
    await terminerOf(o.id, o.IDmachine, { stampArret: false })
    console.info(`of-queue-trm: OF ${o.id} (métier ${o.IDmachine}) fermé — reliquat de l'AutoActivation legacy`)
    healed.push(o.id)
  }
  return healed
}
