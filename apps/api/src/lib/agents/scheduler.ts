// « Agents IA » — the in-process timer, same shape as the pointage reports
// (lib/rapports-pointage-envoi.ts): no cron, no systemd unit, it ships with
// /etm_deploy.
//
// ⚠️ Only the production API runs agents on its own (NODE_ENV=production), so
// a dev or worktree API never reads contact@ nor writes a BL twice, nor mails
// the Superviseur report. AGENTS_IA=off disables it in production too;
// AGENTS_IA=on forces it anywhere (tests only). A manual « Relever / Lancer
// maintenant » from the screen works in any environment — in dev it reads the
// real mailbox, so keep the agents in « essai » there.
//
// One minute tick for every agent, each on its own trigger (catalog.ts):
//   - `releve`: polled every `intervalleMs` (BL Ennoblisseur, 2 min);
//   - `quotidien`: once a day at `heure` (Paris) on `jours` — or once per hour
//     when `heure` lists several (Rapport d'activité); the slot is written in
//     state.json BEFORE the run (at most once a slot even if the process dies
//     mid-run; after a restart later the same day it catches up the latest).
//
// One lock per agent shared by the tick, the manual run and the Triage's
// hand-off (verrous.ts): two runs of the same agent never overlap (they would
// process the same mail twice).
//
// The automates (lib/automates/, Agents IA › Automates) run on this same
// engine: everything below works on a « tâche » (key, trigger, state, run),
// agents are keyed by their slug, automates by `automate:<slug>` and
// registered from index.ts (enregistrerTaches) — the automates code is never
// imported here.

import { AGENTS, agentDef, type AgentDef, type Declenchement } from './catalog.js'
import { lireEtat, marquerPlanification, nouvelIdRun, versionActive, type Auteur } from './store.js'
import { gmailLectureErreur } from '../gmail-reader.js'
import { estVerrouille, prendreVerrou, rendreVerrou, SondageEnCoursError, sousVerrou } from './verrous.js'

export { SondageEnCoursError, sousVerrou }
import { jourParis, msHeureParis, partiesParis } from '../pointage-etat.js'

const TICK_MS = 60_000

/** A manual launch (« Relever / Lancer maintenant »). The route answers at once
 *  and the screen polls the agent until `fin` is set: the Superviseur runs past
 *  nginx's 60 s proxy timeout (504 on 2026-09-23 for a 63 s run, whose result
 *  only showed up on the next refresh). */
export interface Lancement {
  id: string
  debut: string
  fin: string | null
  runs: RunResume[]
  erreur: string | null
}

/** What a launch keeps of each run it produced. */
export interface RunResume {
  id: string
  statut: string
  resume: string
}

/** Anything the tick and « Lancer maintenant » can run: an agent or an automate. */
export interface Tache {
  cle: string
  declenchement: Declenchement
  lireEtat(): Promise<{ mode: string; dernierePlanification?: string | null }>
  marquerPlanification(jour: string): Promise<unknown>
  executer(par: Auteur | null): Promise<RunResume[]>
}

function tacheAgent(def: AgentDef): Tache {
  return {
    cle: def.slug,
    declenchement: def.declenchement,
    lireEtat: () => lireEtat(def.slug, def.versionInitiale),
    marquerPlanification: (jour) => marquerPlanification(def.slug, def.versionInitiale, jour),
    executer: async (par) => {
      const state = await lireEtat(def.slug, def.versionInitiale)
      return def.sonder(state, versionActive(state), par)
    },
  }
}

const tachesEnregistrees: Tache[] = []

/** Called once from index.ts with the automates' tâches. */
export function enregistrerTaches(taches: readonly Tache[]): void {
  for (const t of taches) if (!tachesEnregistrees.some((x) => x.cle === t.cle)) tachesEnregistrees.push(t)
}

function toutesTaches(): Tache[] {
  return [...AGENTS.map(tacheAgent), ...tachesEnregistrees]
}

function tacheOu(cle: string): Tache {
  const def = agentDef(cle)
  if (def) return tacheAgent(def)
  const t = tachesEnregistrees.find((x) => x.cle === cle)
  if (!t) throw new Error(`tâche inconnue : ${cle}`)
  return t
}

export interface EtatSondage {
  dernierSondage: string | null
  dernierSucces: string | null
  derniereErreur: string | null
  /** In memory: gone after an API restart (the screen then says so). */
  dernierLancement: Lancement | null
  enCours: boolean
}

const etats = new Map<string, EtatSondage>()

const etatVide = (): EtatSondage => ({ dernierSondage: null, dernierSucces: null, derniereErreur: null, dernierLancement: null, enCours: false })

export function etatSondage(cle: string): EtatSondage {
  return { ...(etats.get(cle) ?? etatVide()), enCours: estVerrouille(cle) }
}

/** Run one agent (by slug) or automate (by `automate:<slug>`) now. Throws
 *  SondageEnCoursError when already running. */
