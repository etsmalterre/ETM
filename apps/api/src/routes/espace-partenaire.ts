// ETM side of the espace partenaire access list (lib/espace-partenaire-acces.ts): the switch on
// each contact of Sous-traitants › Gestion › Contacts. The portal's side lives in
// routes/webservice-site.ts (espace/partenaires/acces, espace/partenaires/activite).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { requirePermission, ETM_PERMISSIONS } from '../lib/clients-common.js'
import { AccesRefuse, EspaceIndisponible, espaceConfigure } from '../lib/espace-client-acces.js'
import { accesDuPartenaire, changerAccesPartenaire } from '../lib/espace-partenaire-acces.js'
import { nomUtilisateur } from '../lib/stock-fini-mesures.js'

export const espacePartenaireRouter: RouterType = Router()

function echec(res: Response, where: string, err: unknown): void {
  if (err instanceof EspaceIndisponible) {
    res.status(503).json({ error: 'L’accès espace partenaire n’est pas configuré sur ce serveur.' })
    return
  }
  if (err instanceof AccesRefuse) {
    res.status(409).json({ error: err.message })
    return
  }
  console.error(`[espace-partenaire] ${where}:`, err)
  res.status(500).json({ error: 'Erreur interne du serveur' })
}

/** GET /api/espace-partenaire/sous-traitants/:id — access state of that sous-traitant's contacts. */
espacePartenaireRouter.get('/sous-traitants/:id', async (req: Request, res: Response) => {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
  if (!espaceConfigure()) { res.json({ disponible: false, contacts: [] }); return }
  try {
    res.json({ disponible: true, contacts: await accesDuPartenaire(id) })
  } catch (err) {
    echec(res, `GET sous-traitants/${id}`, err)
  }
})

const changementSchema = z.object({ idsous_traitant: z.number().int().positive(), actif: z.boolean() })

/** PUT /api/espace-partenaire/contacts/:id — { idsous_traitant, actif }. */
espacePartenaireRouter.put('/contacts/:id', async (req: Request, res: Response) => {
  if (!(await requirePermission(req, res, 'gestion_acces_espace_partenaire', ETM_PERMISSIONS))) return
  const id = Number(req.params.id)
  const body = changementSchema.safeParse(req.body)
  if (!Number.isInteger(id) || id <= 0 || !body.success) { res.status(400).json({ error: 'Requête invalide' }); return }
  try {
    await changerAccesPartenaire(id, body.data.idsous_traitant, body.data.actif, await nomUtilisateur(req.userId!))
    res.json({ contacts: await accesDuPartenaire(body.data.idsous_traitant) })
  } catch (err) {
    echec(res, `PUT contacts/${id}`, err)
  }
})
