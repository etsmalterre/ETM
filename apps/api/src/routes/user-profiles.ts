// User-profiles routes — admin-managed per-user photo + email signature.
// JSON-file backed via lib/user-profiles.ts (photos on disk under
// data/user-photos/). Signatures are structured fields rendered through the
// company template (lib/signature-template.ts); the rendered HTML is
// appended to outgoing emails by lib/gmail.ts (logo as inline cid: image)
// and returned here with a data-URI logo for in-app previews. The photo
// feeds the header avatar + "Mon profil" modal.
//
// Endpoints:
//   GET    /api/user-profiles/me               — current user's profile
//   GET    /api/user-profiles/me/dashboard     — the user's tableaux de bord
//   PUT    /api/user-profiles/me/dashboard     — replace them (names + layouts)
//   GET    /api/user-profiles/users            — admin only, every user + profile
//   GET    /api/user-profiles/users/:id/photo  — self or admin, raw image bytes
//   PUT    /api/user-profiles/users/:id/signature — admin only, set/clear fields
//   POST   /api/user-profiles/signature-preview — admin only, render fields → HTML
//   PUT    /api/user-profiles/users/:id/photo  — admin only, multipart upload
//   DELETE /api/user-profiles/users/:id/photo  — admin only

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { requireAdmin, isEffectiveAdmin } from '../lib/auth.js'
import {
  getUserProfile,
  setUserSignature,
  setUserPhoto,
  clearUserPhoto,
  getUserPhotoPath,
  getAllUserProfiles,
  getEffectiveSignature,
  getUserDashboards,
  setUserDashboards,
  DASHBOARD_MAX_WIDGETS,
  DASHBOARD_MAX_KEY_LENGTH,
  DASHBOARD_MIN_WIDTH,
  DASHBOARD_MAX_WIDTH,
  DASHBOARD_MIN_HEIGHT_PX,
  DASHBOARD_MAX_HEIGHT_PX,
  DASHBOARD_MAX_Y,
  DASHBOARD_PRIMARY_ID,
  DASHBOARD_PRIMARY_NAME,
  DASHBOARD_MAX_TABS,
  DASHBOARD_MAX_NAME_LENGTH,
  DASHBOARD_MAX_ID_LENGTH,
  type DashboardApp,
  type DashboardTab,
  type PhotoExt,
  type UserProfile,
} from '../lib/user-profiles.js'
import {
  hasSignatureContent,
  renderSignatureHtml,
  signatureLogoDataUri,
  type SignatureFields,
} from '../lib/signature-template.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

export const userProfilesRouter: RouterType = Router()

interface Utilisateur {
  IDutilisateur: number
  pc: string | null
  prenom: string | null
  nom: string | null
}

const TEXT_FIELDS = ['pc', 'prenom', 'nom']

const MIME_TO_EXT: Record<string, PhotoExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const EXT_TO_MIME: Record<PhotoExt, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

const signatureFieldsSchema = z.object({
  displayName: z.string().max(120),
  fonction: z.string().max(120),
  telFixe: z.string().max(40),
  email: z.string().max(200),
})

const putSignatureBody = z.object({
  signature: signatureFieldsSchema,
})

const EMPTY_PROFILE: UserProfile = { signature: null, legacySignatureHtml: null, photo: null }

/** Shared payload shape. `signatureHtml` is the RENDERED signature (template
 *  with data-URI logo for previews), or the raw legacy pasted HTML when the
 *  user has no structured fields yet. */
function profilePayload(p: UserProfile) {
  const signatureHtml =
    p.signature !== null
      ? renderSignatureHtml(p.signature, signatureLogoDataUri())
      : p.legacySignatureHtml
  return {
    signature: p.signature,
    hasLegacySignature: p.signature === null && p.legacySignatureHtml !== null,
    signatureHtml,
    hasPhoto: p.photo !== null,
    photoVersion: p.photo?.updatedAt ?? null,
  }
}

// ── GET /api/user-profiles/me ──────────────────────────
// `signatureHtml` here is the EFFECTIVE signature — the one gmail.ts appends
// at send time, including the identity-derived fallback when nothing is
// stored. The send dialogs preview this, so what the user sees is what the
// recipient gets. `signature` / `hasLegacySignature` still describe what is
// actually stored, so the profile modal can tell "configured" from "default".
userProfilesRouter.get('/me', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const profile = await getUserProfile(req.userId)
  const effective = await getEffectiveSignature(req.userId)
  const signatureHtml = effective
    ? effective.fields
      ? renderSignatureHtml(effective.fields, signatureLogoDataUri())
      : effective.legacyHtml
    : null
  res.json({
    IDutilisateur: req.userId,
    ...profilePayload(profile),
    signatureHtml,
    signatureIsDefault: effective?.isDefault ?? false,
  })
})

