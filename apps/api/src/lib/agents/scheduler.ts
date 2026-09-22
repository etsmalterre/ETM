// « Agents IA » — the in-process timer, same shape as the pointage reports
// (lib/rapports-pointage-envoi.ts): no cron, no systemd unit, it ships with
// /etm_deploy.
//
// ⚠️ Only the production API polls (NODE_ENV=production), so a dev or worktree
// API never reads contact@ nor writes a BL twice. AGENTS_IA=off disables it in
// production too; AGENTS_IA=on forces it anywhere (tests only). A manual
// « Relever maintenant » from the screen works in any environment — in dev it
// reads the real mailbox, so keep the agent in « essai » there.
//
// One lock per agent shared by the tick and the manual run: two polls of the
// same agent never overlap (they would process the same mail twice).

import { AGENTS, agentDef } from './catalog.js'
import { lireEtat, versionActive, type AgentRun, type Auteur } from './store.js'
import { gmailLectureErreur } from '../gmail-reader.js'

const INTERVALLE_MS = 2 * 60_000

export interface EtatSondage {
  dernierSondage: string | null
  dernierSucces: string | null
  derniereErreur: string | null
  enCours: boolean
}

const etats = new Map<string, EtatSondage>()
const enCours = new Set<string>()

export function etatSondage(slug: string): EtatSondage {
  return { ...(etats.get(slug) ?? { dernierSondage: null, dernierSucces: null, derniereErreur: null }), enCours: enCours.has(slug) }
}

export class SondageEnCoursError extends Error {
  constructor() {
    super('Une lecture de la boîte mail est déjà en cours.')
  }
}

/** Poll one agent's mailbox now. Throws SondageEnCoursError when already running. */
export async function sonder(slug: string, par: Auteur | null): Promise<AgentRun[]> {
  const def = agentDef(slug)
  if (!def) throw new Error(`agent inconnu : ${slug}`)
  if (enCours.has(slug)) throw new SondageEnCoursError()
  enCours.add(slug)
  const e: EtatSondage = etats.get(slug) ?? { dernierSondage: null, dernierSucces: null, derniereErreur: null, enCours: false }
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

async function tick(): Promise<void> {
  for (const def of AGENTS) {
    try {
      const state = await lireEtat(def.slug, def.versionInitiale)
      if (state.mode === 'off' || enCours.has(def.slug)) continue
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
  setInterval(() => void tick(), INTERVALLE_MS).unref()
}
