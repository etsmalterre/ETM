// Server-side sessions (table `session`, migration 0002_sessions): the cookie
// carries a random token, the database only its sha256 — the table can never
// be turned back into cookies, and revoking a row logs that browser out.
//
// A browser session slides: every use more than TOUCH_MS after the last one
// pushes its expiry DUREE_MS further (30 days without using the app = logged
// out). A POSTE session (an enrolled station PC — Visitage…) never expires; it
// dies only when revoked.
//
// Resolving is on every request, so a resolved session is cached CACHE_MS:
// a revocation reaches the other API requests within that delay (this
// process drops its own entries at once).

import crypto from 'node:crypto'
import { mpsPg } from './mps-pg.js'

export const SESSION_DUREE_MS = 30 * 24 * 3600_000
const TOUCH_MS = 5 * 60_000
const CACHE_MS = 15_000

export type TypeSession = 'navigateur' | 'poste'

export interface SessionResolue {
  id: string
  idutilisateur: number
  voirComme: number | null
  type: TypeSession
  /** The OWNER's flags (not the impersonated account's). */
  estAdmin: boolean
  doitChangerMdp: boolean
  /** Set on the call that slid `vu_le` (at most every TOUCH_MS): the moment a
   *  POSTE re-sends its long-lived cookie. A browser session turned into a
   *  poste in place (scripts/postes-appareils-fix.ts) still carries a 31-day
   *  cookie until then. */
  renouvele?: boolean
}

interface EntreeCache { at: number; session: SessionResolue | null; vuLe: number }
const cache = new Map<string, EntreeCache>()

export function hacherJeton(jeton: string): string {
  return crypto.createHash('sha256').update(jeton).digest('hex')
}

export interface NouvelleSession {
  idutilisateur: number
  type?: TypeSession
  libelle?: string | null
  ip?: string | null
  userAgent?: string | null
}

/** Creates a session and returns the cookie token (shown once, never stored). */
export async function creerSession(s: NouvelleSession): Promise<string> {
  const jeton = crypto.randomBytes(32).toString('base64url')
  const type = s.type ?? 'navigateur'
  const expire = type === 'poste' ? null : new Date(Date.now() + SESSION_DUREE_MS)
  await mpsPg()`
    INSERT INTO session (id, idutilisateur, type, libelle, expire_le, ip, user_agent)
    VALUES (${hacherJeton(jeton)}, ${s.idutilisateur}, ${type}, ${s.libelle ?? null}, ${expire},
            ${s.ip ?? null}, ${s.userAgent?.slice(0, 300) ?? null})`
  return jeton
}

/** The live session a cookie token names, or null (unknown, expired, revoked,
 *  or its account deactivated). Slides the expiry of a browser session. */
export async function resoudreSession(jeton: string): Promise<SessionResolue | null> {
  if (!jeton || jeton.length > 100) return null
  const id = hacherJeton(jeton)
  const now = Date.now()
  const hit = cache.get(id)
  if (hit && now - hit.at < CACHE_MS) return hit.session

  const [row] = await mpsPg()<{
    idutilisateur: number; voir_comme: number | null; type: TypeSession; vu_le: Date
    est_admin: boolean; doit_changer_mdp: boolean
  }[]>`
    SELECT s.idutilisateur, s.voir_comme, s.type, s.vu_le, u.est_admin, u.doit_changer_mdp
    FROM session s JOIN utilisateur u ON u.idutilisateur = s.idutilisateur
    WHERE s.id = ${id} AND s.revoque_le IS NULL AND u.actif
      AND (s.expire_le IS NULL OR s.expire_le > now())`
  const session: SessionResolue | null = row
    ? {
        id,
        idutilisateur: row.idutilisateur,
        voirComme: row.voir_comme,
        type: row.type,
        estAdmin: row.est_admin,
        doitChangerMdp: row.doit_changer_mdp,
      }
    : null
  cache.set(id, { at: now, session, vuLe: row ? row.vu_le.getTime() : 0 })
  if (row && now - row.vu_le.getTime() > TOUCH_MS) {
    mpsPg()`
      UPDATE session SET vu_le = now(),
        expire_le = CASE WHEN type = 'poste' THEN NULL ELSE ${new Date(now + SESSION_DUREE_MS)} END
      WHERE id = ${id}`.catch((err) => console.error('sessions: touch failed', err))
    return session ? { ...session, renouvele: true } : null
  }
  return session
}

