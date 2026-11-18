// Notification subscriptions + the live alert feed behind the tableau de bord
// "Notifications" widget. Port of legacy FI_Notifications.wdw (the panel) and
// FEN_Abonnement.wdw (the gear → "Liste des abonnements" window).
//
// Endpoints (all scoped to the CALLING user — there is no admin view here;
// subscriptions are a personal preference, not a permission):
//   GET  /api/abonnements                  — catalog + this user's subscriptions
//   PUT  /api/abonnements/me               — replace this user's subscriptions
//   GET  /api/abonnements/notifications    : the live alert feed (?all=1 keeps hidden ones,
//                                            ?rouge=1 the red tasks only: the header bell's poll)
//   PUT  /api/abonnements/hidden           — hide / re-show one alert
//
// Since 2026-11-18 the feed is the notification CENTRE (the bell of the header,
// Vincent): a row is either a TASK (`niveau: 'rouge'`: someone at Malterre must
// act now: a red item of a list the user subscribed to, a Superviseur point, an
// invoice to check, a reminder due) or a plain notification of the legacy
// detectors (`niveau: null`, a state: never counted). The bell counts the tasks.
// A task left red more than 2 working days is `retard: true`, and also reaches
// whoever subscribed to « Tâches en retard » (lib/taches/registre.ts).
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
  ABONNEMENT_RETARD,
  ID_RAPPELS,
  abonnesEtm,
  estAbonnementEtm,
  getUserAbonnementsEtm,
  setUserAbonnementsEtm,
  type AbonnementEtm,
} from '../lib/abonnements-etm.js'
import { mpsPg } from '../lib/mps-pg.js'
import { SOURCES_ROUGES, sourceParCle } from '../lib/taches/sources.js'
import { assurerFrais, oublierReleves } from '../lib/taches/releve.js'
import { aujourdhuiParis, enRetard, joursRouges, lireTaches, type TacheRouge } from '../lib/taches/registre.js'
import { aujourdhuiIso, nombreRappelsOuvertsDe, rappelsEchusPour, rappelsEnRetard, type Rappel } from '../lib/rappels.js'
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
  // The bell's poll: the tasks only, the legacy detectors (four-figure volumes) are not run.
  const rougeSeul = req.query.rouge === '1' || req.query.rouge === 'true'
  try {
    const catalog = await getAbonnementCatalog()
    const subscribed = await abonnementsDe(userId, await offreDe(req, userId, catalog))
    const taches = await tachesDe(userId, subscribed)
    // The person's open reminders, due or to come: the count on the centre's « Mes rappels » button.
    const rappelsOuverts = await nombreRappelsOuvertsDe(userId).catch(() => 0)
    if (rougeSeul) {
      res.json({ rows: taches, rouges: taches.length, rappels_ouverts: rappelsOuverts, hidden_count: 0, unimplemented: [], subscribed_count: subscribed.length })
      return
    }
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
    // A legacy alert is a state (a stock at its minimum, a piece without an order), not a task.
    const all = detected.map((d) => ({ ...d, hidden: hiddenSet.has(d.key), niveau: null }))
    const rows = [
      // The tasks first: a handful of things to act on, never hidden (handling
      // one takes it off the list: the eye would mean nothing).
      ...taches,
      ...(includeHidden ? all : all.filter((d) => !d.hidden)),
    ]

    res.json({
      rows,
      /** How many rows are tasks (red): what the header bell counts. */
      rouges: taches.length,
      rappels_ouverts: rappelsOuverts,
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
  oublierReleves()
  res.json({ ok: true })
})

// ── The tasks (red rows) ─────────────────────────────────

const ICONE_ETM = new Map<number, string>(ABONNEMENTS_ETM.map((a) => [a.id, a.icone]))

/** Since when a task is red, for its card: the day (YYYYMMDD), the working days since, and whether
 *  it is late (more than 2, lib/taches/registre.ts). */
function anciennete(depuis: string, aujourdhui: string) {
  return { depuis, jours: joursRouges(depuis, aujourdhui), retard: enRetard(depuis, aujourdhui) }
}

function carteTache(t: TacheRouge, sourceId: number, aujourdhui: string) {
  return {
    key: `${sourceId}:${t.cle}`,
    abonnementId: sourceId,
    titre: t.titre,
    description: t.raison,
    icone: ICONE_ETM.get(sourceId) ?? 'retard',
    hidden: false,
    niveau: 'rouge' as const,
    lien: t.lien,
    ...anciennete(t.depuis, aujourdhui),
  }
}

function carteRappel(r: Rappel, aujourdhui: string) {
  return {
    key: `${ID_RAPPELS}:${r.id}`,
    abonnementId: ID_RAPPELS,
    titre: r.objet_libelle,
    description: r.observation,
    icone: 'rappel',
    hidden: false,
    niveau: 'rouge' as const,
    lien: r.lien,
    ...anciennete(r.echeance.replace(/-/g, ''), aujourdhui),
    rappel: { id: r.id, echeance: r.echeance, pour_id: r.pour_id, pour: r.pour, par: r.par, cree_le: r.cree_le },
  }
}

/** « Prénom Nom » of these accounts (the people a late task is with). */
async function nomsDe(ids: readonly number[]): Promise<Map<number, string>> {
  const u = [...new Set(ids.filter((x) => x > 0))]
  if (u.length === 0) return new Map()
  const rows = await mpsPg()<{ id: number; prenom: string | null; nom: string | null }[]>`
    SELECT idutilisateur AS id, prenom, nom FROM utilisateur WHERE idutilisateur = ANY(${u})`
  return new Map(rows.map((r) => [Number(r.id), `${r.prenom ?? ''} ${r.nom ?? ''}`.trim()]))
}

/** Every task of this user, most pressing family first: their reminders due, the Superviseur points and
 *  the invoices they follow, the red items of the lists they subscribed to, then (« Tâches en retard »)
 *  whatever has been red more than 2 working days at anyone's. One row per item, whatever brought it. */
async function tachesDe(userId: number, subscribed: readonly number[]) {
  const aujourdhui = aujourdhuiParis()
  const enRetardAussi = subscribed.includes(ABONNEMENT_RETARD)
  const suivies = SOURCES_ROUGES.filter((s) => subscribed.includes(s.id))
  // The register dates the families shown here; « Tâches en retard » reads them all.
  await assurerFrais(enRetardAussi ? SOURCES_ROUGES : suivies)
  const registre = await lireTaches((enRetardAussi ? SOURCES_ROUGES : suivies).map((s) => s.cle)).catch((err) => {
    // No register (migration not applied yet): the feed keeps its own cards, without dates.
    console.error('Red-task register unreadable:', err)
    return [] as TacheRouge[]
  })
  const depuisDe = new Map(registre.map((t) => [`${sourceParCle(t.source)?.id}:${t.cle}`, t.depuis]))
  const dater = <T extends { key: string }>(c: T) => {
    const d = depuisDe.get(c.key)
    return { ...c, niveau: 'rouge' as const, ...(d ? anciennete(d, aujourdhui) : { depuis: null, jours: 0, retard: false }) }
  }

  const rappels = await rappelsEchusPour(userId, aujourdhuiIso()).catch((err) => {
    console.error('Reminders for the notification feed failed:', err)
    return [] as Rappel[]
  })
  const rows: Array<{ key: string; retard: boolean; chez?: string[] } & Record<string, unknown>> = [
    ...rappels.map((r) => carteRappel(r, aujourdhui)),
    ...(subscribed.includes(ABONNEMENT_SUPERVISEUR) ? (await pointsSuperviseur()).map(dater) : []),
    ...(subscribed.includes(ABONNEMENT_FACTURES_SST) ? (await cartesFacturesSst()).map(dater) : []),
    ...registre
      .filter((t) => { const s = sourceParCle(t.source); return !!s && s.cartes && subscribed.includes(s.id) })
      .map((t) => carteTache(t, sourceParCle(t.source)!.id, aujourdhui)),
  ]
  if (!enRetardAussi) return rows

  // « Tâches en retard »: what has been red more than 2 working days at anyone's, once.
  const vues = new Set(rows.map((r) => r.key))
  const [abonnes, rappelsTard] = await Promise.all([
    abonnesEtm(),
    rappelsEnRetard(aujourdhuiIso()).catch(() => [] as Rappel[]),
  ])
  const tardives = registre.filter((t) => enRetard(t.depuis, aujourdhui))
  const noms = await nomsDe([
    ...tardives.flatMap((t) => abonnes.get(sourceParCle(t.source)?.id ?? 0) ?? []),
  ])
  for (const t of tardives) {
    const s = sourceParCle(t.source)
    if (!s) continue
    const carte = carteTache(t, s.id, aujourdhui)
    if (vues.has(carte.key)) continue
    vues.add(carte.key)
    // Who it is with: the family's subscribers (nobody = no one follows that list).
    const chez = (abonnes.get(s.id) ?? []).filter((id) => id !== userId).map((id) => noms.get(id) ?? '').filter(Boolean)
    rows.push({ ...carte, chez })
  }
  for (const r of rappelsTard) {
    const carte = carteRappel(r, aujourdhui)
    if (vues.has(carte.key)) continue
    vues.add(carte.key)
    rows.push({ ...carte, chez: [r.pour].filter(Boolean) })
  }
  return rows
}

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
