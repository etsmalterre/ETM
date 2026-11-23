// Expe permissions routes: per-user rights of the shipping and transfer
// tracking app (expe.intra.etsmalterre.com, repo expe), managed from the
// Console Administration › Utilisateurs › EXPE. Mirror of
// routes/permissions-trm.ts over Expe's catalog + store (see the header of
// lib/permissions-expe.ts for why they are separate), same two-axis
// screen-access model (lib/screen-keys-expe.ts).
//
// Endpoints (mounted at /api/permissions-expe):
//   GET  /me         — current user's granted Expe keys + admin flags
//   GET  /keys       — public catalog of Expe permission keys
//   GET  /screens    — public catalog of Expe's navigation tree
//   GET  /users      — admin only, all users + their Expe grants
//   PUT  /users/:id  — admin only, replace a user's Expe grants

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { requireAdmin, isEffectiveAdmin } from '../lib/auth.js'
import {
  getExpeUserPermissions,
  setExpeUserPermissions,
  getAllExpePermissions,
  isStorableExpeKey,
} from '../lib/permissions-expe.js'
import { EXPE_PERMISSION_KEYS } from '../lib/permission-keys-expe.js'
import { EXPE_SCREEN_MENUS, allExpeMenuAccessKeys } from '../lib/screen-keys-expe.js'

export const permissionsExpeRouter: RouterType = Router()

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

// ── GET /api/permissions-expe/me ───────────────────────
// Same contract as /permissions/me and /permissions-trm/me: `isAdmin` is
// session-level (true even while impersonating), `isEffectiveAdmin` drives the
// bypass: an effective admin gets the whole Expe catalog plus every MENU
// GRANT. Screen HIDE keys are never reported to an admin (negative keys: they
// would hide every screen from them).
permissionsExpeRouter.get('/me', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const isAdmin = req.adminId !== undefined
  const effective = isEffectiveAdmin(req)
  const granted: string[] = effective
    ? [...EXPE_PERMISSION_KEYS.map((p) => p.key), ...allExpeMenuAccessKeys()]
    : await getExpeUserPermissions(req.userId)
  res.json({ isAdmin, isEffectiveAdmin: effective, granted })
})

// ── GET /api/permissions-expe/screens ──────────────────
// The navigation tree the screen-access keys derive from. The Console
// Administration draws its Écrans tab from it (it cannot import Expe's
// navigation).
permissionsExpeRouter.get('/screens', (_req: Request, res: Response) => {
  res.json(EXPE_SCREEN_MENUS)
})

// ── GET /api/permissions-expe/keys ─────────────────────
// Public catalog of known Expe permission keys, for the admin screen's
// toggles. The catalog itself is not sensitive.
permissionsExpeRouter.get('/keys', (_req: Request, res: Response) => {
  res.json(EXPE_PERMISSION_KEYS)
})

// ── GET /api/permissions-expe/users ────────────────────
// Admin only. Every deduped user with their Expe grants (same dedupe rule as
// /auth/users: lowest IDutilisateur per person); the screen narrows to Expe's
// members client-side.
permissionsExpeRouter.get('/users', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const rows = await query<Utilisateur>(
      'SELECT IDutilisateur, pc, prenom, nom FROM utilisateur ORDER BY IDutilisateur'
    )
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', TEXT_FIELDS)

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

    const allPerms = await getAllExpePermissions()
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
    console.error('Error fetching utilisateur Expe permissions list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/permissions-expe/users/:id ────────────────
// Admin only. Replaces a user's Expe grant list with the body. Both axes are
// accepted (action keys and screen-access keys); unknown keys are silently
// dropped (the lib filters again: defence in depth).
permissionsExpeRouter.put('/users/:id', async (req: Request, res: Response) => {
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
  try {
    await setExpeUserPermissions(id, parsed.data.granted.filter(isStorableExpeKey))
    res.json({ IDutilisateur: id, granted: await getExpeUserPermissions(id) })
  } catch (err) {
    console.error('Error updating user Expe permissions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
