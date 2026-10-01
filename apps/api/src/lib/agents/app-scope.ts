// Agents IA belongs to an APP, like a screen: ETM and TRM each have a menu
// « Agents IA » (Agents + Automates) that lists only its own agents and
// automates and checks its own permission store. One engine runs them all
// (lib/agents/scheduler.ts); the app only decides which screen shows and pilots
// a job. The routers are mounted twice (index.ts): /api/agents-ia +
// /api/automates for ETM, /api/agents-ia-trm + /api/automates-trm for TRM.
//
// An agent or automate without `app` is ETM's. Moving one to the other app is a
// one-word change in its catalog entry: its slug, state and runs stay put.

import type { Request, Response } from 'express'
import { userHasPermission } from '../permissions.js'
import { trmUserHasPermission } from '../permissions-trm.js'
import { isKnownTrmPermissionKey } from '../permission-keys-trm.js'

export type AppIa = 'etm' | 'trm'

/** The rights the two routers check. The two `dashboard_*` keys exist in
 *  ETM's catalog only (the Notifications widget's Superviseur points). */
export type DroitIa = 'edit_agents_ia' | 'evaluer_agents_ia' | 'dashboard_notifications' | 'dashboard_notif_superviseur'

export interface AgentsIaScope {
  app: AppIa
  aLeDroit(userId: number, isAdmin: boolean, droit: DroitIa): Promise<boolean>
}

export const AGENTS_IA_ETM: AgentsIaScope = {
  app: 'etm',
  aLeDroit: (userId, isAdmin, droit) => userHasPermission(userId, isAdmin, droit),
}

export const AGENTS_IA_TRM: AgentsIaScope = {
  app: 'trm',
  aLeDroit: async (userId, isAdmin, droit) =>
    isKnownTrmPermissionKey(droit) ? trmUserHasPermission(userId, isAdmin, droit) : isAdmin,
}

/** The scope of the mount serving this request (set by `avecScope`). */
export function scopeDe(res: Response): AgentsIaScope {
  return (res.locals.agentsIa as AgentsIaScope | undefined) ?? AGENTS_IA_ETM
}

/** Middleware stamping the mount's scope on the request. */
export function avecScope(scope: AgentsIaScope) {
  return (_req: Request, res: Response, next: () => void) => {
    res.locals.agentsIa = scope
    next()
  }
}

/** Whether a catalog entry belongs to an app (no `app` = ETM). */
export function deLApp(def: { app?: AppIa }, app: AppIa): boolean {
  return (def.app ?? 'etm') === app
}
