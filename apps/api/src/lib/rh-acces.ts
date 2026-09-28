// Who may open the RH menu, and the « code RH » that proves it.
//
// ETM has no passwords: POST /auth/login accepts any IDutilisateur, so anyone at
// the factory can pick « Isabelle Malterre » in the user picker. For HR data
// (birthdays, photos, workload) that is not enough, so the menu has TWO locks:
//
//   1. a fixed list of people, by name (like isAdminUtilisateur in auth.ts) —
//      not a permission, nothing Paramètres › Utilisateurs can hand out;
//   2. a personal code per person, hashed in the `rh` PostgreSQL database and
//      set ON THE SERVER only (scripts/rh-code.ts) — never through the app,
//      since whoever picks « Vincent Malterre » in the picker becomes admin.
//
// Typing the code sets the `mps_rh` cookie: the person's key + an expiry,
// HMAC-signed with AUTH_COOKIE_SECRET. It is bound to the person, so switching
// identity in the picker locks RH again.
//
// Temporary by decision (2026-09-25): replaced by real password login once the
// user feature is rebuilt after the PostgreSQL migration.

import crypto from 'node:crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { query } from './hfsql-auto.js'

export interface PersonneRh {
  /** Stable key stored in the database and in the cookie. */
  cle: string
  prenom: string
  nom: string
  label: string
}

/** The only people who may open RH. Matched on the `utilisateur` row's name,
 *  so every PC row of the same person (Isabelle has home + bureau) qualifies. */
export const PERSONNES_RH: readonly PersonneRh[] = [
  { cle: 'vincent', prenom: 'vincent', nom: 'malterre', label: 'Vincent Malterre' },
  { cle: 'isabelle', prenom: 'isabelle', nom: 'malterre', label: 'Isabelle Malterre' },
]

export function personneRh(u: { prenom?: string | null; nom?: string | null }): PersonneRh | null {
  const p = u.prenom?.trim().toLowerCase()
  const n = u.nom?.trim().toLowerCase()
  return PERSONNES_RH.find((x) => x.prenom === p && x.nom === n) ?? null
}

// ── Who is the current user (cached: one HFSQL read per user per 5 min) ──

const CACHE_MS = 5 * 60_000
const cache = new Map<number, { at: number; personne: PersonneRh | null }>()

export async function personneRhDeUtilisateur(userId: number | undefined): Promise<PersonneRh | null> {
  if (!userId) return null
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.personne
  const rows = await query<{ prenom: string | null; nom: string | null }>(
    `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${Number(userId)}`,
  )
  const personne = rows[0] ? personneRh(rows[0]) : null
  cache.set(userId, { at: Date.now(), personne })
  return personne
}

// ── Code hashing ─────────────────────────────────────────

export const CODE_MIN_LENGTH = 6

export function hacherCode(code: string, sel = crypto.randomBytes(16).toString('hex')): { hash: string; sel: string } {
  const hash = crypto.scryptSync(code, sel, 64).toString('hex')
  return { hash, sel }
}

export function verifierCode(code: string, hash: string, sel: string): boolean {
  const attendu = Buffer.from(hash, 'hex')
  const calcule = crypto.scryptSync(code, sel, attendu.length)
  return attendu.length === calcule.length && crypto.timingSafeEqual(attendu, calcule)
}

// ── Failed attempts: 5 wrong codes lock the person out for 15 minutes ──

export const ESSAIS_MAX = 5
export const BLOCAGE_MS = 15 * 60_000
const essais = new Map<string, { echecs: number; bloqueJusqua: number }>()

/** Milliseconds left before this person may try again, 0 when free. */
export function blocageRestant(cle: string, now = Date.now()): number {
  const e = essais.get(cle)
  return e && e.bloqueJusqua > now ? e.bloqueJusqua - now : 0
}

export function noterEchec(cle: string, now = Date.now()): void {
  const e = essais.get(cle) ?? { echecs: 0, bloqueJusqua: 0 }
  e.echecs += 1
  if (e.echecs >= ESSAIS_MAX) {
    e.bloqueJusqua = now + BLOCAGE_MS
    e.echecs = 0
  }
  essais.set(cle, e)
}

export function noterSucces(cle: string): void {
  essais.delete(cle)
}

// ── Session cookie ───────────────────────────────────────

export const RH_COOKIE_NAME = 'mps_rh'
export const RH_SESSION_MS = 12 * 60 * 60_000

function signer(payload: string): string {
  const secret = process.env.AUTH_COOKIE_SECRET
  if (!secret) throw new Error('AUTH_COOKIE_SECRET is not set')
  return crypto.createHmac('sha256', secret).update(`rh:${payload}`).digest('base64url')
}

export function signerSessionRh(cle: string, now = Date.now()): string {
  const payload = `${cle}.${now + RH_SESSION_MS}`
  return `${payload}.${signer(payload)}`
}

/** The person key the cookie was issued to, or null when absent, tampered or expired. */
export function lireSessionRh(raw: string | undefined, now = Date.now()): string | null {
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const [cle, exp, sig] = parts
  const attendu = Buffer.from(signer(`${cle}.${exp}`))
  const recu = Buffer.from(sig)
  if (attendu.length !== recu.length || !crypto.timingSafeEqual(attendu, recu)) return null
  if (!/^\d+$/.test(exp) || Number(exp) <= now) return null
  return cle
}

export function rhCookieOptions(): { httpOnly: true; sameSite: 'lax'; path: '/'; maxAge: number } {
  return { httpOnly: true, sameSite: 'lax', path: '/', maxAge: RH_SESSION_MS }
}

// ── Route guard ──────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Set by requireRh(): the unlocked RH person. */
      personneRh?: PersonneRh
    }
  }
}

/** 404 for anyone not on the list (the menu does not exist for them), 401
 *  `rh_verrouille` for the right person without a valid code session. */
export function requireRh(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    personneRhDeUtilisateur(req.userId)
      .then((personne) => {
        if (!personne) {
          res.status(404).json({ error: 'Not found' })
          return
        }
        const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {}
        if (lireSessionRh(cookies[RH_COOKIE_NAME]) !== personne.cle) {
          res.status(401).json({ error: 'rh_verrouille' })
          return
        }
        req.personneRh = personne
        next()
      })
      .catch(next)
  }
}
