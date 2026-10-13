// Qualité › Analyse (LIVA #1289) — read-only history of the validated lots,
// référentiel vs dyer vs internal controls. Rules in lib/analyse-qualite.ts.
// Reads stay open like the rest of Qualité; the Écrans grant hides the menu.
import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { chargerLotsAnalyse } from '../lib/analyse-qualite.js'

export const analyseQualiteRouter: RouterType = Router()

// GET /analyse-qualite/lots — every validated lot, newest first. The screen
// filters, sorts and exports client-side (~5 500 rows, one query). Null fields
// are left out of the JSON: most controls are partial, and dropping them
// halves the payload (4,6 → ~2 Mo); the screen reads a missing key as null.
analyseQualiteRouter.get('/lots', async (_req: Request, res: Response) => {
  try {
    const lots = await chargerLotsAnalyse()
    res.type('json').send(JSON.stringify(lots, (_key, value) => (value === null ? undefined : value)))
  } catch (err) {
    console.error('Error loading analyse qualité:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
