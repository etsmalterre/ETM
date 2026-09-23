import dotenv from 'dotenv'

const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' }) // fallback / overrides
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { entreprisesRouter } from './routes/entreprises.js'
import { fournisseursRouter } from './routes/fournisseurs.js'
import { referencesFilRouter } from './routes/references-fil.js'
import { referencesFiniRouter } from './routes/references-fini.js'
import { referencesEcruRouter } from './routes/references-ecru.js'
import { referencesDiversRouter } from './routes/references-divers.js'
import { referencesRectiligneRouter } from './routes/references-rectiligne.js'
import { tarifsFiniRouter } from './routes/tarifs-fini.js'
import { stockDiversRouter } from './routes/stock-divers.js'
import { commandesFilRouter } from './routes/commandes-fil.js'
import { commandesSousTraitantRouter } from './routes/commandes-sous-traitant.js'
import { commandesClientRouter } from './routes/commandes-client.js'
import { commandesTrmRouter } from './routes/commandes-trm.js'
import { facturesRouter, facturesTrmRouter } from './routes/factures.js'
import { devisRouter } from './routes/devis.js'
import { expeditionsRouter } from './routes/expeditions.js'
import { expeditionsTrmRouter } from './routes/expeditions-trm.js'
import { transfertsRouter } from './routes/transferts.js'
import { clientsRouter } from './routes/clients.js'
import { clientsTrmRouter } from './routes/clients-trm.js'
import { sousTraitantsRouter } from './routes/sous-traitants.js'
import { etudesColorisRouter } from './routes/etudes-coloris.js'
import { prospectsRouter } from './routes/prospects.js'
import { stockRouter } from './routes/stock.js'
import { stockFiniRouter } from './routes/stock-fini.js'
import { stockEcruRouter } from './routes/stock-ecru.js'
import { stockEcruTrmRouter } from './routes/stock-ecru-trm.js'
import { stockFilTrmRouter } from './routes/stock-fil-trm.js'
import { suiviLotsRouter } from './routes/suivi-lots.js'
import { dossiersQualiteRouter } from './routes/dossiers-qualite.js'
import { actionsQualiteRouter } from './routes/actions-qualite.js'
import { rapportsRouter } from './routes/rapports.js'
import { rapportsTrmRouter } from './routes/rapports-trm.js'
import { planningAtelierRouter } from './routes/planning-atelier.js'
import { ofTrmRouter } from './routes/of-trm.js'
import { recorderRouter } from './routes/recorder.js'
import { visitageTrmRouter } from './routes/visitage-trm.js'
import { atelierRouter } from './routes/atelier.js'
import { appareilsAtelierRouter } from './routes/appareils-atelier.js'
import { trsRouter } from './routes/trs.js'
import { pointageRouter } from './routes/pointage.js'
import { pointageAdminRouter } from './routes/pointage-admin.js'
import { dashboardTrmRouter } from './routes/dashboard-trm.js'
import { primeTrmRouter } from './routes/prime-trm.js'
import { maintenanceTrmRouter } from './routes/maintenance-trm.js'
import { retoursClientTrmRouter } from './routes/retours-client-trm.js'
import { authRouter } from './routes/auth.js'
import { ticketsRouter, ticketsTrmRouter } from './routes/tickets.js'
import { permissionsRouter } from './routes/permissions.js'
import { permissionsTrmRouter } from './routes/permissions-trm.js'
import { notificationsRouter } from './routes/notifications.js'
import { notificationsTrmRouter } from './routes/notifications-trm.js'
import { demarrerRapportsPointage } from './lib/rapports-pointage-envoi.js'
import { agentsIaRouter } from './routes/agents-ia.js'
import { webserviceSiteRouter } from './routes/webservice-site.js'
import { demarrerAgents } from './lib/agents/scheduler.js'
import { abonnementsRouter } from './routes/abonnements.js'
import { userEmailsRouter } from './routes/user-emails.js'
import { userProfilesRouter } from './routes/user-profiles.js'
import { query } from './lib/hfsql-auto.js'
import { attachUser } from './lib/auth.js'
import { closeConnection } from './lib/hfsql-auto.js'
import { probeFiniSourceTable, FINI_SOURCE_TABLE } from './lib/fini-sources.js'

