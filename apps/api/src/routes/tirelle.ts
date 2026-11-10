// Tirelle PWA — the lab tablet where Laetitia controls the tirelles
// (apps/tirelle, host tirelle.intra.etsmalterre.com; rules in lib/tirelle-labo.ts).
//
//   Tablet enrolment (codes issued by an admin in Utilisateurs › Appareils,
//   POST /api/atelier/appareils/codes with type 'tirelle'):
//     GET  /appareil/moi                    this tablet (401 = not enrolled / revoked)
//     GET  /appareil/enrolement-en-attente  { enAttente } — a tirelle code is pending
//     POST /appareil/enroler                { code } → sets the `mps_tirelle` cookie
//   The lab (enrolled tablet; reads also open to an admin session):
//     GET  /lots                            every lot with something to do, by status
//     POST /lots/:id/avant-lavage           { laize, poids, coloris, observations?, note? }
//     POST /lots/:id/apres-lavage           { stabh, stabl, vrillage, casier, observations? } — done
//     POST /lots/:id/jete                   after a reprise: round, square, tirelle thrown
//
// ⚠️ Its own cookie, `mps_tirelle` (like `mps_pointeuse`): browsers share
// cookies across ports on localhost, and lib/auth.ts would otherwise let the
// tablet act as an atelier phone. Writes come from the enrolled tablet only:
// an admin session reads, never measures.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { changementsCote, lireMesuresCotes, noterLot, type MesuresLot } from '../lib/journal-lot.js'
import { nomUtilisateur } from '../lib/stock-fini-mesures.js'
import { COOKIE_MAX_AGE_SECONDS, appareilCookieOptions, isEffectiveAdmin } from '../lib/auth.js'
import {
  codeEnAttente,
  consommerCode,
  enroler,
  noterEchec,
  oublierEchecs,
  peutEssayer,
  resoudreAppareil,
  typeAppareil,
  type AppareilAtelier,
} from '../lib/appareils-atelier.js'
import {
  LIBELLE_ETAPE,
  OBSERVATIONS_MAX,
  ORDRE_ETAPES,
  RefusLabo,
  enregistrerAvantLavage,
  lireLotsLabo,
  marquerJete,
  terminerApresLavage,
} from '../lib/tirelle-labo.js'

export const tirelleRouter: RouterType = Router()

export const TIRELLE_COOKIE_NAME = 'mps_tirelle'

// ── Who is asking ──

/** Dev convenience, same idea as lib/pointage-dev.ts: on a dev API talking to
 *  a dev database, any browser is the tablet. Never in production, never on
 *  the production database `mps`; TIRELLE_DEV_ENROLEMENT=1 restores the gate. */
export function enrolementTirelleContourne(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return false
  if (env.TIRELLE_DEV_ENROLEMENT === '1') return false
  try {
    const db = new URL(env.PG_CONNECTION_STRING ?? '').pathname.replace(/^\//, '')
    return db !== '' && db !== 'mps'
  } catch {
    return false
  }
}

const TABLETTE_DE_DEV: AppareilAtelier = {
  id: 0,
  type: 'tirelle',
  secretHash: '',
  IDutilisateur: 0,
  IDbonnetier: null,
  libelle: 'Tablette labo de dev (sans enrôlement)',
  creeLe: new Date(0).toISOString(),
  creePar: 0,
  vuLe: null,
}

async function tablette(req: Request): Promise<AppareilAtelier | null> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[TIRELLE_COOKIE_NAME]
  const a = raw ? await resoudreAppareil(raw) : null
  if (a && typeAppareil(a) === 'tirelle') return a
  return enrolementTirelleContourne() ? TABLETTE_DE_DEV : null
}

/** The lab tablet's gesture in the lot's Journal (lib/journal-lot.ts): who is the
 *  tablet (its label — an admin trying it from a desk is named), what changed. */
async function journalTablette(req: Request, id: number, evenement: 'tirelle_avant_lavage' | 'tirelle_apres_lavage' | 'tirelle_jete', avant: MesuresLot | null): Promise<void> {
  const a = await tablette(req)
  const par = a && a !== TABLETTE_DE_DEV
    ? { id: 0, nom: a.libelle || 'Tablette tirelle' }
    : req.userId ? { id: req.userId, nom: await nomUtilisateur(req.userId) } : { id: 0, nom: 'Tablette tirelle' }
  let detail: string | null = null
  if (evenement !== 'tirelle_jete') {
    const apres = await lireMesuresCotes(id)
    const parts = [changementsCote(avant, apres, 'tirelle')]
    if (apres && (avant?.coloris_tirelle ?? null) !== (apres.coloris_tirelle ?? null) && apres.coloris_tirelle) {
      parts.push(apres.coloris_tirelle === 'conforme' ? 'coloris conforme' : 'coloris en écart')
    }
    detail = parts.filter(Boolean).join(' · ') || null
  }
  await noterLot({ idsuivilot: id, evenement, detail, par })
}

