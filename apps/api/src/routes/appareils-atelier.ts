// Atelier phones — enrolment, revocation, and « who is this phone? ».
// Mounted at /api/atelier/appareils (before /api/atelier, so it wins).
//
// Two audiences:
//   Admin (Paramètres › Utilisateurs, TRM ERP, `requireAdmin`):
//     GET    /            every enrolled phone + the pending codes
//     POST   /codes       generate a one-time enrolment code
//     DELETE /codes/:code cancel a pending code
//     PATCH  /:id         rename a phone
//     DELETE /:id         revoke a phone (its cookie dies with the row)
//   The phone itself (atelier PWA, no prior identity):
//     POST   /enroler     { code } → sets the `mps_appareil` cookie
//     GET    /moi         what this phone is (401 = not enrolled / revoked)
//     GET    /enrolement-en-attente  { enAttente } — is a code pending?
//
// Model and store: lib/appareils-atelier.ts.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import {
  requireAdmin,
  APPAREIL_COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,
  appareilCookieOptions,
} from '../lib/auth.js'
import {
  LIBELLE_MAX,
  CODE_TTL_MS,
  listerAppareils,
  listerCodes,
  codeEnAttente,
  creerCode,
  annulerCode,
  consommerCode,
  enroler,
  revoquer,
  renommer,
  publier,
  peutEssayer,
  noterEchec,
  oublierEchecs,
  type AppareilPublic,
} from '../lib/appareils-atelier.js'
import { selectBonnetiers } from '../lib/production-trm.js'

export const appareilsAtelierRouter: RouterType = Router()

interface BonnetierPublic {
  IDbonnetier: number
  prenom: string
  nom: string
  regleur: number
}

async function bonnetierPublic(id: number | null): Promise<BonnetierPublic | null> {
  if (id === null) return null
  const b = (await selectBonnetiers()).find((x) => x.id === id)
  if (!b) return null
  return { IDbonnetier: b.id, prenom: b.prenom, nom: b.nom, regleur: b.regleur }
}

/** The phone-facing shape: the row plus its resolved identity. No « can it
 *  write? » flag any more: an enrolled phone always can (routes/atelier.ts,
 *  gateSaisie — decision of 2026-09-15). */
async function moi(a: AppareilPublic) {
  const bonnetier = await bonnetierPublic(a.IDbonnetier)
  return {
    id: a.id,
    libelle: a.libelle,
    IDutilisateur: a.IDutilisateur,
    bonnetier,
  }
}

// ── Phone side ─────────────────────────────────────────────────────────────

appareilsAtelierRouter.get('/moi', async (req: Request, res: Response) => {
  try {
    if (!req.appareil) {
      res.status(401).json({ error: 'appareil_non_enrole' })
      return
    }
    res.json(await moi(publier(req.appareil)))
  } catch (err) {
    console.error('Error in /atelier/appareils/moi:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// The PWA offers « Enrôler ce téléphone » only while an admin has a code
// pending (2026-09-15). Public like /enroler, and a boolean only — never the
// code, its label or its régleur. It tells a guesser WHEN a code exists,
// nothing more; the brake on /enroler still holds.
appareilsAtelierRouter.get('/enrolement-en-attente', (_req: Request, res: Response) => {
  res.json({ enAttente: codeEnAttente() })
})

const enrolerBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict()

appareilsAtelierRouter.post('/enroler', async (req: Request, res: Response) => {
  try {
    const client = req.ip ?? 'inconnu'
    if (!peutEssayer(client)) {
      res.status(429).json({ error: 'trop_d_essais', message: 'Trop d’essais. Réessayez dans un quart d’heure.' })
      return
    }
    const parsed = enrolerBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const c = consommerCode(parsed.data.code)
    if (!c) {
      noterEchec(client)
      res.status(404).json({ error: 'code_invalide', message: 'Code inconnu ou expiré.' })
      return
    }
    oublierEchecs(client)
    const { appareil, token } = await enroler(c)
    res.cookie(APPAREIL_COOKIE_NAME, token, {
      ...appareilCookieOptions(),
      maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
    })
    res.status(201).json(await moi(publier(appareil)))
  } catch (err) {
    console.error('Error in /atelier/appareils/enroler:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Admin side ─────────────────────────────────────────────────────────────

appareilsAtelierRouter.get('/', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const bonnetiers = await selectBonnetiers()
    const nom = (id: number | null) => {
      if (id === null) return null
      const b = bonnetiers.find((x) => x.id === id)
      return b ? { IDbonnetier: b.id, prenom: b.prenom, nom: b.nom } : { IDbonnetier: id, prenom: '?', nom: '' }
    }
    const appareils = (await listerAppareils()).map((a) => ({ ...a, bonnetier: nom(a.IDbonnetier) }))
    const codes = listerCodes().map((c) => ({
      code: c.code,
      IDutilisateur: c.IDutilisateur,
      libelle: c.libelle,
      bonnetier: nom(c.IDbonnetier),
      expireLe: new Date(c.expireLe).toISOString(),
    }))
    res.json({ appareils, codes, ttlMs: CODE_TTL_MS })
  } catch (err) {
    console.error('Error listing atelier appareils:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const codeBody = z
  .object({
    IDutilisateur: z.number().int().positive(),
    /** A régleur's own phone; omit / null for a shared bonnetier phone. */
    IDbonnetier: z.number().int().positive().nullable().optional(),
    libelle: z.string().trim().min(1).max(LIBELLE_MAX),
  })
  .strict()

appareilsAtelierRouter.post('/codes', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const parsed = codeBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const { IDutilisateur, libelle } = parsed.data
    const IDbonnetier = parsed.data.IDbonnetier ?? null
    if (IDbonnetier !== null) {
      // A fixed identity is a RÉGLEUR's: the whole point of the fixed phone
      // is the régleur screens, and a bonnetier keeps picking his face.
      const b = (await selectBonnetiers()).find((x) => x.id === IDbonnetier)
      if (!b || b.archive !== 0 || b.regleur !== 1) {
        res.status(400).json({ error: 'regleur_requis', message: 'L’identité fixe doit être un régleur actif.' })
        return
      }
    }
    const c = creerCode({ IDutilisateur, IDbonnetier, libelle, creePar: req.userId! })
    res.status(201).json({ code: c.code, expireLe: new Date(c.expireLe).toISOString(), ttlMs: CODE_TTL_MS })
  } catch (err) {
    console.error('Error creating enrolment code:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

appareilsAtelierRouter.delete('/codes/:code', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const code = String(req.params.code)
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: 'Invalid code' })
    return
  }
  res.json({ ok: true, supprime: annulerCode(code) })
})

function parseId(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id), 10)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' })
    return null
  }
  return id
}

const renameBody = z.object({ libelle: z.string().trim().min(1).max(LIBELLE_MAX) }).strict()

appareilsAtelierRouter.patch('/:id', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const id = parseId(req, res)
    if (id === null) return
    const parsed = renameBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const row = await renommer(id, parsed.data.libelle)
    if (!row) {
      res.status(404).json({ error: 'appareil not found' })
      return
    }
    res.json(row)
  } catch (err) {
    console.error('Error renaming atelier appareil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

appareilsAtelierRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const id = parseId(req, res)
    if (id === null) return
    const ok = await revoquer(id)
    if (!ok) {
      res.status(404).json({ error: 'appareil not found' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error revoking atelier appareil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