const app = express()
const PORT = process.env.PORT || 8080
// CORS_ORIGIN accepts a single URL or a comma-separated list. With
// `credentials: true`, we cannot use '*' — every allowed origin must be
// explicit, so we parse the list and pass an array to the cors middleware.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5174')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.use(helmet())
// CORS must set `credentials: true` for the browser to send/receive cookies
// cross-origin. With credentials, `origin` must be explicit (not '*').
app.use(cors({ origin: CORS_ORIGINS, credentials: true }))
// 25 MB body limit — the email endpoints accept base64-encoded user
// attachments inline, and Gmail's hard ceiling per message is 25 MB raw
// (~33 MB base64'd). 25 MB here gives enough room for the largest practical
// attachment payload while keeping runaway bodies bounded.
app.use(express.json({ limit: '25mb' }))
app.use(cookieParser())
// Best-effort: attaches req.userId when a valid signed cookie is present.
// Never 401s — routes keep working without a cookie, same as before.
app.use(attachUser())

// Liveness by default. `?db=1` upgrades it to a readiness probe that actually
// touches HFSQL — the process can answer the plain form perfectly while every
// data route hangs on a poisoned connection, which is exactly the failure the
// worktree spin-up scripts need to catch (they used to accept "port is open"
// as proof the API was usable).
app.get('/api/health', async (req, res) => {
  const base = { status: 'ok', app: 'MPS API', version: '0.1.0' }
  if (req.query.db === undefined) {
    res.json(base)
    return
  }
  const t0 = Date.now()
  try {
    await query('SELECT COUNT(*) AS n FROM utilisateur')
    res.json({ ...base, db: 'ok', dbMs: Date.now() - t0 })
  } catch (err) {
    res.status(503).json({
      ...base,
      status: 'degraded',
      db: 'error',
      dbMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

app.use('/api/auth', authRouter)
// Bug/feature ticket reporting — proxy to the LIVA issue tracker
app.use('/api/tickets', ticketsRouter)
// Same proxy, product "trm-erp" — the TRM web app's ticket widget.
app.use('/api/tickets-trm', ticketsTrmRouter)
app.use('/api/permissions', permissionsRouter)
// TRM's own permission catalog + store (Paramètres > Utilisateurs of the
// sister TRM app) — separate from /api/permissions so neither admin screen
// can strip the other app's grants on save (see lib/permissions-trm.ts).
app.use('/api/permissions-trm', permissionsTrmRouter)
app.use('/api/notifications', notificationsRouter)
// TRM's own subscriptions (Paramètres › Utilisateurs › Notifications of the TRM app)
app.use('/api/notifications-trm', notificationsTrmRouter)
app.use('/api/abonnements', abonnementsRouter)
app.use('/api/user-emails', userEmailsRouter)
app.use('/api/user-profiles', userProfilesRouter)
app.use('/api/entreprises', entreprisesRouter)
app.use('/api/fournisseurs', fournisseursRouter)
app.use('/api/references-fil', referencesFilRouter)
app.use('/api/references-fini', referencesFiniRouter)
app.use('/api/references-ecru', referencesEcruRouter)
app.use('/api/references-divers', referencesDiversRouter)
app.use('/api/references-rectiligne', referencesRectiligneRouter)
app.use('/api/tarifs-fini', tarifsFiniRouter)
app.use('/api/stock-divers', stockDiversRouter)
app.use('/api/commandes-fil', commandesFilRouter)
app.use('/api/commandes-sous-traitant', commandesSousTraitantRouter)
app.use('/api/commandes-client', commandesClientRouter)
// TRM client ledger (IDsociete = 2) — served to the sister TRM app, which has
// no API of its own. Separate router from commandes-client: same tables, other
// partition, and a production-centric screen (see commandes-trm.ts header).
app.use('/api/commandes-trm', commandesTrmRouter)
app.use('/api/factures', facturesRouter)
// Same router, IDsociete = 2 — the Tricotage Malterre ledger (TRM web app).
app.use('/api/factures-trm', facturesTrmRouter)
app.use('/api/devis', devisRouter)
app.use('/api/expeditions', expeditionsRouter)
// Tricotage Malterre's own shipments (expedition.IDsociete = 2) — consumed by
// the TRM frontend. Separate mount so the ETM routes stay société-1 only.
app.use('/api/expeditions-trm', expeditionsTrmRouter)
app.use('/api/transferts', transfertsRouter)
app.use('/api/clients', clientsRouter)
// TRM ledger (IDsociete = 2) — consumed by the TRM app, see routes/clients-trm.ts
app.use('/api/clients-trm', clientsTrmRouter)
app.use('/api/sous-traitants', sousTraitantsRouter)
app.use('/api/etudes-coloris', etudesColorisRouter)
app.use('/api/prospects', prospectsRouter)
app.use('/api/stock', stockRouter)
app.use('/api/stock', stockFiniRouter)
app.use('/api/stock', stockEcruRouter)
// TRM (IDsociete = 2) écru stock — consumed by the TRM frontend only.
app.use('/api/stock', stockEcruTrmRouter)
app.use('/api/stock', stockFilTrmRouter)
app.use('/api/suivi-lots', suiviLotsRouter)
app.use('/api/dossiers-qualite', dossiersQualiteRouter)
app.use('/api/actions-qualite', actionsQualiteRouter)
app.use('/api/rapports', rapportsRouter)
app.use('/api/rapports-trm', rapportsTrmRouter)
// TRM atelier planning — consumed by the TRM web app (C:\dev\etsmalterre\TRM)
app.use('/api/planning-atelier', planningAtelierRouter)
// TRM production orders (Gestion des OF) — consumed by the TRM web app.
app.use('/api/of-trm', ofTrmRouter)
// TRS data collector (repo C:devetsmalterreTRS) - the ONLY writer of
// evenement_machine, replacing the WinDev Data_Recorder_V2 daemon on 10.10.11.2.
// Guarded by a shared secret (RECORDER_TOKEN), not a user session.
app.use('/api/recorder', recorderRouter)
app.use('/api/visitage-trm', visitageTrmRouter)
// Atelier PWA (bonnetier + régleur, host atelier.intra.etsmalterre.com) — a SECOND TRM
// client of this API, not part of the TRM ERP web app. Its phones are
// enrolled (routes/appareils-atelier.ts) — mounted first so the more specific
// path wins over /api/atelier.
app.use('/api/atelier/appareils', appareilsAtelierRouter)
app.use('/api/atelier', atelierRouter)
// TRS wall tablet (TRM/apps/trs, host trs.intra.etsmalterre.com) — a THIRD TRM client:
// the shift TRS of every métier on the floor plan. Read-only, no identity.
app.use('/api/trs', trsRouter)
// Pointage tablet (TRM/apps/pointage, host pointage.intra.etsmalterre.com) — a FOURTH
// client: the shared time clock, on the legacy `pointage` database. Enrolled
// tablet only, under its own `mps_pointeuse` cookie (routes/pointage.ts).
app.use('/api/pointage', pointageRouter)
// Admin Pointage — the office's side of the same time clock, from the TRM ERP
// menu « Pointage » (cookie session + view_pointage / edit_pointage).
app.use('/api/pointage-admin', pointageAdminRouter)
// TRM tableau de bord widgets (Poids des pièces, …) — consumed by the TRM web app.
app.use('/api/dashboard-trm', dashboardTrmRouter)
// TRM production prime (Production › Prime) — consumed by the TRM web app.
app.use('/api/prime-trm', primeTrmRouter)
// TRM machine upkeep (Atelier > Maintenance) — consumed by the TRM web app.
app.use('/api/maintenance-trm', maintenanceTrmRouter)
// TRM client returns (Qualité › Retour client) — the receiving end of an ETM
// FNC, answered here and republished onto the dossier. Consumed by the TRM web app.
app.use('/api/retours-client-trm', retoursClientTrmRouter)
// Agents IA (menu Agents IA) — the BL MATEL agent and its successors, lib/agents/.
app.use('/api/agents-ia', agentsIaRouter)
// The website (etsmalterre.fr customer space + QR sample page) — replaces the
// WinDev webservice MPS_WS. PUBLIC through Caddy (alpha.etsmalterre.com →
// /api/site/*): read-only documents + the catalogue-request form only.
app.use('/api/site', webserviceSiteRouter)

app.listen(PORT, () => {
  console.log(`MPS API running on port ${PORT} [${env}]`)
  // The daily pointage report + weekly balance emails (production only).
  demarrerRapportsPointage()
  // The Agents IA mailbox polls (production only).
  demarrerAgents()
})

// Grouped rolls (LIVA #1149) need `stock_fini_source`, declared in the WinDev
// analysis and pushed to the server. Probe once at start and say so: while it
// is missing every reader behaves as before and « Fusionner » is disabled.
probeFiniSourceTable()
  .then((ok) => {
    if (ok) console.log(`[fini-sources] ${FINI_SOURCE_TABLE} available — grouped rolls enabled`)
    else console.warn(`[fini-sources] ${FINI_SOURCE_TABLE} missing on this HFSQL server — grouped rolls disabled until the analysis declares it`)
  })
  .catch((err) => console.error('[fini-sources] probe failed:', err instanceof Error ? err.message : err))

async function shutdown() {
  await closeConnection()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
