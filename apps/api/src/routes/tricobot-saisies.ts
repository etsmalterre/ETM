// What Tricobot wrote or asked, and the gestures that judge it
// (claude_doc/agents_autonomie.md, lib/agents/flux-ennoblisseur/saisies.ts).
// Given where the work is done, never in Agents IA:
//   Délais     → Sous-traitants › Ennoblissement (a délai on a sst line)
//   Contrôles  → Qualité › Suivi lots (the dyer's measures on a lot)
// Mounted at /api/tricobot/saisies.
//
//   GET  /compteurs              per sst order: à valider / aide / written alone (Délais)
//   GET  /compteurs-lots         per lot: the same (Contrôles)
//   GET  /?commande=N | ?lot=N   the order's / lot's saisies, newest first (the revue)
//   GET  /mails                  the mails read without writing anything, to check (supervisé)
//   GET  /mail/:runId            the mails Tricobot read: our Point (the question) + the reply
//   POST /:id/valider            Tricobot was right
//   POST /:id/corriger           { valeur, commentaire } another value, why required
//   POST /:id/supprimer          { commentaire } nothing should have been written
//   POST /:id/trancher           { valeur | null, commentaire, justifie, pourquoiAvis } an aide settled,
//                                and « Tu as bien fait de me demander ? » (Discernement)
//   POST /:id/omission           { commentaire } a « rien »: something was missed
//
// Gate: the screen of the skill (Écrans), no action key — like the réception.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { userCanOpenScreen } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { auteur } from './agents-ia.js'
import { lireFichier, lireRun } from '../lib/agents/store.js'
import { BL_ENNOBLISSEUR_SLUG } from '../lib/agents/bl-ennoblisseur.js'
import {
  compteursParCommande, compteursParLot, corriger, GesteRefuse, omission, riensARevoir, saisie, saisiesDeCommande, saisiesDeLot,
  supprimer, trancher, valider,
} from '../lib/agents/flux-ennoblisseur/saisies.js'
import type { ResultatFlux } from '../lib/agents/flux-ennoblisseur/delais.js'
import { pointDuRun } from '../lib/agents/flux-ennoblisseur/point-du-run.js'
import { MpsPgIndisponible } from '../lib/mps-pg.js'

export const tricobotSaisiesRouter: RouterType = Router()

type Ecran = 'ennoblissement' | 'suivi_lots'
const ECRANS: Record<Ecran, [string, string]> = {
  ennoblissement: ['/sous-traitants', '/sous-traitants/ennoblissement'],
  suivi_lots: ['/qualite', '/qualite/suivi-lots'],
}
const ecranDe = (competence: string): Ecran => (competence === 'controles' ? 'suivi_lots' : 'ennoblissement')

/** 401 / 403 unless the caller opens one of the given screens. */
async function garde(req: Request, res: Response, ...ecrans: Ecran[]): Promise<number | null> {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return null }
  for (const e of ecrans) {
    const [menu, ecran] = ECRANS[e]
    if (await userCanOpenScreen(req.userId, isEffectiveAdmin(req), menu, ecran)) return req.userId
  }
  res.status(403).json({ error: 'écran non accessible' })
  return null
}

function echec(res: Response, err: unknown, quoi: string): void {
  if (err instanceof GesteRefuse) { res.status(409).json({ error: err.code, message: err.message }); return }
  if (err instanceof MpsPgIndisponible) { res.status(503).json({ error: 'base indisponible' }); return }
  console.error(`[tricobot-saisies] ${quoi} failed:`, err)
  res.status(500).json({ error: 'Internal server error' })
}

tricobotSaisiesRouter.get('/compteurs', async (req, res) => {
  if ((await garde(req, res, 'ennoblissement')) === null) return
  try { res.json(await compteursParCommande()) } catch (err) { echec(res, err, 'compteurs') }
})

tricobotSaisiesRouter.get('/compteurs-lots', async (req, res) => {
  if ((await garde(req, res, 'suivi_lots')) === null) return
  try { res.json(await compteursParLot()) } catch (err) { echec(res, err, 'compteurs-lots') }
})

tricobotSaisiesRouter.get('/mails', async (req, res) => {
  if ((await garde(req, res, 'ennoblissement')) === null) return
  try {
    const riens = await riensARevoir()
    const out = []
    for (const s of riens) {
      const run = await lireRun(s.agent, s.runId)
      out.push({ ...s, mail: run?.message ?? null })
    }
    res.json(out)
  } catch (err) { echec(res, err, 'mails') }
})

tricobotSaisiesRouter.get('/mail/:runId', async (req, res) => {
  if ((await garde(req, res, 'ennoblissement', 'suivi_lots')) === null) return
  try {
    const run = await lireRun(BL_ENNOBLISSEUR_SLUG, req.params.runId)
    if (!run || !run.message) { res.status(404).json({ error: 'mail introuvable' }); return }
    const r = run.resultat as Partial<ResultatFlux>
    res.json({
      ...run.message, texte: r.texte ?? '', jourPoint: r.jourPoint ?? null, resume: run.resume,
      competence: run.competence ?? 'bl',
      // The question it answers: our Point, its §2 / §5 (claude_doc/agents_autonomie.md §7).
      point: r.idpoint ? await pointDuRun(r.idpoint) : null,
      delais: (r.delais ?? []).map((d) => ({ commande: d.commande, idligne: d.idligne, reponse: d.reponse, nommee: d.nommee ?? null })),
      controles: (r.controles ?? []).map((c) => ({ lot: c.lot, idsuivilot: c.idsuivilot, idligne: c.idligne ?? 0, texte: c.texte, demande: c.demande ?? null })),
      // A BL: the document he read (GET /mail/:runId/fichiers/:n) and what it says of itself.
      fichiers: (run.fichiers ?? []).map((f, n) => ({ n, nom: f.nom })),
      bl: (run.competence ?? 'bl') === 'bl' ? blDuRun(run.resultat) : null,
    })
  } catch (err) { echec(res, err, 'mail') }
})

