// « Tricobot » feedback given where the work is done (decision Vincent
// 2026-10-02; lib/agents/retours.ts). Users only see Tricobot; each route
// below knows which agent produced the item and sends the feedback there.
//
//   PUT /bl-reception — rolls received from a BL Tricobot pre-filled
//     (Sous-traitants › Commandes › Réception): received as pre-filled =
//     réussite, any pre-filled value changed = échec with what changed (and
//     why, if said). Scored per BL run, the one that wrote the lot.
//
// Gate: the screen where the work is done (Écrans), no action key.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { userCanOpenScreen } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { auteur } from './agents-ia.js'
import { enregistrerRetour } from '../lib/agents/retours.js'
import { BL_ENNOBLISSEUR_SLUG, runDuLot } from '../lib/agents/bl-ennoblisseur.js'

export const tricobotRouter: RouterType = Router()

async function garde(req: Request, res: Response, menu: string, ecran: string): Promise<number | null> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  if (!(await userCanOpenScreen(req.userId, isEffectiveAdmin(req), menu, ecran))) {
    res.status(403).json({ error: 'écran non accessible' })
    return null
  }
  return req.userId
}

const blReception = z.object({
  ligneId: z.number().int().positive(),
  lots: z.array(z.object({
    lot: z.string().trim().min(1).max(100),
    /** What the person changed in Tricobot's pre-fill, one line each (« 3505/14 poids 21,4 → 24,1 »). */
    corrections: z.array(z.string().max(300)).max(200),
  })).min(1).max(50),
  /** The person's why, when they gave one. */
  commentaire: z.string().max(2000).default(''),
})

tricobotRouter.put('/bl-reception', async (req, res) => {
  const uid = await garde(req, res, '/sous-traitants', '/sous-traitants/commandes')
  if (uid === null) return
  const p = blReception.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'corps invalide' }); return }
  try {
    const par = await auteur(uid)
    const retours: Array<{ lot: string; runId: string | null; juste: boolean }> = []
    for (const { lot, corrections } of p.data.lots) {
      const run = await runDuLot(p.data.ligneId, lot)
      const juste = corrections.length === 0
      if (run) {
        const commentaire = juste ? '' : [p.data.commentaire.trim(), corrections.join(' ; ')].filter(Boolean).join(' — ')
        await enregistrerRetour({ slug: BL_ENNOBLISSEUR_SLUG, runId: run.id, cle: null, juste, commentaire, par, garderEchec: true })
      }
      retours.push({ lot, runId: run?.id ?? null, juste })
    }
    res.json({ retours })
  } catch (err) {
    console.error('[tricobot] bl-reception failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
