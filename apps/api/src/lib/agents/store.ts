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
// Writes are serialised through one in-process queue shared with the automates
// store (json-store.ts) and land through tmp + rename.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { exclusive, readJson, writeJson } from './json-store.js'

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
  /** Daily agents: the Paris day (YYYYMMDD) of the last scheduled run, written
   *  BEFORE the run so a crash mid-run never runs it twice the same day. */
  dernierePlanification?: string | null
  /** The agent's options a pilot switched (AgentDef.options), absent = its default. */
  options?: Record<string, boolean>
}

// ── Runs ─────────────────────────────────────────────────

export type RunStatut =
  | 'ecrit' // written to HFSQL
  | 'simule' // mode essai: everything passed, would have been written
  | 'a_verifier' // a blocking check failed: a human must look
  | 'deja_importe' // every piece already in data_bl_tricotbot with the same values
  | 'ignore' // nothing to read (no PDF attachment)
  | 'erreur' // an exception (API down, HFSQL…)
  // Superviseur (a nightly report read in Agents IA):
  | 'points_a_voir' // the report lists at least one point
  | 'rien_a_signaler' // nothing to look at
  // Superviseur until 2026-09-23, when it still mailed its report — history only:
  | 'mail_envoye'

export type RunSource = 'gmail' | 'essai_manuel' | 'retraitement' | 'planifie' | 'manuel'

export interface RunFichier {
  nom: string
  /** File name under data/agents/fichiers/. */
  fichier: string
  taille: number
}

/** Tricobot's feedback on one item an agent produced (decision Vincent
 *  2026-10-02 — « partielle » dropped): « réussite » = nobody had anything to
 *  say when handling it (silence), « échec » = a person corrected it, with why —
 *  that comment is what the next prompt version is written from. Users only
 *  see « Tricobot »; the score goes to the agent behind the item. */
export type Note = 'reussite' | 'echec'
export const NOTES: readonly Note[] = ['reussite', 'echec']

/** A score as stored before 2026-10-02 may be « partielle »: a person had
 *  something to correct, so it reads as « échec » under the binary scale. */
export const noteBinaire = (n: string | null | undefined): Note => (n === 'reussite' ? 'reussite' : 'echec')

export interface Evaluation {
  note: Note
  commentaire: string
  par: Auteur
  le: string
  /** What an échec removed from ETM, in French (BL: the pre-filled pieces). */
  retrait?: string | null
}

/** Before 2026-09-23: thumbs up / down (BL) or « échouée » (Superviseur).
 *  Read as an Evaluation by normaliserRun(), never written any more. */
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
  /** Free-form per agent (for BL Ennoblisseur: OCR text, extraction, resolution, checks, write). */
  resultat: Record<string, unknown>
  resume: string
  coutUsd: number
  dureeMs: number
  erreur?: string
  /** The run's score. Absent = « à évaluer ». */
  evaluation?: Evaluation | null
  /** Superviseur: the score of each point of the report, by Constat.cle. */
  avisPoints?: Record<string, Evaluation>
  /** Superviseur: points a person marked resolved on this report, with why. */
  resolutionsPoints?: Record<string, Pick<Evaluation, 'commentaire' | 'par' | 'le'>>
  /** Legacy — see RunVerdict. */
  verdict?: RunVerdict | null
}

/** A stored run in today's shape: a legacy verdict becomes an evaluation
 *  (correct → réussite, incorrect → échec — the échec removed nothing then). */
export function normaliserRun(r: AgentRun): AgentRun {
  // Scores stored under the old three-level scale read as binary.
  const binaire = (e: Evaluation): Evaluation => (e.note === 'reussite' || e.note === 'echec' ? e : { ...e, note: noteBinaire(e.note) })
  const avisPoints = r.avisPoints
    ? Object.fromEntries(Object.entries(r.avisPoints).map(([k, e]) => [k, binaire(e)]))
    : r.avisPoints
  const base: AgentRun = { ...r, avisPoints, evaluation: r.evaluation ? binaire(r.evaluation) : r.evaluation }
  if (!base.verdict) return base
  const { verdict, ...rest } = base
  return {
    ...rest,
    evaluation: rest.evaluation ?? {
      note: verdict.valeur === 'correct' ? 'reussite' : 'echec',
      commentaire: verdict.commentaire,
      par: verdict.par,
      le: verdict.le,
      retrait: null,
    },
  }
}

