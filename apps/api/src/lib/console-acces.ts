// The gate of the Console Administration (admin.intra.etsmalterre.com,
// repo admin-malterre): the routes only the console calls answer members of 'admin'
// only (table `utilisateur_app`, lib/utilisateur-apps.ts). Membership is the
// whole right to enter; inside, each section keeps its own locks: RH its grant
// + code RH (lib/rh-acces.ts), Utilisateurs the admin (est_admin), every write
// its company's action key (edit_agents_ia…).
//
// A route an ERP screen still calls stays outside: the Superviseur points are
// handled from the dashboard Notifications widget (`/:slug/points/*`).

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { isEffectiveAdmin } from './auth.js'
import { estMembreConsole } from './utilisateur-apps.js'

/** 401 without a session, 404 for a non-member (the console does not exist
 *  for them, like RH). `sauf`: paths of the router left open. */
export function exigerConsole(sauf?: RegExp): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (sauf?.test(req.path)) { next(); return }
    if (req.userId === undefined) {
      res.status(401).json({ error: 'non_connecte' })
      return
    }
    try {
      if (await estMembreConsole(req.userId, isEffectiveAdmin(req))) { next(); return }
      res.status(404).json({ error: 'not found' })
    } catch (err) {
      next(err)
    }
  }
}

/** The Superviseur points, handled from the ERP dashboard. */
export const POINTS_TABLEAU_DE_BORD = /^\/[^/]+\/points\//
