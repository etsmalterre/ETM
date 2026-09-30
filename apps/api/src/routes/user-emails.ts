// User-emails routes — admin-managed mapping of IDutilisateur → corporate
// email address (for domain-wide-delegation Gmail sends). JSON-file backed
// via lib/user-emails.ts.
//
// Endpoints:
//   GET  /api/user-emails/me         — current user's email (or null)
//   GET  /api/user-emails/users      — admin only, every user + email
//   PUT  /api/user-emails/users/:id  — admin only, set/clear one user's email

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { requireAdmin } from '../lib/auth.js'
import {
  getUserEmail,
  setUserEmail,
  getAllUserEmails,
  EmailDejaUtilise,
} from '../lib/user-emails.js'

export const userEmailsRouter: RouterType = Router()

interface Utilisateur {
  IDutilisateur: number
  pc: string | null
  prenom: string | null
  nom: string | null
}

const TEXT_FIELDS = ['pc', 'prenom', 'nom']

const putBody = z.object({
  email: z.string().trim().max(255),
})

// Basic RFC-5322-ish email check — permissive but rejects obvious garbage.
// Empty string is allowed (clears the mapping).
function looksLikeEmail(value: string): boolean {
  if (!value) return true
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

// ── GET /api/user-emails/me ────────────────────────────
userEmailsRouter.get('/me', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const email = await getUserEmail(req.userId)
  res.json({ email })
})

// ── GET /api/user-emails/users ─────────────────────────
// Admin only. Returns every deduped user with their current email.
userEmailsRouter.get('/users', async (req: Request, res: Response) => {
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

    const allEmails = await getAllUserEmails()
    const payload = Array.from(seen.values())
      .map((u) => ({ ...u, email: allEmails[u.IDutilisateur] ?? null }))
      .sort((a, b) => {
        const an = (a.nom ?? '').localeCompare(b.nom ?? '', 'fr')
        if (an !== 0) return an
        return (a.prenom ?? '').localeCompare(b.prenom ?? '', 'fr')
      })

    res.json(payload)
  } catch (err) {
    console.error('Error fetching user-emails list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/user-emails/users/:id ─────────────────────
userEmailsRouter.put('/users/:id', async (req: Request, res: Response) => {
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
  const email = parsed.data.email.trim()
  if (!looksLikeEmail(email)) {
    res.status(400).json({ error: 'invalid email' })
    return
  }
  try {
    await setUserEmail(id, email)
    res.json({ IDutilisateur: id, email: await getUserEmail(id) })
  } catch (err) {
    if (err instanceof EmailDejaUtilise) {
      res.status(409).json({ error: 'email_deja_utilise', message: 'Cette adresse est déjà celle d’un autre compte.' })
      return
    }
    console.error('Error updating user email:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
