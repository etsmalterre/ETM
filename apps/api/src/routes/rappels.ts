// Rappels: a dated note on an object (lib/rappels.ts, Vincent 2026-11-18).
//
//   GET    /api/rappels?objet=<type>:<id>   the object's reminders (open first), for the « Rappel » button
//   GET    /api/rappels/destinataires       who a reminder can be for (active ETM people)
//   GET    /api/rappels/miens               the caller's open reminders, due or to come (« Mes rappels »)
//   POST   /api/rappels                     put one: { objet_type, objet_id, echeance, observation, pour_id? }
//   PUT    /api/rappels/:id                 « Repousser » (echeance) or correct (observation, pour_id)
//   POST   /api/rappels/:id/fait            « Fait », optional { commentaire }
//   DELETE /api/rappels/:id                 put by mistake: its author or an admin, open only
//
// Guard: there is no global auth middleware. Reading needs a session; every
// write needs the Écrans grant of the object's screen (lib/rappels-objets.ts):
// whoever may open a lot may put a reminder on it. No permission key of its
// own (CLAUDE.md § 14: Écrans = what a user sees, a key only when viewers of
// one screen need different rights).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { isEffectiveAdmin } from '../lib/auth.js'
import { userCanOpenScreen } from '../lib/permissions.js'
import { mpsPg } from '../lib/mps-pg.js'
import { membres } from '../lib/utilisateur-apps.js'
import { nomUtilisateur } from '../lib/stock-fini-mesures.js'
import { estTypeObjet, lireObjet, TYPES_OBJET, type TypeObjet } from '../lib/rappels-objets.js'
import {
  creerRappel, lireRappel, marquerFait, modifierRappel, OBSERVATION_MAX, RappelRefuse, rappelsDeLObjet, rappelsOuvertsDe, supprimerRappel,
  type Auteur,
} from '../lib/rappels.js'

export const rappelsRouter: RouterType = Router()

function refuse(res: Response, err: unknown, quoi: string): void {
  if (err instanceof RappelRefuse) {
    res.status(err.status).json({ error: err.code, message: err.message })
    return
  }
  console.error(`Error ${quoi}:`, err)
  res.status(500).json({ error: 'Internal server error' })
}

/** The people a reminder can be for: active persons (never a station or a device account) of ETM. */
async function destinataires(): Promise<Auteur[]> {
  const [rows, etm] = await Promise.all([
    mpsPg()<{ id: number; prenom: string | null; nom: string | null }[]>`
      SELECT idutilisateur AS id, prenom, nom FROM utilisateur WHERE actif AND type_compte = 'personne' ORDER BY prenom, nom`,
    membres('etm'),
  ])
  return rows
    .filter((r) => !etm || etm.has(Number(r.id)))
    .map((r) => ({ id: Number(r.id), nom: `${r.prenom ?? ''} ${r.nom ?? ''}`.trim() || `Utilisateur ${r.id}` }))
}

/** May this user write a reminder on that object? Answers 401 / 403 / 404 itself. */
async function peutEcrire(req: Request, res: Response, type: TypeObjet, id: number) {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  const objet = await lireObjet(type, id)
  if (!objet) {
    res.status(404).json({ error: 'objet_introuvable', message: 'Cet élément n’existe plus.' })
    return null
  }
  if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), objet.ecran[0], objet.ecran[1]))) {
    res.status(403).json({ error: 'ecran_non_autorise', message: 'Vous n’avez pas accès à l’écran de cet élément.' })
    return null
  }
  return { objet, userId: req.userId }
}

const parseObjet = (v: unknown): { type: TypeObjet; id: number } | null => {
  const [type, idRaw] = String(v ?? '').split(':')
  const id = parseInt(idRaw ?? '', 10)
  return estTypeObjet(type) && Number.isInteger(id) && id > 0 ? { type, id } : null
}

rappelsRouter.get('/', async (req: Request, res: Response) => {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
  const objet = parseObjet(req.query.objet)
  if (!objet) { res.status(400).json({ error: 'objet invalide' }); return }
  try {
    // Whoever may open the object's screen reads its reminders (they quote clients and agreements).
    // An object that is gone has no screen left to guard: its reminders stay readable.
    const o = await lireObjet(objet.type, objet.id)
    if (o && !(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), o.ecran[0], o.ecran[1]))) {
      res.status(403).json({ error: 'ecran_non_autorise', message: 'Vous n’avez pas accès à l’écran de cet élément.' })
      return
    }
    res.json({ rappels: await rappelsDeLObjet(objet.type, objet.id) })
  } catch (err) {
    refuse(res, err, 'listing rappels')
  }
})

rappelsRouter.get('/destinataires', async (req: Request, res: Response) => {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
  try {
    res.json({ destinataires: await destinataires(), moi: req.userId })
  } catch (err) {
    refuse(res, err, 'listing rappel recipients')
  }
})

