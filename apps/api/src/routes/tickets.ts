// Ticket reporting proxy — LIVA issue tracker.
//
// One router factory mounted twice, factures.ts-style: the ETM and TRM web
// apps are two distinct products in the tracker (the reporter's "Mes tickets"
// must not mix them), but everything except the product slug is identical —
// same company API key, same session-derived reporter identity, same quirks.
//
//   /api/tickets      → product ISSUE_TRACKER_PRODUCT_SLUG      (ETM web app)
//   /api/tickets-trm  → product ISSUE_TRACKER_PRODUCT_SLUG_TRM  (TRM web app)
//
// The browser only ever calls these same-origin routes; the tracker API key
// and product slug live server-side in env and are injected here. Reporter
// identity (name + email) is resolved from the session cookie — the client
// cannot spoof it:
//   - name  ← utilisateur.prenom/nom (HFSQL, fixEncoding for accents)
//   - email ← user-emails.json (same admin-managed mapping the Gmail send
//     feature uses). An account with NO mapped email still reports, under a
//     stable synthetic per-account identity (lib/tickets-reporter.ts) — the
//     tracker keys reporters by email but only *sends* to it for the opt-in
//     follow-up mail, which is therefore the one thing such an account loses.
//     That is the visitage PC (compte-poste) and a colleague without a
//     company mailbox; until v1.3.0 they got a 400 and could not report at all.
//   - name  may carry a hint from a shared station ("who is at the keyboard",
//     e.g. the visiteuse picked on the poste) — honoured ONLY for a synthetic
//     reporter, appended to the account name, never substituted.
//
// Reads are scoped to the mount's product slug as well: the tracker key is
// company-scoped, so without it a reporter who also files tickets in another
// of the company's products would see them listed here (see belongsToProduct).
//
// Routes (per mount):
//   POST   /                  — create a ticket
//   GET    /reporter          — who the session reports as (name, can_follow)
//   GET    /                  — list the session user's tickets
//   GET    /:id               — detail (404 unless owned)
//   PATCH  /:id/follow        — opt in/out of status-change emails (owner only)
//   POST   /:id/attachments   — multipart upload (owner only)
//
// Env (server-side only, never sent to the client):
//   ISSUE_TRACKER_URL              — default https://liva-holding.com/issues/api/v1
//   ISSUE_TRACKER_API_KEY          — company-scoped key (shared by both mounts)
//   ISSUE_TRACKER_PRODUCT_SLUG     — ETM product slug in the tracker
//   ISSUE_TRACKER_PRODUCT_SLUG_TRM — TRM product slug in the tracker
//
// Missing key/slug → 503 (graceful, not a crash). Tracker timeout → 504,
// unreachable → 502. A tracker 401 (bad key) is remapped to 502 so it can
// never be mistaken for an expired MPS session.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import https from 'node:https'
import http from 'node:http'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { getUserEmail } from '../lib/user-emails.js'
import { composeReporterName, syntheticReporterEmail } from '../lib/tickets-reporter.js'

// Read env lazily — dotenv.config() in index.ts runs after ESM imports are
// evaluated (same reasoning as lib/auth.ts getSecret()).
const trackerUrl = () =>
  (process.env.ISSUE_TRACKER_URL || 'https://liva-holding.com/issues/api/v1').replace(/\/+$/, '')
const trackerKey = () => process.env.ISSUE_TRACKER_API_KEY || ''

const NOT_CONFIGURED_MSG = "Le système de tickets n'est pas configuré sur le serveur."
const UNREACHABLE_MSG = 'Impossible de contacter le serveur de tickets.'
const TIMEOUT_MSG = 'Le serveur de tickets ne répond pas (délai dépassé).'
const BAD_KEY_MSG = 'Système de tickets : clé API invalide. Contactez un administrateur.'
const NO_FOLLOW_MSG =
  "Le suivi par email demande une adresse associée à votre compte. " +
  'Un administrateur peut en définir une dans Paramètres › Utilisateurs.'

