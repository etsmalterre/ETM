// What Tricobot wrote or asked, and the gestures that judge it
// (claude_doc/agents_autonomie.md, lib/agents/flux-ennoblisseur/saisies.ts).
// Given where the work is done, never in Agents IA: a BL of Flux Ennoblisseur,
// in Sous-traitants › Ennoblissement (the rolls of a delivery note to receive).
// Mounted at /api/tricobot/saisies.
//
//   GET  /compteurs              per sst order: à valider / aide / received alone
//   GET  /?commande=N            the order's saisies, newest first (the revue)
//   GET  /mail/:runId            the mail Tricobot read: its BL (documents, what it says of itself)
//   GET  /mail/:runId/fichiers/:n   one of its documents (the PDF)
//   POST /:id/valider            Tricobot was right: the rolls are received
//   POST /:id/supprimer          { commentaire } nothing should have been proposed
//   POST /:id/trancher           { valeur | null, commentaire, justifie, pourquoiAvis } an aide settled,
//                                and « Tu as bien fait de me demander ? » (Discernement)
// A BL is corrected from the réception dialog (PUT /tricobot/bl-reception).
//
// Gate: the screen (Écrans: Sous-traitants › Ennoblissement), no action key — like the réception.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { userCanOpenScreen } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { auteur } from './agents-ia.js'
import { lireFichier, lireRun } from '../lib/agents/store.js'
import { BL_ENNOBLISSEUR_SLUG } from '../lib/agents/bl-ennoblisseur.js'
import { compteursParCommande, GesteRefuse, saisie, saisiesDeCommande, supprimer, trancher, valider } from '../lib/agents/flux-ennoblisseur/saisies.js'
import { MpsPgIndisponible } from '../lib/mps-pg.js'

export const tricobotSaisiesRouter: RouterType = Router()

/** 401 / 403 unless the caller opens Sous-traitants › Ennoblissement. */
async function garde(req: Request, res: Response): Promise<number | null> {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return null }
  if (await userCanOpenScreen(req.userId, isEffectiveAdmin(req), '/sous-traitants', '/sous-traitants/ennoblissement')) return req.userId
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
  if ((await garde(req, res)) === null) return
  try { res.json(await compteursParCommande()) } catch (err) { echec(res, err, 'compteurs') }
})

/** A BL run, or null: unknown, or the run of a skill removed since (Délais, Contrôles). */
async function runBl(id: string) {
  const run = await lireRun(BL_ENNOBLISSEUR_SLUG, id)
  return run && (run.competence ?? 'bl') === 'bl' ? run : null
}

tricobotSaisiesRouter.get('/mail/:runId', async (req, res) => {
  if ((await garde(req, res)) === null) return
  try {
    const run = await runBl(req.params.runId)
    if (!run || !run.message) { res.status(404).json({ error: 'mail introuvable' }); return }
    res.json({
      ...run.message, resume: run.resume,
      // The document he read (GET /mail/:runId/fichiers/:n) and what it says of itself.
      fichiers: (run.fichiers ?? []).map((f, n) => ({ n, nom: f.nom })),
      bl: blDuRun(run.resultat),
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
  if ((await garde(req, res)) === null) return
  try {
    const run = await runBl(req.params.runId)
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
  if ((await garde(req, res)) === null) return
  const id = Number(req.query.commande)
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'commande requise' }); return }
  try { res.json(await saisiesDeCommande(id)) } catch (err) { echec(res, err, 'saisies') }
})

const idParam = (req: Request) => Number(req.params.id)
/** The rolls to receive, as JSON (checked by the gesture). */
const valeur = z.string().min(1).max(500)

/** The gate of a gesture: the screen, on a saisie that exists. */
async function gardeGeste(req: Request, res: Response): Promise<number | null> {
  const s = await saisie(idParam(req)).catch(() => null)
  if (!s) { res.status(404).json({ error: 'introuvable', message: 'Cette saisie de Tricobot n’existe plus.' }); return null }
  return garde(req, res)
}

tricobotSaisiesRouter.post('/:id/valider', async (req, res) => {
  const uid = await gardeGeste(req, res)
  if (uid === null) return
  try { await valider(idParam(req), await auteur(uid)); res.json({ ok: true }) } catch (err) { echec(res, err, 'valider') }
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