// ── Plumbing ─────────────────────────────────────────────

const runsFile = (slug: string) => path.join(AGENTS_DIR, `runs-${slug.replace(/[^a-z0-9-]/g, '')}.json`)

// ── Renamed slugs ────────────────────────────────────────

/** Agents renamed after going live (old slug → new). The state entry, the
 *  runs file and each run's `slug` move once, before the store is first read —
 *  the runs carry the Gmail ids already handled, so losing them would make the
 *  agent re-read its mailbox. Keep an entry until every data/ has moved. */
const SLUGS_RENOMMES: Record<string, string> = {
  'bl-matel': 'bl-ennoblisseur', // « BL MATEL » → « BL Ennoblisseur », 2026-09-23
}

let migration: Promise<void> | null = null
/** Awaited by every entry point, OUTSIDE `exclusive()` (it queues through it). */
function migrerSlugs(): Promise<void> {
  migration ??= exclusive(async () => {
    const etat = await readJson<Record<string, AgentState>>(STATE_FILE, {})
    let etatModifie = false
    for (const [ancien, nouveau] of Object.entries(SLUGS_RENOMMES)) {
      const runs = await readJson<AgentRun[] | null>(runsFile(ancien), null)
      if (runs && (await readJson<AgentRun[] | null>(runsFile(nouveau), null)) === null) {
        for (const r of runs) r.slug = nouveau
        await writeJson(runsFile(nouveau), runs)
        await fs.rm(runsFile(ancien))
      }
      if (etat[ancien] && !etat[nouveau]) {
        etat[nouveau] = etat[ancien]
        delete etat[ancien]
        etatModifie = true
      }
    }
    if (etatModifie) await writeJson(STATE_FILE, etat)
  }).catch((err) => {
    console.error('[agents] slug migration failed:', err)
  })
  return migration
}

// ── State ────────────────────────────────────────────────

export interface VersionInitiale {
  model: string
  prompt: string
  note: string
}

/** State of an agent, seeded (mode off, version 1) the first time it is read. */
export async function lireEtat(slug: string, initiale: VersionInitiale): Promise<AgentState> {
  await migrerSlugs()
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
  await migrerSlugs()
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

export function changerOption(slug: string, initiale: VersionInitiale, cle: string, valeur: boolean): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    s.options = { ...(s.options ?? {}), [cle]: valeur }
  })
}

/** An option's value: what a pilot set, else the agent's default. */
export function optionDe(s: AgentState, cle: string, defaut: boolean): boolean {
  return s.options?.[cle] ?? defaut
}

export function marquerPlanification(slug: string, initiale: VersionInitiale, jour: string): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    s.dernierePlanification = jour
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

/** A shipped version is published once a stored version carries its prompt
 *  and its note (a behaviour change may keep the prompt, BL v2). */
export function estPublie(livre: VersionInitiale, versions: ReadonlyArray<{ prompt: string; note?: string | null }>): boolean {
  return versions.some((x) => x.prompt.trim() === livre.prompt.trim() && (x.note ?? '').trim() === livre.note.trim())
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
  await migrerSlugs()
  return (await readJson<AgentRun[]>(runsFile(slug), [])).map(normaliserRun)
}

export async function lireRun(slug: string, id: string): Promise<AgentRun | null> {
  return (await lireRuns(slug)).find((r) => r.id === id) ?? null
}

export async function ajouterRun(run: AgentRun): Promise<void> {
  await migrerSlugs()
  return exclusive(async () => {
    const runs = await readJson<AgentRun[]>(runsFile(run.slug), [])
    runs.push(run)
    await writeJson(runsFile(run.slug), runs)
  })
}

export async function modifierRun(slug: string, id: string, fn: (r: AgentRun) => void): Promise<AgentRun | null> {
  await migrerSlugs()
  return exclusive(async () => {
    // Normalised on the way through: the first write on a legacy run drops its verdict.
    const runs = (await readJson<AgentRun[]>(runsFile(slug), [])).map(normaliserRun)
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
