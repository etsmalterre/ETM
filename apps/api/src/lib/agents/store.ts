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
import { tirer, type EtatCompetence, type ModeCompetence } from './competences.js'

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
  /** Each skill's mode and autonomy draw (AgentDef.competences, competences.ts),
   *  absent = the skill's default mode. */
  competences?: Record<string, EtatCompetence>
  /** The prompt versions of each skill that has its own prompt (Flux
   *  Ennoblisseur › Délais, Contrôles; doctrine §0 « le modèle lit »). Absent =
   *  the skill's shipped versions (CompetenceDef.versionsLivrees). The agent's
   *  own `versions` stay the first skill's (the BL). */
  promptsCompetences?: Record<string, PromptsCompetence>
}

export interface PromptsCompetence {
  activeVersion: number
  versions: AgentVersion[]
}

// ── Runs ─────────────────────────────────────────────────

export type RunStatut =
  | 'ecrit' // written to HFSQL
  | 'simule' // mode essai: everything passed, would have been written
  | 'a_verifier' // a blocking check failed: a human must look
  | 'verifie' // was à vérifier / erreur, a pilot checked it (AgentRun.verification keeps the original)
  | 'deja_importe' // every piece already in data_bl_tricotbot with the same values
  | 'ignore' // nothing to read (no PDF attachment)
  | 'erreur' // an exception (API down, HFSQL…)
  // Triage (a mail of contact@ given its categories, handed to the agents behind them):
  | 'trie'
  // Superviseur (a nightly report read in Agents IA):
  | 'points_a_voir' // the report lists at least one point
  | 'rien_a_signaler' // nothing to look at
  // Superviseur until 2026-09-23, when it still mailed its report — history only:
  | 'mail_envoye'

/** « triage »: a mail the Triage agent handed over (lib/agents/triage/). */
/** « triage »: a mail the Triage agent handed over (lib/agents/triage/). */
/** 'observation': a reply to the Point read late by the hourly pass, once a person reacted (2026-11-09). */
export type RunSource = 'gmail' | 'essai_manuel' | 'retraitement' | 'planifie' | 'manuel' | 'triage' | 'observation'

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
  /** BL: what the person changed in Tricobot's pre-fill at the réception, one
   *  line each (« 3505/14 poids 21,4 → 24,1 »). Kept apart from `commentaire`,
   *  which is only what the person wrote (2026-10-12). */
  corrections?: string[]
  /** Set when a pilot corrected the score from the run dialog (Agents IA): the
   *  score it replaced, kept so the person's original retour stays readable. */
  avant?: Omit<Evaluation, 'avant'> | null
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
  /** The skill this run exercised (AgentDef.competences). Absent = the agent's
   *  first skill (Flux Ennoblisseur: « bl », every run before 2026-11-05). */
  competence?: string
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
  /** Superviseur: « Former Tricobot › Tu pouvais aller chercher plus loin » on a
   *  point that was right: where else the agent should have looked. Not a score, never closes the
   *  point; read by the Retours tab like the other comments. */
  leconsPoints?: Record<string, Array<Pick<Evaluation, 'commentaire' | 'par' | 'le'>>>
  /** BL Ennoblisseur: what a person explained about a BL Tricobot left to them
   *  (a particularity of the dyer's document, given at the réception, LIVA
   *  #1347). Not a score: blocking was the right move; read by the Retours tab
   *  with the other lessons. */
  lecons?: Array<Pick<Evaluation, 'commentaire' | 'par' | 'le'>>
  /** Notes a pilot leaves on the run for the next version of the agent (Agents
   *  IA › run dialog). Not a score: the score stays where the work is done. */
  notesDev?: Array<Pick<Evaluation, 'commentaire' | 'par' | 'le'>>
  /** A pilot marked an « à vérifier » / « erreur » run as checked (Agents IA,
   *  2026-10-12): statut became 'verifie', the original is kept here. Not a score. */
  verification?: { statutAvant: RunStatut; commentaire: string; par: Auteur; le: string } | null
  /** BL in observation (skill in essai, 2026-11-05): how the reading compared with
   *  the rolls a person received (bl-observation.ts). Absent = not compared yet. */
  observation?: { statut: 'validee' | 'corrigee' | 'resolue'; ecarts: number; douteJustifie: boolean | null; le: string } | null
  /** Legacy — see RunVerdict. */
  verdict?: RunVerdict | null
}

