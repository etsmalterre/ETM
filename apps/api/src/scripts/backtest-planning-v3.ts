// Backtest of « Planning atelier » v3 on the plannings already acquired
// (2026-11-27). Nothing is written. Each week of the history is planned again
// from the 8 weeks before it, as Tricobot would have, and compared with the
// week Isabelle finally kept (planning_bonnetier: her corrections included).
//
//   node --env-file=.env.development --import tsx src/scripts/backtest-planning-v3.ts --avant=<other checkout>/apps/api/src [--depuis=2026-06-28] [--entries=<file>] [--modele=<runs-planning-atelier.json>] [--fois=2]
//
// Two reports:
//   1. The facts, no model: for every week, what the code BEFORE (--avant) and
//      the code of this checkout tell the model of the pairs (held or to
//      recompose, which ones) and of each one's hours, against what was
//      planned. A fact is right, wrong, or not given (« l'historique ne dit
//      pas », or no line at all). Expected: nothing right before turns wrong,
//      and the weeks after a week with someone missing come right.
//   2. The model (--modele, the stored runs): each week Tricobot really
//      planned is asked again with v3 (prompt shipped with this checkout, its
//      facts, its checks), with the desiderata and instructions of the run.
//      Counted: the créneaux Isabelle would still have to change, next to what
//      she changed then.
//
// --entries reads the planning from a file instead of the database, one
// créneau per line « IDbonnetier|YYYY-MM-DD|HH:MM|HH:MM » (a dump of
// production when the dev copy is behind).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeConnection } from '../lib/hfsql-auto.js'
import { addDays, selectEntries } from '../lib/planning-bonnetier.js'
import { selectBonnetiers } from '../lib/production-trm.js'
import { PLANNING_ATELIER_PROMPT_LIVRE, proposer, SEMAINES_HISTORIQUE, type ResultatPlanning } from '../lib/agents/planning-atelier/agent.js'
import { ecarts, equipesDeLaSemaine, faitsDuRoulement, semaineIso, type BonnetierPlanning, type Creneau } from '../lib/agents/planning-atelier/regles.js'

const arg = (nom: string) => process.argv.find((a) => a.startsWith(`--${nom}=`))?.slice(nom.length + 3)
const avantDir = arg('avant')
if (!avantDir) {
  console.error('usage: backtest-planning-v3.ts --avant=<checkout>/apps/api/src [--depuis=YYYY-MM-DD] [--entries=<file>] [--modele=<runs.json>] [--fois=2]')
  process.exit(1)
}
const avant = (await import(pathToFileURL(path.join(avantDir, 'lib/agents/planning-atelier/regles.ts')).href)) as { faitsDuRoulement: typeof faitsDuRoulement }

const depuis = arg('depuis') ?? '2026-06-28'
const fichier = arg('entries')
const tout: Creneau[] = fichier
  ? fs.readFileSync(fichier, 'utf8').trim().split(/\r?\n/).map((l) => { const [id, date, debut, fin] = l.split('|'); return { IDbonnetier: Number(id), date, debut, fin } })
  : await selectEntries(addDays(depuis, -7 * SEMAINES_HISTORIQUE), '2099-12-31')
const bonnetiers: BonnetierPlanning[] = (await selectBonnetiers())
  .filter((b) => b.archive === 0 && b.regleur === 0)
  .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'))
  .map((b) => ({ id: b.id, prenom: b.prenom, nom: b.nom }))

const S = (dim: string) => `S${semaineIso(dim)}`
const semaineDe = (dim: string) => tout.filter((e) => e.date >= dim && e.date <= addDays(dim, 6))
const histoDe = (dim: string) => tout.filter((e) => e.date >= addDays(dim, -7 * SEMAINES_HISTORIQUE) && e.date < dim)
const dimanchesDe = (dim: string) => Array.from({ length: SEMAINES_HISTORIQUE }, (_, i) => addDays(dim, 7 * (i - SEMAINES_HISTORIQUE)))
const cle = (groupes: string[][]) => groupes.map((g) => [...g].sort().join('+')).sort().join(' / ')

// ── 1. The facts ─────────────────────────────────────────

interface Lu { recomposer: boolean; binomes: string | null; horaires: Map<string, string>; indecis: number }

