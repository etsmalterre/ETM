// Automate « Tâches rouges »: every 10 minutes, reads what is red on each
// list of the notification centre (lib/taches/sources.ts) and writes the
// register (lib/taches/registre.ts, PG `tache_rouge`): one row per red item,
// with the day it turned red.
//
// Why an automate when the feed already reads the lists live: the rule « a
// task left red more than 2 working days also goes to the holder of Tâches en
// retard » (Vincent 2026-11-18) counts from the day the item turned red, and
// that day is only known if someone looked. Without this pass, a family
// nobody is subscribed to would never be dated.
//
// It writes no business data: only its own register. Essai reads and counts,
// writes nothing.

import { SOURCES_ROUGES } from '../../taches/sources.js'
import { relever } from '../../taches/releve.js'
import type { Issue } from '../catalog.js'

export const SLUG = 'taches-rouges'
export const VERSION = 1
export const VERSIONS = [
  {
    version: 1,
    date: '2026-11-18',
    note: 'Première version : relève toutes les 10 minutes ce qui est rouge dans les commandes clients, les sous-traitants, le suivi des lots et les commandes de fil, pour savoir depuis quand.',
  },
] as const

export async function executer(mode: 'essai' | 'actif', resultat: Record<string, unknown>): Promise<Issue> {
  const comptes: Record<string, number | string> = {}
  const erreurs: string[] = []
  for (const source of SOURCES_ROUGES) {
    try {
      // Essai: read only, the register is left alone.
      comptes[source.cle] = mode === 'actif' ? await relever(source) : (await source.relever()).length
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      comptes[source.cle] = `erreur : ${msg}`
      erreurs.push(source.cle)
    }
  }
  resultat.rouges = comptes
  const total = Object.values(comptes).reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0)
  if (erreurs.length === SOURCES_ROUGES.length) {
    return { statut: 'erreur', resume: 'Aucune famille n’a pu être relevée.' }
  }
  const detail = erreurs.length ? ` Non relevées : ${erreurs.join(', ')}.` : ''
  if (mode === 'essai') {
    // The same count every 10 minutes is kept once (execution.ts aGarder).
    return { statut: 'simule', resume: `${total} tâche(s) rouge(s) relevée(s), registre non écrit (essai).${detail}`, empreinte: JSON.stringify(comptes) }
  }
  // A periodic pass that only confirms the register is not worth a kept run; a failing family is.
  return erreurs.length
    ? { statut: 'erreur', resume: `${total} tâche(s) rouge(s).${detail}` }
    : { statut: 'inchange', resume: `${total} tâche(s) rouge(s) au registre.` }
}
