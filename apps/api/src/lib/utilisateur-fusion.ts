// Old per-PC `utilisateur` ids folded into a person's account
// (scripts/comptes-import.ts, table `utilisateur_fusion`). A browser still
// holding a cookie for #18 acts as #1: attachUser() resolves through here.
//
// The table only grows during an import, so it is cached and re-read every
// few minutes; a read failure keeps the previous map (an empty one at worst:
// the old id then simply matches no account and the user logs in again).

import { mpsPg } from './mps-pg.js'

const REFRESH_MS = 5 * 60_000
let carte = new Map<number, number>()
let lue = 0
let enCours: Promise<void> | null = null

async function relire(): Promise<void> {
  try {
    const rows = await mpsPg()<{ ancien_id: number; idutilisateur: number }[]>`
      SELECT ancien_id, idutilisateur FROM utilisateur_fusion`
    carte = new Map(rows.map((r) => [r.ancien_id, r.idutilisateur]))
  } catch (err) {
    console.error('utilisateur-fusion: read failed', err)
  }
  lue = Date.now()
}

/** Makes sure the map is loaded (awaits only the first time). */
export async function chargerFusion(): Promise<void> {
  if (Date.now() - lue < REFRESH_MS) return
  enCours ??= relire().finally(() => { enCours = null })
  if (lue === 0) await enCours
}

/** The account an id stands for today: itself, or the account it was folded into. */
export function idCourant(id: number): number {
  return carte.get(id) ?? id
}
