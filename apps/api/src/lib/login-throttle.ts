// Login attempts: journal (table `connexion`) and slow-down. The apps are
// reachable from outside the factory over Tailscale, so repeated guessing
// must be slowed — but an account is NEVER locked: after too many failures
// the login is refused for a while, then accepted again. Nobody can lock a
// colleague out, and an admin can always reset a password.
//
// Rules (decision pure, tested): per identifiant, 5 failures since the last
// success within the window → wait until the oldest of those is WINDOW_MS
// old; per IP, 20 failures within the window (a guess spread over accounts).

import { mpsPg } from './mps-pg.js'

export const WINDOW_MS = 15 * 60_000
export const MAX_ECHECS_IDENTIFIANT = 5
export const MAX_ECHECS_IP = 20

/** Milliseconds to wait before the next attempt, 0 = allowed. `echecs` are
 *  the failure times (ms) inside the window, most recent first. */
export function attenteAvantEssai(echecs: readonly number[], max: number, now: number): number {
  if (echecs.length < max) return 0
  const plusAncienCompte = echecs[max - 1]
  return Math.max(0, plusAncienCompte + WINDOW_MS - now)
}

export async function attenteConnexion(identifiant: string, ip: string | null): Promise<number> {
  const sql = mpsPg()
  const depuis = new Date(Date.now() - WINDOW_MS)
  const parIdentifiant = await sql<{ le: Date }[]>`
    SELECT le FROM connexion
    WHERE lower(identifiant) = lower(${identifiant}) AND le > ${depuis} AND NOT succes
      AND le > COALESCE((SELECT max(le) FROM connexion
                         WHERE lower(identifiant) = lower(${identifiant}) AND succes), '-infinity')
    ORDER BY le DESC LIMIT ${MAX_ECHECS_IDENTIFIANT}`
  const parIp = ip
    ? await sql<{ le: Date }[]>`
        SELECT le FROM connexion WHERE ip = ${ip} AND le > ${depuis} AND NOT succes
        ORDER BY le DESC LIMIT ${MAX_ECHECS_IP}`
    : []
  const now = Date.now()
  return Math.max(
    attenteAvantEssai(parIdentifiant.map((r) => r.le.getTime()), MAX_ECHECS_IDENTIFIANT, now),
    attenteAvantEssai(parIp.map((r) => r.le.getTime()), MAX_ECHECS_IP, now),
  )
}

export async function journaliserConnexion(e: {
  identifiant: string
  idutilisateur: number | null
  ip: string | null
  succes: boolean
  motif?: string
}): Promise<void> {
  await mpsPg()`
    INSERT INTO connexion (identifiant, idutilisateur, ip, succes, motif)
    VALUES (${e.identifiant.slice(0, 200)}, ${e.idutilisateur}, ${e.ip}, ${e.succes}, ${e.motif ?? null})`
}
