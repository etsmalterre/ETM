// TRS — the per-métier shift computation behind the workshop tablet
// (TRM/apps/trs, host trs.malterre). Pure functions, no HFSQL: this file is
// unit-tested, and routes/trs.ts only feeds it rows.
//
// The spec is the legacy FI_TRS timeline procedure (`MAJAffichageAtelier`),
// supplied by the user on 2026-08-28 and quoted in full in
// ~/.claude/plans/trs-atelier.md §4. The tablet's own window
// (FEN_Main_App_TRS.wdw) is PCS-compressed and its `TRSEquipeEnCours` is not
// recoverable, so FI_TRS is the only place the formula exists in clear.
//
// Per métier, over the current shift bounded at "now":
//
//   temps de production  P   = time an OF is running (demarrage_prod → arret_prod
//                              or now), ∩ shift
//   temps en marche          = Σ evenement_machine `etat = 1` periods ∩ P
//   arrêts déductibles       = per machine stop started in P: min(60 s, its length)
//                              + per « Nettoyage »: 3 min (6 with lycra)
//                              + per « Début du tricotage » of a piece n° ≠ 1
//                                (= the previous piece's end): 5 min (8 with lycra)
//   arrêts « défaut »        = machine stops started in P, minus one per piece
//                              event (the stop that accompanies a cleaning or a
//                              piece end is not a defect), floored at 0
//   TRS                      = temps en marche / (P − déductibles)
//
// The TRS can exceed 100 % — that is how the legacy tablet shows 106 % or
// 115 %: the flat allowances exceed the stop actually taken. Not a bug.
//
// Three deliberate deltas from the legacy code, all documented in the plan
// (§4.2): P is the UNION of OF windows (what the code's own comment
// describes — « 2 + 3 = 5 heures » — where the code keeps a single window
// and drops the first OF); the state at shift start comes from the last
// event BEFORE the shift (a métier running the whole shift without a
// transition is at 100 %, not 0 %); every stop started in P counts as an
// arrêt (the legacy skipped the first one when the run began before P).

export type EquipeNom = 'Matin' | 'Après-Midi' | 'Nuit'

export interface Equipe {
  nom: EquipeNom
  debutMs: number
  finMs: number
}

/** The shift running at `nowMs`, with the legacy boundaries every TRM screen
 *  uses (dashboard-trm.ts `equipeAt`): 5–13 Matin, 13–21 Après-Midi, else
 *  Nuit. Nuit straddles midnight: 21:00 → 05:00 the next day. */
export function equipeCourante(nowMs: number): Equipe {
  const now = new Date(nowMs)
  const h = now.getHours()
  const at = (dayOffset: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0, 0, 0).getTime()
  if (h >= 5 && h < 13) return { nom: 'Matin', debutMs: at(0, 5), finMs: at(0, 13) }
  if (h >= 13 && h < 21) return { nom: 'Après-Midi', debutMs: at(0, 13), finMs: at(0, 21) }
  // Before 05:00 the shift began yesterday evening; after 21:00 it ends tomorrow.
  return h < 5
    ? { nom: 'Nuit', debutMs: at(-1, 21), finMs: at(0, 5) }
    : { nom: 'Nuit', debutMs: at(0, 21), finMs: at(1, 5) }
}

/** The shift before / after — the ◀ ▶ of the ERP screen (FI_TRS
 *  BTN_Precedent / BTN_Suivant: an 8 h step on the same 5 / 13 / 21 grid). */
export function equipePrecedente(e: Equipe): Equipe {
  return equipeCourante(e.debutMs - 1)
}
export function equipeSuivante(e: Equipe): Equipe {
  return equipeCourante(e.finMs)
}

/** The shift starting at an HFSQL literal ('YYYYMMDDHHMMSS', local time), or
 *  null unless the literal is exactly a shift boundary — the ERP's `?debut=`
 *  parameter must name a shift, not an arbitrary instant. */
export function equipeDepuisLiteral(lit: string): Equipe | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(lit)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  if (mi !== 0 || s !== 0 || ![5, 13, 21].includes(h)) return null
  const ms = new Date(y, mo - 1, d, h, 0, 0, 0).getTime()
  if (isNaN(ms)) return null
  const e = equipeCourante(ms)
  return e.debutMs === ms ? e : null
}

