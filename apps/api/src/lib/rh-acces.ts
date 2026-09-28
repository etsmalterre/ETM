// Who may open the RH menu, and the « code RH » that proves it.
//
// ETM has no passwords: POST /auth/login accepts any IDutilisateur, so anyone at
// the factory can pick « Isabelle Malterre » in the user picker. For HR data
// (birthdays, photos, workload) that is not enough, so the menu has TWO locks:
//
//   1. the RH menu of the Écrans axis (`screen_rh`, Paramètres › Utilisateurs ›
//      Écrans, never handed out by the seed scripts) — here the curtain IS the
//      lock, like Paramètres › Outils: every /rh route checks it (peutOuvrirRh).
//      Until 2026-09-28 it was a fixed list of two names, nothing grantable;
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
import { isEffectiveAdmin } from './auth.js'
import { getUserPermissions } from './permissions.js'
import { menuAccessKey, screenHideKey } from './screen-keys.js'

export interface PersonneRh {
  /** Stable key stored in the database and in the cookie — one per PERSON,
   *  not per `utilisateur` row (Isabelle has home + bureau, one code). */
  cle: string
  label: string
}

/** The two people who held RH before it joined the Écrans axis: their keys
 *  stay what the database already stores their code and journal under. */
const CLES_HISTORIQUES = [
  { cle: 'vincent', prenom: 'vincent', nom: 'malterre', label: 'Vincent Malterre' },
  { cle: 'isabelle', prenom: 'isabelle', nom: 'malterre', label: 'Isabelle Malterre' },
] as const

const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Who a `utilisateur` row is for RH — identity only, access is peutOuvrirRh.
 *  Keyed by name so every PC row of a person shares one code. Any other
 *  person gets `u-<prénom>-<nom>`: the `u-` prefix can never collide with a
 *  historical key, and the key never holds a '.', which the cookie splits on. */
export function personneRh(u: { prenom?: string | null; nom?: string | null }): PersonneRh | null {
  const prenom = (u.prenom ?? '').trim()
  const nom = (u.nom ?? '').trim()
  const p = prenom.toLowerCase()
  const n = nom.toLowerCase()
  const hist = CLES_HISTORIQUES.find((x) => x.prenom === p && x.nom === n)
  if (hist) return { cle: hist.cle, label: hist.label }
  const slug = ascii(`${prenom} ${nom}`)
  if (!slug) return null
  return { cle: `u-${slug}`, label: `${prenom} ${nom}`.trim() }
}

export const RH_MENU = '/rh'
export const RH_ECRANS = ['/rh/employes', '/rh/charge'] as const

/** The first lock: the RH menu granted in Écrans (admins always pass) with at
 *  least one of its screens left visible — hiding both is revoking the menu,
 *  the same rule the navigation applies. Read on every request, never cached:
 *  a withdrawal takes effect at once. */
export async function peutOuvrirRh(userId: number | undefined, admin: boolean): Promise<boolean> {
  if (!userId) return false
  if (admin) return true
  const granted = new Set(await getUserPermissions(userId))
  return granted.has(menuAccessKey(RH_MENU)) && RH_ECRANS.some((s) => !granted.has(screenHideKey(s)))
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

/** The RH person behind this request, or null when they may not open RH. */
export async function personneRhAutorisee(req: Request): Promise<PersonneRh | null> {
  if (!(await peutOuvrirRh(req.userId, isEffectiveAdmin(req)))) return null
  return personneRhDeUtilisateur(req.userId)
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

/** 404 for anyone without the RH menu in Écrans (it does not exist for them),
 *  401 `rh_verrouille` for a granted person without a valid code session. */
export function requireRh(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    personneRhAutorisee(req)
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
