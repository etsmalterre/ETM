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
// the address. Each subscription also needs its own sub-permission (offreDe):
// the dialog lists, the PUT accepts and the feed runs only what the user holds.
//
// ⚠️ Naming: /api/notifications (routes/notifications.ts) is a DIFFERENT
// feature — per-user subscriptions to outgoing *emails*. This router owns the
// legacy `abonnement_*` tables and the dashboard alert cards.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { isEffectiveAdmin } from '../lib/auth.js'
import { userHasPermission, getUserPermissions } from '../lib/permissions.js'
import type { PermissionKey } from '../lib/permission-keys.js'
import {
  getAbonnementCatalog,
  getUserAbonnementIds,
  setUserAbonnementIds,
  detectForUser,
  invalidateDetectionCache,
  NOTIF_PERMISSIONS,
  abonnementsPermis,
  fusionnerAbonnements,
  type Abonnement,
  type DetectedNotification,
} from '../lib/abonnements.js'
import { getUserHidden, setUserHidden, toggleUserHidden } from '../lib/notification-hidden.js'
import {
  ABONNEMENTS_ETM,
  ABONNEMENT_SUPERVISEUR,
  ABONNEMENT_FACTURES_SST,
  estAbonnementEtm,
  getUserAbonnementsEtm,
  setUserAbonnementsEtm,
  type AbonnementEtm,
} from '../lib/abonnements-etm.js'
import { pointsATraiter } from '../lib/agents/superviseur/points.js'
import { DOMAINE_LIBELLE } from '../lib/agents/superviseur/types.js'
import { facturesATraiter } from './factures-sst.js'

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

/** What this user may subscribe to: each subscription needs its
 *  sub-permission of `dashboard_notifications` (NOTIF_PERMISSIONS for the
 *  legacy catalog, `permission` for the ETM-only ones). Admins hold them all. */
interface Offre {
  legacy: Abonnement[]
  etm: AbonnementEtm[]
  detient: (key: PermissionKey) => boolean
}

async function offreDe(req: Request, userId: number, catalogLu?: Abonnement[]): Promise<Offre> {
  const admin = isEffectiveAdmin(req)
  const [catalog, granted] = await Promise.all([catalogLu ?? getAbonnementCatalog(), getUserPermissions(userId)])
  const held = new Set<string>(granted)
  const detient = (key: PermissionKey) => admin || held.has(key)
  return {
    legacy: abonnementsPermis(catalog, detient),
    etm: ABONNEMENTS_ETM.filter((a) => detient(a.permission)),
    detient,
  }
}

const versCatalogue = (a: AbonnementEtm): Abonnement =>
  ({ id: a.id, nom: a.nom, description: a.description, icone: a.icone, implemented: true })

/** This user's subscriptions, legacy + ETM-only — only those still offered:
 *  a withdrawn sub-permission stops the feed even if the row is still stored. */
async function abonnementsDe(userId: number, offre: Offre): Promise<number[]> {
  const [legacy, etm] = await Promise.all([getUserAbonnementIds(userId), getUserAbonnementsEtm(userId)])
  const visiblesEtm = new Set(offre.etm.map((a) => a.id))
  return [
    ...legacy.filter((id) => NOTIF_PERMISSIONS[id] === undefined || offre.detient(NOTIF_PERMISSIONS[id])),
    ...etm.filter((id) => visiblesEtm.has(id)),
  ]
}