// ── Tableaux de bord (self-service, not admin-gated) ────────────────────
// Personal preference, so every user manages their own — unlike the signature
// and photo above, which an admin sets on their behalf.
//
// A user has one or more NAMED dashboards, surfaced as the submenu tabs of
// "Tableau de bord"; the first one is the primary and always exists. Widgets
// are arranged per dashboard, which is how a user splits them across several
// screens instead of one long one.
//
// The widget catalog lives in the frontend registry
// (apps/web/src/components/dashboard/registry.tsx); this layer only validates
// shape and size. Keys it doesn't recognise are stored verbatim and dropped by
// the dashboard when it merges the registry, so a widget can be renamed or
// retired without a migration here.

const widgetPref = z.object({
  key: z.string().min(1).max(DASHBOARD_MAX_KEY_LENGTH),
  width: z.number().int().min(DASHBOARD_MIN_WIDTH).max(DASHBOARD_MAX_WIDTH),
  heightPx: z.number().int()
    .min(DASHBOARD_MIN_HEIGHT_PX).max(DASHBOARD_MAX_HEIGHT_PX)
    .optional(),
  x: z.number().int().min(0).max(DASHBOARD_MAX_WIDTH - 1).optional(),
  y: z.number().int().min(0).max(DASHBOARD_MAX_Y).optional(),
  visible: z.boolean(),
})

const dashboardsBody = z.object({
  dashboards: z
    .array(
      z.object({
        id: z.string().min(1).max(DASHBOARD_MAX_ID_LENGTH),
        name: z.string().min(1).max(DASHBOARD_MAX_NAME_LENGTH),
        // null = "follow the registry defaults" (primary only)
        layout: z.array(widgetPref).max(DASHBOARD_MAX_WIDGETS).nullable(),
      }),
    )
    .min(1)
    .max(DASHBOARD_MAX_TABS),
})

// Both apps (ETM and TRM) call these with their own `?app=` — the layouts are
// stored per app because the widget catalogs differ. No scope = ETM, which is
// what every pre-existing client sends.
const appQuery = z.object({ app: z.enum(['etm', 'trm']).default('etm') })

function dashboardApp(req: Request, res: Response): DashboardApp | null {
  const parsed = appQuery.safeParse({ app: req.query.app ?? undefined })
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid app', issues: parsed.error.issues })
    return null
  }
  return parsed.data.app
}

// GET /api/user-profiles/me/dashboard?app=etm|trm
userProfilesRouter.get('/me/dashboard', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const app = dashboardApp(req, res)
  if (!app) return
  res.json({ dashboards: await getUserDashboards(req.userId, app) })
})

// PUT /api/user-profiles/me/dashboard?app=etm|trm
userProfilesRouter.put('/me/dashboard', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const app = dashboardApp(req, res)
  if (!app) return
  const parsed = dashboardsBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues })
    return
  }

  const seenIds = new Set<string>()
  const tabs: DashboardTab[] = []
  for (const [i, tab] of parsed.data.dashboards.entries()) {
    // The first tab IS the primary one, whatever the client called it: the app
    // routes it at `/` and it can never be deleted, so its id has to be known.
    const id = i === 0 ? DASHBOARD_PRIMARY_ID : tab.id
    if (seenIds.has(id)) continue // a duplicate id would make routing ambiguous
    seenIds.add(id)
    const name = tab.name.trim().slice(0, DASHBOARD_MAX_NAME_LENGTH)
    tabs.push({
      id,
      name: name || (i === 0 ? DASHBOARD_PRIMARY_NAME : `Tableau ${i + 1}`),
      // Last write wins per key — a duplicated key would otherwise render the
      // same widget twice and make drag-and-drop ambiguous.
      layout: tab.layout ? [...new Map(tab.layout.map((w) => [w.key, w])).values()] : null,
    })
  }

  await setUserDashboards(req.userId, tabs, app)
  res.json({ dashboards: await getUserDashboards(req.userId, app) })
})

