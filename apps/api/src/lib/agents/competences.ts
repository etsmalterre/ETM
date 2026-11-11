// Skills (« compétences »), supervision and autonomy of an AI agent — the pure
// rules of claude_doc/agents_autonomie.md (decided with Vincent 2026-11-05).
//
// An agent has skills (Flux Ennoblisseur: BL, Délais, Contrôles), each with its
// own mode and its own three measures:
//   - Fiabilité   when it acts alone, is it right?
//   - Autonomie   does it act without asking?
//   - Discernement when it asks, was it worth asking?
// A new skill always starts « supervisé »: it writes, a person validates every
// execution. « Autonomie X % / N » draws, on each block of N executions, X %
// done alone — at random, and a doubt always wins over the draw.
//
// No I/O here: store.ts keeps the state, each skill feeds its points.

// ── Modes ────────────────────────────────────────────────

export type ModeCompetence = 'off' | 'essai' | 'supervise' | 'autonomie'
export const MODES_COMPETENCE: readonly ModeCompetence[] = ['off', 'essai', 'supervise', 'autonomie']

export const LIBELLE_MODE: Record<ModeCompetence, string> = {
  off: 'Arrêt',
  essai: 'Observation',
  supervise: 'Supervisé',
  autonomie: 'Autonome',
}

/** The steps offered by « proposer de monter » (doctrine §5). */
export const PALIERS_AUTONOMIE = [10, 25, 50, 75] as const
export const FENETRE_DEFAUT = 10

export interface EtatCompetence {
  mode: ModeCompetence
  /** The autonomy cycle: share of executions done alone, 1..99 (%). Kept outside « autonomie » (2026-11-05). */
  taux?: number
  /** The autonomy cycle: block size the share is drawn on. Kept outside « autonomie ». */
  fenetre?: number
  /** What is left of the current block, true = done alone (drawn at random). */
  tirage?: boolean[]
  changeLe?: string | null
  changePar?: { id: number; nom: string } | null
}

/** A skill's mode as a label: « Autonome 10 % / 10 exécutions ». */
export function libelleEtat(e: Pick<EtatCompetence, 'mode' | 'taux' | 'fenetre'>): string {
  if (e.mode !== 'autonomie') return LIBELLE_MODE[e.mode]
  return `Autonome ${e.taux ?? 0} % / ${e.fenetre ?? FENETRE_DEFAUT} exécutions`
}

/** A fresh block of `fenetre` slots, round(taux × fenetre) of them alone, shuffled. */
export function nouveauBloc(taux: number, fenetre: number, rng: () => number = Math.random): boolean[] {
  const n = Math.max(1, Math.round(fenetre))
  const seuls = Math.min(n, Math.max(0, Math.round((taux / 100) * n)))
  const bloc = Array.from({ length: n }, (_, i) => i < seuls)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[bloc[i], bloc[j]] = [bloc[j], bloc[i]]
  }
  return bloc
}

/** The next draw of a skill in « autonomie »: whether this execution is done
 *  alone, and the state left. Supervisé / essai / off: never alone. Pure. */
export function tirer(e: EtatCompetence, rng: () => number = Math.random): { seul: boolean; etat: EtatCompetence } {
  if (e.mode !== 'autonomie') return { seul: false, etat: e }
  const bloc = e.tirage?.length ? [...e.tirage] : nouveauBloc(e.taux ?? 0, e.fenetre ?? FENETRE_DEFAUT, rng)
  const seul = bloc.shift() ?? false
  return { seul, etat: { ...e, tirage: bloc } }
}

// ── Points and measures ──────────────────────────────────

/** What the agent decided on one point (doctrine §3). */
export type Decision = 'saisie' | 'rien' | 'aide'

/** Where the point stands once written:
 *  a_revoir   supervisé, waits for a person;
 *  autonome   done alone, nobody has to look (still correctable);
 *  validee / corrigee / supprimee   a person judged a saisie or a « rien »;
 *  omission   a « rien » a person said was wrong (something was in the mail);
 *  resolue    an aide a person settled;
 *  observation  recorded in « observation » (mode essai), invisible, waiting for the
 *             value a person types to be compared with (then validee / corrigee / resolue). */
