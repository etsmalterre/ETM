// Pointage PWA — the shared wall tablet that replaces the WinDev pointeuse
// (TRM/apps/pointage, host pointage.intra.etsmalterre.com). A FOURTH client of
// this API, on the legacy `pointage` database (lib/hfsql-pointage.ts).
// Design: ~/.claude/plans/pointage-pwa.md.
//
//   Tablet enrolment (codes issued by an admin, POST /api/atelier/appareils/codes
//   with type 'pointeuse'):
//     GET  /appareil/moi                    this tablet (401 = not enrolled / revoked)
//     GET  /appareil/enrolement-en-attente  { enAttente } — a pointeuse code is pending
//     POST /appareil/enroler                { code } → sets the `mps_pointeuse` cookie
//   The screens (enrolled tablet; reads also open to an admin session):
//     GET  /jour                            the home table: today's lines
//     GET  /salaries                        the face grid, with each one's status
//     GET  /salaries/:id/photo?size=        portrait through id_mps → bonnetier.photo
//     GET  /salaries/:id/etat               buttons, open line, messages, week, hors prod
//     POST /salaries/:id/pointage           { action, ligneId } → 409 when stale
//     PUT  /salaries/:id/hors-prod          { duree } (hours)
//
// ⚠️ Its own cookie, `mps_pointeuse`, not `mps_appareil`: browsers share
// cookies across ports on localhost, so in dev enrolling the tablet would
// replace the atelier phone's cookie — and attachUser() must never turn a
// tablet into a user session. The device store is shared (one Appareils list).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
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
import { photoBonnetier, taillePhoto } from '../lib/bonnetier-photo.js'
import { enrolementContourne } from '../lib/pointage-dev.js'
import {
  POSTE_OUVERT_MAX_S,
  ACTIONS_POINTAGE,
  etatPointage,
  jourParis,
  jourPrecedent,
  pausesS,
  semaineIso,
  type ActionPointage,
  type LigneHoraire,
} from '../lib/pointage-etat.js'
import {
  horsProdDuJour,
  ligneOuverte,
  lignesDepuis,
  lignesOuvertes,
  listerSalaries,
  messagesActifs,
  tousLesSalaries,
  trouverSalarie,
  type Salarie,
} from '../lib/pointage.js'
import { HORS_PROD_MAX_H, RefusPointage, definirHorsProd, pointer } from '../lib/pointage-ecritures.js'

export const pointageRouter: RouterType = Router()

export const POINTEUSE_COOKIE_NAME = 'mps_pointeuse'

// ── Who is asking ──

/** Stands in for an enrolled tablet on a local dev setup (lib/pointage-dev.ts). */
const POINTEUSE_DE_DEV: AppareilAtelier = {
  id: 0,
  type: 'pointeuse',
  secretHash: '',
  IDutilisateur: 0,
  IDbonnetier: null,
  libelle: 'Pointeuse de dev (sans enrôlement)',
  creeLe: new Date(0).toISOString(),
  creePar: 0,
  vuLe: null,
}

async function pointeuse(req: Request): Promise<AppareilAtelier | null> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[POINTEUSE_COOKIE_NAME]
  const a = raw ? await resoudreAppareil(raw) : null
  if (a && typeAppareil(a) === 'pointeuse') return a
  return enrolementContourne() ? POINTEUSE_DE_DEV : null
}

/** Hours and names are personal data: an enrolled tablet, or an admin. */
async function gateLecture(req: Request, res: Response): Promise<boolean> {
  if ((await pointeuse(req)) || isEffectiveAdmin(req)) return true
  res.status(401).json({ error: 'appareil_non_enrole', message: 'Cette tablette n’est pas enrôlée.' })
  return false
}

/** Only the tablet clocks anyone in — an admin session does not. */
async function gateEcriture(req: Request, res: Response): Promise<boolean> {
  if (await pointeuse(req)) return true
  res.status(401).json({ error: 'appareil_non_enrole', message: 'Cette tablette n’est pas enrôlée.' })
  return false
}

