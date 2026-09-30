// Which fini rolls may be put on an expedition (LIVA #1235).
//
// Only a roll in état « Validé » ships. « En Contrôle », « En Reprise » and
// « Attente décision » are rolls the quality check has not released yet —
// a roll sent back to the dyer for reprise went to the client in the same
// week because nothing stopped it. « Expédié » is already gone. Écru rolls
// carry no état and are not concerned.
//
// Both roads onto an expedition go through this rule: the Affectation tab's
// quick-ship (`POST /commandes-client/:id/lignes/:ligneId/expedier`) and the
// Expéditions screen roll picker (`PUT /expeditions/formelle/:id/lignes/:lcc/rolls/:stockId`).

import { ETAT_FINI_VALIDE } from './donation-pieces.js'

export function isFiniExpediable(etat: unknown): boolean {
  return Number(etat) === ETAT_FINI_VALIDE
}

/** SQL predicate — race guard on the UPDATE that puts a roll on a shipment. */
export const FINI_EXPEDIABLE_SQL = `IDetat_stock_fini = ${ETAT_FINI_VALIDE}`

/** 409 body for a request carrying non-validated rolls. `numeros` names them
 *  so the user sees which ones to take out. */
export function finiNonValideRefus(numeros: string[]) {
  const list = numeros.join(', ')
  return {
    error: 'rouleau_non_valide',
    message: numeros.length > 1
      ? `Seuls les rouleaux validés peuvent être expédiés : ${list} ne le sont pas.`
      : `Seuls les rouleaux validés peuvent être expédiés : ${list} ne l'est pas.`,
  }
}