export type StatutPoint = 'a_revoir' | 'autonome' | 'validee' | 'corrigee' | 'supprimee' | 'omission' | 'resolue' | 'observation'

export interface PointMesure {
  decision: Decision
  statut: StatutPoint
  /** Aide: the value the agent proposed (null = none) and the one the person kept. */
  proposition?: string | null
  valeurFinale?: string | null
  /** Aide: the person's answer to « Tu as bien fait de me demander ? »
   *  (null / absent: not asked — then read from the value kept, the rule before 2026-11-05). */
  douteJustifie?: boolean | null
  /** For « dernières N » and the descent alert. */
  le: string
  /** Written alone (mode autonomie, drawn) — the descent alert reads it. */
  autonome?: boolean
  /** Recorded in observation: judged by comparison, never by a person's gesture. */
  observation?: boolean
}

export interface Ratio {
  num: number
  den: number
  /** num / den, null while den = 0. */
  taux: number | null
}

export interface Mesures {
  fiabilite: Ratio
  autonomie: Ratio
  discernement: Ratio
  /** Points waiting for a person (supervisé saisies, « rien », aides). */
  aRevoir: number
  /** Points done alone that nobody judged (never counted as a réussite). */
  nonRevus: number
  /** Observation points still waiting for a person's value to be compared with. */
  enObservation: number
  /** Points judged by comparing with what a person typed (observation), among the judged ones. */
  compares: number
  total: number
}

const ratio = (num: number, den: number): Ratio => ({ num, den, taux: den ? num / den : null })

const JUGE_OK: ReadonlySet<StatutPoint> = new Set(['validee'])
const JUGE_KO: ReadonlySet<StatutPoint> = new Set(['corrigee', 'supprimee', 'omission'])

/** True when a person judged this saisie / « rien » (fiabilité's denominator). */
export const estJuge = (p: Pick<PointMesure, 'decision' | 'statut'>) =>
  p.decision !== 'aide' && (JUGE_OK.has(p.statut) || JUGE_KO.has(p.statut))

/** An aide settled on the value the agent proposed = the doubt was not needed. */
export function aideInutile(p: Pick<PointMesure, 'proposition' | 'valeurFinale'>): boolean {
  const a = (p.proposition ?? '').trim()
  return !!a && a === (p.valeurFinale ?? '').trim()
}

/** The three measures over a skill's points (doctrine §4). Pure. */
export function mesurer(points: readonly PointMesure[]): Mesures {
  let fOk = 0, fDen = 0, agit = 0, dOk = 0, dDen = 0, aRevoir = 0, nonRevus = 0, enObservation = 0, compares = 0
  for (const p of points) {
    if (p.decision !== 'aide') agit++
    if (p.statut === 'a_revoir') aRevoir++
    if (p.statut === 'autonome') nonRevus++
    if (p.statut === 'observation') enObservation++
    else if (p.observation) compares++
    if (estJuge(p)) {
      fDen++
      if (JUGE_OK.has(p.statut)) fOk++
    }
    if (p.decision === 'aide' && p.statut === 'resolue') {
      dDen++
      // The person said whether asking was right; else (older points) the value kept tells.
      if (p.douteJustifie != null ? p.douteJustifie : !aideInutile(p)) dOk++
    }
  }
  return {
    fiabilite: ratio(fOk, fDen),
    autonomie: ratio(agit, points.length),
    discernement: ratio(dOk, dDen),
    aRevoir,
    nonRevus,
    enObservation,
    compares,
    total: points.length,
  }
}

/** What one execution brings to a measure: its points counted for it, against
 *  it, and still waiting for a person. */
export interface Apport { plus: number; moins: number; attente: number }

export interface ApportMesures { fiabilite: Apport; autonomie: Apport; discernement: Apport }

/** The three measures read on the points of ONE execution (Agents IA ›
 *  Exécutions, Vincent 2026-11-11): the same rules as `mesurer`, kept per point.
 *  Observation (Vincent 2026-11-11, doctrine §2): the fiabilité is the agreement
 *  with what a person typed, and the autonomie what it WOULD have done (acted or
 *  asked: a fact it records either way). No discernement there: nobody is asked,
 *  and whether asking was right is the answer of the person asked. Pure. */