interface Reporter {
  name: string
  email: string
  /** No mapped email: `email` is the synthetic per-account identity, and the
   *  follow-up mail is off limits (nobody would receive it). */
  synthetic: boolean
}

/** Resolve the acting user's reporter identity from the session. Writes the
 *  error response and returns null when the user is unidentified. */
async function resolveReporter(req: Request, res: Response): Promise<Reporter | null> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  const mapped = await getUserEmail(req.userId)
  const email = mapped ?? syntheticReporterEmail(req.userId)
  const rows = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
    `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
  )
  let name = 'Utilisateur MPS'
  if (rows.length > 0) {
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const u = fixed[0] as { prenom: string | null; nom: string | null }
    const display = [u.prenom?.trim(), u.nom?.trim()].filter(Boolean).join(' ')
    if (display) name = display
  }
  return { name, email, synthetic: mapped === null }
}

function trackerHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': trackerKey() }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

/** JSON round-trip to the tracker with a hard timeout. Throws on network
 *  errors; callers map those via sendTrackerError. */
async function trackerJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${trackerUrl()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = { error: text }
  }
  return { status: res.status, data }
}

function sendTrackerError(res: Response, err: unknown, label: string): void {
  console.error(`Issue tracker proxy error (${label}):`, err)
  const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
  if (isTimeout) {
    res.status(504).json({ error: 'tracker_timeout', message: TIMEOUT_MSG })
  } else {
    res.status(502).json({ error: 'tracker_unreachable', message: UNREACHABLE_MSG })
  }
}

/** Forward a tracker response, remapping 401 (bad API key) to 502 so the
 *  frontend never confuses it with an expired MPS session. */
function forward(res: Response, status: number, data: unknown): void {
  if (status === 401) {
    res.status(502).json({ error: 'tracker_auth', message: BAD_KEY_MSG })
    return
  }
  res.status(status).json(data)
}

const TICKET_ID_RE = /^[0-9a-fA-F-]{10,64}$/

const submitBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(20000),
  severity: z.enum(['critique', 'majeur', 'mineur', 'cosmetique', 'haute', 'moyenne', 'basse']),
  category: z.enum(['bug', 'fonctionnalite']).default('bug'),
  context: z.string().max(2000).optional(),
  environment: z.string().max(200).optional(),
  // Reporter asked to be emailed on every status change of this ticket.
  // Optional so an older client keeps the tracker's silent default.
  follow_up: z.boolean().optional(),
  // Who is at the keyboard of a shared station. Only honoured for a synthetic
  // reporter (see composeReporterName) — for an account with a mapped email
  // the session is the identity and this field is dropped on the floor.
  reporter_name: z.string().trim().max(120).optional(),
})

const followBody = z.object({ follow_up: z.boolean() })

/** Everything below is per-mount: the two apps differ only in which env var
 *  names their product slug in the tracker. */
function createTicketsRouter(slugEnvVar: string): RouterType {
  const router = Router()
  const productSlug = () => process.env[slugEnvVar] || ''

  function ensureConfigured(res: Response): boolean {
    if (!trackerKey() || !productSlug()) {
      res.status(503).json({ error: 'not_configured', message: NOT_CONFIGURED_MSG })
      return false
    }
    return true
  }

  /** The tracker API key is *company*-scoped, not product-scoped: ETS Malterre
   *  owns "etm-erp", "trm-erp" and MFProd, so a user who reports in several
   *  apps under the same email gets the other products' tickets back unless the
   *  product is named explicitly. Every read is therefore scoped to this
   *  mount's slug — as a query filter for the list, and as an ownership check
   *  on detail/attachments. */
  function belongsToProduct(data: unknown): boolean {
    const slug = (data as { product_slug?: string } | null)?.product_slug
    // Trackers older than the product_slug filter omit the field; don't 404 the
    // whole widget against them — the reporter_email check still applies.
    if (typeof slug !== 'string') return true
    return slug === productSlug()
  }

  // ── POST / — create ───────────────────────────────────────
  router.post('/', async (req: Request, res: Response) => {
    if (!ensureConfigured(res)) return
    const parsed = submitBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    try {
      const reporter = await resolveReporter(req, res)
      if (!reporter) return
      const { reporter_name: hint, follow_up, ...fields } = parsed.data
      const payload = {
        ...fields,
        product_slug: productSlug(),
        reporter_email: reporter.email,
        reporter_name: reporter.synthetic ? composeReporterName(reporter.name, hint) : reporter.name,
        // A synthetic address receives nothing: never let the tracker queue
        // mail to it, whatever the client ticked.
        follow_up: reporter.synthetic ? false : follow_up,
      }
      const { status, data } = await trackerJson('/bugs', {
        method: 'POST',
        headers: trackerHeaders(true),
        body: JSON.stringify(payload),
      })
      forward(res, status, data)
    } catch (err) {
      sendTrackerError(res, err, 'POST /bugs')
    }
  })

  // ── GET / — list, scoped to user + product ────────────────
  router.get('/', async (req: Request, res: Response) => {
    if (!ensureConfigured(res)) return
    try {
      const reporter = await resolveReporter(req, res)
      if (!reporter) return
      const params = new URLSearchParams({
        reporter_email: reporter.email,
        product_slug: productSlug(),
      })
      for (const key of ['severity', 'category', 'status', 'page', 'per_page'] as const) {
        const v = req.query[key]
        if (typeof v === 'string' && v) params.set(key, v)
      }
      const { status, data } = await trackerJson(`/bugs?${params}`, { headers: trackerHeaders() })
      if (status === 200 && Array.isArray((data as { items?: unknown[] })?.items)) {
        // Second line of defence behind the product_slug filter above: drop any
        // foreign-product row the tracker still returned (older tracker build).
        const body = data as { items: unknown[]; total?: number }
        const items = body.items.filter(belongsToProduct)
        const dropped = body.items.length - items.length
        forward(res, status, {
          ...body,
          items,
          total: dropped > 0 ? items.length : body.total,
        })
        return
      }
      forward(res, status, data)
    } catch (err) {
      sendTrackerError(res, err, 'GET /bugs')
    }
  })

  // ── GET /reporter — who the session reports as ────────────
  // Lets the widget hide the follow-up controls for an account that cannot
  // receive the mail, instead of offering a checkbox the proxy then ignores.
  // Declared before /:id (the id pattern would not match anyway, but the
  // order makes it explicit). The email itself is never returned.
  router.get('/reporter', async (req: Request, res: Response) => {
    if (!ensureConfigured(res)) return
    try {
      const reporter = await resolveReporter(req, res)
      if (!reporter) return
      res.json({ name: reporter.name, can_follow: !reporter.synthetic })
    } catch (err) {
      console.error('Issue tracker proxy error (GET /reporter):', err)
      res.status(500).json({ error: 'reporter_lookup_failed' })
    }
  })

  // ── GET /:id — detail, owner only ─────────────────────────
  router.get('/:id', async (req: Request, res: Response) => {
    if (!ensureConfigured(res)) return
    if (!TICKET_ID_RE.test(req.params.id)) {
      res.status(404).json({ error: 'Ticket introuvable' })
      return
    }
    try {
      const reporter = await resolveReporter(req, res)
      if (!reporter) return
      const { status, data } = await trackerJson(`/bugs/${req.params.id}`, {
        headers: trackerHeaders(),
      })
      if (status === 200) {
        const owner = (data as { reporter_email?: string })?.reporter_email
        if (
          !owner ||
          owner.toLowerCase() !== reporter.email.toLowerCase() ||
          !belongsToProduct(data)
        ) {
          res.status(404).json({ error: 'Ticket introuvable' })
          return
        }
      }
      forward(res, status, data)
    } catch (err) {
      sendTrackerError(res, err, 'GET /bugs/:id')
    }
  })

  // ── PATCH /:id/follow — opt in/out of status-change emails ─
  // The one write a reporter may make on an existing ticket. Ownership is
  // re-checked against the tracker first (same rule as detail/attachments):
  // the tracker key is company-scoped, so without it any user of the company
  // could subscribe themselves to a colleague's ticket.
  router.patch('/:id/follow', async (req: Request, res: Response) => {
    if (!ensureConfigured(res)) return
    if (!TICKET_ID_RE.test(req.params.id)) {
      res.status(404).json({ error: 'Ticket introuvable' })
      return
    }
    const parsed = followBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    try {
      const reporter = await resolveReporter(req, res)
      if (!reporter) return
      if (reporter.synthetic) {
        res.status(400).json({ error: 'no_reporter_email', message: NO_FOLLOW_MSG })
        return
      }
      const owned = await trackerJson(`/bugs/${req.params.id}`, { headers: trackerHeaders() })
      if (owned.status === 401) {
        forward(res, owned.status, owned.data)
        return
      }
      const owner = (owned.data as { reporter_email?: string })?.reporter_email
      if (
        owned.status !== 200 ||
        !owner ||
        owner.toLowerCase() !== reporter.email.toLowerCase() ||
        !belongsToProduct(owned.data)
      ) {
        res.status(404).json({ error: 'Ticket introuvable' })
        return
      }
      const { status, data } = await trackerJson(`/bugs/${req.params.id}/follow`, {
        method: 'PATCH',
        headers: trackerHeaders(true),
        body: JSON.stringify(parsed.data),
      })
      forward(res, status, data)
    } catch (err) {
      sendTrackerError(res, err, 'PATCH /bugs/:id/follow')
    }
  })

  // ── POST /:id/attachments — multipart pipe ────────────────
  // The multipart body is streamed through untouched (express.json ignores
  // non-JSON content types, so req is still an unread stream here). Ownership
  // is verified against the tracker before piping.
  router.post('/:id/attachments', async (req: Request, res: Response) => {
    if (!ensureConfigured(res)) return
    if (!TICKET_ID_RE.test(req.params.id)) {
      res.status(404).json({ error: 'Ticket introuvable' })
      return
    }
    try {
      const reporter = await resolveReporter(req, res)
      if (!reporter) return
      const { status, data } = await trackerJson(`/bugs/${req.params.id}`, {
        headers: trackerHeaders(),
      })
      if (status === 401) {
        forward(res, status, data)
        return
      }
      const owner = (data as { reporter_email?: string })?.reporter_email
      if (
        status !== 200 ||
        !owner ||
        owner.toLowerCase() !== reporter.email.toLowerCase() ||
        !belongsToProduct(data)
      ) {
        res.status(404).json({ error: 'Ticket introuvable' })
        return
      }
    } catch (err) {
      sendTrackerError(res, err, 'attachments ownership check')
      return
    }

    const parsedUrl = new URL(`${trackerUrl()}/bugs/${req.params.id}/attachments`)
    const lib = parsedUrl.protocol === 'https:' ? https : http
    const proxyReq = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          // Pass the browser's multipart Content-Type through verbatim — it
          // carries the boundary. Never set it manually.
          'Content-Type': req.headers['content-type'] || '',
          'X-API-Key': trackerKey(),
        },
      },
      (proxyRes) => {
        let body = ''
        proxyRes.on('data', (chunk) => (body += chunk))
        proxyRes.on('end', () => {
          const status = proxyRes.statusCode || 500
          let data: unknown
          try {
            data = JSON.parse(body)
          } catch {
            data = { error: body }
          }
          forward(res, status, data)
        })
      },
    )
    proxyReq.setTimeout(30_000, () => {
      proxyReq.destroy(new Error('tracker attachment upload timeout'))
    })
    proxyReq.on('error', (err) => {
      if (!res.headersSent) sendTrackerError(res, err, 'POST attachments')
    })
    req.pipe(proxyReq)
  })

  return router
}

export const ticketsRouter: RouterType = createTicketsRouter('ISSUE_TRACKER_PRODUCT_SLUG')
export const ticketsTrmRouter: RouterType = createTicketsRouter('ISSUE_TRACKER_PRODUCT_SLUG_TRM')