function erreur(res: Response, label: string, err: unknown): void {
  console.error(`Error in /pointage ${label}:`, err)
  res.status(500).json({ error: 'Internal server error' })
}

async function salarieDeLaRoute(req: Request, res: Response): Promise<Salarie | null> {
  const id = parseInt(String(req.params.id), 10)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' })
    return null
  }
  const s = await trouverSalarie(id)
  if (!s) res.status(404).json({ error: 'salarie_inconnu' })
  return s
}

// ── Shapes ──

const ms = (s: number) => (s > 0 ? s * 1000 : null)

function ligneJson(l: LigneHoraire) {
  return {
    id: l.id,
    jour: l.jour,
    debutMs: ms(l.debut),
    debutPause1Ms: ms(l.debut_pause1),
    finPause1Ms: ms(l.fin_pause1),
    debutPause2Ms: ms(l.debut_pause2),
    finPause2Ms: ms(l.fin_pause2),
    finMs: ms(l.fin),
  }
}

const salarieJson = (s: Salarie) => ({ id: s.id, nom: s.nom, prenom: s.prenom, photo: s.idMps > 0 })

async function etatSalarie(s: Salarie, maintenantMs = Date.now()) {
  const jour = jourParis(maintenantMs)
  const [ouverte, messages, horsProd] = await Promise.all([
    ligneOuverte(s.id),
    messagesActifs(s.id, jour),
    horsProdDuJour(s.id, jour),
  ])
  const e = etatPointage(ouverte, Math.floor(maintenantMs / 1000))
  return {
    salarie: salarieJson(s),
    statut: e.statut,
    ligne: e.ligne && ligneJson(e.ligne),
    posteNonFerme: e.nonFermee && ligneJson(e.nonFermee),
    actions: e.actions.map(({ action, libelle }) => ({ action, libelle })),
    messages,
    // The legacy « Cumul » next to the week is an annualised-hours balance
    // (lst_lissage / lst_prev / lst_info_sal_annee) whose formula did not
    // survive the bytecode — not shown until it is confirmed.
    semaine: semaineIso(maintenantMs),
    horsProd,
    maintenantMs,
  }
}

// ── Tablet enrolment ──

pointageRouter.get('/appareil/moi', async (req: Request, res: Response) => {
  try {
    const a = await pointeuse(req)
    if (!a) {
      res.status(401).json({ error: 'appareil_non_enrole' })
      return
    }
    res.json({ id: a.id, libelle: a.libelle })
  } catch (err) {
    erreur(res, 'appareil/moi', err)
  }
})

pointageRouter.get('/appareil/enrolement-en-attente', (_req: Request, res: Response) => {
  res.json({ enAttente: codeEnAttente(Date.now(), 'pointeuse') })
})

const enrolerBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict()

pointageRouter.post('/appareil/enroler', async (req: Request, res: Response) => {
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
    const c = consommerCode(parsed.data.code, Date.now(), 'pointeuse')
    if (!c) {
      noterEchec(client)
      res.status(404).json({ error: 'code_invalide', message: 'Code inconnu ou expiré.' })
      return
    }
    oublierEchecs(client)
    const { appareil, token } = await enroler(c)
    res.cookie(POINTEUSE_COOKIE_NAME, token, { ...appareilCookieOptions(), maxAge: COOKIE_MAX_AGE_SECONDS * 1000 })
    res.status(201).json({ id: appareil.id, libelle: appareil.libelle })
  } catch (err) {
    erreur(res, 'appareil/enroler', err)
  }
})

// ── Reads ──

