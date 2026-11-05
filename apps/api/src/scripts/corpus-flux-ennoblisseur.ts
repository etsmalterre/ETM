// Corpus of the dyers' mails to contact@ for the « Flux Ennoblisseur » skills
// (délais, contrôles): what they really write, before a prompt is written for
// them. READ-ONLY — lists and reads messages, never labels nor writes.
//
//   node --env-file=.env.development --import tsx src/scripts/corpus-flux-ennoblisseur.ts [--jours=60] [--max=200] [--out=<file.json>]
//
// Writes one JSON entry per mail: sender, subject, date, attachments, body
// without the quoted history. Look at it, never commit it (customer data).
import * as fs from 'node:fs'
import { contactsEnnoblisseurs } from '../lib/agents/bl-ennoblisseur-db.js'
import { requeteExpediteurs, termesExpediteurs } from '../lib/agents/bl-profils.js'
import { listerTousMessages, lireFil, sansCitation } from '../lib/gmail-reader.js'

const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d
const jours = Number(opt('jours', '60'))
const max = Number(opt('max', '200'))
const out = opt('out', 'corpus-flux-ennoblisseur.json')
const BOITE = process.env.AGENT_BL_BOITE?.trim() || 'contact@etsmalterre.com'

const contacts = await contactsEnnoblisseurs()
const termes = termesExpediteurs(contacts.map((c) => c.mail))
const q = `${requeteExpediteurs(termes)} newer_than:${jours}d`
console.log('query', q)
const ids = await listerTousMessages(BOITE, q, max)
const fils = new Set<string>()
const mails: unknown[] = []
for (const { threadId } of ids) {
  if (fils.has(threadId)) continue
  fils.add(threadId)
  for (const m of await lireFil(BOITE, threadId)) {
    if (m.envoye || !termes.some((t) => m.de.toLowerCase().includes(t.replace(/^@/, '')))) continue
    mails.push({
      id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date,
      pj: m.piecesJointes.map((p) => p.nom),
      texte: sansCitation(m.texte).slice(0, 3000),
    })
  }
}
fs.writeFileSync(out, JSON.stringify(mails, null, 2))
console.log(`${mails.length} mails → ${out}`)
process.exit(0)
