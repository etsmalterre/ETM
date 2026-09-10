// HMAC-signed cookie helpers + a best-effort Express middleware that attaches
// req.userId when a valid cookie is present. No third-party JWT lib — we use
// node:crypto.createHmac directly.
//
// Cookie format: "<id>.<hmacBase64Url>"
//   where hmac = HMAC-SHA256(AUTH_COOKIE_SECRET, String(id))
//
// Verification uses a constant-time comparison so tampered cookies can't be
// fingerprinted via timing.

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import crypto from 'node:crypto'

// Read the secret lazily — ESM hoists imports to the top of the file, so
// dotenv.config() in index.ts runs AFTER this module is first evaluated.
// Accessing process.env at call time (inside hmac()) works correctly because
// by the time any route handler fires, dotenv has populated process.env.
function getSecret(): string {
  const s = process.env.AUTH_COOKIE_SECRET
  if (!s) {
    throw new Error(
      'AUTH_COOKIE_SECRET is not set. Define it in apps/api/.env.{development,production}.',
    )
  }
  return s
}

export const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'mps_uid'

// Second cookie that remembers the ORIGINAL admin user when an admin
// switches to another identity. Persists across switches so the admin can
// always come back. See routes/auth.ts /login for the persistence logic.
export const ADMIN_COOKIE_NAME = `${COOKIE_NAME}_admin`

// 10 years, in seconds. Effectively permanent — the legacy hostname model
// has no expiry either.
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10

// Hardcoded admin list — users with the right to switch to another identity.
// Currently just Vincent Malterre. When a real role/flag column is added to
// the utilisateur table, replace this with a DB lookup.
export function isAdminUtilisateur(u: { prenom?: string | null; nom?: string | null }): boolean {
  return (
    (u.prenom?.trim().toLowerCase() === 'vincent') &&
    (u.nom?.trim().toLowerCase() === 'malterre')
  )
}

/** URL-safe base64 (no padding, - and _ instead of + and /). */
function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function hmac(payload: string): string {
  return base64url(crypto.createHmac('sha256', getSecret()).update(payload).digest())
}

/** Sign a numeric user id into a cookie-safe string "<id>.<hmac>". */
export function signUserId(id: number): string {
  const payload = String(id)
  return `${payload}.${hmac(payload)}`
}

/** Verify a signed cookie value. Returns the id or null. */
export function verifyUserCookie(raw: string | undefined | null): number | null {
  if (!raw || typeof raw !== 'string') return null
  const dot = raw.indexOf('.')
  if (dot < 1) return null
  const payload = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  if (!/^\d+$/.test(payload)) return null

  const expected = hmac(payload)
  // Constant-time compare — both values are already base64url strings of the
  // same length (SHA-256 → 43 chars), so lengths match when the cookie isn't
  // malformed. Use Buffer.from to get a Buffer for timingSafeEqual.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!crypto.timingSafeEqual(a, b)) return null

  const id = parseInt(payload, 10)
  return Number.isFinite(id) && id > 0 ? id : null
}

/** Cookie options used by both login and logout responses. */
export function cookieOptions(): {
  httpOnly: true
  sameSite: 'lax'
  path: '/'
  secure: false
} {
  // SameSite=Lax without Secure. The ideal for the WinDev HTML control (which
  // Chromium treats as a third-party iframe context) is SameSite=None; Secure
  // so cookies persist across app restarts — but that requires HTTPS. When
  // the site was served over plain HTTP (until 2026-09-10),
  // Secure made Chromium silently drop every Set-Cookie and the picker came
  // back on every page load, hence Lax without Secure: cookies persist while
  // the WinDev session is alive; at worst the user re-picks once per restart.
  // Since 2026-09-10 the site is served over HTTPS at
  // `https://etm.intra.etsmalterre.com/` (Caddy terminates TLS), so flipping
  // to `sameSite: 'none'` + `secure: true` is now possible — not done yet;
  // the WinDev embedding must be re-tested when it is.
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: false,
  }
}

/** Best-effort middleware: if a valid cookie is present, attaches req.userId
 *  (and req.adminId if the admin cookie is also valid). Never sends a 401 —
 *  routes that need to know whether the user is identified can check
 *  req.userId / req.adminId themselves. */
export function attachUser(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {}
    const id = verifyUserCookie(cookies[COOKIE_NAME])
    if (id !== null) req.userId = id
    const adminId = verifyUserCookie(cookies[ADMIN_COOKIE_NAME])
    if (adminId !== null) req.adminId = adminId
    next()
  }
}

/** True when the current user is also the admin user (i.e. the admin is
 *  acting as themselves, NOT impersonating someone else). When an admin
 *  impersonates another user, this is false and they temporarily lose all
 *  admin powers — the impersonated user's real permissions apply.
 *
 *  Distinct from "session admin" (req.adminId !== undefined), which stays
 *  true during impersonation so the header "Changer d'utilisateur" button
 *  remains visible. Effective admin is the check that should gate permission
 *  bypasses and admin-only endpoints. */
export function isEffectiveAdmin(req: Request): boolean {
  return req.adminId !== undefined && req.userId === req.adminId
}

/** Route-level guard: returns true when the current user is the EFFECTIVE
 *  admin (acting as themselves, not impersonating), otherwise sends a 403
 *  and returns false. Use at the top of admin-only endpoints:
 *
 *    permissionsRouter.get('/users', async (req, res) => {
 *      if (!requireAdmin(req, res)) return
 *      // ...admin work...
 *    })
 *
 *  Admins who are currently impersonating another user get 403'd here too
 *  — they have to switch back to themselves first. */
export function requireAdmin(req: Request, res: Response): boolean {
  if (!isEffectiveAdmin(req)) {
    res.status(403).json({ error: 'admin access required' })
    return false
  }
  return true
}

// Module augmentation so req.userId / req.adminId are typed across the app.
declare global {
  namespace Express {
    interface Request {
      /** Populated by attachUser() when a valid signed user cookie is present. */
      userId?: number
      /** Populated by attachUser() when a valid signed admin cookie is present.
       *  Indicates the session was originally established by an admin user
       *  (currently Vincent Malterre) — even if they have since switched to
       *  impersonate another user. The admin cookie persists across switches
       *  so the admin can always come back to themselves. */
      adminId?: number
    }
  }
}