export function apportMesures(points: readonly PointMesure[]): ApportMesures {
  const vide = (): Apport => ({ plus: 0, moins: 0, attente: 0 })
  const a: ApportMesures = { fiabilite: vide(), autonomie: vide(), discernement: vide() }
  for (const p of points) {
    if (p.decision !== 'aide') {
      if (JUGE_OK.has(p.statut)) a.fiabilite.plus++
      else if (JUGE_KO.has(p.statut)) a.fiabilite.moins++
      else a.fiabilite.attente++
    }
    if (p.decision !== 'aide') { a.autonomie.plus++; continue }
    a.autonomie.moins++
    if (p.observation) continue
    if (p.statut !== 'resolue') a.discernement.attente++
    else if (p.douteJustifie != null ? p.douteJustifie : !aideInutile(p)) a.discernement.plus++
    else a.discernement.moins++
  }
  return a
}

// ── Up / down (doctrine §5) ──────────────────────────────

export const MONTEE_MIN_JUGES = 30
export const MONTEE_FIABILITE = 0.95
/** From observation to supervisé: the agreement with what people typed (doctrine §5). */
export const MONTEE_OBSERVATION = 0.9

export interface Conseil {
  /** The next step, when the criterion is met. */
  monter: { mode: ModeCompetence; taux?: number; texte: string } | null
  /** An autonomous point judged wrong since the last mode change. */
  descendre: string | null
  /** What the criterion says right now, one line. */
  critere: string
}

/** The step after the current one, null at the top (or for a skill that stops at supervisé). */
export function crantSuivant(e: Pick<EtatCompetence, 'mode' | 'taux'>, modes: readonly ModeCompetence[]): { mode: ModeCompetence; taux?: number } | null {
  if (e.mode === 'off' || e.mode === 'essai') return modes.includes('supervise') ? { mode: 'supervise' } : null
  if (!modes.includes('autonomie')) return null
  if (e.mode === 'supervise') return { mode: 'autonomie', taux: PALIERS_AUTONOMIE[0] }
  const suivant = PALIERS_AUTONOMIE.find((t) => t > (e.taux ?? 0))
  return suivant ? { mode: 'autonomie', taux: suivant } : null
}

/** Whether to propose going up or down. Points in any order. Pure. */
export function conseiller(e: EtatCompetence, modes: readonly ModeCompetence[], points: readonly PointMesure[]): Conseil {
  const juges = points.filter(estJuge).sort((a, b) => a.le.localeCompare(b.le))
  const derniers = juges.slice(-MONTEE_MIN_JUGES)
  const f = derniers.length ? derniers.filter((p) => p.statut === 'validee').length / derniers.length : null
  const pct = (x: number) => `${Math.round(x * 100)} %`
  const critere = juges.length < MONTEE_MIN_JUGES
    ? `${juges.length} point${juges.length > 1 ? 's' : ''} jugé${juges.length > 1 ? 's' : ''} sur ${MONTEE_MIN_JUGES} avant de pouvoir monter d’un cran`
    : `Fiabilité ${pct(f!)} sur les ${MONTEE_MIN_JUGES} derniers points jugés (${pct(e.mode === 'essai' ? MONTEE_OBSERVATION : MONTEE_FIABILITE)} demandés)`
  const suivant = crantSuivant(e, modes)
  // In observation the bar is the agreement with what people typed (90 %); above, 95 % of judged points.
  const seuil = e.mode === 'essai' ? MONTEE_OBSERVATION : MONTEE_FIABILITE
  const pret = e.mode !== 'off' && juges.length >= MONTEE_MIN_JUGES && f !== null && f >= seuil
  const monter = suivant && pret
    ? { ...suivant, texte: suivant.mode === 'autonomie' ? `Passer en autonome ${suivant.taux} %` : 'Passer en supervisé' }
    : null
  const depuis = e.changeLe ?? ''
  const rate = points.find((p) => p.autonome && JUGE_KO.has(p.statut) && p.le >= depuis)
  return {
    monter,
    descendre: rate && e.mode === 'autonomie' ? 'Un point fait seul a été corrigé depuis le passage en autonome : redescendre d’un cran ?' : null,
    critere,
  }
}
