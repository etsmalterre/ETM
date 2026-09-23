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
//   - `quotidien`: once a day at `heure` (Paris) on `jours`; the day is written
//     in state.json BEFORE the run (at most once a day even if the process dies
//     mid-run; after a restart later the same day it catches up).
//
// One lock per agent shared by the tick and the manual run: two runs of the
// same agent never overlap (they would process the same mail twice).

import { AGENTS, agentDef, type Declenchement } from './catalog.js'
import { lireEtat, marquerPlanification, nouvelIdRun, versionActive, type AgentRun, type Auteur } from './store.js'
import { gmailLectureErreur } from '../gmail-reader.js'
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
  runs: Array<Pick<AgentRun, 'id' | 'statut' | 'resume'>>
  erreur: string | null
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
const enCours = new Set<string>()

const etatVide = (): EtatSondage => ({ dernierSondage: null, dernierSucces: null, derniereErreur: null, dernierLancement: null, enCours: false })

export function etatSondage(slug: string): EtatSondage {
  return { ...(etats.get(slug) ?? etatVide()), enCours: enCours.has(slug) }
}

export class SondageEnCoursError extends Error {
  constructor() {
    super('Une exécution de cet agent est déjà en cours.')
  }
}

/** Run one agent now. Throws SondageEnCoursError when already running. */
export async function sonder(slug: string, par: Auteur | null): Promise<AgentRun[]> {
  const def = agentDef(slug)
  if (!def) throw new Error(`agent inconnu : ${slug}`)
  if (enCours.has(slug)) throw new SondageEnCoursError()
  enCours.add(slug)
  const e: EtatSondage = etats.get(slug) ?? etatVide()
  e.dernierSondage = new Date().toISOString()
  etats.set(slug, e)
  try {
    const state = await lireEtat(slug, def.versionInitiale)
    const runs = await def.sonder(state, versionActive(state), par)
    e.dernierSucces = new Date().toISOString()
    e.derniereErreur = null
    if (runs.length) console.log(`[agents] ${slug}: ${runs.length} run(s) — ${runs.map((r) => r.statut).join(', ')}`)
    return runs
  } catch (err) {
    e.derniereErreur = gmailLectureErreur(err)
    throw err
  } finally {
    enCours.delete(slug)
  }
}

/** Start one agent now in the background and return at once — the outcome
 *  lands in `etatSondage(slug).dernierLancement`. Throws SondageEnCoursError
 *  (synchronously) when already running. */
export function lancerSondage(slug: string, par: Auteur): Lancement {
  if (!agentDef(slug)) throw new Error(`agent inconnu : ${slug}`)
  if (enCours.has(slug)) throw new SondageEnCoursError()
  const e = etats.get(slug) ?? etatVide()
  etats.set(slug, e)
  const l: Lancement = { id: nouvelIdRun(), debut: new Date().toISOString(), fin: null, runs: [], erreur: null }
  e.dernierLancement = l
  sonder(slug, par)
    .then(
      (runs) => {
        l.runs = runs.map((r) => ({ id: r.id, statut: r.statut, resume: r.resume }))
      },
      (err) => {
        l.erreur = gmailLectureErreur(err)
        console.error(`[agents] ${slug}: manual launch failed:`, l.erreur)
      },
    )
    .then(() => {
      l.fin = new Date().toISOString()
    })
  return l
}

/** Is a daily agent due at `nowMs` (Paris), given the day of its last scheduled run? */
export function quotidienDu(d: Extract<Declenchement, { type: 'quotidien' }>, nowMs: number, dernierJour: string | null | undefined): boolean {
  const t = partiesParis(nowMs)
  const jourSemaine = new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay() || 7
  return d.jours.includes(jourSemaine) && t.h >= d.heure && dernierJour !== jourParis(nowMs)
}

/** Next scheduled run of a daily agent, as an ISO instant (for the screen). */
export function prochainQuotidien(d: Extract<Declenchement, { type: 'quotidien' }>, nowMs: number, dernierJour: string | null | undefined): string | null {
  for (let i = 0; i < 8; i++) {
    const t = partiesParis(nowMs + i * 86_400_000)
    const jourSemaine = new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay() || 7
    if (!d.jours.includes(jourSemaine)) continue
    const jour = jourParis(nowMs + i * 86_400_000)
    if (i === 0 && dernierJour === jour) continue
    // Today and already past the hour: due now (the next tick picks it up).
    if (i === 0 && t.h >= d.heure) return new Date(nowMs).toISOString()
    return new Date(msHeureParis(t.y, t.mo, t.d, d.heure)).toISOString()
  }
  return null
}

const dernierReleve = new Map<string, number>()

async function tick(): Promise<void> {
  const now = Date.now()
  for (const def of AGENTS) {
    try {
      const state = await lireEtat(def.slug, def.versionInitiale)
      if (state.mode === 'off' || enCours.has(def.slug)) continue
      const d = def.declenchement
      if (d.type === 'releve') {
        if (now - (dernierReleve.get(def.slug) ?? 0) < d.intervalleMs - 5_000) continue
        dernierReleve.set(def.slug, now)
      } else {
        if (!quotidienDu(d, now, state.dernierePlanification)) continue
        // Journal first: at most once a day, even if the process dies mid-run.
        await marquerPlanification(def.slug, def.versionInitiale, jourParis(now))
      }
      await sonder(def.slug, null)
    } catch (err) {
      if (!(err instanceof SondageEnCoursError)) console.error(`[agents] ${def.slug} tick failed:`, gmailLectureErreur(err))
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
