// « Agents IA » — JSON-file store for agent state, prompt versions and runs.
//
// ⚠️ Like permissions.json / notifications.json, this lives in apps/api/data/
// (gitignored, next to the running API) until the PostgreSQL cutover gives it
// real tables. Layout:
//   data/agents/state.json          one entry per agent slug (mode, versions)
//   data/agents/runs-<slug>.json    every run of that agent, newest last
//   data/agents/fichiers/<run>-<n>.pdf   the attachments a run read
//
// Model borrowed from MFProd's Agents IA (tables ai_agent /
// ai_agent_prompt_version / ai_*_run):
//   - a version (prompt + model) is IMMUTABLE; editing publishes a new one and
//     a rollback only re-points `activeVersion`;
//   - `startedAt` is stamped the first time the agent leaves « off » and never
//     reset: the mailbox is only read from that instant (no historical backfill).
//
// Writes are serialised through one in-process queue (a single API process
// runs the agents — see scheduler.ts) and land through tmp + rename.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const AGENTS_DIR = path.resolve(__dirname, '../../../data/agents')
const STATE_FILE = path.join(AGENTS_DIR, 'state.json')
const FICHIERS_DIR = path.join(AGENTS_DIR, 'fichiers')

/** off = nothing runs; essai = reads the mailbox and extracts, writes NOTHING
 *  (shadow run next to n8n); actif = writes HFSQL and labels the mail. */
export type AgentMode = 'off' | 'essai' | 'actif'
export const AGENT_MODES: readonly AgentMode[] = ['off', 'essai', 'actif']

export interface Auteur {
  id: number
  nom: string
}

export interface AgentVersion {
  version: number
  model: string
  prompt: string
  note: string
  createdBy: Auteur | null
  createdAt: string
}

export interface AgentState {
  mode: AgentMode
  startedAt: string | null
  activeVersion: number
  versions: AgentVersion[]
  modeChangedAt: string | null
  modeChangedBy: Auteur | null
}

// ── Runs ─────────────────────────────────────────────────

export type RunStatut =
  | 'ecrit' // written to HFSQL
  | 'simule' // mode essai: everything passed, would have been written
  | 'a_verifier' // a blocking check failed: a human must look
  | 'deja_importe' // every piece already in data_bl_tricotbot with the same values
  | 'ignore' // nothing to read (no PDF attachment)
  | 'erreur' // an exception (API down, HFSQL…)

export type RunSource = 'gmail' | 'essai_manuel' | 'retraitement'

export interface RunFichier {
  nom: string
  /** File name under data/agents/fichiers/. */
  fichier: string
  taille: number
}

export interface RunVerdict {
  valeur: 'correct' | 'incorrect'
  commentaire: string
  par: Auteur
  le: string
}

export interface AgentRun {
  id: string
  slug: string
  createdAt: string
  source: RunSource
  /** The agent mode when the run happened (essai runs never write). */
  mode: AgentMode
  /** Run this one re-processes (retraitement). */
  retraiteDe?: string
  lancePar?: Auteur | null
  message?: { id: string; threadId: string; de: string; sujet: string; date: string } | null
  fichiers: RunFichier[]
  version: number
  model: string
  statut: RunStatut
  /** Free-form per agent (for BL MATEL: OCR text, extraction, resolution, checks, write). */
  resultat: Record<string, unknown>
  resume: string
  coutUsd: number
  dureeMs: number
  erreur?: string
  verdict?: RunVerdict | null
}