// ── GET /api/user-profiles/users ───────────────────────
// Admin only. Returns every deduped user with their current profile.
userProfilesRouter.get('/users', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const rows = await query<Utilisateur>(
      'SELECT IDutilisateur, pc, prenom, nom FROM utilisateur ORDER BY IDutilisateur'
    )
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', TEXT_FIELDS)

    // Same dedupe rule as /auth/users — lowest IDutilisateur per (prenom, nom).
    const seen = new Map<string, {
      IDutilisateur: number
      prenom: string | null
      nom: string | null
    }>()
    for (const u of fixed as any[]) {
      const prenom = (u.prenom ?? '').toString()
      const nom = (u.nom ?? '').toString()
      const key = `${prenom.trim().toLowerCase()}|${nom.trim().toLowerCase()}`
      if (seen.has(key)) continue
      seen.set(key, {
        IDutilisateur: Number(u.IDutilisateur),
        prenom: prenom || null,
        nom: nom || null,
      })
    }

    const allProfiles = await getAllUserProfiles()
    const payload = Array.from(seen.values())
      .map((u) => ({
        ...u,
        ...profilePayload(allProfiles[u.IDutilisateur] ?? EMPTY_PROFILE),
      }))
      .sort((a, b) => {
        const an = (a.nom ?? '').localeCompare(b.nom ?? '', 'fr')
        if (an !== 0) return an
        return (a.prenom ?? '').localeCompare(b.prenom ?? '', 'fr')
      })

    res.json(payload)
  } catch (err) {
    console.error('Error fetching user-profiles list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/user-profiles/users/:id/photo ─────────────
// Self or admin. Streams the stored image; 404 when none. Strip helmet's
// restrictive headers so the cross-origin <img> works (mirror the
// etudes-coloris photo proxy).
userProfilesRouter.get('/users/:id/photo', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  if (req.userId !== id && !isEffectiveAdmin(req)) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  try {
    const photo = await getUserPhotoPath(id)
    if (!photo) {
      res.status(404).json({ error: 'No photo' })
      return
    }
    res.setHeader('Content-Type', EXT_TO_MIME[photo.ext])
    res.setHeader('Content-Disposition', 'inline')
    // Immutable is safe: the URL carries ?v=<photoVersion> which changes on
    // every upload.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.sendFile(photo.path, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'No photo' })
    })
  } catch (err) {
    console.error('Error serving user photo:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/user-profiles/users/:id/signature ─────────
userProfilesRouter.put('/users/:id/signature', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const id = parseInt(req.params.id, 10)
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  const parsed = putSignatureBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues })
    return
  }
  try {
    await setUserSignature(id, parsed.data.signature)
    const profile = await getUserProfile(id)
    res.json({ IDutilisateur: id, ...profilePayload(profile) })
  } catch (err) {
    console.error('Error updating user signature:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/user-profiles/signature-preview ──────────
// Admin only. Renders draft fields through the company template (data-URI
// logo) so the editor can show a live preview while typing, without saving.
userProfilesRouter.post('/signature-preview', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const parsed = putSignatureBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues })
    return
  }
  const fields: SignatureFields = parsed.data.signature
  const html = hasSignatureContent(fields)
    ? renderSignatureHtml(fields, signatureLogoDataUri())
    : ''
  res.json({ html })
})

// ── PUT /api/user-profiles/users/:id/photo ─────────────
userProfilesRouter.put(
  '/users/:id/photo',
  (req: Request, res: Response, next) => {
    if (!requireAdmin(req, res)) return
    next()
  },
  upload.single('photo'),
  async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const file = req.file
    if (!file || file.buffer.length === 0) {
      res.status(400).json({ error: 'missing photo file' })
      return
    }
    const ext = MIME_TO_EXT[file.mimetype]
    if (!ext) {
      res.status(400).json({ error: 'unsupported image type' })
      return
    }
    try {
      const { updatedAt } = await setUserPhoto(id, file.buffer, ext)
      res.json({ IDutilisateur: id, hasPhoto: true, photoVersion: updatedAt })
    } catch (err) {
      console.error('Error uploading user photo:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── DELETE /api/user-profiles/users/:id/photo ──────────
userProfilesRouter.delete('/users/:id/photo', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const id = parseInt(req.params.id, 10)
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    await clearUserPhoto(id)
    res.status(204).end()
  } catch (err) {
    console.error('Error deleting user photo:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
