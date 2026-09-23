// Check that the Superviseur can read each factory mailbox (read-only scope).
// Prints counts only — never a subject or a body: these are people's mailboxes.
//
//   npx tsx src/scripts/essai-superviseur-boites.ts [boite...]
//
// Default: SUPERVISEUR_BOITES. Exit code 1 if any mailbox is unreadable.

import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` })

const { SUPERVISEUR_BOITES } = await import('../lib/agents/superviseur/superviseur.js')
const { boiteErreur, lireFil, listerFils, profil } = await import('../lib/agents/superviseur/boites.js')

const boites = process.argv.slice(2).length ? process.argv.slice(2) : [...SUPERVISEUR_BOITES]
let ko = 0
for (const b of boites) {
  try {
    const p = await profil(b)
    const recus = await listerFils(b, 'newer_than:1d -in:sent -in:chats', 500)
    const envoyes = await listerFils(b, 'newer_than:1d in:sent', 500)
    let lecture = 'aucun fil récent à lire'
    if (recus[0]) {
      const msgs = await lireFil(b, recus[0])
      lecture = `dernier fil lu : ${msgs.length} message(s), ${msgs.reduce((s, m) => s + m.texte.length, 0)} caractères de texte, ${msgs.reduce((s, m) => s + m.piecesJointes.length, 0)} pièce(s) jointe(s)`
    }
    console.log(`OK  ${p.email} — ${p.fils} fils au total · 24 h : ${recus.length} fil(s) reçu(s), ${envoyes.length} envoyé(s) · ${lecture}`)
  } catch (err) {
    ko++
    console.log(`KO  ${boiteErreur(b, err)}`)
  }
}
process.exit(ko ? 1 : 0)