/** What a BL run read of the document itself, for Tricobot's reasoning. */
function blDuRun(resultat: Record<string, unknown>) {
  const r = resultat as {
    extraction?: { numero_bordereau?: string; numero_commande?: string; nombre_pieces?: number | null; poids_total?: number | null; metrage_total?: number | null; pieces?: unknown[] } | null
    resolution?: { lot?: string; commandeId?: number | null } | null
    controles?: Array<{ gravite?: string; message?: string }> | null
  }
  if (!r.extraction) return null
  return {
    bordereau: r.extraction.numero_bordereau ?? '',
    commande: r.extraction.numero_commande ?? '',
    lot: r.resolution?.lot ?? '',
    pieces: r.extraction.pieces?.length ?? 0,
    poidsTotal: r.extraction.poids_total ?? null,
    metrageTotal: r.extraction.metrage_total ?? null,
    avertissements: (r.controles ?? []).filter((c) => c.gravite === 'avertissement' && (c.message ?? '').trim()).map((c) => String(c.message).trim()),
  }
}

// One document of a mail Tricobot read (a BL's PDF), for the panel beside his bubble.
tricobotSaisiesRouter.get('/mail/:runId/fichiers/:n', async (req, res) => {
  if ((await garde(req, res, 'ennoblissement', 'suivi_lots')) === null) return
  try {
    const run = await lireRun(BL_ENNOBLISSEUR_SLUG, req.params.runId)
    const f = run?.fichiers?.[parseInt(req.params.n, 10)]
    const buf = f ? await lireFichier(f.fichier) : null
    if (!f || !buf) { res.status(404).json({ error: 'document introuvable' }); return }
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.nom)}"`)
    // Shown in an iframe of the web app (another origin in dev).
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) { echec(res, err, 'fichier') }
})

tricobotSaisiesRouter.get('/', async (req, res) => {
  const lot = Number(req.query.lot)
  if (Number.isInteger(lot) && lot > 0) {
    if ((await garde(req, res, 'suivi_lots')) === null) return
    try { res.json(await saisiesDeLot(lot)) } catch (err) { echec(res, err, 'saisies-lot') }
    return
  }
  if ((await garde(req, res, 'ennoblissement')) === null) return
  const id = Number(req.query.commande)
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'commande ou lot requis' }); return }
  try { res.json(await saisiesDeCommande(id)) } catch (err) { echec(res, err, 'saisies') }
})

const idParam = (req: Request) => Number(req.params.id)
/** A délai 'YYYY-MM-DD', or the dyer's measures as JSON (checked by the gesture). */
const valeur = z.string().min(1).max(500)

/** The gate of a gesture: the screen of the saisie's skill. */
async function gardeGeste(req: Request, res: Response): Promise<number | null> {
  const s = await saisie(idParam(req)).catch(() => null)
  if (!s) { res.status(404).json({ error: 'introuvable', message: 'Cette saisie de Tricobot n’existe plus.' }); return null }
  return garde(req, res, ecranDe(s.competence))
}

tricobotSaisiesRouter.post('/:id/valider', async (req, res) => {
  const uid = await gardeGeste(req, res)
  if (uid === null) return
  try { await valider(idParam(req), await auteur(uid)); res.json({ ok: true }) } catch (err) { echec(res, err, 'valider') }
})

tricobotSaisiesRouter.post('/:id/corriger', async (req, res) => {
  const uid = await gardeGeste(req, res)
  if (uid === null) return
  const p = z.object({ valeur, commentaire: z.string().max(2000) }).safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide' }); return }
  try { await corriger(idParam(req), p.data.valeur, p.data.commentaire, await auteur(uid)); res.json({ ok: true }) } catch (err) { echec(res, err, 'corriger') }
})

tricobotSaisiesRouter.post('/:id/supprimer', async (req, res) => {
  const uid = await gardeGeste(req, res)
  if (uid === null) return
  const p = z.object({ commentaire: z.string().max(2000) }).safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide' }); return }
  try { await supprimer(idParam(req), p.data.commentaire, await auteur(uid)); res.json({ ok: true }) } catch (err) { echec(res, err, 'supprimer') }
})

tricobotSaisiesRouter.post('/:id/trancher', async (req, res) => {
  const uid = await gardeGeste(req, res)
  if (uid === null) return
  const p = z.object({
    valeur: valeur.nullable(),
    commentaire: z.string().max(2000).default(''),
    /** « Tu as bien fait de me demander ? » */
    justifie: z.boolean(),
    pourquoiAvis: z.string().max(2000).default(''),
  }).safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide' }); return }
  try {
    await trancher(idParam(req), p.data.valeur, p.data.commentaire, await auteur(uid), { justifie: p.data.justifie, pourquoi: p.data.pourquoiAvis })
    res.json({ ok: true })
  } catch (err) { echec(res, err, 'trancher') }
})

tricobotSaisiesRouter.post('/:id/omission', async (req, res) => {
  const uid = await gardeGeste(req, res)
  if (uid === null) return
  const p = z.object({ commentaire: z.string().max(2000) }).safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide' }); return }
  try { await omission(idParam(req), p.data.commentaire, await auteur(uid)); res.json({ ok: true }) } catch (err) { echec(res, err, 'omission') }
})
