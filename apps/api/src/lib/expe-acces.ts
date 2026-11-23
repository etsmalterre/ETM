// The gate of Expe (expe.intra.etsmalterre.com, repo expe): the routes only
// Expe calls answer the members of 'expe' only (table `utilisateur_app`,
// lib/utilisateur-apps.ts), like the Console Administration's
// (lib/console-acces.ts). Membership is the right to enter; inside, a gated
// action checks its key in Expe's own store (lib/permissions-expe.ts).

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { isEffectiveAdmin } from './auth.js'
import { estMembreExpe } from './utilisateur-apps.js'

/** 401 without a session, 404 for a non-member (Expe does not exist for them). */
export function exigerExpe(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'non_connecte' })
      return
    }
    try {
      if (await estMembreExpe(req.userId, isEffectiveAdmin(req))) { next(); return }
      res.status(404).json({ error: 'not found' })
    } catch (err) {
      next(err)
    }
  }
}
