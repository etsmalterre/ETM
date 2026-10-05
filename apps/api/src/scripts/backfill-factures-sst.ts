// One-off backfill: runs the Factures Ennoblisseur agent (LIVA #1255) over the
// dyers' invoice mails of the last N days, in « actif » — the regular poll
// only reads mail received since the agent was started.
//
//   cd /home/debian/mps_api
//   node --env-file=.env --import tsx src/scripts/backfill-factures-sst.ts [--jours=365]          # lists the mails
//   node --env-file=.env --import tsx src/scripts/backfill-factures-sst.ts [--jours=365] --write  # processes them
//
// Same pipeline as the poll (traiterPdfs): one run per invoice in
// data/agents/, the invoice stored once in facture_sst (a second copy of the
// same number → « déjà enregistrée »), its number written on the sst lines.
// Reads contact@ (the agent's mailbox) AND pierre-emmanuel@ (Bontemps mails
// him since 12/2025). Mails some run already handled are skipped, so a rerun
// only picks up what is left. Oldest first. Sends no email.
import { listerMessages, lireMessage, lirePieceJointe } from '../lib/gmail-reader.js'
import { closeMpsPg } from '../lib/mps-pg.js'
import { closeConnection } from '../lib/hfsql-auto.js'
import { contactsEnnoblisseurs } from '../lib/agents/bl-ennoblisseur-db.js'
import { requeteExpediteurs, sousTraitantExpediteur, termesExpediteurs } from '../lib/agents/bl-profils.js'
import { traiterPdfs, FACTURES_SST_BOITE, FACTURES_SST_SLUG, FACTURES_SST_VERSION_INITIALE } from '../lib/agents/factures-sst/agent.js'
import { estFactureCandidate } from '../lib/agents/factures-sst/extraction.js'
import { lireEtat, messagesTraites, versionActive } from '../lib/agents/store.js'

const write = process.argv.includes('--write')
const jours = Number(process.argv.find((a) => a.startsWith('--jours='))?.split('=')[1] ?? 365)
const BOITES = [FACTURES_SST_BOITE, 'pierre-emmanuel@etsmalterre.com']

const version = versionActive(await lireEtat(FACTURES_SST_SLUG, FACTURES_SST_VERSION_INITIALE))
const cs = await contactsEnnoblisseurs()
const termes = termesExpediteurs(cs.map((c) => c.mail))
const q = `${requeteExpediteurs(termes)} has:attachment (filename:facture OR filename:fa OR subject:facture) newer_than:${jours}d`
const deja = await messagesTraites(FACTURES_SST_SLUG)

let total = 0
for (const boite of BOITES) {
  const ids = (await listerMessages(boite, q, 500)).filter((id) => !deja.has(id)).reverse()
  console.log(`${boite}: ${ids.length} mail(s) to read (${jours} days)`)
  for (const id of ids) {
    const m = await lireMessage(boite, id)
    const pjs = m.piecesJointes.filter(estFactureCandidate)
    if (!write) {
      console.log(`  ${m.date}  ${m.de}  « ${m.sujet} »  ${pjs.map((p) => p.nom).join(', ') || '(no invoice PDF)'}`)
      continue
    }
    if (!pjs.length) continue
    const pdfs = await Promise.all(pjs.map(async (p) => ({ nom: p.nom, contenu: await lirePieceJointe(boite, id, p.attachmentId) })))
    const runs = await traiterPdfs(pdfs, {
      mode: 'actif', version, source: 'gmail', lancePar: { id: 0, nom: 'Reprise 365 jours' },
      message: { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date },
      sousTraitantExpediteur: sousTraitantExpediteur(m.de, cs),
    })
    deja.add(id)
    for (const r of runs) console.log(`  ${r.statut.padEnd(13)} ${r.resume}`)
    total += runs.length
  }
}
console.log(write ? `Done: ${total} run(s).` : 'Dry run — re-run with --write to process.')
await closeMpsPg()
await closeConnection()
process.exit(0)
