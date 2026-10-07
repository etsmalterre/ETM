// Agent « Rapport d'activité » — build a report now, without the agent's mode
// nor its runs. Reads the journal of THIS environment's database and the real
// mailbox (read-only), calls Mistral with the prompt shipped with the code.
//
//   npx tsx src/scripts/essai-rapport-activite.ts [--out f.html]  # « Lancer maintenant »: since the last slot, writes the HTML preview
//   npx tsx src/scripts/essai-rapport-activite.ts --creneau 10      # the scheduled report of today's 10:00 slot (09:00 → 10:00)
//   npx tsx src/scripts/essai-rapport-activite.ts --a vincent@etsmalterre.com   # + a « [Test] » send to that address only
import '../load-env.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { construireRapport, envoyerRapport, RAPPORT_ACTIVITE_PROMPT_LIVRE } from '../lib/agents/rapport-activite/agent.js'
import { contenuEmail, sujetRapport } from '../lib/agents/rapport-activite/email.js'
import { renderNotificationEmailPreview } from '../lib/notification-email.js'
import { msHeureParis, partiesParis } from '../lib/pointage-etat.js'
import { closeMpsPg } from '../lib/mps-pg.js'

const arg = (nom: string) => {
  const i = process.argv.indexOf(nom)
  return i > 0 ? process.argv[i + 1] : null
}
const a = arg('--a')
const creneau = arg('--creneau')

try {
  const t = partiesParis(Date.now())
  // A scheduled run fires in the first minute of its slot.
  const now = creneau ? msHeureParis(t.y, t.mo, t.d, parseInt(creneau, 10), 0, 30) : Date.now()
  const d = await construireRapport(RAPPORT_ACTIVITE_PROMPT_LIVRE, now, !!creneau)
  const sortie = path.resolve(arg('--out') ?? 'rapport-activite-apercu.html')
  fs.writeFileSync(sortie, renderNotificationEmailPreview(contenuEmail(d.contenu)))
  console.log(sujetRapport(d.contenu))
  console.log(d.compteurs, `coût ${d.coutUsd.toFixed(4)} $`, d.contenu.iaErreur ? `IA : ${d.contenu.iaErreur}` : '')
  console.log(`Aperçu : ${sortie}`)
  if (a) console.log(await envoyerRapport(d.contenu, [a], true))
} finally {
  await closeMpsPg()
}