// The caller's own reminders (for them, or put by them): no screen to guard, they wrote or received each.
rappelsRouter.get('/miens', async (req: Request, res: Response) => {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
  try {
    res.json({ rappels: await rappelsOuvertsDe(req.userId), moi: req.userId })
  } catch (err) {
    refuse(res, err, 'listing own rappels')
  }
})

const corpsCreation = z.object({
  objet_type: z.enum(TYPES_OBJET),
  objet_id: z.number().int().positive(),
  echeance: z.string(),
  observation: z.string().max(OBSERVATION_MAX * 2),
  pour_id: z.number().int().positive().optional(),
})

/** The person a reminder is for: the caller by default, else an active ETM person. */
async function pourQui(pourId: number | undefined, userId: number): Promise<Auteur> {
  if (pourId === undefined || pourId === userId) return { id: userId, nom: await nomUtilisateur(userId) }
  const p = (await destinataires()).find((d) => d.id === pourId)
  if (!p) throw new RappelRefuse('destinataire_inconnu', 'Cette personne ne peut pas recevoir de rappel.')
  return p
}

rappelsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = corpsCreation.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'invalid body', details: parsed.error.issues }); return }
  const d = parsed.data
  try {
    const ok = await peutEcrire(req, res, d.objet_type, d.objet_id)
    if (!ok) return
    const rappel = await creerRappel({
      objet_type: d.objet_type,
      objet_id: d.objet_id,
      objet_libelle: ok.objet.libelle,
      echeance: d.echeance,
      observation: d.observation,
      pour: await pourQui(d.pour_id, ok.userId),
      par: { id: ok.userId, nom: await nomUtilisateur(ok.userId) },
    })
    res.status(201).json({ rappel })
  } catch (err) {
    refuse(res, err, 'creating rappel')
  }
})

const corpsModification = z.object({
  echeance: z.string().optional(),
  observation: z.string().max(OBSERVATION_MAX * 2).optional(),
  pour_id: z.number().int().positive().optional(),
})

/** The stored reminder of `:id` and the right to write on its object, or null after answering.
 *  ⚠️ The object may be gone by the reminder's date (a roll cut, dyed again or deleted): the reminder
 *  must still be closable, or it would stay red for ever. With no screen left to guard, the person it
 *  is for, its author and an admin keep the hand. */
async function rappelEcrivable(req: Request, res: Response) {
  const id = parseInt(String(req.params.id), 10)
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'id invalide' }); return null }
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return null }
  const rappel = await lireRappel(id)
  if (!rappel) { res.status(404).json({ error: 'introuvable', message: 'Ce rappel n’existe plus.' }); return null }
  const objet = await lireObjet(rappel.objet_type, rappel.objet_id)
  const autorise = objet
    ? await userCanOpenScreen(req.userId, isEffectiveAdmin(req), objet.ecran[0], objet.ecran[1])
    : rappel.pour_id === req.userId || rappel.par_id === req.userId || isEffectiveAdmin(req)
  if (!autorise) {
    res.status(403).json({ error: 'ecran_non_autorise', message: 'Vous n’avez pas accès à ce rappel.' })
    return null
  }
  return { rappel, userId: req.userId }
}

rappelsRouter.put('/:id', async (req: Request, res: Response) => {
  const parsed = corpsModification.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'invalid body', details: parsed.error.issues }); return }
  try {
    const ok = await rappelEcrivable(req, res)
    if (!ok) return
    const d = parsed.data
    const rappel = await modifierRappel(ok.rappel.id, {
      echeance: d.echeance,
      observation: d.observation,
      pour: d.pour_id !== undefined ? await pourQui(d.pour_id, ok.userId) : undefined,
    })
    res.json({ rappel })
  } catch (err) {
    refuse(res, err, 'updating rappel')
  }
})

rappelsRouter.post('/:id/fait', async (req: Request, res: Response) => {
  const parsed = z.object({ commentaire: z.string().max(OBSERVATION_MAX * 2).nullish() }).safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ error: 'invalid body', details: parsed.error.issues }); return }
  try {
    const ok = await rappelEcrivable(req, res)
    if (!ok) return
    const rappel = await marquerFait(ok.rappel.id, { id: ok.userId, nom: await nomUtilisateur(ok.userId) }, parsed.data.commentaire ?? null)
    res.json({ rappel })
  } catch (err) {
    refuse(res, err, 'closing rappel')
  }
})

rappelsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const ok = await rappelEcrivable(req, res)
    if (!ok) return
    // Put by mistake: its author takes it back. Anyone else closes it with « Fait » and a word.
    if (ok.rappel.par_id !== ok.userId && !isEffectiveAdmin(req)) {
      res.status(403).json({ error: 'pas_auteur', message: 'Seul l’auteur du rappel peut le supprimer. « Fait » le clôt pour tout le monde.' })
      return
    }
    await supprimerRappel(ok.rappel.id)
    res.json({ ok: true })
  } catch (err) {
    refuse(res, err, 'deleting rappel')
  }
})
