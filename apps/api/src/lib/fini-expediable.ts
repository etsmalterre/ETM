// Which fini rolls may be put on an expedition (LIVA #1235, #1351).
//
// A roll in état « Validé » ships. « En Contrôle », « En Reprise » and
// « Attente décision » are rolls the quality check has not released yet —
// a roll sent back to the dyer for reprise went to the client in the same
// week because nothing stopped it. « Expédié » is already gone. Écru rolls
// carry no état and are not concerned.
//
// Exception (#1351, decision Vincent 2026-11-05): a reference switched
// « Expédier dès la réception » (ref_fini.expedier_des_reception, Finis ›
// Références › Informations › Contrôles des lots) lets its « En Contrôle »
// rolls ship too — high-volume references Malterre masters, where the délai
// is worth more than waiting for the controls. The lot keeps its control
// cycle afterwards (the measures are still taken, « Valider le lot » never
// pulls a shipped roll back, a reprise never takes one). « En Reprise » and
// « Attente décision » never ship, switch or not.
//
// Every road onto an expedition goes through this rule: the Affectation tab's
// quick-ship (`POST /commandes-client/:id/lignes/:ligneId/expedier`) and the
// Expéditions screen roll picker (`PUT /expeditions/formelle/:id/lignes/:lcc/rolls/:stockId`).
// Every reader of « ready to ship » too (line status « prête », Stock potentiel
// « Dispo », the Superviseur's ready-not-shipped check).

import { ETAT_FINI_VALIDE } from './donation-pieces.js'

export const ETAT_FINI_EN_CONTROLE = 1

/** May a roll in this état ship? `expedieDesReception` = its reference's
 *  « Expédier dès la réception » switch — always passed, never defaulted, so a
 *  caller cannot forget the exception. */
export function isFiniExpediable(etat: unknown, expedieDesReception: boolean): boolean {
  const e = Number(etat)
  return e === ETAT_FINI_VALIDE || (expedieDesReception && e === ETAT_FINI_EN_CONTROLE)
}

/** SQL predicate on an unaliased `stock_fini` — race guard on the UPDATE that
 *  puts a roll on a shipment, and filter of the readers of ready rolls. */
export const FINI_EXPEDIABLE_SQL =
  `(IDetat_stock_fini = ${ETAT_FINI_VALIDE} OR (IDetat_stock_fini = ${ETAT_FINI_EN_CONTROLE}` +
  ` AND IDref_fini IN (SELECT IDref_fini FROM ref_fini WHERE expedier_des_reception = 1)))`

/** The references of `ids` switched « Expédier dès la réception ». */
export async function refsExpedieesDesReception(ids: Iterable<number>): Promise<Set<number>> {
  const u = [...new Set([...ids].map(Number).filter((x) => x > 0))]
  const out = new Set<number>()
  if (u.length === 0) return out
  // Lazy: the rule above stays importable by pure modules (lib/stock-potentiel.ts) and tests.
  const { query } = await import('./hfsql-auto.js')
  const rows = await query<{ IDref_fini: number }>(
    `SELECT IDref_fini FROM ref_fini WHERE IDref_fini IN (${u.join(',')}) AND expedier_des_reception = 1`,
  )
  for (const r of rows) out.add(Number(r.IDref_fini))
  return out
}

/** 409 body for a request carrying rolls that may not ship. `numeros` names
 *  them so the user sees which ones to take out. */
export function finiNonValideRefus(numeros: string[]) {
  const list = numeros.join(', ')
  return {
    error: 'rouleau_non_valide',
    message: numeros.length > 1
      ? `Seuls les rouleaux validés peuvent être expédiés : ${list} ne le sont pas.`
      : `Seuls les rouleaux validés peuvent être expédiés : ${list} ne l'est pas.`,
  }
}
