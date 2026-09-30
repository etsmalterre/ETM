// Agents IA › Automates — JSON-file store, beside the agents' (same plumbing,
// lib/agents/json-store.ts). Layout:
//   data/automates/state.json          one entry per automate slug
//   data/automates/runs-<slug>.json    the runs worth keeping, newest last
//
// An automate has no prompt and no model: its version is the CODE version
// (catalog.ts), shipped with /etm_deploy. Feedback is free text per version
// (« Retours »), read to write the next one — never a score.
//
// ⚠️ An hourly automate would write 8 760 runs a year: a run is kept only when
// it matters (execution.ts `aGarder`); every run, kept or not, updates
// `dernierControle` so the screen shows the automate is alive.

import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { exclusive, readJson, writeJson } from '../agents/json-store.js'
import type { AgentMode, Auteur } from '../agents/store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTOMATES_DIR = path.resolve(__dirname, '../../../data/automates')
const STATE_FILE = path.join(AUTOMATES_DIR, 'state.json')
const runsFile = (slug: string) => path.join(AUTOMATES_DIR, `runs-${slug.replace(/[^a-z0-9-]/g, '')}.json`)

/** Oldest runs dropped beyond this (errors every hour for weeks stay bounded). */
const RUNS_MAX = 3000

export type AutomateMode = AgentMode

/** applique = written to the device (a report: sent); simule = essai, would have written;
 *  inchange = nothing to change; erreur = the run failed (device, DB…). */
export type AutomateStatut = 'applique' | 'simule' | 'inchange' | 'erreur'

export interface Controle {
  le: string
  statut: AutomateStatut
  resume: string
}

export interface Retour {
  id: string
  version: number
  texte: string
  par: Auteur
  le: string
}

export interface AutomateState {
  mode: AutomateMode
  modeChangedAt: string | null
  modeChangedBy: Auteur | null
  dernierePlanification?: string | null
  /** The last run, kept or not. */
  dernierControle?: Controle | null
  retours: Retour[]
}

export interface AutomateRun {
  id: string
  slug: string
  createdAt: string
  /** planifie = the hourly tick; manuel = « Lancer maintenant »; arret = leaving « actif ». */
  source: 'planifie' | 'manuel' | 'arret'
  lancePar: Auteur | null
  /** The automate's mode when it ran (essai never writes). */
  mode: AutomateMode
  version: number
  statut: AutomateStatut
  resume: string
  dureeMs: number
  erreur?: string
  /** Identifies the proposal (essai kept once per distinct proposal). */
  empreinte?: string
  /** Free-form per automate (Vidéosurveillance: planning read, target, per-camera before/after, snapshot). */
  resultat: Record<string, unknown>
}

const etatVide = (): AutomateState => ({ mode: 'off', modeChangedAt: null, modeChangedBy: null, dernierControle: null, retours: [] })

/** What an automate starts from before its first stored state (catalog.ts
 *  `etatInitial`): an automate that takes over a job already running in
 *  production (the pointage reports) starts « actif » with the old timer's
 *  last day instead of « off » — else the job would silently stop at deploy. */
const initiaux = new Map<string, () => Partial<AutomateState>>()

export function declarerEtatInitial(slug: string, init: () => Partial<AutomateState>): void {
  initiaux.set(slug, init)
}

const depart = (slug: string, stocke: AutomateState | undefined): AutomateState =>
  stocke ? { ...etatVide(), ...stocke } : { ...etatVide(), ...initiaux.get(slug)?.() }

export async function lireEtat(slug: string): Promise<AutomateState> {
  const all = await readJson<Record<string, AutomateState>>(STATE_FILE, {})
  return depart(slug, all[slug])
}

function modifierEtat(slug: string, fn: (s: AutomateState) => void): Promise<AutomateState> {
  return exclusive(async () => {
    const all = await readJson<Record<string, AutomateState>>(STATE_FILE, {})
    const s = depart(slug, all[slug])
    fn(s)
    all[slug] = s
    await writeJson(STATE_FILE, all)
    return s
  })
}

export function changerMode(slug: string, mode: AutomateMode, par: Auteur): Promise<AutomateState> {
  return modifierEtat(slug, (s) => {
    if (s.mode === mode) return
    s.mode = mode
    s.modeChangedAt = new Date().toISOString()
    s.modeChangedBy = par
  })
}

export function marquerPlanification(slug: string, jour: string): Promise<AutomateState> {
  return modifierEtat(slug, (s) => {
    s.dernierePlanification = jour
  })
}

export function noterControle(slug: string, c: Controle): Promise<AutomateState> {
  return modifierEtat(slug, (s) => {
    s.dernierControle = c
  })
}

export const nouvelId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

export function ajouterRetour(slug: string, r: Omit<Retour, 'id' | 'le'>): Promise<Retour> {
  const retour: Retour = { ...r, id: nouvelId(), le: new Date().toISOString() }
  return modifierEtat(slug, (s) => {
    s.retours.push(retour)
  }).then(() => retour)
}

/** Removes a feedback line; only its author may (false otherwise, or when unknown). */
export async function supprimerRetour(slug: string, id: string, par: Auteur): Promise<boolean> {
  let ok = false
  await modifierEtat(slug, (s) => {
    const i = s.retours.findIndex((r) => r.id === id && r.par.id === par.id)
    if (i >= 0) {
      s.retours.splice(i, 1)
      ok = true
    }
  })
  return ok
}

export function lireRuns(slug: string): Promise<AutomateRun[]> {
  return readJson<AutomateRun[]>(runsFile(slug), [])
}

export async function lireRun(slug: string, id: string): Promise<AutomateRun | null> {
  return (await lireRuns(slug)).find((r) => r.id === id) ?? null
}

export function ajouterRun(run: AutomateRun): Promise<void> {
  return exclusive(async () => {
    const runs = await readJson<AutomateRun[]>(runsFile(run.slug), [])
    runs.push(run)
    await writeJson(runsFile(run.slug), runs.slice(-RUNS_MAX))
  })
}
