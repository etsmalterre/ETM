// Replay of the Triage agent on the mails contact@ received — nothing is
// written: no run stored, no Gmail label, no hand-off (trierMessage with
// `simulation`, mode essai). Prints one line per mail and the count per
// category, and writes a Markdown table to review (--out).
//
//   node --env-file=.env.development --import tsx src/scripts/replay-triage.ts [--jours=14] [--n=300] [--out=triage-replay.md] [--version=N]
//
// Costs one mistral-small call per mail (~0,0005 $).
import * as fs from 'node:fs'
import { listerTousMessages } from '../lib/gmail-reader.js'
import { trierMessage, resultatTriage, TRIAGE_BOITE, TRIAGE_SLUG, TRIAGE_VERSION_INITIALE } from '../lib/agents/triage/agent.js'
import { categorie } from '../lib/agents/triage/categories.js'
import { lireEtat, versionActive } from '../lib/agents/store.js'
import { closeMpsPg } from '../lib/mps-pg.js'

const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const jours = Number(opt('jours', '14'))
const n = Number(opt('n', '300'))
const out = opt('out', '')

const state = await lireEtat(TRIAGE_SLUG, TRIAGE_VERSION_INITIALE)
const v = Number(opt('version', '0'))
const version = v ? state.versions.find((x) => x.version === v) ?? versionActive(state) : versionActive(state)
const ids = (await listerTousMessages(TRIAGE_BOITE, `newer_than:${jours}d -in:sent -in:drafts -in:chats -in:spam -in:trash`, n)).reverse()
console.log(`${ids.length} mails, version ${version.version} (${version.model})`)

const parCat = new Map<string, number>()
const lignes: string[] = []
let cout = 0
let erreurs = 0
for (const x of ids) {
  try {
    const r = await trierMessage(x.id, x.threadId, { mode: 'essai', version, source: 'essai_manuel', lancePar: null, simulation: true })
    const res = resultatTriage(r)
    cout += r.coutUsd
    for (const c of res.categories) parCat.set(c, (parCat.get(c) ?? 0) + 1)
    const cats = res.categories.map((c) => `${categorie(c)?.libelle ?? c}${res.sousCategories[c] ? ` (${res.sousCategories[c]})` : ''}`).join(' + ')
    const org = res.expediteur.organisation ? `${res.expediteur.organisation.nom}` : '—'
    console.log(`${r.message!.date.slice(5, 16)} | ${res.expediteur.adresse.padEnd(36).slice(0, 36)} | ${r.message!.sujet.slice(0, 50).padEnd(50)} | ${cats}`)
    const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
    lignes.push(`| ${r.message!.date.slice(0, 16).replace('T', ' ')} | ${cell(res.expediteur.adresse)} | ${cell(org)} | ${cell(r.message!.sujet).slice(0, 80)} | **${cell(cats)}** | ${cell(res.raison)} |`)
  } catch (err) {
    erreurs++
    console.log(`ERREUR ${x.id}: ${err instanceof Error ? err.message : err}`)
  }
}
console.log('\nPar catégorie :')
for (const [c, k] of [...parCat].sort((a, b) => b[1] - a[1])) console.log(`  ${(categorie(c)?.libelle ?? c).padEnd(24)} ${k}`)
console.log(`\n${ids.length - erreurs} triés, ${erreurs} erreurs, coût ${cout.toFixed(4)} $`)
if (out) {
  fs.writeFileSync(out, [
    `# Replay Triage — ${ids.length} mails de ${TRIAGE_BOITE} (${jours} jours), version ${version.version}`,
    '',
    ...[...parCat].sort((a, b) => b[1] - a[1]).map(([c, k]) => `- ${categorie(c)?.libelle ?? c} : ${k}`),
    '',
    '| Reçu | De | Connu comme | Objet | Catégories | Raison |',
    '|---|---|---|---|---|---|',
    ...lignes,
  ].join('\n'))
  console.log(`→ ${out}`)
}
await closeMpsPg()