export async function sonder(cle: string, par: Auteur | null): Promise<RunResume[]> {
  const t = tacheOu(cle)
  prendreVerrou(cle)
  const e: EtatSondage = etats.get(cle) ?? etatVide()
  e.dernierSondage = new Date().toISOString()
  etats.set(cle, e)
  try {
    const runs = await t.executer(par)
    e.dernierSucces = new Date().toISOString()
    e.derniereErreur = null
    if (runs.length) console.log(`[agents] ${cle}: ${runs.length} run(s) — ${runs.map((r) => r.statut).join(', ')}`)
    return runs
  } catch (err) {
    e.derniereErreur = gmailLectureErreur(err)
    throw err
  } finally {
    rendreVerrou(cle)
  }
}

/** Start one tâche now in the background and return at once — the outcome
 *  lands in `etatSondage(cle).dernierLancement`. Throws SondageEnCoursError
 *  (synchronously) when already running. */
export function lancerSondage(cle: string, par: Auteur): Lancement {
  tacheOu(cle)
  if (estVerrouille(cle)) throw new SondageEnCoursError()
  const e = etats.get(cle) ?? etatVide()
  etats.set(cle, e)
  const l: Lancement = { id: nouvelIdRun(), debut: new Date().toISOString(), fin: null, runs: [], erreur: null }
  e.dernierLancement = l
  sonder(cle, par)
    .then(
      (runs) => {
        l.runs = runs.map((r) => ({ id: r.id, statut: r.statut, resume: r.resume }))
      },
      (err) => {
        l.erreur = gmailLectureErreur(err)
        console.error(`[agents] ${cle}: manual launch failed:`, l.erreur)
      },
    )
    .then(() => {
      l.fin = new Date().toISOString()
    })
  return l
}

type Quotidien = Extract<Declenchement, { type: 'quotidien' }>

const heuresDe = (d: Quotidien): number[] => (typeof d.heure === 'number' ? [d.heure] : [...d.heure].sort((a, b) => a - b))

/** The slot a daily trigger is in at `nowMs` (Paris) — the key written in
 *  `dernierePlanification` — or null before its first hour / on an off day.
 *  One hour: the day (`20260923`, the historical shape); several: day + hour
 *  (`20260923-15`). Missed slots are not replayed: a restart catches up the
 *  latest one only. */
export function creneauQuotidien(d: Quotidien, nowMs: number): string | null {
  const t = partiesParis(nowMs)
  const jourSemaine = new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay() || 7
  if (!d.jours.includes(jourSemaine)) return null
  const passees = heuresDe(d).filter((h) => h <= t.h)
  if (!passees.length) return null
  return typeof d.heure === 'number' ? jourParis(nowMs) : `${jourParis(nowMs)}-${String(passees[passees.length - 1]).padStart(2, '0')}`
}

/** Is a daily agent due at `nowMs` (Paris), given the slot of its last scheduled run? */
export function quotidienDu(d: Quotidien, nowMs: number, dernierCreneau: string | null | undefined): boolean {
  const c = creneauQuotidien(d, nowMs)
  return c !== null && c !== dernierCreneau
}

/** Next scheduled run of a daily agent, as an ISO instant (for the screen). */
export function prochainQuotidien(d: Quotidien, nowMs: number, dernierCreneau: string | null | undefined): string | null {
  // Due now (the next tick picks it up).
  if (quotidienDu(d, nowMs, dernierCreneau)) return new Date(nowMs).toISOString()
  for (let i = 0; i < 8; i++) {
    const t = partiesParis(nowMs + i * 86_400_000)
    const jourSemaine = new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay() || 7
    if (!d.jours.includes(jourSemaine)) continue
    const h = heuresDe(d).find((x) => i > 0 || x > t.h)
    if (h !== undefined) return new Date(msHeureParis(t.y, t.mo, t.d, h)).toISOString()
  }
  return null
}

const dernierReleve = new Map<string, number>()

async function tick(): Promise<void> {
  const now = Date.now()
  for (const t of toutesTaches()) {
    try {
      const state = await t.lireEtat()
      if (state.mode === 'off' || estVerrouille(t.cle)) continue
      const d = t.declenchement
      if (d.type === 'releve') {
        if (now - (dernierReleve.get(t.cle) ?? 0) < d.intervalleMs - 5_000) continue
        dernierReleve.set(t.cle, now)
      } else {
        const creneau = creneauQuotidien(d, now)
        if (creneau === null || creneau === state.dernierePlanification) continue
        // Journal first: at most once a slot, even if the process dies mid-run.
        await t.marquerPlanification(creneau)
      }
      await sonder(t.cle, null)
    } catch (err) {
      if (!(err instanceof SondageEnCoursError)) console.error(`[agents] ${t.cle} tick failed:`, gmailLectureErreur(err))
    }
  }
}

export function planificateurAgentsActif(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AGENTS_IA?.trim().toLowerCase()
  if (v === 'off') return false
  if (v === 'on') return true
  return env.NODE_ENV === 'production'
}

/** Start the tick. Called once from index.ts. */
export function demarrerAgents(): void {
  if (!planificateurAgentsActif()) {
    console.log('[agents] scheduler off (not production)')
    return
  }
  console.log('[agents] scheduler on')
  setTimeout(() => void tick(), 45_000)
  setInterval(() => void tick(), TICK_MS).unref()
}
