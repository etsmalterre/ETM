// Expe (expe.intra.etsmalterre.com, repo expe): the routes only the shipping
// and transfer tracking app calls. Mounted at /api/expe behind exigerExpe()
// (index.ts): members of the app 'expe' only, 404 for anyone else.
//
// Expe is a window on the documents ETM, TRM and MFProd create: these routes
// never create an avis, a bon de transfert or an invoice, and never move stock.
//
//   GET /transports?jours=30  the ETM transports of the window: the avis and
//                             avis divers grouped by what travels together,
//                             each with its computed status
//                             (lib/expe-departs.ts, lib/expe-transports.ts)

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { listerDeparts, lireJours } from '../lib/expe-departs.js'
import { grouperEnTransports, type AdresseEnlevement } from '../lib/expe-transports.js'
import { loadEnlevementAdresse } from './expeditions.js'

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
