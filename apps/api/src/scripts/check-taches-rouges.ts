// Guard for the red families of the notification centre (lib/taches/sources.ts).
//
//   npx tsx --env-file=.env.development src/scripts/check-taches-rouges.ts           read only
//   npx tsx --env-file=.env.development src/scripts/check-taches-rouges.ts --write   also write the register
//
// For each family: runs its relevé, times it, and counts as problems a key
// that is not unique, an empty title or reason (a red card always prints the
// Malterre action, mps_designer §41), a link that is not a path of the web app.
// With --write it then syncs the register twice and checks that `depuis` did
// not move between the two (a task keeps its day while it stays red).

import { SOURCES_ROUGES } from '../lib/taches/sources.js'
import { lireTaches, synchroniser } from '../lib/taches/registre.js'
import { closeMpsPg } from '../lib/mps-pg.js'

const ecrire = process.argv.includes('--write')
let problemes = 0
const probleme = (msg: string) => { problemes++; console.log(`  ⚠️  ${msg}`) }

for (const source of SOURCES_ROUGES) {
  const debut = Date.now()
  let relevees
  try {
    relevees = await source.relever()
  } catch (err) {
    probleme(`${source.cle}: relevé impossible : ${err instanceof Error ? err.message : err}`)
    continue
  }
  console.log(`${source.cle.padEnd(18)} ${String(relevees.length).padStart(4)} rouge(s)  ${Date.now() - debut} ms`)
  const cles = new Set<string>()
  for (const t of relevees) {
    if (cles.has(t.cle)) probleme(`${source.cle}: clé en double ${t.cle}`)
    cles.add(t.cle)
    if (!t.titre.trim()) probleme(`${source.cle}:${t.cle} sans titre`)
    if (!t.raison.trim()) probleme(`${source.cle}:${t.cle} sans raison`)
    if (t.lien !== null && !/^\/[a-z-]+/.test(t.lien)) probleme(`${source.cle}:${t.cle} lien inattendu ${t.lien}`)
  }
  for (const t of relevees.slice(0, 3)) console.log(`    ${t.titre} : ${t.raison}`)

  if (ecrire) {
    await synchroniser(source.cle, relevees)
    const avant = new Map((await lireTaches([source.cle])).map((t) => [t.cle, t.depuis]))
    await synchroniser(source.cle, relevees)
    const apres = await lireTaches([source.cle])
    if (apres.length !== cles.size) probleme(`${source.cle}: registre ${apres.length} ligne(s) pour ${cles.size} rouge(s)`)
    for (const t of apres) if (avant.get(t.cle) !== t.depuis) probleme(`${source.cle}:${t.cle} « depuis » a bougé`)
  }
}

await closeMpsPg()
console.log(problemes === 0 ? '\nOK' : `\n${problemes} problème(s)`)
process.exit(problemes === 0 ? 0 : 1)