/** A stored run in today's shape: a legacy verdict becomes an evaluation
 *  (correct → réussite, incorrect → échec — the échec removed nothing then). */
/** One line of a BL réception diff: a piece numero, a field, « avant → après ». */
const CORRECTION_RE = /^\d+\/[\w/+.-]*\s+\S+\s(?:(?! — ).)*\s→\s/

/** Before 2026-10-12 a BL retour stored « <comment> — <c1> ; <c2> » in one
 *  string. Split it back: the person's comment, and the field changes. A
 *  string that is not of that shape stays a comment. Pure. */
export function separerCorrections(texte: string): { commentaire: string; corrections: string[] } {
  const toutes = (s: string) => { const xs = s.split(' ; ').map((x) => x.trim()); return xs.length > 0 && xs.every((x) => CORRECTION_RE.test(x)) ? xs : null }
  const seules = toutes(texte.trim())
  if (seules) return { commentaire: '', corrections: seules }
  for (let i = texte.indexOf(' — '); i >= 0; i = texte.indexOf(' — ', i + 1)) {
    const xs = toutes(texte.slice(i + 3).trim())
    if (xs) return { commentaire: texte.slice(0, i).trim(), corrections: xs }
  }
  return { commentaire: texte, corrections: [] }
}

export function normaliserRun(r: AgentRun): AgentRun {
  // Scores stored under the old three-level scale read as binary; a BL retour
  // stored as one string gets its field changes split from the comment.
  const binaire = (e0: Evaluation): Evaluation => {
    const e = e0.corrections || !e0.commentaire.includes(' → ') ? e0 : { ...e0, ...separerCorrections(e0.commentaire) }
    const avant = e.avant && !e.avant.corrections && e.avant.commentaire.includes(' → ') ? { ...e.avant, ...separerCorrections(e.avant.commentaire) } : e.avant
    const x = avant === e.avant ? e : { ...e, avant }
    return x.note === 'reussite' || x.note === 'echec' ? x : { ...x, note: noteBinaire(x.note) }
  }
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

/** A skill's state: what a pilot set, else its default mode. */
export function etatCompetence(s: AgentState, cle: string, defaut: ModeCompetence): EtatCompetence {
  return s.competences?.[cle] ?? { mode: defaut }
}

/** A skill's mode as it runs: the agent's mode caps it. Since 2026-11-05 an
 *  agent with skills has no mode of its own (derived, below): the cap only
 *  matters for a state written before. */
export function modePlafonne(agent: AgentMode, competence: ModeCompetence): ModeCompetence {
  if (agent === 'off' || competence === 'off') return 'off'
  return agent === 'essai' ? 'essai' : competence
}

/** The agent's mode of an agent with skills, derived from them (Vincent
 *  2026-11-05, one switch per skill): « off » when every skill is off, else
 *  « actif » — each skill's own mode then decides what is written. The poll,
 *  the Triage hand-off and the scheduler read it as « is anything running ». */
export const modeDerive = (modes: readonly ModeCompetence[]): AgentMode => (modes.every((m) => m === 'off') ? 'off' : 'actif')

/** A pilot sets a skill's mode (and, for autonomie, its share and block). A
 *  new block is drawn on every change. Every skill's mode is written out as it
 *  runs (an old agent mode capping them is folded in once), then the agent's
 *  mode is derived from them; the mailbox is read from the first time a skill
 *  leaves « off ». `defauts`: each skill's mode before a pilot set one. */
export function changerModeCompetence(
  slug: string,
  initiale: VersionInitiale,
  cle: string,
  e: { mode: ModeCompetence; taux?: number; fenetre?: number },
  par: Auteur,
  defauts: Readonly<Record<string, ModeCompetence>>,
): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    const competences: Record<string, EtatCompetence> = { ...(s.competences ?? {}) }
    for (const [k, d] of Object.entries(defauts)) {
      const actuel = competences[k] ?? { mode: d }
      const m = modePlafonne(s.mode, actuel.mode)
      competences[k] = m === actuel.mode ? actuel : { mode: m }
    }
    const le = new Date().toISOString()
    const avant = competences[cle]
    // The autonomy cycle is kept whatever the mode (prepared before going autonome, 2026-11-05).
    const taux = e.taux ?? avant?.taux
    const fenetre = e.fenetre ?? avant?.fenetre
    competences[cle] = {
      mode: e.mode,
      ...(taux != null ? { taux } : {}),
      ...(fenetre != null ? { fenetre } : {}),
      changeLe: le,
      changePar: par,
    }
    s.competences = competences
    const mode = modeDerive(Object.values(competences).map((x) => x.mode))
    if (mode !== s.mode) { s.mode = mode; s.modeChangedAt = le; s.modeChangedBy = par }
    if (mode !== 'off' && !s.startedAt) s.startedAt = le
  })
}

