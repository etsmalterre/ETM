// Notification subscriptions + the live alert feed behind the tableau de bord
// "Notifications" widget. Port of legacy FI_Notifications.wdw (the panel) and
// FEN_Abonnement.wdw (the gear → "Liste des abonnements" window).
//
// Endpoints (all scoped to the CALLING user — there is no admin view here;
// subscriptions are a personal preference, not a permission):
//   GET  /api/abonnements                  — catalog + this user's subscriptions
//   PUT  /api/abonnements/me               — replace this user's subscriptions
//   GET  /api/abonnements/notifications    — the live alert feed (?all=1 keeps hidden ones)
//   PUT  /api/abonnements/hidden           — hide / re-show one alert
//
// Everything is gated on `dashboard_notifications` on the API too, not just by
// hiding the widget: the feed names client orders, quality dossiers and stock
// levels, so a user without the widget must not be able to read it by guessing
// the address.
//
// ⚠️ Naming: /api/notifications (routes/notifications.ts) is a DIFFERENT
// feature — per-user subscriptions to outgoing *emails*. This router owns the
// legacy `abonnement_*` tables and the dashboard alert cards.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { isEffectiveAdmin } from '../lib/auth.js'
import { userHasPermission } from '../lib/permissions.js'
import {
  getAbonnementCatalog,
  getUserAbonnementIds,
  setUserAbonnementIds,
  detectForUser,
  invalidateDetectionCache,
  type Abonnement,
  type DetectedNotification,
} from '../lib/abonnements.js'
import { getUserHidden, setUserHidden, toggleUserHidden } from '../lib/notification-hidden.js'

export const abonnementsRouter: RouterType = Router()

const PERMISSION = 'dashboard_notifications'

/** Resolve the calling user and check the widget permission in one step.
 *  Returns the IDutilisateur, or null after having answered 401/403. */
async function requireWidgetUser(req: Request, res: Response): Promise<number | null> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), PERMISSION)
  if (!allowed) {
    res.status(403).json({ error: `permission denied: ${PERMISSION}` })
    return null
  }
  return req.userId
}

// ── GET /api/abonnements ─────────────────────────────────
// The subscription catalog for this app's société, plus the ids this user has
// ticked — everything the "Liste des abonnements" dialog needs in one round trip.
abonnementsRouter.get('/', async (req: Request, res: Response) => {
  const userId = await requireWidgetUser(req, res)
  if (userId === null) return
  try {
    const [catalog, subscribed] = await Promise.all([
      getAbonnementCatalog(),
      getUserAbonnementIds(userId),
    ])
    res.json({ catalog, subscribed })
  } catch (err) {
    console.error('Error fetching abonnements:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/abonnements/me ──────────────────────────────
// Replace this user's subscriptions. Writes the shared `abonnement_user` table,
// so the change is visible in the legacy WinDev app too.
const putSubscriptions = z.object({
  subscribed: z.array(z.number().int().positive()).max(100),
})

abonnementsRouter.put('/me', async (req: Request, res: Response) => {
  const userId = await requireWidgetUser(req, res)
  if (userId === null) return
  const parsed = putSubscriptions.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues })
    return
  }
  try {
    await setUserAbonnementIds(userId, parsed.data.subscribed)
    res.json({ subscribed: await getUserAbonnementIds(userId) })
  } catch (err) {
    console.error('Error updating abonnements:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/abonnements/notifications?all=1 ─────────────
// The live feed. Alerts are recomputed from the source tables on every read
// (see lib/abonnements.ts for why nothing is persisted); `?all=1` is the
// legacy "Afficher tout" checkbox, which reveals the hidden ones instead of
// filtering them out.
abonnementsRouter.get('/notifications', async (req: Request, res: Response) => {
  const userId = await requireWidgetUser(req, res)
  if (userId === null) return
  const includeHidden = req.query.all === '1' || req.query.all === 'true'
  try {
    const catalog = await getAbonnementCatalog()
    const subscribed = await getUserAbonnementIds(userId)
    const detected = await detectForUser(subscribed, catalog)

    // Prune entries whose alert no longer exists. Legacy deletes the
    // notification row outright once its condition clears, taking `visible = 0`
    // with it — so a condition that comes back is announced again. Scope the
    // prune to the subscriptions we actually ran, or unsubscribing from a type
    // would silently forget which of its cards the user had hidden.
    const stored = await getUserHidden(userId)
    const live = new Set(detected.map((d) => d.key))
    const ranAbos = new Set(
      catalog.filter((a) => a.implemented && subscribed.includes(a.id)).map((a) => a.id),
    )
    const kept = stored.filter((k) => {
      const aboId = Number(k.slice(0, k.indexOf(':')))
      if (!ranAbos.has(aboId)) return true // detector didn't run — can't judge
      return live.has(k)
    })
    if (kept.length !== stored.length) await setUserHidden(userId, kept)

    const hiddenSet = new Set(kept)
    const all = detected.map((d) => ({ ...d, hidden: hiddenSet.has(d.key) }))
    const rows = includeHidden ? all : all.filter((d) => !d.hidden)

    res.json({
      rows,
      /** Always the TOTAL hidden count, whatever `?all` is — so the widget's
       *  counter pill doesn't change value when the user toggles it. */
      hidden_count: all.filter((d) => d.hidden).length,
      /** Subscriptions with no detector yet, so the widget can say so rather
       *  than look broken when a user subscribes to one. */
      unimplemented: catalog
        .filter((a) => subscribed.includes(a.id) && !a.implemented)
        .map((a) => a.nom),
      subscribed_count: subscribed.length,
    })
  } catch (err) {
    console.error('Error building notification feed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/abonnements/hidden ──────────────────────────
// Hide (or re-show) one alert for this user. The key travels in the body
// rather than the path because it contains a colon.
const putHidden = z.object({
  key: z.string().min(1).max(200),
  hidden: z.boolean(),
})

abonnementsRouter.put('/hidden', async (req: Request, res: Response) => {
  const userId = await requireWidgetUser(req, res)
  if (userId === null) return
  const parsed = putHidden.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues })
    return
  }
  try {
    const hidden = await toggleUserHidden(userId, parsed.data.key, parsed.data.hidden)
    res.json({ hidden })
  } catch (err) {
    console.error('Error updating hidden notification:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/abonnements/refresh ────────────────────────
// Drop the detection cache so the next read hits the source tables. Backs the
// widget's refresh button — without it a user who just fixed the underlying
// record would wait out the TTL wondering why the card is still there.
// The cache is keyed by subscription, not by user, so this clears it for
// everyone — which is correct (the underlying tables are shared) and harmless:
// the next read simply re-detects.
abonnementsRouter.post('/refresh', async (req: Request, res: Response) => {
  if ((await requireWidgetUser(req, res)) === null) return
  invalidateDetectionCache()
  res.json({ ok: true })
})

export type { Abonnement, DetectedNotification }
