// TRM notification-subscription routes — the TRM app's Paramètres >
// Utilisateurs › Notifications tab. Twin of routes/notifications.ts over the
// TRM catalog + store (lib/notification-keys-trm.ts, lib/notifications-trm.ts).
//
// Endpoints (mounted at /api/notifications-trm):
//   GET  /keys               — catalog of TRM notification types
//   GET  /users              — admin only, subscriptions per user
//   PUT  /users/:id          — admin only, replace a subscription list
//   GET  /apercu/:key        — admin only, the report as it would go out now (HTML)
//   POST /envoyer-test/:key  — admin only, send that report to the caller alone
//
// A subscription whose notification `requires` a permission the user lacks is
// refused (409 permission_requise): the pointage reports carry working hours.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { requireAdmin } from '../lib/auth.js'
import { trmNotifications } from '../lib/notifications-trm.js'
import { TRM_NOTIFICATION_KEYS, isKnownTrmNotificationKey, trmNotificationDef } from '../lib/notification-keys-trm.js'
import { apercuHtml, construireRapport, envoyerRapport, peutRecevoir } from '../lib/rapports-pointage-envoi.js'
import { getUserEmail } from '../lib/user-emails.js'
import { msHeureParis } from '../lib/pointage-etat.js'

export const notificationsTrmRouter: RouterType = Router()

const putBody = z.object({ subscribed: z.array(z.string()) })

notificationsTrmRouter.get('/keys', (_req: Request, res: Response) => {
  res.json(TRM_NOTIFICATION_KEYS)
})

notificationsTrmRouter.get('/users', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  try {
    const all = await trmNotifications.getAllNotifications()
    res.json(Object.entries(all).map(([id, subscribed]) => ({ IDutilisateur: Number(id), subscribed })))
  } catch (err) {
    console.error('Error fetching TRM notification subscriptions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

notificationsTrmRouter.put('/users/:id', async (req: Request, res: Response) => {
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
  const keys = parsed.data.subscribed.filter(isKnownTrmNotificationKey)
  try {
    // Only NEW subscriptions are checked, so a user who lost the right can
    // still be unsubscribed from the rest of the list.
    const avant = new Set(await trmNotifications.getUserNotifications(id))
    for (const k of keys) {
      if (avant.has(k) || (await peutRecevoir(id, k))) continue
      const def = trmNotificationDef(k)
      res.status(409).json({
        error: 'permission_requise',
        message: `« ${def.label} » demande le droit ${def.requires} : accordez-le d’abord dans l’onglet Permissions.`,
      })
      return
    }
    await trmNotifications.setUserNotifications(id, keys)
    res.json({ IDutilisateur: id, subscribed: await trmNotifications.getUserNotifications(id) })
  } catch (err) {
    console.error('Error updating TRM notification subscriptions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** `?jour=YYYYMMDD` pretends the report is built at 09:00 that day (to replay a
 *  past morning); default = now. */
function instant(req: Request): number | null {
  const j = String(req.query.jour ?? '')
  if (!j) return Date.now()
  if (!/^\d{8}$/.test(j)) return null
  return msHeureParis(+j.slice(0, 4), +j.slice(4, 6), +j.slice(6, 8), 9, 0)
}

notificationsTrmRouter.get('/apercu/:key', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const key = req.params.key
  const t = instant(req)
  if (!isKnownTrmNotificationKey(key) || t === null) {
    res.status(400).json({ error: 'invalid key or jour' })
    return
  }
  try {
    const r = await construireRapport(key, t)
    if (!r) {
      res.status(404).json({ error: 'rien_a_envoyer', message: 'Aucune donnée pour ce rapport à cette date.' })
      return
    }
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>${r.subject}</title><body style="margin:0">${apercuHtml(r)}</body>`)
  } catch (err) {
    console.error('Error building TRM report preview:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

notificationsTrmRouter.post('/envoyer-test/:key', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const key = req.params.key
  const t = instant(req)
  if (!isKnownTrmNotificationKey(key) || t === null) {
    res.status(400).json({ error: 'invalid key or jour' })
    return
  }
  try {
    const email = await getUserEmail(req.userId!)
    if (!email) {
      res.status(409).json({ error: 'sans_email', message: 'Votre compte n’a pas d’adresse email.' })
      return
    }
    const r = await construireRapport(key, t)
    if (!r) {
      res.status(404).json({ error: 'rien_a_envoyer', message: 'Aucune donnée pour ce rapport à cette date.' })
      return
    }
    const ok = await envoyerRapport({ ...r, subject: `[Test] ${r.subject}` }, [email])
    if (!ok) {
      res.status(502).json({ error: 'envoi_echoue', message: 'L’envoi a échoué (voir le journal de l’API).' })
      return
    }
    res.json({ envoye: email })
  } catch (err) {
    console.error('Error sending TRM test report:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