/** The autonomy cycle of a skill (share done alone, block size), set from the
 *  side panel whatever the mode. In « autonomie », a new block is drawn. */
export function reglerCycle(slug: string, initiale: VersionInitiale, cle: string, defaut: ModeCompetence, c: { taux: number; fenetre: number }): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    const e = etatCompetence(s, cle, defaut)
    const { tirage: _tirage, ...reste } = e
    s.competences = { ...(s.competences ?? {}), [cle]: { ...reste, taux: c.taux, fenetre: c.fenetre } }
  })
}

/** Draw the next execution of a skill (competences.ts `tirer`), persisted:
 *  true = done alone. Never alone outside « autonomie ». */
export async function tirerCompetence(slug: string, initiale: VersionInitiale, cle: string, defaut: ModeCompetence): Promise<boolean> {
  let seul = false
  await modifierEtat(slug, initiale, (s) => {
    const t = tirer(etatCompetence(s, cle, defaut))
    seul = t.seul
    if (t.etat.mode === 'autonomie') s.competences = { ...(s.competences ?? {}), [cle]: t.etat }
  })
  return seul
}

// ── A skill's own prompt versions ───────────────────────

/** A skill's prompt versions as stored, else seeded from the ones it ships
 *  with (the last shipped one active). Once stored, a prompt shipped later is
 *  only offered (« prompt livré », estPublie): publishing it stays a pilot's gesture. */
export function promptsCompetence(s: AgentState, cle: string, livrees: readonly VersionInitiale[]): PromptsCompetence {
  const stocke = s.promptsCompetences?.[cle]
  if (stocke) return stocke
  const versions = livrees.map((v, i) => ({ version: i + 1, ...v, createdBy: null, createdAt: new Date(0).toISOString() }))
  return { activeVersion: versions.length, versions }
}

export function versionCompetenceActive(p: PromptsCompetence): AgentVersion {
  return p.versions.find((v) => v.version === p.activeVersion) ?? p.versions[p.versions.length - 1]
}

export function publierVersionCompetence(
  slug: string,
  initiale: VersionInitiale,
  cle: string,
  livrees: readonly VersionInitiale[],
  v: { model: string; prompt: string; note: string },
  par: Auteur,
): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    const p = promptsCompetence(s, cle, livrees)
    const version = Math.max(0, ...p.versions.map((x) => x.version)) + 1
    s.promptsCompetences = {
      ...(s.promptsCompetences ?? {}),
      [cle]: { activeVersion: version, versions: [...p.versions, { version, ...v, createdBy: par, createdAt: new Date().toISOString() }] },
    }
  })
}

export function activerVersionCompetence(slug: string, initiale: VersionInitiale, cle: string, livrees: readonly VersionInitiale[], version: number): Promise<AgentState> {
  return modifierEtat(slug, initiale, (s) => {
    const p = promptsCompetence(s, cle, livrees)
    if (!p.versions.some((v) => v.version === version)) throw new Error(`version ${version} inconnue`)
    s.promptsCompetences = { ...(s.promptsCompetences ?? {}), [cle]: { ...p, activeVersion: version } }
  })
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