async function gateLecture(req: Request, res: Response): Promise<boolean> {
  if ((await tablette(req)) || isEffectiveAdmin(req)) return true
  res.status(401).json({ error: 'appareil_non_enrole', message: 'Cette tablette n’est pas enrôlée.' })
  return false
}

async function gateEcriture(req: Request, res: Response): Promise<boolean> {
  if (await tablette(req)) return true
  res.status(401).json({ error: 'appareil_non_enrole', message: 'Cette tablette n’est pas enrôlée.' })
  return false
}

function erreur(res: Response, label: string, err: unknown): void {
  if (err instanceof RefusLabo) {
    res.status(err.status).json({ error: err.code, message: err.message })
    return
  }
  console.error(`Error in /tirelle ${label}:`, err)
  res.status(500).json({ error: 'Internal server error' })
}

function idDe(req: Request, res: Response): number | null {
  const id = parseInt(req.params.id, 10)
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid ID' })
    return null
  }
  return id
}

// ── Tablet enrolment ──

tirelleRouter.get('/appareil/moi', async (req: Request, res: Response) => {
  try {
    const a = await tablette(req)
    if (!a) {
      res.status(401).json({ error: 'appareil_non_enrole' })
      return
    }
    res.json({ id: a.id, libelle: a.libelle })
  } catch (err) {
    erreur(res, 'appareil/moi', err)
  }
})

tirelleRouter.get('/appareil/enrolement-en-attente', (_req: Request, res: Response) => {
  res.json({ enAttente: codeEnAttente(Date.now(), 'tirelle') })
})

const enrolerBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict()

tirelleRouter.post('/appareil/enroler', async (req: Request, res: Response) => {
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
    const c = consommerCode(parsed.data.code, Date.now(), 'tirelle')
    if (!c) {
      noterEchec(client)
      res.status(404).json({ error: 'code_invalide', message: 'Code inconnu ou expiré.' })
      return
    }
    oublierEchecs(client)
    const { appareil, token } = await enroler(c)
    res.cookie(TIRELLE_COOKIE_NAME, token, { ...appareilCookieOptions(), maxAge: COOKIE_MAX_AGE_SECONDS * 1000 })
    res.status(201).json({ id: appareil.id, libelle: appareil.libelle })
  } catch (err) {
    erreur(res, 'appareil/enroler', err)
  }
})

// ── The lab ──

tirelleRouter.get('/lots', async (req: Request, res: Response) => {
  if (!(await gateLecture(req, res))) return
  try {
    const lots = await lireLotsLabo()
    res.json({
      etapes: ORDRE_ETAPES.map((e) => ({ etape: e, libelle: LIBELLE_ETAPE[e] })),
      lots,
    })
  } catch (err) {
    erreur(res, 'lots', err)
  }
})

const avantBody = z
  .object({
    laize: z.union([z.number(), z.string()]).nullable().optional(),
    poids: z.union([z.number(), z.string()]).nullable().optional(),
    coloris: z.enum(['conforme', 'ecart']).nullable().optional(),
    note: z.string().max(500).optional(),
    observations: z.string().max(OBSERVATIONS_MAX).optional(),
  })
  .strict()

tirelleRouter.post('/lots/:id/avant-lavage', async (req: Request, res: Response) => {
  if (!(await gateEcriture(req, res))) return
  const id = idDe(req, res)
  if (id === null) return
  const parsed = avantBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  try {
    const avant = await lireMesuresCotes(id)
    const lot = await enregistrerAvantLavage(id, parsed.data)
    await journalTablette(req, id, 'tirelle_avant_lavage', avant)
    res.json({ lot })
  } catch (err) {
    erreur(res, 'avant-lavage', err)
  }
})

const apresBody = z
  .object({
    stabh: z.union([z.number(), z.string()]).nullable().optional(),
    stabl: z.union([z.number(), z.string()]).nullable().optional(),
    vrillage: z.union([z.number(), z.string()]).nullable().optional(),
    casier: z.string().max(100).optional(),
    observations: z.string().max(OBSERVATIONS_MAX).optional(),
  })
  .strict()

tirelleRouter.post('/lots/:id/apres-lavage', async (req: Request, res: Response) => {
  if (!(await gateEcriture(req, res))) return
  const id = idDe(req, res)
  if (id === null) return
  const parsed = apresBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  try {
    const avant = await lireMesuresCotes(id)
    await terminerApresLavage(id, parsed.data)
    await journalTablette(req, id, 'tirelle_apres_lavage', avant)
    res.json({ ok: true })
  } catch (err) {
    erreur(res, 'apres-lavage', err)
  }
})

tirelleRouter.post('/lots/:id/jete', async (req: Request, res: Response) => {
  if (!(await gateEcriture(req, res))) return
  const id = idDe(req, res)
  if (id === null) return
  try {
    await marquerJete(id)
    await journalTablette(req, id, 'tirelle_jete', null)
    res.json({ ok: true })
  } catch (err) {
    erreur(res, 'jete', err)
  }
})
