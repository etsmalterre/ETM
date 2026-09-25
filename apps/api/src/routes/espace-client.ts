// ETM side of the espace client access list (lib/espace-client-acces.ts): the switch on
// each contact of Clients › Gestion › Contacts. The portal's side lives in
// routes/webservice-site.ts (espace/acces, espace/activite).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { requirePermission, ETM_PERMISSIONS } from '../lib/clients-common.js'
import {
  accesDuClient, changerAcces, espaceConfigure, AccesRefuse, EspaceIndisponible,
} from '../lib/espace-client-acces.js'

export const espaceClientRouter: RouterType = Router()

function echec(res: Response, where: string, err: unknown): void {
  if (err instanceof EspaceIndisponible) {
    res.status(503).json({ error: 'L’accès espace client n’est pas configuré sur ce serveur.' })
    return
  }
  if (err instanceof AccesRefuse) {
    res.status(409).json({ error: err.message })
    return
  }
  console.error(`[espace-client] ${where}:`, err)
  res.status(500).json({ error: 'Erreur interne du serveur' })
}

async function nomUtilisateur(userId: number): Promise<string> {
  const rows = await fixEncoding(
    await query<Record<string, unknown>>(`SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${userId}`),
    'utilisateur', 'IDutilisateur', ['prenom', 'nom'],
  )
  const nom = [rows[0]?.prenom, rows[0]?.nom].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ')
  return nom || `Utilisateur #${userId}`
}

/** GET /api/espace-client/clients/:id — access state of that client's contacts. */
espaceClientRouter.get('/clients/:id', async (req: Request, res: Response) => {
  if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
  if (!espaceConfigure()) { res.json({ disponible: false, contacts: [] }); return }
  try {
    res.json({ disponible: true, contacts: await accesDuClient(id) })
  } catch (err) {
    echec(res, `GET clients/${id}`, err)
  }
})

const changementSchema = z.object({ idclient: z.number().int().positive(), actif: z.boolean() })

/** PUT /api/espace-client/contacts/:id — { idclient, actif }. */
espaceClientRouter.put('/contacts/:id', async (req: Request, res: Response) => {
  if (!(await requirePermission(req, res, 'gestion_acces_espace_client', ETM_PERMISSIONS))) return
  const id = Number(req.params.id)
  const body = changementSchema.safeParse(req.body)
  if (!Number.isInteger(id) || id <= 0 || !body.success) { res.status(400).json({ error: 'Requête invalide' }); return }
  try {
    await changerAcces(id, body.data.idclient, body.data.actif, await nomUtilisateur(req.userId!))
    res.json({ contacts: await accesDuClient(body.data.idclient) })
  } catch (err) {
    echec(res, `PUT contacts/${id}`, err)
  }
})
