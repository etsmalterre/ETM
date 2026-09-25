// Dry run of the Superviseur's checks: prints what each one finds. Never
// touches the findings memory, never mails, SELECT only.
//
//   npx tsx src/scripts/essai-superviseur.ts                 # dev database (.env.development)
//   npx tsx src/scripts/essai-superviseur.ts --env=<file>    # another database, e.g. the prod
//        .env.production of the main checkout (read-only: every check is SELECT-only)
//   npx tsx src/scripts/essai-superviseur.ts --only=couverture,fil_a_commander
//   … --prompt=livre     triage with the prompt shipped with the code (promptLivre), not v1
//   … --raisons          also print why each object was let pass (what a closing point says)
//
// Run it on dev first for any new check (a bad column name is a prod outage
// on Linux), then on prod to measure how often it fires before switching it on.

import * as fs from 'node:fs'
import dotenv from 'dotenv'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const envFile = arg('env')
if (envFile) {
  const m = fs.readFileSync(envFile, 'utf8').match(/^HFSQL_CONNECTION_STRING=(.*)$/m)
  if (!m) throw new Error(`HFSQL_CONNECTION_STRING absent de ${envFile}`)
  process.env.HFSQL_CONNECTION_STRING = m[1].trim().replace(/^"|"$/g, '')
}
dotenv.config({ path: '.env.development' }) // never overrides the line above

const { CONTROLES } = await import('../lib/agents/superviseur/controles/index.js')
const { SUPERVISEUR_VERSION_INITIALE, SUPERVISEUR_PROMPT_LIVRE } = await import('../lib/agents/superviseur/superviseur.js')
const only = arg('only')?.split(',')
const nowMs = Date.now()
let total = 0
let coutUsd = 0
// The code's initial prompt — not the stored active version (this script has no store).
const livre = arg('prompt') === 'livre'
const raisons = new Map<string, string>()
// Version 0 / 99: never collides with a stored version in the triage cache.
const ctx = {
  nowMs,
  version: livre ? { version: 99, ...SUPERVISEUR_PROMPT_LIVRE } : { version: 0, ...SUPERVISEUR_VERSION_INITIALE },
  cout: (usd: number) => { coutUsd += usd || 0 },
  raison: (cle: string, t: string) => { raisons.set(cle, t) },
}
for (const c of CONTROLES.filter((x) => !only || only.includes(x.id))) {
  const t = Date.now()
  try {
    const cs = await c.executer(ctx)
    if (process.argv.includes('--raisons')) {
      for (const [k, t] of raisons) if (k.startsWith(`${c.id}:`)) console.log(`  · ${t}`)
    }
    total += cs.length
    console.log(`\n■ ${c.libelle} (${c.id}) — ${cs.length} point(s), ${Date.now() - t} ms`)
    for (const x of cs) console.log(`  [${x.gravite}] ${x.titre}\n      ${x.message}${x.lien ? `\n      → ${x.lien}` : ''}`)
  } catch (err) {
    console.log(`\n■ ${c.libelle} (${c.id}) — ERREUR : ${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log(`\nTotal : ${total} point(s) · coût IA ${(coutUsd * 1000).toFixed(1)} m$.`)
process.exit(0)
