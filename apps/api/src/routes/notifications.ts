// Notification-subscription routes — per-user email subscriptions, managed
// from the Settings > Utilisateurs › Notifications tab. Mirrors permissions.ts.
//
// Endpoints:
//   GET  /api/notifications/keys         — catalog of notification types
//   GET  /api/notifications/users        — admin only, subscriptions per user
//   PUT  /api/notifications/users/:id    — admin only, replace a subscription list
//
// The user list itself comes from /api/permissions/users (same page, already
// deduped there) — this router only owns the subscription map.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { requireAdmin } from '../lib/auth.js'
import {
  getUserNotifications,
  setUserNotifications,
  getAllNotifications,
} from '../lib/notifications.js'
import { NOTIFICATION_KEYS, isKnownNotificationKey } from '../lib/notification-keys.js'

export const notificationsRouter: RouterType = Router()

const putBody = z.object({
  subscribed: z.array(z.string()),
})

// ── GET /api/notifications/keys ────────────────────────
// Catalog of known notification types, used by the admin UI to render toggles.
notificationsRouter.get('/keys', (_req: Request, res: Response) => {
  res.json(NOTIFICATION_KEYS)
})

// ── GET /api/notifications/users ───────────────────────
// Admin only. The raw subscription map, as a list the frontend can index by
// IDutilisateur. Users with no subscriptions are simply absent.
notificationsRouter.get('/users', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const all = await getAllNotifications()
    res.json(Object.entries(all).map(([id, subscribed]) => ({
      IDutilisateur: Number(id),
      subscribed,
    })))
  } catch (err) {
    console.error('Error fetching notification subscriptions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/notifications/users/:id ───────────────────
// Admin only. Replaces a user's subscription list (unknown keys are dropped).
notificationsRouter.put('/users/:id', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const id = parseInt(req.params.id, 10)
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  const parsed = putBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues })
    return
  }
  const keys = parsed.data.subscribed.filter(isKnownNotificationKey)
  try {
    await setUserNotifications(id, keys)
    res.json({ IDutilisateur: id, subscribed: await getUserNotifications(id) })
  } catch (err) {
    console.error('Error updating notification subscriptions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
