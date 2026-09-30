// Enrolment of a STATION PC (the Visitage PC…) to a station account
// (`utilisateur.type_compte = 'poste'`). Same shape as the atelier phones
// (lib/appareils-atelier.ts): an admin generates a one-time 6-digit code in
// Paramètres › Utilisateurs, the PC types it once on the login screen and
// receives a session of type 'poste' — no password, no expiry, revoked from
// the account's session list. Who does the work is picked inside the app.
//
// Codes live in memory (10 min, single use): an API restart voids them.

import crypto from 'node:crypto'

const DUREE_CODE_MS = 10 * 60_000

interface CodePoste {
  idutilisateur: number
  libelle: string
  expire: number
  creePar: number
}

const codes = new Map<string, CodePoste>()

function purger(now: number): void {
  for (const [c, v] of codes) if (v.expire <= now) codes.delete(c)
}

export function genererCodePoste(idutilisateur: number, libelle: string, creePar: number): { code: string; expire: string } {
  const now = Date.now()
  purger(now)
  let code: string
  do code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  while (codes.has(code))
  codes.set(code, { idutilisateur, libelle, expire: now + DUREE_CODE_MS, creePar })
  return { code, expire: new Date(now + DUREE_CODE_MS).toISOString() }
}

/** Consumes a code: the account and label it enrols, or null. */
export function consommerCodePoste(code: string): { idutilisateur: number; libelle: string } | null {
  const now = Date.now()
  purger(now)
  const v = codes.get(code.trim())
  if (!v) return null
  codes.delete(code.trim())
  return { idutilisateur: v.idutilisateur, libelle: v.libelle }
}

/** The codes still pending for one account (Paramètres › Utilisateurs ›
 *  Appareils shows them next to the phones' codes, with a countdown). */
export function codesPosteEnAttente(idutilisateur: number): Array<{ code: string; libelle: string; expire: string }> {
  const now = Date.now()
  purger(now)
  return [...codes.entries()]
    .filter(([, v]) => v.idutilisateur === idutilisateur)
    .sort(([, a], [, b]) => a.expire - b.expire)
    .map(([code, v]) => ({ code, libelle: v.libelle, expire: new Date(v.expire).toISOString() }))
}

/** Cancels a pending code of this account. */
export function annulerCodePoste(idutilisateur: number, code: string): boolean {
  const v = codes.get(code)
  if (!v || v.idutilisateur !== idutilisateur) return false
  return codes.delete(code)
}