export function oublierCache(id?: string): void {
  if (id) cache.delete(id)
  else cache.clear()
}

export async function revoquerSession(id: string): Promise<void> {
  await mpsPg()`UPDATE session SET revoque_le = now() WHERE id = ${id} AND revoque_le IS NULL`
  oublierCache(id)
}

/** Revokes every live session of an account (password reset, deactivation) —
 *  or only those of one `type` — optionally sparing one (the caller's own,
 *  after changing their password). */
export async function revoquerSessionsDe(idutilisateur: number, sauf?: string, type?: TypeSession): Promise<number> {
  const sql = mpsPg()
  const rows = await sql`
    UPDATE session SET revoque_le = now()
    WHERE idutilisateur = ${idutilisateur} AND revoque_le IS NULL AND id <> ${sauf ?? ''}
      ${type ? sql`AND type = ${type}` : sql``}
    RETURNING id`
  oublierCache()
  return rows.length
}

export async function definirVoirComme(id: string, voirComme: number | null): Promise<void> {
  await mpsPg()`UPDATE session SET voir_comme = ${voirComme} WHERE id = ${id}`
  oublierCache(id)
}

export interface SessionListee {
  /** First 12 hex chars of the id: enough to revoke, useless as a cookie. */
  ref: string
  type: TypeSession
  libelle: string | null
  creeLe: string
  vuLe: string
  expireLe: string | null
  ip: string | null
  userAgent: string | null
}

export async function listerSessions(idutilisateur: number, type?: TypeSession): Promise<SessionListee[]> {
  const sql = mpsPg()
  const rows = await sql<{
    id: string; type: TypeSession; libelle: string | null; cree_le: Date; vu_le: Date
    expire_le: Date | null; ip: string | null; user_agent: string | null
  }[]>`
    SELECT id, type, libelle, cree_le, vu_le, expire_le, ip, user_agent FROM session
    WHERE idutilisateur = ${idutilisateur} AND revoque_le IS NULL
      AND (expire_le IS NULL OR expire_le > now())
      ${type ? sql`AND type = ${type}` : sql``}
    ORDER BY vu_le DESC`
  return rows.map((r) => ({
    ref: r.id.slice(0, 12),
    type: r.type,
    libelle: r.libelle,
    creeLe: r.cree_le.toISOString(),
    vuLe: r.vu_le.toISOString(),
    expireLe: r.expire_le?.toISOString() ?? null,
    ip: r.ip,
    userAgent: r.user_agent,
  }))
}

/** Renames an enrolled PC (a POSTE session of the account named by its ref). */
export async function renommerPoste(idutilisateur: number, ref: string, libelle: string): Promise<boolean> {
  if (!/^[0-9a-f]{12}$/.test(ref)) return false
  const rows = await mpsPg()`
    UPDATE session SET libelle = ${libelle}
    WHERE idutilisateur = ${idutilisateur} AND type = 'poste' AND revoque_le IS NULL AND left(id, 12) = ${ref}
    RETURNING id`
  return rows.length > 0
}

/** Revokes the session of an account whose id starts with `ref` (a listing's ref). */
export async function revoquerParRef(idutilisateur: number, ref: string): Promise<boolean> {
  if (!/^[0-9a-f]{12}$/.test(ref)) return false
  const rows = await mpsPg()<{ id: string }[]>`
    UPDATE session SET revoque_le = now()
    WHERE idutilisateur = ${idutilisateur} AND revoque_le IS NULL AND left(id, 12) = ${ref}
    RETURNING id`
  for (const r of rows) oublierCache(r.id)
  return rows.length > 0
}
