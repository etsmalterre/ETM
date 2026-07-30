// Permissions routes — per-user action permissions, managed from the
// Settings > Utilisateurs admin page. Built on top of the cookie auth
// feature: req.userId / req.adminId come from the attachUser middleware.
//
// Endpoints:
//   GET  /api/permissions/me         — current user's granted keys + isAdmin
//   GET  /api/permissions/keys       — public catalog of permission keys
//   GET  /api/permissions/users      — admin only, all users + their grants
//   PUT  /api/permissions/users/:id  — admin only, replace a user's grants

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { requireAdmin, isEffectiveAdmin } from '../lib/auth.js'
import {
  getUserPermissions,
  setUserPermissions,
  getAllPermissions,
} from '../lib/permissions.js'
import { PERMISSION_KEYS, isKnownPermissionKey } from '../lib/permission-keys.js'
import { SCREEN_MENUS, allMenuAccessKeys, isScreenAccessKey } from '../lib/screen-keys.js'

export const permissionsRouter: RouterType = Router()

interface Utilisateur {
  IDutilisateur: number
  pc: string | null
  prenom: string | null
  nom: string | null
}

const TEXT_FIELDS = ['pc', 'prenom', 'nom']

const putBody = z.object({
  granted: z.array(z.string()),
})

// ── GET /api/permissions/me ────────────────────────────
// Returns the current user's granted permission keys + two distinct flags:
//
//   isAdmin           — session level: an admin cookie is present (true even
//                       when the admin is impersonating someone else). Used
//                       by the frontend to decide whether to show the
//                       "Changer d'utilisateur" button.
//   isEffectiveAdmin  — currently acting AS the admin (req.userId === adminId).
//                       False during impersonation. This is the flag that
//                       drives the permission bypass — admins only get full
//                       powers when acting as themselves, NOT when
//                       impersonating another user.
//
// The bypass on `granted` only applies for effective admins; an admin who
// impersonates a non-admin sees that user's real grant list.
permissionsRouter.get('/me', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const isAdmin = req.adminId !== undefined
  const effective = isEffectiveAdmin(req)
  // For an effective admin, report every action key plus every MENU GRANT.
  // Screen HIDE keys are deliberately never reported: they are negative keys,
  // so handing them to the admin would hide every screen from them. The
  // frontend also reads hide keys through hasRaw() (no bypass) for the same
  // reason — see PermissionsContext.
  const granted: string[] = effective
    ? [...PERMISSION_KEYS.map((p) => p.key), ...allMenuAccessKeys()]
    : await getUserPermissions(req.userId)
  res.json({ isAdmin, isEffectiveAdmin: effective, granted })
})

// ── GET /api/permissions/screens ───────────────────────
// Public catalog of the navigation tree the screen-access keys are derived
// from. The admin UI builds its tree from the web's own navigation.ts (so it
// can never drift from the real nav); this endpoint exists so the stored keys
// can be inspected/validated from outside the web app.
permissionsRouter.get('/screens', (_req: Request, res: Response) => {
  res.json(SCREEN_MENUS)
})

// ── GET /api/permissions/keys ──────────────────────────
// Public catalog of known permission keys. Used by the admin UI to render
// toggles. No auth required — the catalog itself is not sensitive.
permissionsRouter.get('/keys', (_req: Request, res: Response) => {
  res.json(PERMISSION_KEYS)
})

// ── GET /api/permissions/users ─────────────────────────
// Admin only. Returns every deduped user with their current grants. Reuses
// the same dedupe rule as /auth/users (lowest IDutilisateur per person).
permissionsRouter.get('/users', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const rows = await query<Utilisateur>(
      'SELECT IDutilisateur, pc, prenom, nom FROM utilisateur ORDER BY IDutilisateur'
    )
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', TEXT_FIELDS)

    // Same dedupe as /auth/users — lowest IDutilisateur wins per (prenom, nom).
    const seen = new Map<string, {
      IDutilisateur: number
      prenom: string | null
      nom: string | null
      roleHint: string | null
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
        roleHint: typeof u.pc === 'string' ? u.pc.toLowerCase() : null,
      })
    }

    // Attach permissions and sort alphabetically by nom, prenom.
    const allPerms = await getAllPermissions()
    const payload = Array.from(seen.values())
      .map((u) => ({
        ...u,
        granted: allPerms[u.IDutilisateur] ?? [],
      }))
      .sort((a, b) => {
        const an = (a.nom ?? '').localeCompare(b.nom ?? '', 'fr')
        if (an !== 0) return an
        return (a.prenom ?? '').localeCompare(b.prenom ?? '', 'fr')
      })

    res.json(payload)
  } catch (err) {
    console.error('Error fetching utilisateur permissions list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/permissions/users/:id ─────────────────────
// Admin only. Replaces a user's grant list with the body. Validates that
// every key is in the catalog (unknown keys are silently dropped).
permissionsRouter.put('/users/:id', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const id = parseInt(req.params.id, 10)
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  const parsed = putBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues })
    return
  }
  // Filter to known keys — defence in depth (the lib also filters). Both
  // axes are accepted: action keys from the catalog, and screen-access keys.
  const keys = parsed.data.granted.filter(
    (k) => isKnownPermissionKey(k) || isScreenAccessKey(k),
  )
  try {
    await setUserPermissions(id, keys)
    res.json({ IDutilisateur: id, granted: await getUserPermissions(id) })
  } catch (err) {
    console.error('Error updating user permissions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
