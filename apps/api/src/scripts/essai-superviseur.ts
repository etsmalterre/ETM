// Dry run of the Superviseur's checks: prints what each one finds. Never
// touches the findings memory, never mails, SELECT only.
//
//   npx tsx src/scripts/essai-superviseur.ts                 # dev database (.env.development)
//   npx tsx src/scripts/essai-superviseur.ts --env=<file>    # another database, e.g. the prod
//        .env.production of the main checkout (read-only: every check is SELECT-only)
//   npx tsx src/scripts/essai-superviseur.ts --only=couverture,fil_a_commander
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
const { SUPERVISEUR_VERSION_INITIALE } = await import('../lib/agents/superviseur/superviseur.js')
const only = arg('only')?.split(',')
const nowMs = Date.now()
let total = 0
let coutUsd = 0
// The code's initial prompt — not the stored active version (this script has no store).
const ctx = { nowMs, version: { version: 0, ...SUPERVISEUR_VERSION_INITIALE }, cout: (usd: number) => { coutUsd += usd || 0 } }
for (const c of CONTROLES.filter((x) => !only || only.includes(x.id))) {
  const t = Date.now()
  try {
    const cs = await c.executer(ctx)
    total += cs.length
    console.log(`\n■ ${c.libelle} (${c.id}) — ${cs.length} point(s), ${Date.now() - t} ms`)
    for (const x of cs) console.log(`  [${x.gravite}] ${x.titre}\n      ${x.message}${x.lien ? `\n      → ${x.lien}` : ''}`)
  } catch (err) {
    console.log(`\n■ ${c.libelle} (${c.id}) — ERREUR : ${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log(`\nTotal : ${total} point(s) · coût IA ${(coutUsd * 1000).toFixed(1)} m$.`)
process.exit(0)
