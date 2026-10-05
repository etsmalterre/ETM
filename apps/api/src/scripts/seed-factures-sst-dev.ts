// Seeds the DEV database with real dyer invoices read by the Factures
// Ennoblisseur agent in « actif » mode, to try Sous-traitants › Factures, the
// Notifications widget card and the agent's runs without waiting for mail.
//
//   node --env-file=.env.development --import tsx src/scripts/seed-factures-sst-dev.ts [--n=6] [--jours=200]
//
// Reads contact@ (MATEL) and pierre-emmanuel@ (Bontemps, until they mail
// contact@), stores one run per invoice in this worktree's data/agents/,
// writes facture_sst + ligne_facture_sst and the invoice numbers into
// mps_dev. Refuses any database whose name does not end in _dev.
import { listerMessages, lireMessage, lirePieceJointe } from '../lib/gmail-reader.js'
import { closeMpsPg } from '../lib/mps-pg.js'
import { closeConnection } from '../lib/hfsql-auto.js'
import { traiterPdfs, FACTURES_SST_SLUG, FACTURES_SST_VERSION_INITIALE } from '../lib/agents/factures-sst/agent.js'
import { estFactureCandidate } from '../lib/agents/factures-sst/extraction.js'
import { lireEtat, versionActive } from '../lib/agents/store.js'

const db = new URL(process.env.PG_CONNECTION_STRING ?? 'x://x/none').pathname.replace(/^\//, '')
if (!/_dev$/.test(db)) {
  console.error(`Refusé : la base ${db} n'est pas une base de dev.`)
  process.exit(1)
}
const opt = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d)
const n = opt('n', 6)
const jours = opt('jours', 200)

const version = versionActive(await lireEtat(FACTURES_SST_SLUG, FACTURES_SST_VERSION_INITIALE))
const sources: Array<[string, string, number]> = [
  ['contact@etsmalterre.com', `from:mateltextiles.fr has:attachment filename:facture newer_than:${jours}d`, n],
  ['pierre-emmanuel@etsmalterre.com', `from:bontempsennoblissement.fr has:attachment filename:facture newer_than:${jours}d`, 1],
]
for (const [boite, q, max] of sources) {
  for (const id of await listerMessages(boite, q, max)) {
    const m = await lireMessage(boite, id)
    const pdfs = await Promise.all(m.piecesJointes.filter(estFactureCandidate).map(async (p) => ({ nom: p.nom, contenu: await lirePieceJointe(boite, id, p.attachmentId) })))
    if (!pdfs.length) continue
    const runs = await traiterPdfs(pdfs, {
      mode: 'actif', version, source: 'manuel', lancePar: { id: 0, nom: 'Seed dev' },
      message: { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date },
    })
    for (const r of runs) console.log(`${r.statut.padEnd(13)} ${r.resume}`)
  }
}
await closeMpsPg()
await closeConnection()
process.exit(0)
