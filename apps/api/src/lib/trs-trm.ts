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

export function calculerTrs(e: TrsEntree): TrsResultat {
  const debut = e.equipe.debutMs
  const finEval = Math.min(e.nowMs, e.equipe.finMs)
  const prod = fenetresProduction(e.fenetres, debut, finEval)
  const tempsProdS = prod.reduce((s, p) => s + (p.finMs - p.debutMs) / 1000, 0)
  const enProduction = e.fenetres.some(
    (f) => f.debutMs <= e.nowMs && (f.finMs === null || f.finMs > e.nowMs),
  )

  // Walk the machine timeline: [shift start, first event) carries the initial
  // state, each event opens the next period, the last runs to `finEval`.
  const evts = e.evenements
    .filter((ev) => ev.atMs >= debut && ev.atMs <= finEval)
    .sort((a, b) => a.atMs - b.atMs)
  // No history at all: the legacy inferred the opening state as the inverse
  // of the first event. Keep that as the fallback; with no events either the
  // métier is treated as stopped.
  let etat: 0 | 1 = e.etatInitial ?? (evts.length > 0 ? ((1 - evts[0].etat) as 0 | 1) : 0)
  let t = debut
  let tempsMarcheS = 0
  let deductibleS = 0
  let arrets = 0

  const close = (finMs: number, ouvertParEvenement: boolean) => {
    const periode = { debutMs: t, finMs }
    if (etat === 1) {
      tempsMarcheS += overlapS(periode, prod)
    } else if (ouvertParEvenement && dansFenetre(t, prod)) {
      // A stop that began (as a real transition) while an OF was running.
      arrets += 1
      deductibleS += Math.min(INTERVENTION_MAX_S, (finMs - t) / 1000)
    }
  }

  let ouvertParEvenement = false
  for (const ev of evts) {
    if (ev.etat === etat) continue // duplicate state — the recorder never writes these
    close(ev.atMs, ouvertParEvenement)
    etat = ev.etat
    t = ev.atMs
    ouvertParEvenement = true
  }
  close(finEval, ouvertParEvenement)

  // Piece events: flat allowances, and one arrêt each is not a defect.
  for (const p of e.evenementsPiece) {
    if (p.atMs < debut || p.atMs > finEval) continue
    if (p.type === 'nettoyage') {
      deductibleS += 60 * (p.lycra ? FORFAIT_MIN.nettoyage.lycra : FORFAIT_MIN.nettoyage.sans)
    } else if (p.numero !== 1) {
      deductibleS += 60 * (p.lycra ? FORFAIT_MIN.finPiece.lycra : FORFAIT_MIN.finPiece.sans)
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
