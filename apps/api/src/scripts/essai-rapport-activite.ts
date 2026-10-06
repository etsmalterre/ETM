// Agent « Rapport d'activité » — build tonight's report now, without the
// agent's mode nor its runs. Reads the journal of THIS environment's database
// and the real mailbox (read-only), calls Mistral.
//
//   npx tsx src/scripts/essai-rapport-activite.ts [--out f.html]  # writes the HTML preview
//   npx tsx src/scripts/essai-rapport-activite.ts --a vincent@etsmalterre.com   # + a « [Test] » send to that address only
import '../load-env.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { construireRapport, envoyerRapport, RAPPORT_ACTIVITE_VERSION_INITIALE } from '../lib/agents/rapport-activite/agent.js'
import { contenuEmail, sujetRapport } from '../lib/agents/rapport-activite/email.js'
import { renderNotificationEmailPreview } from '../lib/notification-email.js'
import { closeMpsPg } from '../lib/mps-pg.js'

const i = process.argv.indexOf('--a')
const a = i > 0 ? process.argv[i + 1] : null

try {
  const d = await construireRapport(RAPPORT_ACTIVITE_VERSION_INITIALE, Date.now())
  const o = process.argv.indexOf('--out')
  const sortie = path.resolve(o > 0 ? process.argv[o + 1] : 'rapport-activite-apercu.html')
  fs.writeFileSync(sortie, renderNotificationEmailPreview(contenuEmail(d.contenu)))
  console.log(sujetRapport(d.contenu))
  console.log(d.compteurs, `coût ${d.coutUsd.toFixed(4)} $`, d.contenu.iaErreur ? `IA : ${d.contenu.iaErreur}` : '')
  console.log(`Aperçu : ${sortie}`)
  if (a) console.log(await envoyerRapport(d.contenu, [a], true))
} finally {
  await closeMpsPg()
}