// ── GET /api/abonnements ─────────────────────────────────
// The subscription catalog for this app's société, plus the ids this user has
// ticked — everything the "Liste des abonnements" dialog needs in one round trip.
abonnementsRouter.get('/', async (req: Request, res: Response) => {
  const userId = await requireWidgetUser(req, res)
  if (userId === null) return
  try {
    const offre = await offreDe(req, userId)
    const subscribed = await abonnementsDe(userId, offre)
    res.json({ catalog: [...offre.legacy, ...offre.etm.map(versCatalogue)], subscribed })
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
    // Legacy ids go to the shared HFSQL table, ETM-only ones to their own store.
    // Only offered ids are taken from the request; a subscription the user may
    // no longer see keeps its stored row untouched (fusionnerAbonnements).
    const offre = await offreDe(req, userId)
    const voulusLegacy = parsed.data.subscribed.filter((id) => !estAbonnementEtm(id))
    await setUserAbonnementIds(userId, fusionnerAbonnements(
      await getUserAbonnementIds(userId), voulusLegacy, offre.legacy.map((a) => a.id),
    ))
    await setUserAbonnementsEtm(userId, parsed.data.subscribed.filter(estAbonnementEtm), offre.etm.map((a) => a.id))
    res.json({ subscribed: await abonnementsDe(userId, offre) })
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
    const subscribed = await abonnementsDe(userId, await offreDe(req, userId, catalog))
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
    const rows = [
      // Superviseur points first: a handful of things to act on, never hidden
      // (handling one takes it off the list — the eye would mean nothing).
      ...(subscribed.includes(ABONNEMENT_SUPERVISEUR) ? await pointsSuperviseur() : []),
      // Same for the invoices with a gap: handled on Sous-traitants › Factures.
      ...(subscribed.includes(ABONNEMENT_FACTURES_SST) ? await cartesFacturesSst() : []),
      ...(includeHidden ? all : all.filter((d) => !d.hidden)),
    ]

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

/** The Superviseur's points still to handle, as widget cards (lib/agents/superviseur/points.ts). */
async function pointsSuperviseur() {
  try {
    return (await pointsATraiter()).map((p) => ({
      key: `${ABONNEMENT_SUPERVISEUR}:${p.cle}`,
      abonnementId: ABONNEMENT_SUPERVISEUR,
      titre: p.titre,
      description: p.message,
      icone: 'superviseur',
      hidden: false,
      superviseur: {
        runId: p.runId,
        cle: p.cle,
        gravite: p.gravite,
        domaine: DOMAINE_LIBELLE[p.domaine] ?? p.domaine,
        nouveau: p.etat !== 'ouvert',
        depuis: p.depuis,
        lien: p.lien,
        lecons: p.lecons,
      },
    }))
  } catch (err) {
    // Like a failing detector: no cards rather than a blank widget.
    console.error('Superviseur points for the notification feed failed:', err)
    return []
  }
}

/** The dyers' invoices waiting for a person (all of them while the agent's
 *  « confirmation » option is on), as widget cards. */
async function cartesFacturesSst() {
  try {
    const eur = (v: number) => v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return (await facturesATraiter()).map((f) => {
      const parts: string[] = []
      if (f.nb_ecarts) parts.push(`${f.nb_ecarts} écart${f.nb_ecarts > 1 ? 's' : ''} (${eur(f.ecart_montant)} € facturés en trop)`)
      if (f.nb_non_verifies) parts.push(`${f.nb_non_verifies} ligne${f.nb_non_verifies > 1 ? 's' : ''} à vérifier`)
      if (!parts.length) parts.push(f.statut === 'conforme' ? 'aucun écart — à valider' : 'lecture à vérifier')
      const date = f.date_facture ? ` du ${f.date_facture.split('-').reverse().join('/')}` : ''
      return {
        key: `${ABONNEMENT_FACTURES_SST}:${f.id}`,
        abonnementId: ABONNEMENT_FACTURES_SST,
        titre: `${f.sous_traitant} — facture ${f.numero}${date}`,
        description: parts.join(' · '),
        icone: 'facture_sst',
        hidden: false,
        lien: `/sous-traitants/factures?facture=${f.id}`,
      }
    })
  } catch (err) {
    console.error('Invoice cards for the notification feed failed:', err)
    return []
  }
}

export type { Abonnement, DetectedNotification }
