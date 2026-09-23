// Replay « client sans réponse » over past weekday evenings: what would the
// 19:00 mail have said? Each evening sees only the headers and the thread text
// that existed then (Mistral never sees the later answer). Prints per evening
// the findings, and whether the conversation got an answer afterwards — a
// finding answered the next morning is a legitimate but low-value alert, one
// never answered is the kind the Superviseur exists for.
//
//   npx tsx src/scripts/replay-superviseur-mails.ts --env=<.env.production> [--jours=20]
//
// Reads the four mailboxes (read-only) and calls Mistral (cost printed).
// The triage cache is keyed by message + version: an evening replayed twice
// re-uses it, but a DIFFERENT evening seeing the same message re-uses it too —
// fine, the text it saw was cut at its own evening the first time.

import * as fs from 'node:fs'
import dotenv from 'dotenv'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const envFile = arg('env')
if (envFile) {
  const m = fs.readFileSync(envFile, 'utf8').match(/^HFSQL_CONNECTION_STRING=(.*)$/m)
  if (m) process.env.HFSQL_CONNECTION_STRING = m[1].trim().replace(/^"|"$/g, '')
}
dotenv.config({ path: '.env.development' })

const { SUPERVISEUR_BOITES } = await import('../lib/agents/superviseur/boites-liste.js')
const { SUPERVISEUR_VERSION_INITIALE } = await import('../lib/agents/superviseur/superviseur.js')
const { collecterEntetes } = await import('../lib/agents/superviseur/boites.js')
const { appelleReponse, chargerAnnuaire, FENETRE_JOURS, trier } = await import('../lib/agents/superviseur/mails.js')
const { conversationsSansReponse, estInterne } = await import('../lib/agents/superviseur/reponses.js')
const { REPONSE_ATTENTION_H, evaluerAttente } = await import('../lib/agents/superviseur/controles/regles.js')

const jours = Number(arg('jours') ?? 20)
const now = Date.now()
const debut = now - (jours * 1.5 + FENETRE_JOURS + 2) * 86_400_000
const annuaire = await chargerAnnuaire()
const tous = []
for (const b of SUPERVISEUR_BOITES) tous.push(...(await collecterEntetes(b, debut)))
console.log(`${tous.length} messages lus.`)

// Past weekday evenings at 19:00 Paris (17:00 UTC in summer time).
const soirs: number[] = []
for (let d = 1; soirs.length < jours && d < jours * 2; d++) {
  const t = new Date(now - d * 86_400_000)
  t.setUTCHours(17, 0, 0, 0)
  if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) soirs.push(t.getTime())
}
soirs.reverse()

let cout = 0
let total = 0
let reponduApres = 0
const version = { version: 0, ...SUPERVISEUR_VERSION_INITIALE }
for (const soir of soirs) {
  const visibles = tous.filter((m) => m.date <= soir)
  const attente = conversationsSansReponse(visibles, annuaire, soir, soir - FENETRE_JOURS * 86_400_000)
    .filter((c) => c.heuresAttente >= REPONSE_ATTENTION_H)
  const tris = await trier(attente.map((c) => ({ cle: `${c.dernier.messageId || c.cle}@${soir}`, boite: c.dernier.boite, threadId: c.dernier.threadId })), version, soir, (u) => { cout += u })
  const lignes: string[] = []
  for (const c of attente) {
    const tri = tris.get(`${c.dernier.messageId || c.cle}@${soir}`)
    if (!tri || ('erreur' in tri) || !appelleReponse(tri)) continue
    // Answered later? Any internal message after that evening in the conversation or to that person.
    const apres = tous.find((x) => x.date > soir && (x.envoye || estInterne(x.de)) &&
      (x.references.includes(c.dernier.messageId) || x.inReplyTo === c.dernier.messageId || x.a.includes(c.dernier.de) || x.cc.includes(c.dernier.de)))
    if (apres) reponduApres++
    total++
    const suite = apres ? `répondu ${Math.max(0, Math.round((apres.date - soir) / 86_400_000))} j après` : 'JAMAIS répondu'
    lignes.push(`   [${evaluerAttente(c.heuresAttente, tri.urgence)}] ${c.client.nom} · ${Math.floor(c.heuresAttente / 24)} j · ${tri.categorie} · ${suite} — ${tri.resume.slice(0, 110)}`)
  }
  console.log(`${new Date(soir).toISOString().slice(0, 10)} : ${attente.length} en attente ≥ 24 h, ${lignes.length} signalé(s)`)
  for (const l of lignes) console.log(l)
}
console.log(`\n${soirs.length} soirs · ${total} signalements (${reponduApres} répondus ensuite) · coût IA ${(cout * 1000).toFixed(1)} m$`)
process.exit(0)