/** What a version's facts say, read from their text (the same reading for both codes). */
function lire(lignes: readonly string[]): Lu {
  const b = lignes.find((l) => l.startsWith('Binômes ') && l.includes('ensemble depuis'))
  const recomposer = !!b?.includes('à recomposer')
  const prio = lignes.find((l) => l.includes('à former en priorité'))
  const noms = recomposer ? prio?.slice(prio.indexOf(': ') + 2).replace(/\.$/, '').replace(/ \(S\d+\)/g, '') : b?.slice('Binômes '.length, b.indexOf(' : ensemble'))
  const binomes = noms ? cle(noms.split(', ').map((p) => p.split(' + '))) : null
  const h = lignes.find((l) => l.startsWith('Heures de début de cette semaine')) ?? ''
  const horaires = new Map<string, string>()
  for (const m of h.matchAll(/ : (\S+) (\d\d:\d\d-\d\d:\d\d), (\S+) (\d\d:\d\d-\d\d:\d\d) \(/g)) horaires.set(m[1], m[2]).set(m[3], m[4])
  return { recomposer, binomes, horaires, indecis: (h.match(/l’historique ne dit pas/g) ?? []).length }
}

// Every planned week from `depuis` (a Sunday) to the last créneau known.
const fin = tout.reduce((m, e) => (e.date > m ? e.date : m), depuis)
const dims: string[] = []
for (let d = depuis; d <= fin; d = addDays(d, 7)) if (semaineDe(d).length > 0) dims.push(d)

console.log(`\n=== 1. Les faits, sans modèle : ${dims.length} semaines planifiées depuis ${depuis} ===`)
console.log('Par semaine : binômes annoncés (avant | v3) contre ceux d’Isabelle, puis heures justes / fausses / non données sur les personnes planifiées.\n')
const total = { avant: { binOk: 0, binFaux: 0, hOk: 0, hFaux: 0, hRien: 0 }, v3: { binOk: 0, binFaux: 0, hOk: 0, hFaux: 0, hRien: 0 } }
for (const dim of dims) {
  const reel = equipesDeLaSemaine(semaineDe(dim), bonnetiers)
  const reelBinomes = cle(reel.map((g) => g.membres.map((m) => m.prenom)))
  const reelHoraires = new Map(reel.flatMap((g) => g.membres.map((m) => [m.prenom, m.horaire] as const)))
  const histo = histoDe(dim)
  if (histo.length === 0) continue
  const col = (qui: 'avant' | 'v3', lignes: string[]) => {
    const l = lire(lignes)
    const t = total[qui]
    const binOk = l.binomes === reelBinomes
    if (binOk) t.binOk++; else t.binFaux++
    let ok = 0, faux = 0, rien = 0
    for (const [p, h] of reelHoraires) {
      const dit = l.horaires.get(p)
      if (!dit) rien++
      else if (dit === h) ok++
      else faux++
    }
    t.hOk += ok; t.hFaux += faux; t.hRien += rien
    return `${l.recomposer ? 'recompose' : 'garde    '} ${binOk ? 'binômes ok  ' : 'binômes FAUX'} heures ${ok} ok / ${faux} fausses / ${rien} non données`
  }
  console.log(`${S(dim).padEnd(4)} ${dim}  avant : ${col('avant', avant.faitsDuRoulement(histo, bonnetiers, dimanchesDe(dim)))}`)
  console.log(`${' '.repeat(16)} v3    : ${col('v3', faitsDuRoulement(histo, bonnetiers, dimanchesDe(dim)))}   (réel : ${reelBinomes})`)
}
for (const qui of ['avant', 'v3'] as const) {
  const t = total[qui]
  console.log(`\nTOTAL ${qui.padEnd(5)} : binômes ${t.binOk} justes / ${t.binFaux} faux · heures ${t.hOk} justes / ${t.hFaux} fausses / ${t.hRien} non données`)
}

// ── 2. The model ─────────────────────────────────────────

const runsFile = arg('modele')
if (runsFile) {
  const fois = Number(arg('fois') ?? 2)
  interface RunLu { id: string; version: number; statut: string; resultat: ResultatPlanning; evaluation?: { note: string; corrections?: string[] } | null }
  const runs = (JSON.parse(fs.readFileSync(runsFile, 'utf8')) as RunLu[]).filter((r) => r.statut === 'ecrit')
  // The last run of each week is the one Isabelle validated.
  const parSemaine = new Map(runs.map((r) => [r.resultat.semaine, r]))
  console.log(`\n=== 2. Le modèle : ${parSemaine.size} semaines rejouées ${fois} fois avec la v3 (${PLANNING_ATELIER_PROMPT_LIVRE.model}) ===\n`)
  const compte = { usd: 0 }
  for (const [dim, run] of parSemaine) {
    const reel = semaineDe(dim)
    const alors = run.evaluation ? (run.evaluation.corrections?.length ?? 0) : null
    console.log(`${S(dim)} (v${run.version} alors : ${alors === null ? 'non validée' : alors === 0 ? 'réussite' : `échec, ${alors} créneaux changés`})${run.resultat.instructions ? ` · consignes : « ${run.resultat.instructions} »` : ''}`)
    for (let i = 0; i < fois; i++) {
      try {
        const v = await proposer({ dimanche: dim, bonnetiers: run.resultat.bonnetiers, histo: histoDe(dim), desiderata: run.resultat.desiderata, instructions: run.resultat.instructions, version: PLANNING_ATELIER_PROMPT_LIVRE, compte })
        const e = ecarts(v.creneaux, reel, run.resultat.bonnetiers)
        console.log(`   v3 essai ${i + 1} : ${e.length === 0 ? 'la semaine d’Isabelle, rien à changer' : `${e.length} créneaux à changer`}${v.relances.length ? ` · renvoyé une fois (${v.relances.length} point${v.relances.length > 1 ? 's' : ''})` : ''}`)
        for (const l of v.relances) console.log(`        renvoi : ${l}`)
        for (const l of e.slice(0, 6)) console.log(`        ${l}`)
        if (e.length > 6) console.log(`        … et ${e.length - 6} autres`)
        for (const a of v.attention) console.log(`        attention : ${a}`)
      } catch (err) {
        console.log(`   v3 essai ${i + 1} : erreur ${err instanceof Error ? err.message : err}`)
      }
    }
  }
  console.log(`\nCoût des appels : ${compte.usd.toFixed(4)} $`)
}

await closeConnection()