// ── Plumbing ─────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve()
/** Serialise every read-modify-write of the store. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8')
  await fs.rename(tmp, file)
}

const runsFile = (slug: string) => path.join(AGENTS_DIR, `runs-${slug.replace(/[^a-z0-9-]/g, '')}.json`)

// ── State ────────────────────────────────────────────────

export interface VersionInitiale {
  model: string
  prompt: string
  note: string
}

/** State of an agent, seeded (mode off, version 1) the first time it is read. */
export async function lireEtat(slug: string, initiale: VersionInitiale): Promise<AgentState> {
  const all = await readJson<Record<string, AgentState>>(STATE_FILE, {})
  return all[slug] ?? {
    mode: 'off',
    startedAt: null,
    activeVersion: 1,
    versions: [{ version: 1, ...initiale, createdBy: null, createdAt: new Date(0).toISOString() }],
    modeChangedAt: null,
    modeChangedBy: null,
  }
}

async function modifierEtat(slug: string, initiale: VersionInitiale, fn: (s: AgentState) => void): Promise<AgentState> {
  return exclusive(async () => {
    const all = await readJson<Record<string, AgentState>>(STATE_FILE, {})
    const s = all[slug] ?? (await lireEtat(slug, initiale))
    fn(s)
    all[slug] = s
    await writeJson(STATE_FILE, all)
    return s
  })
}

export function versionActive(s: AgentState): AgentVersion {
  return s.versions.find((v) => v.version === s.activeVersion) ?? s.versions[s.versions.length - 1]
}

export function changerMode(slug: string, initiale: VersionInitiale, mode: AgentMode, par: Auteur): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    if (s.mode === mode) return
    s.mode = mode
    s.modeChangedAt = new Date().toISOString()
    s.modeChangedBy = par
    if (mode !== 'off' && !s.startedAt) s.startedAt = s.modeChangedAt
  })
}

export function publierVersion(
  slug: string,
  initiale: VersionInitiale,
  v: { model: string; prompt: string; note: string },
  par: Auteur,
): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    const version = Math.max(...s.versions.map((x) => x.version)) + 1
    s.versions.push({ version, ...v, createdBy: par, createdAt: new Date().toISOString() })
    s.activeVersion = version
  })
}

export function activerVersion(slug: string, initiale: VersionInitiale, version: number): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    if (!s.versions.some((v) => v.version === version)) throw new Error(`version ${version} inconnue`)
    s.activeVersion = version
  })
}

// ── Runs ─────────────────────────────────────────────────

export const nouvelIdRun = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

export async function lireRuns(slug: string): Promise<AgentRun[]> {
  return readJson<AgentRun[]>(runsFile(slug), [])
}

export async function lireRun(slug: string, id: string): Promise<AgentRun | null> {
  return (await lireRuns(slug)).find((r) => r.id === id) ?? null
}

export function ajouterRun(run: AgentRun): Promise<void> {
  return exclusive(async () => {
    const runs = await readJson<AgentRun[]>(runsFile(run.slug), [])
    runs.push(run)
    await writeJson(runsFile(run.slug), runs)
  })
}

export function modifierRun(slug: string, id: string, fn: (r: AgentRun) => void): Promise<AgentRun | null> {
  return exclusive(async () => {
    const runs = await readJson<AgentRun[]>(runsFile(slug), [])
    const r = runs.find((x) => x.id === id)
    if (!r) return null
    fn(r)
    await writeJson(runsFile(slug), runs)
    return r
  })
}

/** Gmail message ids some run already handled (whatever its outcome). */
export async function messagesTraites(slug: string): Promise<Set<string>> {
  return new Set((await lireRuns(slug)).map((r) => r.message?.id).filter((x): x is string => !!x))
}

// ── Attachments ──────────────────────────────────────────

export async function enregistrerFichier(runId: string, n: number, contenu: Buffer): Promise<string> {
  const nom = `${runId}-${n}.pdf`
  await fs.mkdir(FICHIERS_DIR, { recursive: true })
  await fs.writeFile(path.join(FICHIERS_DIR, nom), contenu)
  return nom
}

export async function lireFichier(nom: string): Promise<Buffer | null> {
  if (!/^[a-z0-9-]+\.pdf$/.test(nom)) return null
  try {
    return await fs.readFile(path.join(FICHIERS_DIR, nom))
  } catch {
    return null
  }
}
