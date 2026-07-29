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
import { tarifsFiniRouter } from './routes/tarifs-fini.js'
import { stockDiversRouter } from './routes/stock-divers.js'
import { commandesFilRouter } from './routes/commandes-fil.js'
import { commandesSousTraitantRouter } from './routes/commandes-sous-traitant.js'
import { commandesClientRouter } from './routes/commandes-client.js'
import { facturesRouter } from './routes/factures.js'
import { devisRouter } from './routes/devis.js'
import { expeditionsRouter } from './routes/expeditions.js'
import { transfertsRouter } from './routes/transferts.js'
import { clientsRouter } from './routes/clients.js'
import { sousTraitantsRouter } from './routes/sous-traitants.js'
import { etudesColorisRouter } from './routes/etudes-coloris.js'
import { prospectsRouter } from './routes/prospects.js'
import { stockRouter } from './routes/stock.js'
import { stockFiniRouter } from './routes/stock-fini.js'
import { stockEcruRouter } from './routes/stock-ecru.js'
import { suiviLotsRouter } from './routes/suivi-lots.js'
import { dossiersQualiteRouter } from './routes/dossiers-qualite.js'
import { actionsQualiteRouter } from './routes/actions-qualite.js'
import { rapportsRouter } from './routes/rapports.js'
import { planningAtelierRouter } from './routes/planning-atelier.js'
import { authRouter } from './routes/auth.js'
import { ticketsRouter } from './routes/tickets.js'
import { permissionsRouter } from './routes/permissions.js'
import { notificationsRouter } from './routes/notifications.js'
import { userEmailsRouter } from './routes/user-emails.js'
import { userProfilesRouter } from './routes/user-profiles.js'
import { query } from './lib/hfsql-auto.js'
import { attachUser } from './lib/auth.js'
import { closeConnection } from './lib/hfsql-auto.js'

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
app.use('/api/permissions', permissionsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/user-emails', userEmailsRouter)
app.use('/api/user-profiles', userProfilesRouter)
app.use('/api/entreprises', entreprisesRouter)
app.use('/api/fournisseurs', fournisseursRouter)
app.use('/api/references-fil', referencesFilRouter)
app.use('/api/references-fini', referencesFiniRouter)
app.use('/api/references-ecru', referencesEcruRouter)
app.use('/api/references-divers', referencesDiversRouter)
app.use('/api/tarifs-fini', tarifsFiniRouter)
app.use('/api/stock-divers', stockDiversRouter)
app.use('/api/commandes-fil', commandesFilRouter)
app.use('/api/commandes-sous-traitant', commandesSousTraitantRouter)
app.use('/api/commandes-client', commandesClientRouter)
app.use('/api/factures', facturesRouter)
app.use('/api/devis', devisRouter)
app.use('/api/expeditions', expeditionsRouter)
app.use('/api/transferts', transfertsRouter)
app.use('/api/clients', clientsRouter)
app.use('/api/sous-traitants', sousTraitantsRouter)
app.use('/api/etudes-coloris', etudesColorisRouter)
app.use('/api/prospects', prospectsRouter)
app.use('/api/stock', stockRouter)
app.use('/api/stock', stockFiniRouter)
app.use('/api/stock', stockEcruRouter)
app.use('/api/suivi-lots', suiviLotsRouter)
app.use('/api/dossiers-qualite', dossiersQualiteRouter)
app.use('/api/actions-qualite', actionsQualiteRouter)
app.use('/api/rapports', rapportsRouter)
// TRM atelier planning — consumed by the MPS-TRM web app (C:\dev\etsmalterre\MPS-TRM)
app.use('/api/planning-atelier', planningAtelierRouter)

app.listen(PORT, () => {
  console.log(`MPS API running on port ${PORT} [${env}]`)
})

async function shutdown() {
  await closeConnection()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