// FEN_Pointage's TABLE_Pointage: the lines of the day, plus a night shift
// still open from yesterday.
pointageRouter.get('/jour', async (req: Request, res: Response) => {
  try {
    if (!(await gateLecture(req, res))) return
    const maintenantMs = Date.now()
    const maintenantS = Math.floor(maintenantMs / 1000)
    const jour = jourParis(maintenantMs)
    const [lignes, salaries] = await Promise.all([lignesDepuis(jourPrecedent(jour)), tousLesSalaries()])
    const noms = new Map(salaries.map((s) => [s.id, s]))
    const retenues = lignes
      .filter((l) => l.jour === jour || (l.fin === 0 && maintenantS - l.debut <= POSTE_OUVERT_MAX_S))
      .sort((a, b) => a.debut - b.debut || a.id - b.id)
    res.json({
      jour,
      maintenantMs,
      lignes: retenues.map((l) => {
        const s = noms.get(l.idSalarie)
        return {
          ...ligneJson(l),
          salarie: s ? salarieJson(s) : { id: l.idSalarie, nom: '', prenom: '', photo: false },
          pauseMin: Math.round(pausesS(l, maintenantS) / 60),
        }
      }),
    })
  } catch (err) {
    erreur(res, 'jour', err)
  }
})

pointageRouter.get('/salaries', async (req: Request, res: Response) => {
  try {
    if (!(await gateLecture(req, res))) return
    const maintenantS = Math.floor(Date.now() / 1000)
    const [salaries, ouvertes] = await Promise.all([listerSalaries(), lignesOuvertes()])
    res.json(
      salaries.map((s) => ({
        ...salarieJson(s),
        statut: etatPointage(ouvertes.get(s.id) ?? null, maintenantS).statut,
      })),
    )
  } catch (err) {
    erreur(res, 'salaries', err)
  }
})

pointageRouter.get('/salaries/:id/photo', async (req: Request, res: Response) => {
  try {
    if (!(await gateLecture(req, res))) return
    const s = await salarieDeLaRoute(req, res)
    if (!s) return
    const out = s.idMps > 0 ? await photoBonnetier(s.idMps, taillePhoto(req.query.size)) : null
    if (!out) {
      res.status(404).json({ error: 'No photo' })
      return
    }
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(out)
  } catch (err) {
    erreur(res, 'photo', err)
  }
})

pointageRouter.get('/salaries/:id/etat', async (req: Request, res: Response) => {
  try {
    if (!(await gateLecture(req, res))) return
    const s = await salarieDeLaRoute(req, res)
    if (!s) return
    res.json(await etatSalarie(s))
  } catch (err) {
    erreur(res, 'etat', err)
  }
})

// ── Writes ──

const pointageBody = z
  .object({
    action: z.enum(ACTIONS_POINTAGE as [ActionPointage, ...ActionPointage[]]),
    /** The open line the screen showed; null when it offered to open one. */
    ligneId: z.number().int().positive().nullable(),
  })
  .strict()

pointageRouter.post('/salaries/:id/pointage', async (req: Request, res: Response) => {
  try {
    if (!(await gateEcriture(req, res))) return
    const parsed = pointageBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const s = await salarieDeLaRoute(req, res)
    if (!s) return
    try {
      const resultat = await pointer(s, parsed.data.action, parsed.data.ligneId)
      res.json({ resultat, etat: await etatSalarie(s) })
    } catch (err) {
      if (err instanceof RefusPointage) {
        res.status(409).json({ error: err.code, message: err.message, etat: await etatSalarie(s) })
        return
      }
      throw err
    }
  } catch (err) {
    erreur(res, 'pointage', err)
  }
})

const horsProdBody = z
  .object({ duree: z.number().min(0).max(HORS_PROD_MAX_H).multipleOf(0.25) })
  .strict()

pointageRouter.put('/salaries/:id/hors-prod', async (req: Request, res: Response) => {
  try {
    if (!(await gateEcriture(req, res))) return
    const parsed = horsProdBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const s = await salarieDeLaRoute(req, res)
    if (!s) return
    await definirHorsProd(s, parsed.data.duree)
    res.json({ horsProd: parsed.data.duree })
  } catch (err) {
    erreur(res, 'hors-prod', err)
  }
})
