// Benchmark of « commande reçue par mail non saisie / différente » over the
// last N days: every client mail whose subject speaks of an order is read
// (Mistral OCR + extraction, cached like the check) and matched against ETM.
// Prints how many new orders were found, how they matched, the absent ones
// and the differences — the absent ones are then checked by hand: a real miss
// or a matching failure.
//
//   npx tsx src/scripts/benchmark-superviseur-commandes.ts --env=<.env.production> [--jours=60]
//
// Reads the four mailboxes (read-only), calls Mistral (cost printed), SELECT only.

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
const { chargerAnnuaire } = await import('../lib/agents/superviseur/mails.js')
const { identifierClient } = await import('../lib/agents/superviseur/reponses.js')
const { rapprocher } = await import('../lib/agents/superviseur/rapprochement.js')
const { SIGNAL_COMMANDE, extraireCommande, commandesCandidates } = await import('../lib/agents/superviseur/controles/commandes-mails.js')

const jours = Number(arg('jours') ?? 60)
const now = Date.now()
const annuaire = await chargerAnnuaire()
const tous = []
for (const b of SUPERVISEUR_BOITES) tous.push(...(await collecterEntetes(b, now - jours * 86_400_000)))
const vus = new Set<string>()
const candidats = tous.filter((m) => {
  if (m.envoye || m.automatique) return false
  const k = m.messageId || `${m.boite}:${m.id}`
  if (vus.has(k) || !identifierClient(m.de, annuaire) || !SIGNAL_COMMANDE.test(m.sujet)) return false
  vus.add(k)
  return true
})
console.log(`${tous.length} messages, ${candidats.length} candidats (client + objet « commande »).`)

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')
const cacheFile = `data/agents/benchmark-commandes-${jours}j.json`
const cache: Record<string, unknown> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}
let cout = 0
const stats: Record<string, number> = {}
const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1)
for (const m of candidats) {
  const client = identifierClient(m.de, annuaire)!
  const k = m.messageId || m.id
  let ext = cache[k] as Awaited<ReturnType<typeof extraireCommande>> | undefined
  if (!ext) {
    try {
      ext = await extraireCommande(m, SUPERVISEUR_VERSION_INITIALE.model, (u) => { cout += u })
      cache[k] = ext
      fs.writeFileSync(cacheFile, JSON.stringify(cache))
    } catch (err) {
      bump('erreur'); console.log(`  ERREUR ${client.nom} « ${m.sujet} » : ${(err as Error).message.slice(0, 100)}`); continue
    }
  }
  bump(ext.type_message)
  if (ext.type_message !== 'nouvelle_commande' || !ext.lignes.length) continue
  const r = rapprocher(ext, { dateMin: ymd(m.date - 7 * 86_400_000), dateEntree: ymd(m.date - 2 * 86_400_000) }, await commandesCandidates(client.idClient, ymd(m.date - 45 * 86_400_000), ext.numero_commande_client))
  const date = new Date(m.date).toISOString().slice(0, 10)
  const lignes = ext.lignes.map((l) => `${l.quantite ?? '?'} ${l.unite} ${l.reference_client || l.designation}`.trim()).join(' | ').slice(0, 120)
  if (r.statut === 'absente') {
    bump('absente')
    console.log(`  ABSENTE  ${date} ${client.nom} · PO « ${ext.numero_commande_client} » · « ${m.sujet.slice(0, 60)} » · ${lignes}`)
  } else {
    bump(`trouvee_par_${r.par}`)
    if (r.ecarts.length) { bump('avec_ecart'); console.log(`  ÉCART    ${date} ${client.nom} → N°${r.commande.numero} (${r.par}) : ${r.ecarts.join(' ; ')}`) }
  }
}
console.log('\n', stats, `· coût IA ${(cout * 1000).toFixed(1)} m$`)
process.exit(0)
