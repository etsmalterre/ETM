// Expe (expe.intra.etsmalterre.com, repo expe): the routes only the shipping
// and transfer tracking app calls. Mounted at /api/expe behind exigerExpe()
// (index.ts): members of the app 'expe' only, 404 for anyone else.
//
// Expe is a window on the documents ETM, TRM and MFProd create: these routes
// never create an avis, a bon de transfert or an invoice, and never move stock.
// What they write is the physical movement: the carrier chosen (on the avis)
// and the shipment's tracking number (lib/expe-envoi.ts).
//
//   GET /transports?jours=30  the ETM transports of the window: the avis and
//                             avis divers grouped by what travels together,
//                             each with its computed status
//                             (lib/expe-departs.ts, lib/expe-transports.ts)
//   GET /avis/:kind/:id/pieces[?lieu=N]
//                             what an avis carries: its rolls under the order
//                             line they ship (kind formelle), its cartons and
//                             their articles (kind divers). `lieu` = the place
//                             the transport leaves from (magasin id, 0 = the
//                             factory): only the rolls sitting there
//                             (lib/expe-pieces.ts)
//   GET /transporteurs        the carriers a transport can be given
//   PUT /transports           write the carrier and / or the tracking number of
//                             a transport, named by its avis. Key
//                             `edit_transports` of Expe's own store
//                             (lib/expe-envoi.ts)

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { listerDeparts, lireJours } from '../lib/expe-departs.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { RefusTransport, lireModifTransport, listerTransporteurs, modifierTransport } from '../lib/expe-envoi.js'
import { lireLieu } from '../lib/expe-pieces.js'
import { expeUserHasPermission } from '../lib/permissions-expe.js'
import { nomUtilisateur } from '../lib/stock-fini-mesures.js'
import { grouperEnTransports, type AdresseEnlevement } from '../lib/expe-transports.js'
import { loadEnlevementAdresse, loadPiecesAvis } from './expeditions.js'

export const expeRouter: RouterType = Router()

expeRouter.get('/transports', async (req: Request, res: Response) => {
  try {
    const jours = lireJours(req.query.jours)
    const transports = grouperEnTransports(await listerDeparts(jours))

    // One pickup address per place (a handful of places, whatever the window).
    const lieux = Array.from(new Set(transports.map((t) => t.lieu.id).filter((id): id is number => id !== null)))
    const adresses = new Map<number, AdresseEnlevement>()
    await Promise.all(lieux.map(async (id) => { adresses.set(id, await loadEnlevementAdresse(id)) }))
    for (const t of transports) t.enlevement = t.lieu.id !== null ? adresses.get(t.lieu.id) ?? null : null

    res.json({ jours, transports })
  } catch (err) {
    console.error('Error fetching Expe transports:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeRouter.get('/avis/:kind/:id/pieces', async (req: Request, res: Response) => {
  try {
    const kind = req.params.kind === 'formelle' || req.params.kind === 'divers' ? req.params.kind : null
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN
    if (!kind || !Number.isSafeInteger(id) || id <= 0) { res.status(404).json({ error: 'not found' }); return }
    const pieces = await loadPiecesAvis(kind, id, lireLieu(req.query.lieu))
    if (!pieces) { res.status(404).json({ error: 'not found' }); return }
    res.json(pieces)
  } catch (err) {
    console.error('Error fetching Expe avis pieces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeRouter.get('/transporteurs', async (_req: Request, res: Response) => {
  try {
    res.json(await listerTransporteurs())
  } catch (err) {
    console.error('Error fetching Expe transporteurs:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const STATUT_REFUS: Record<RefusTransport['code'], number> = {
  avis_introuvable: 404,
  transporteur_introuvable: 404,
  envois_differents: 409,
}

expeRouter.put('/transports', async (req: Request, res: Response) => {
  try {
    // exigerExpe() (index.ts) already refused a request without a session.
    const userId = req.userId as number
    if (!(await expeUserHasPermission(userId, isEffectiveAdmin(req), 'edit_transports'))) {
      res.status(403).json({ error: 'forbidden', message: 'Vous n’avez pas le droit de modifier un transport.' })
      return
    }
    const modif = lireModifTransport(req.body)
    if (!modif) { res.status(400).json({ error: 'validation', message: 'Modification invalide.' }); return }
    const fait = await modifierTransport(modif, { id: userId, nom: await nomUtilisateur(userId) })
    res.json({ ok: true, ...fait })
  } catch (err) {
    if (err instanceof RefusTransport) {
      res.status(STATUT_REFUS[err.code]).json({ error: err.code, message: err.message })
      return
    }
    console.error('Error updating Expe transport:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