/** HFSQL DATETIME literal, 'YYYYMMDDHHMMSS' in local time — the shape every
 *  TRM route already sends (of-trm.ts, recorder.ts). */
export function toHfsqlDt(ms: number): string {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return (
    String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
}

/** One OF's production window. `finMs` null = still running. */
export interface Fenetre {
  debutMs: number
  finMs: number | null
}

export interface EvenementMachine {
  atMs: number
  etat: 0 | 1
}

export interface EvenementPiece {
  atMs: number
  type: 'nettoyage' | 'debut_piece'
  /** piece_production.numero — n° 1 is the OF launch, not a piece end. */
  numero: number
  /** The OF's yarn carries élasthanne (asso_fil_matiere.IDMatière 4 or 13). */
  lycra: boolean
}

export interface TrsEntree {
  equipe: Equipe
  nowMs: number
  /** Last known state before the shift started; null = nothing recorded ever. */
  etatInitial: 0 | 1 | null
  /** Transitions inside the shift, any order. */
  evenements: EvenementMachine[]
  fenetres: Fenetre[]
  evenementsPiece: EvenementPiece[]
}

export interface TrsResultat {
  /** P, in seconds. 0 = no OF ran during the shift so far. */
  tempsProdS: number
  tempsMarcheS: number
  deductibleS: number
  /** Arrêts « défaut » — machine stops net of piece events. */
  arrets: number
  arretsParHeure: number
  /** Ratio (1 = 100 %), null when P − déductibles ≤ 0. */
  trs: number | null
  /** Whether an OF window covers `nowMs`. */
  enProduction: boolean
}

export const FORFAIT_MIN = {
  nettoyage: { sans: 3, lycra: 6 },
  finPiece: { sans: 5, lycra: 8 },
} as const

/** Max intervention time deducted per machine stop, in seconds. */
export const INTERVENTION_MAX_S = 60

interface Periode { debutMs: number; finMs: number }

/** Clamp the OF windows to [shift start, evalEnd] and merge overlaps. */
export function fenetresProduction(fenetres: Fenetre[], debutMs: number, finMs: number): Periode[] {
  const clipped = fenetres
    .map((f) => ({ debutMs: Math.max(f.debutMs, debutMs), finMs: Math.min(f.finMs ?? finMs, finMs) }))
    .filter((p) => p.finMs > p.debutMs)
    .sort((a, b) => a.debutMs - b.debutMs)
  const out: Periode[] = []
  for (const p of clipped) {
    const last = out[out.length - 1]
    if (last && p.debutMs <= last.finMs) last.finMs = Math.max(last.finMs, p.finMs)
    else out.push({ ...p })
  }
  return out
}

function overlapS(a: Periode, windows: Periode[]): number {
  let s = 0
  for (const w of windows) {
    const d = Math.min(a.finMs, w.finMs) - Math.max(a.debutMs, w.debutMs)
    if (d > 0) s += d / 1000
  }
  return s
}

function dansFenetre(ms: number, windows: Periode[]): boolean {
  return windows.some((w) => ms >= w.debutMs && ms < w.finMs)
}

/** One period of the machine timeline inside the evaluated shift. */
export interface Segment {
  debutMs: number
  finMs: number
  etat: 0 | 1
  /** The period was opened by a recorded transition (false for the opening
   *  period, which merely carries the state inherited from before the shift). */
  ouvertParEvenement: boolean
}

/** The walk `calculerTrs` and `segmentsMachine` share, so the ERP timeline
 *  and the TRS figure can never disagree on where a period starts or ends:
 *  [shift start, first event) carries the initial state, each event opens
 *  the next period, the last runs to `min(now, shift end)`. */
function periodesMachine(e: TrsEntree): Segment[] {
  const debut = e.equipe.debutMs
  const finEval = Math.min(e.nowMs, e.equipe.finMs)
  const evts = e.evenements
    .filter((ev) => ev.atMs >= debut && ev.atMs <= finEval)
    .sort((a, b) => a.atMs - b.atMs)
  // No history at all: the legacy inferred the opening state as the inverse
  // of the first event. Keep that as the fallback; with no events either the
  // métier is treated as stopped.
  let etat: 0 | 1 = e.etatInitial ?? (evts.length > 0 ? ((1 - evts[0].etat) as 0 | 1) : 0)
  let t = debut
  let ouvertParEvenement = false
  const out: Segment[] = []
  for (const ev of evts) {
    if (ev.etat === etat) continue // duplicate state — the recorder never writes these
    out.push({ debutMs: t, finMs: ev.atMs, etat, ouvertParEvenement })
    etat = ev.etat
    t = ev.atMs
    ouvertParEvenement = true
  }
  out.push({ debutMs: t, finMs: finEval, etat, ouvertParEvenement })
  return out
}

/** The machine's marche / arrêt periods over the evaluated shift, for a
 *  timeline. Zero-length periods are dropped (an event exactly at the shift
 *  start, or at `now`). */
export function segmentsMachine(e: TrsEntree): Segment[] {
  return periodesMachine(e).filter((s) => s.finMs > s.debutMs)
}

/** What went into the deductibles — the ⓘ dialog of the ERP screen shows
 *  this breakdown so a régleur can check the figure line by line. */
export interface TrsDetail {
  /** Machine stops started inside P, and the intervention time they cost. */
  arretsDeduits: number
  arretsDeduitsS: number
  nettoyages: number
  nettoyagesS: number
  /** « Début du tricotage » of a piece n° ≠ 1 — the previous piece's end. */
  finsPiece: number
  finsPieceS: number
  /** Piece events inside the shift (each nets one arrêt), launches included. */
  evenementsPiece: number
  /** At least one piece event carried the élasthanne allowances. */
  lycra: boolean
}

export function calculerTrs(e: TrsEntree): TrsResultat & { detail: TrsDetail } {
  const debut = e.equipe.debutMs
  const finEval = Math.min(e.nowMs, e.equipe.finMs)
  const prod = fenetresProduction(e.fenetres, debut, finEval)
  const tempsProdS = prod.reduce((s, p) => s + (p.finMs - p.debutMs) / 1000, 0)
  const enProduction = e.fenetres.some(
    (f) => f.debutMs <= e.nowMs && (f.finMs === null || f.finMs > e.nowMs),
  )

  let tempsMarcheS = 0
  let deductibleS = 0
  let arrets = 0
  const detail: TrsDetail = {
    arretsDeduits: 0, arretsDeduitsS: 0,
    nettoyages: 0, nettoyagesS: 0,
    finsPiece: 0, finsPieceS: 0,
    evenementsPiece: 0, lycra: false,
  }

  for (const s of periodesMachine(e)) {
    if (s.etat === 1) {
      tempsMarcheS += overlapS(s, prod)
    } else if (s.ouvertParEvenement && dansFenetre(s.debutMs, prod)) {
      // A stop that began (as a real transition) while an OF was running.
      arrets += 1
      const d = Math.min(INTERVENTION_MAX_S, (s.finMs - s.debutMs) / 1000)
      deductibleS += d
      detail.arretsDeduits += 1
      detail.arretsDeduitsS += d
    }
  }

  // Piece events: flat allowances, and one arrêt each is not a defect.
  for (const p of e.evenementsPiece) {
    if (p.atMs < debut || p.atMs > finEval) continue
    detail.evenementsPiece += 1
    if (p.lycra) detail.lycra = true
    if (p.type === 'nettoyage') {
      const d = 60 * (p.lycra ? FORFAIT_MIN.nettoyage.lycra : FORFAIT_MIN.nettoyage.sans)
      deductibleS += d
      detail.nettoyages += 1
      detail.nettoyagesS += d
    } else if (p.numero !== 1) {
      const d = 60 * (p.lycra ? FORFAIT_MIN.finPiece.lycra : FORFAIT_MIN.finPiece.sans)
      deductibleS += d
      detail.finsPiece += 1
      detail.finsPieceS += d
    }
    arrets -= 1
  }
  if (arrets < 0) arrets = 0

  const prodMaxS = tempsProdS - deductibleS
  const trs = prodMaxS > 0 ? tempsMarcheS / prodMaxS : null
  const arretsParHeure = tempsProdS > 0 ? Math.round((arrets * 3600) / tempsProdS) : 0

  return {
    tempsProdS: Math.round(tempsProdS),
    tempsMarcheS: Math.round(tempsMarcheS),
    deductibleS: Math.round(deductibleS),
    arrets,
    arretsParHeure,
    trs,
    enProduction,
    detail: { ...detail, arretsDeduitsS: Math.round(detail.arretsDeduitsS) },
  }
}

/** The machine's state at `nowMs` and when it last changed, from the shift's
 *  events plus what preceded them. */
export function etatCourant(
  evenements: EvenementMachine[],
  initial: { etat: 0 | 1; atMs: number | null } | null,
): { etat: 0 | 1 | null; depuisMs: number | null } {
  let last: EvenementMachine | null = null
  for (const ev of evenements) if (!last || ev.atMs > last.atMs) last = ev
  if (last) return { etat: last.etat, depuisMs: last.atMs }
  if (initial) return { etat: initial.etat, depuisMs: initial.atMs }
  return { etat: null, depuisMs: null }
}

// ── Arrêts par pièce — the tablet's own `NombreArrets` ───────
//
// The tile's « arrêts » pill is NOT `TrsResultat.arrets` (that is FI_TRS's
// shift count, kept above because the deductibles ride the same walk). The
// tablet's procedure survives in the WinDev compile cache
// (FEN_Main_App_TRS.CB86C13A.wdw.wcw, read 2026-08-28) as three queries:
//   reqDernierePiece   : the OF's pieces, ORDER BY IDpiece_production DESC LIMIT 2
//   reqNombreArretTotal: COUNT evenement_machine etat = 0
//                        WHERE date_debut < DATE < date_fin of the piece
//   reqNbArretNormal   : COUNT evenement_piece of the piece
//                        WHERE evenement <> 'Début du tricotage'
//   NbArretDéfauts     = total − normal
// i.e. per PIECE, the machine stops not explained by a declared event. The
// WLanguage around them is compressed, so sum-vs-average over the 2 pieces is
// unknown. Decision (user, 2026-08-28): the AVERAGE per piece over the last
// ARRETS_PIECES = 3 FINISHED pieces of the active OF — a frequency, the same
// number on a métier doing 2 pieces a shift and one doing 5; finished pieces
// only, because an open piece has fewer stops for the sole reason that it is
// not over; inside the OF, like the legacy, because a new OF is a legitimate
// reset. No faux-arrêts filter: the tablet had none.

export const ARRETS_PIECES = 3

export interface PieceFinie {
  id: number
  debutMs: number
  finMs: number
  /** evenement_piece rows on the piece other than « Début du tricotage ». */
  evenementsNormaux: number
}

export interface ArretsParPiece {
  /** Mean « défaut » stops per piece, one decimal; null without a finished piece. */
  moyenne: number | null
  /** How many pieces the mean covers (0 … ARRETS_PIECES). */
  pieces: number
}

/** `pieces` in any order (the last ARRETS_PIECES by id are kept);
 *  `arretsMs` = the machine's stop instants (etat 0 transitions). */
export function arretsParPiece(pieces: PieceFinie[], arretsMs: number[]): ArretsParPiece {
  const dernieres = [...pieces].sort((a, b) => b.id - a.id).slice(0, ARRETS_PIECES)
  if (dernieres.length === 0) return { moyenne: null, pieces: 0 }
  let total = 0
  for (const p of dernieres) {
    const stops = arretsMs.filter((t) => t > p.debutMs && t < p.finMs).length
    total += Math.max(0, stops - p.evenementsNormaux)
  }
  return { moyenne: Math.round((total / dernieres.length) * 10) / 10, pieces: dernieres.length }
}

// ── The ERP screen (Production › TRS) — the rest of FI_TRS ───
//
// Everything below ports what FI_TRS shows AROUND the timeline, recovered
// from its compile cache (FI_TRS.B086A5CC.wdw.wcw, 2026-08-28): the four KPI
// cards of `MAJAffichageAtelier`, the bonnetier roster of `ZR_Equipe` and the
// colour thresholds of `ZR_TRS`. Pure functions over rows the route already
// loaded, so the bounds and the arithmetic are pinned by trs-trm.test.ts.

/** A piece_production row that finished inside the shift (KPI « Production »). */
export interface PieceFinieEquipe {
  id: number
  /** `piece_production.poids` — the NOMINAL weight (20 kg on 91 % of pieces),
   *  not a measurement. The legacy sums exactly this. */
  poidsNominal: number
  finMs: number
  /** `stock_ecru.date_saisie` of its roll(s), null while unvisited. */
  visiteeMs: number | null
}

/** A stock_ecru row weighed inside the shift (KPI « Visitage » / « Second choix »). */
export interface RouleauEquipe {
  id: number
  poids: number
  secondChoix: boolean
  saisieMs: number
}

export interface KpiEquipe {
  production: { pieces: number; kg: number; kgParHeure: number | null }
  visitage: { pieces: number; kg: number; kgParHeure: number | null }
  /** `pct` = kg of second choice ÷ kg weighed (the legacy `xRatio`), null
   *  without a weighing. */
  secondChoix: { pieces: number; kg: number; pct: number | null }
  /** Pieces finished in the shift with no roll weighed by the shift's end —
   *  the legacy « Non Visitées à 21H », whose hour is the shift end. */
  nonVisitees: { pieces: number; heureFin: number }
}

const round1 = (x: number) => Math.round(x * 10) / 10

/** The four KPI cards. Bounds are the legacy's, `]debut, fin]` on both
 *  populations; the kg/h rate divides by the hours elapsed at `nowMs`
 *  (bounded to the shift), null before any time has elapsed. Rows outside
 *  the shift are ignored, so a caller may pass a wider read. */
export function kpiEquipe(
  pieces: PieceFinieEquipe[],
  rouleaux: RouleauEquipe[],
  equipe: Equipe,
  nowMs: number,
): KpiEquipe {
  const { debutMs, finMs } = equipe
  const dans = (ms: number) => ms > debutMs && ms <= finMs
  const heures = (Math.min(nowMs, finMs) - debutMs) / 3_600_000
  const taux = (kg: number) => (heures > 0 ? round1(kg / heures) : null)

  const finies = pieces.filter((p) => dans(p.finMs))
  const peses = rouleaux.filter((r) => dans(r.saisieMs))
  const seconds = peses.filter((r) => r.secondChoix)
  const kgProd = finies.reduce((s, p) => s + p.poidsNominal, 0)
  const kgVis = peses.reduce((s, r) => s + r.poids, 0)
  const kgSecond = seconds.reduce((s, r) => s + r.poids, 0)
  const nonVisitees = finies.filter((p) => p.visiteeMs === null || p.visiteeMs > finMs)

  return {
    production: { pieces: finies.length, kg: round1(kgProd), kgParHeure: taux(kgProd) },
    visitage: { pieces: peses.length, kg: round1(kgVis), kgParHeure: taux(kgVis) },
    secondChoix: {
      pieces: seconds.length,
      kg: round1(kgSecond),
      pct: kgVis > 0 ? Math.round((kgSecond / kgVis) * 10000) / 100 : null,
    },
    nonVisitees: { pieces: nonVisitees.length, heureFin: new Date(finMs).getHours() },
  }
}

// ── Présence — the bonnetiers of the shift, from `pointage` ───
//
// FI_TRS's ZR_Equipe does not read the planning: it reads the clock-in table
// `pointage` (IDbonnetier, DATE, en_poste 0/1) — three queries per bonnetier
// (the last row before the shift, the first after, every row inside). Same
// answer here from one read: the state at the shift start is the last
// pointage at or before it, then every toggle inside [debut, finEval] opens
// or closes a presence interval; the interval still open at the end runs to
// `finEval`. A gap between two intervals is a pause. Duplicate states
// (two « in » in a row) are ignored, like the recorder's duplicates.

export interface Pointage {
  bonnetierId: number
  atMs: number
  enPoste: boolean
}

export interface Intervalle { debutMs: number; finMs: number }

export interface PresenceBonnetier {
  bonnetierId: number
  intervalles: Intervalle[]
  pauses: Intervalle[]
  /** Σ intervalles, in seconds. */
  dureeS: number
}

export interface PresenceEquipe {
  rows: PresenceBonnetier[]
  totalS: number
}

/** `pointages` may include rows before `debutMs` (they set the opening state)
 *  and rows after `finEvalMs` (ignored). Bonnetiers without a second of
 *  presence in the window are left out — the legacy list shows who worked. */
export function presenceEquipe(pointages: Pointage[], debutMs: number, finEvalMs: number): PresenceEquipe {
  const parBonnetier = new Map<number, Pointage[]>()
  for (const p of pointages) {
    if (!parBonnetier.has(p.bonnetierId)) parBonnetier.set(p.bonnetierId, [])
    parBonnetier.get(p.bonnetierId)!.push(p)
  }
  const rows: PresenceBonnetier[] = []
  for (const [bonnetierId, liste] of parBonnetier) {
    liste.sort((a, b) => a.atMs - b.atMs)
    let enPoste = false
    for (const p of liste) if (p.atMs <= debutMs) enPoste = p.enPoste
    let t = debutMs
    const intervalles: Intervalle[] = []
    const pauses: Intervalle[] = []
    for (const p of liste) {
      if (p.atMs <= debutMs || p.atMs > finEvalMs) continue
      if (p.enPoste === enPoste) continue
      if (enPoste) {
        if (p.atMs > t) intervalles.push({ debutMs: t, finMs: p.atMs })
      } else if (intervalles.length > 0 && p.atMs > t) {
        pauses.push({ debutMs: t, finMs: p.atMs })
      }
      enPoste = p.enPoste
      t = p.atMs
    }
    if (enPoste && finEvalMs > t) intervalles.push({ debutMs: t, finMs: finEvalMs })
    if (intervalles.length === 0) continue
    const dureeS = Math.round(intervalles.reduce((s, i) => s + (i.finMs - i.debutMs), 0) / 1000)
    rows.push({ bonnetierId, intervalles, pauses, dureeS })
  }
  rows.sort((a, b) => a.intervalles[0].debutMs - b.intervalles[0].debutMs || a.bonnetierId - b.bonnetierId)
  return { rows, totalS: rows.reduce((s, r) => s + r.dureeS, 0) }
}

// ── Colours of the ZR_TRS line (FI_TRS) ───────────────────
//
// The three ladders of the legacy `SELON` blocks. 0.8 and 0.9 are the only
// two real literals in the window's compile cache; the vitesse and arrêts
// bounds are integer literals (not stored) read off the user's own copy of
// the procedure. They colour the ERP's per-métier line; the tablet keeps its
// relative speed ladder (apps/trs/src/lib/affichage.ts, plan §4.3).

export type Teinte = 'vert' | 'ambre' | 'rouge'

export const SEUILS_FI_TRS = {
  /** `ordre_fabrication.vitesse`: < 20 rouge, < 25 ambre. */
  vitesse: { rouge: 20, ambre: 25 },
  /** arrêts « défaut » par heure: 0–1 vert, 2 ambre, beyond rouge. */
  arretsParHeure: { vertMax: 1, ambreMax: 2 },
  /** TRS ratio: ≤ 0.8 rouge, ≤ 0.9 ambre. */
  trs: { rouge: 0.8, ambre: 0.9 },
} as const

export function teinteVitesseFiTrs(vitesse: number): Teinte {
  if (vitesse < SEUILS_FI_TRS.vitesse.rouge) return 'rouge'
  if (vitesse < SEUILS_FI_TRS.vitesse.ambre) return 'ambre'
  return 'vert'
}

export function teinteArretsParHeure(n: number): Teinte {
  if (n <= SEUILS_FI_TRS.arretsParHeure.vertMax) return 'vert'
  if (n <= SEUILS_FI_TRS.arretsParHeure.ambreMax) return 'ambre'
  return 'rouge'
}

export function teinteTrsFiTrs(trs: number): Teinte {
  if (trs <= SEUILS_FI_TRS.trs.rouge) return 'rouge'
  if (trs <= SEUILS_FI_TRS.trs.ambre) return 'ambre'
  return 'vert'
}
