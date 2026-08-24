// TRM permissions routes — per-user action permissions for the Tricotage
// Malterre app, managed from ITS Paramètres > Utilisateurs screen. Mirror of
// routes/permissions.ts over the TRM catalog + store (see the header of
// lib/permissions-trm.ts for why they are separate); no screen-access axis
// here — TRM has no Écrans tab yet.
//
// Endpoints (mounted at /api/permissions-trm):
//   GET  /me         — current user's granted TRM keys + admin flags
//   GET  /keys       — public catalog of TRM permission keys
//   GET  /users      — admin only, all users + their TRM grants
//   PUT  /users/:id  — admin only, replace a user's TRM grants

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { requireAdmin, isEffectiveAdmin } from '../lib/auth.js'
import {
  getTrmUserPermissions,
  setTrmUserPermissions,
  getAllTrmPermissions,
} from '../lib/permissions-trm.js'
import { TRM_PERMISSION_KEYS, isKnownTrmPermissionKey } from '../lib/permission-keys-trm.js'

export const permissionsTrmRouter: RouterType = Router()

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

// ── GET /api/permissions-trm/me ────────────────────────
// Same contract as ETM's /permissions/me: `isAdmin` is session-level (admin
// cookie present, true even while impersonating), `isEffectiveAdmin` is what
// drives the bypass — an effective admin gets the whole TRM catalog.
permissionsTrmRouter.get('/me', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const isAdmin = req.adminId !== undefined
  const effective = isEffectiveAdmin(req)
  const granted: string[] = effective
    ? TRM_PERMISSION_KEYS.map((p) => p.key)
    : await getTrmUserPermissions(req.userId)
  res.json({ isAdmin, isEffectiveAdmin: effective, granted })
})

// ── GET /api/permissions-trm/keys ──────────────────────
// Public catalog of known TRM permission keys. Used by TRM's admin UI to
// render toggles. No auth required — the catalog itself is not sensitive.
permissionsTrmRouter.get('/keys', (_req: Request, res: Response) => {
  res.json(TRM_PERMISSION_KEYS)
})

// ── GET /api/permissions-trm/users ─────────────────────
// Admin only. Returns every deduped user with their TRM grants. Same dedupe
// rule as /auth/users (lowest IDutilisateur per person); the TRM screen
// narrows to its staff allowlist client-side.
permissionsTrmRouter.get('/users', async (req: Request, res: Response) => {
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

    const allPerms = await getAllTrmPermissions()
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
    console.error('Error fetching utilisateur TRM permissions list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/permissions-trm/users/:id ─────────────────
// Admin only. Replaces a user's TRM grant list with the body. Unknown keys
// are silently dropped (the lib filters again — defence in depth).
permissionsTrmRouter.put('/users/:id', async (req: Request, res: Response) => {
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
  const keys = parsed.data.granted.filter((k) => isKnownTrmPermissionKey(k))
  try {
    await setTrmUserPermissions(id, keys)
    res.json({ IDutilisateur: id, granted: await getTrmUserPermissions(id) })
  } catch (err) {
    console.error('Error updating user TRM permissions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
