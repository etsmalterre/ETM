// Production › Planning (TRM, LIVA #1250) — the pure engine: working calendar,
// per-métier efficiency measured on history, and the commande-line schedule.
// No I/O here; the loader is lib/planning-prod-trm-charge.ts.
//
// Port of the legacy FI_Planning_Commande (PCS-compressed; recovered from the
// compile cache: Utilitaire.FinPlanningCommande / InitPlanningCommande) with
// three deliberate departures, decided with Vincent on 2026-10-01:
//   1. Dates are COMPUTED on every read, never stored. The legacy saved
//      planning_depart / planning_fin on the line at creation and on a drag,
//      and they went stale the day production moved. A drag here saves only
//      the métier and the place in that métier's line (planning_prod_ligne).
//   2. The calendar is the bonnetier planning (planning_bonnetier) while it is
//      filled, capped at REEL_HORIZON_JOURS, then a chosen régime (3×8 by
//      default, 2×8, 2×7, custom). The legacy hard-coded a night allowance
//      and a weekend skip.
//   3. Efficiency is MEASURED per métier on its finished OFs. The legacy used
//      vitesse 17 × rendement 0,6 for every métier — measured on 304 OFs
//      (2025-09 → 2026-09) the real median is ~0,43 of worked time, from 0,14
//      to 0,86 depending on the métier: the legacy was ~40 % optimistic.
//
// Duration of K kg on a métier (the tours formula of the legacy and of the
// OF screen's per-piece estimate):
//   minutes = (trs_10kg_chute / nb_chutes) × K / 10 ÷ vitesse ÷ rendement
// with vitesse = OF.vitesse → machine.vitesse → ref_ecru.vitesse_cible.

export const MINUTE = 60_000
export const HEURE = 60 * MINUTE
export const JOUR = 24 * HEURE

/** The bonnetier planning is trusted this far ahead at most (Vincent: « the
 *  next 2 to 3 weeks »); beyond, the régime. */
export const REEL_HORIZON_JOURS = 21
/** How far ahead the calendar is built — a schedule that runs past it is
 *  clipped to its end (flagged `hors_horizon`). */
export const CALENDRIER_JOURS = 366

// ── Régimes ──────────────────────────────────────────────

export type RegimeId = '3x8' | '2x8' | '2x7' | 'custom'

/** One working window per weekday, local time 'HH:MM'. `fin` ≤ `debut` means
 *  the window ends the next day (a night shift: 05:00 → 05:00 = 24 h). */
export interface Horaire { debut: string; fin: string }
/** Index 0 = Monday … 6 = Sunday (ISO order). null = not worked. */
export type SemaineHoraires = Array<Horaire | null>

const SEMAINE_OUVREE = (h: Horaire): SemaineHoraires => [h, h, h, h, h, null, null]

/** Presets. 3×8 = 5 h → 5 h the next day, Monday to Friday (the Friday night
 *  ends Saturday 5 h — no weekend work, the night shifts start Monday to
 *  Friday at 21 h in planning_bonnetier). 2×7 = the 2×8 without the night and
 *  one hour shaved off each edge (Vincent, 2026-10-01). */
export const REGIMES: Record<Exclude<RegimeId, 'custom'>, { libelle: string; semaine: SemaineHoraires }> = {
  '3x8': { libelle: '3×8', semaine: SEMAINE_OUVREE({ debut: '05:00', fin: '05:00' }) },
  '2x8': { libelle: '2×8', semaine: SEMAINE_OUVREE({ debut: '05:00', fin: '21:00' }) },
  '2x7': { libelle: '2×7', semaine: SEMAINE_OUVREE({ debut: '06:00', fin: '20:00' }) },
}

export const REGIME_DEFAUT: RegimeId = '3x8'

export interface Reglage {
  regime: RegimeId
  /** Used when regime = 'custom' (ignored otherwise). */
  horaires: SemaineHoraires | null
}

export function semaineDuReglage(r: Reglage): SemaineHoraires {
  if (r.regime === 'custom') return r.horaires && r.horaires.length === 7 ? r.horaires : REGIMES['3x8'].semaine
  return REGIMES[r.regime].semaine
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function horaireValide(h: unknown): h is Horaire {
  if (!h || typeof h !== 'object') return false
  const o = h as Record<string, unknown>
  return typeof o.debut === 'string' && typeof o.fin === 'string' && HHMM.test(o.debut) && HHMM.test(o.fin)
}

function minutesDe(hhmm: string): number {
  const m = HHMM.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}

// ── Intervals ────────────────────────────────────────────

/** [debut, fin) in epoch ms. */
export interface Intervalle { debut: number; fin: number }

/** Sort + merge overlapping or touching intervals. */
export function fusionner(list: Intervalle[]): Intervalle[] {
  const s = list.filter((i) => i.fin > i.debut).sort((a, b) => a.debut - b.debut)
  const out: Intervalle[] = []
  for (const i of s) {
    const last = out[out.length - 1]
    if (last && i.debut <= last.fin) last.fin = Math.max(last.fin, i.fin)
    else out.push({ ...i })
  }
  return out
}

function minuitLocal(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function ajouterJours(minuit: number, n: number): number {
  const d = new Date(minuit)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime()
}

/** ISO weekday index 0 = Monday … 6 = Sunday. */
function jourIso(ms: number): number {
  return (new Date(ms).getDay() + 6) % 7
}

/** The régime's working windows between two instants (local time, DST-safe:
 *  each window is built from its day's local midnight). */
export function intervallesRegime(
  semaine: SemaineHoraires,
  de: number,
  a: number,
  /** Drop the windows that began before `de` instead of clipping them. */
  commencantApres = false,
): Intervalle[] {
  const out: Intervalle[] = []
  // Start one day early: a night window that began yesterday may cover `de`.
  for (let jour = ajouterJours(minuitLocal(de), -1); jour < a; jour = ajouterJours(jour, 1)) {
    const h = semaine[jourIso(jour)]
    if (!h) continue
    const d0 = minutesDe(h.debut)
    let d1 = minutesDe(h.fin)
    if (d1 <= d0) d1 += 24 * 60
    const d = new Date(jour)
    const debut = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, d0).getTime()
    const fin = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, d1).getTime()
    if (commencantApres && debut < de) continue
    const i = { debut: Math.max(debut, de), fin: Math.min(fin, a) }
    if (i.fin > i.debut) out.push(i)
  }
  return fusionner(out)
}

// ── Calendar ─────────────────────────────────────────────

export interface Calendrier {
  /** Worked windows, merged, sorted, from `depuis` to `jusqua`. */
  ouvert: Intervalle[]
  depuis: number
  jusqua: number
  /** Before this instant the windows come from the bonnetier planning; from
   *  it on, from the régime (« potentiel »). Equal to `depuis` when the
   *  planning has nothing ahead. */
  reelJusqua: number
}

/**
 * The working calendar from `maintenant`:
 *  - up to the end of the last day the bonnetier planning covers (capped at
 *    REEL_HORIZON_JOURS), the union of the booked shifts — a day with no
 *    booking inside that span is a day off (holiday, closure);
 *  - after it, the régime.
 */
export function construireCalendrier(opts: {
  maintenant: number
  /** planning_bonnetier rows (non-régleur), any span — clipped here. */
  postes: Intervalle[]
  semaine: SemaineHoraires
  jours?: number
}): Calendrier {
  const { maintenant, semaine } = opts
  const jusqua = ajouterJours(minuitLocal(maintenant), opts.jours ?? CALENDRIER_JOURS)
  const plafond = ajouterJours(minuitLocal(maintenant), REEL_HORIZON_JOURS)
  const futurs = opts.postes.filter((p) => p.fin > maintenant)
  let reelJusqua = maintenant
  if (futurs.length > 0) {
    const dernierJour = Math.max(...futurs.map((p) => minuitLocal(p.debut)))
    reelJusqua = Math.min(ajouterJours(dernierJour, 1), plafond)
    // A night shift booked on the last day runs past its midnight.
    for (const p of futurs) {
      if (minuitLocal(p.debut) < reelJusqua && p.fin > reelJusqua && reelJusqua < plafond) {
        reelJusqua = Math.min(p.fin, plafond)
      }
    }
    reelJusqua = Math.max(reelJusqua, maintenant)
  }
  const reels = fusionner(
    futurs.map((p) => ({ debut: Math.max(p.debut, maintenant), fin: Math.min(p.fin, reelJusqua) })),
  )
  // A régime window belongs to its start day: Friday's night (21 h → Saturday
  // 5 h) must not spill past a planning that stopped Friday 21 h — unless no
  // planning is ahead, where the window running at `maintenant` counts.
  const potentiels = intervallesRegime(semaine, reelJusqua, jusqua, futurs.length > 0)
  return { ouvert: fusionner([...reels, ...potentiels]), depuis: maintenant, jusqua, reelJusqua }
}

/** Worked minutes between two instants on a list of windows. */
export function minutesOuvrees(ouvert: Intervalle[], de: number, a: number): number {
  let ms = 0
  for (const i of ouvert) {
    if (i.fin <= de) continue
    if (i.debut >= a) break
    ms += Math.min(i.fin, a) - Math.max(i.debut, de)
  }
  return ms / MINUTE
}

/** First worked instant ≥ t (t itself when inside a window); null past the
 *  calendar. */
export function prochainOuvert(ouvert: Intervalle[], t: number): number | null {
  for (const i of ouvert) {
    if (i.fin <= t) continue
    return Math.max(i.debut, t)
  }
  return null
}

/** The instant `minutes` of worked time after `t`; null when the calendar
 *  ends first. */
export function avancer(ouvert: Intervalle[], t: number, minutes: number): number | null {
  let reste = minutes * MINUTE
  if (reste <= 0) return prochainOuvert(ouvert, t) ?? null
  for (const i of ouvert) {
    if (i.fin <= t) continue
    const debut = Math.max(i.debut, t)
    const dispo = i.fin - debut
    if (reste <= dispo) return debut + reste
    reste -= dispo
  }
  return null
}

// ── Duration ─────────────────────────────────────────────

/** Tours per 10 kg on a métier: ref_ecru_machine.trs_10kg_chute / nb_chutes.
 *  null when the pair has no usable row (the métier is not set up for the
 *  ref — not compatible). */
export function toursPar10kg(trs10kgChute: number, nbChutes: number): number | null {
  return trs10kgChute > 0 && nbChutes > 0 ? trs10kgChute / nbChutes : null
}

/** Machine-only minutes (rendement 1) to knit `kg`. null when a factor is
 *  missing. */
export function minutesTheoriques(kg: number, tours10kg: number | null, vitesse: number): number | null {
  if (tours10kg === null || !(vitesse > 0)) return null
  return (Math.max(0, kg) / 10) * tours10kg / vitesse
}

// ── Efficiency (rendement) measured on history ───────────

export interface EchantillonOf {
  idmachine: number
  /** Knitted kg (Σ finished pieces). */
  kg: number
  /** Machine-only minutes for those kg (minutesTheoriques). */
  theoriques: number
  /** First piece start → last piece end. */
  debut: number
  fin: number
}

/** Bounds on a measured rendement. It is a CALIBRATION factor rather than a
 *  pure efficiency: it absorbs whatever the inputs get wrong, as long as the
 *  plan uses the same inputs. It goes above 1 when a métier knits outside the
 *  staffed hours, or when its stored speed is too low (2B: machine.vitesse = 6
 *  measured 1,5+ on 9 OFs). The median over several OFs already rejects one-off
 *  outliers; these bounds only stop a broken setup row from producing an
 *  absurd plan. */
export const RENDEMENT_MIN = 0.15
export const RENDEMENT_MAX = 3
/** Fewer samples than this → the parc's median instead. */
export const RENDEMENT_ECHANTILLONS_MIN = 3
/** Only the most recent N OFs of a métier count. */
export const RENDEMENT_ECHANTILLONS_MAX = 10
/** When the history has nothing usable at all. Measured parc median of
 *  2025-09 → 2026-09 on 3×8 worked time, rounded. */
export const RENDEMENT_REPLI = 0.45

function mediane(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function borner(x: number): number {
  return Math.min(RENDEMENT_MAX, Math.max(RENDEMENT_MIN, x))
}

export interface Rendement {
  valeur: number
  source: 'mesure' | 'parc' | 'defaut'
  echantillons: number
}

/**
 * Per-métier rendement = median of theoretical / worked minutes over its
 * latest finished OFs, worked minutes measured on the HISTORICAL calendar
 * (the bonnetier planning of those days). A sample with no worked time
 * (no planning on those days) is skipped.
 */
export function mesurerRendements(
  echantillons: EchantillonOf[],
  ouvertHistorique: Intervalle[],
): { parMachine: Map<number, Rendement>; parc: Rendement } {
  const ratios = new Map<number, Array<{ fin: number; r: number }>>()
  for (const e of echantillons) {
    if (!(e.theoriques > 0) || !(e.fin > e.debut)) continue
    const ouvre = minutesOuvrees(ouvertHistorique, e.debut, e.fin)
    if (ouvre < 60) continue
    const list = ratios.get(e.idmachine) ?? []
    list.push({ fin: e.fin, r: e.theoriques / ouvre })
    ratios.set(e.idmachine, list)
  }
  const parMachine = new Map<number, Rendement>()
  const tous: number[] = []
  for (const [id, list] of ratios) {
    const recents = list.sort((a, b) => b.fin - a.fin).slice(0, RENDEMENT_ECHANTILLONS_MAX).map((x) => x.r)
    tous.push(...recents)
    if (recents.length >= RENDEMENT_ECHANTILLONS_MIN) {
      parMachine.set(id, { valeur: borner(mediane(recents)!), source: 'mesure', echantillons: recents.length })
    }
  }
  const m = mediane(tous)
  const parc: Rendement = m === null
    ? { valeur: RENDEMENT_REPLI, source: 'defaut', echantillons: 0 }
    : { valeur: borner(m), source: 'parc', echantillons: tous.length }
  return { parMachine, parc }
}

// ── Schedule ─────────────────────────────────────────────

/** How a métier knits a given ref (one row of ref_ecru_machine + speeds). */
export interface Aptitude {
  tours10kg: number
  vitesse: number
}

export interface MachinePlan {
  id: number
  rendement: number
}

/** An open OF (est_termine = 0) — already queued by the régleur. */
export interface OfPlan {
  id: number
  idmachine: number
  actif: boolean
  priorite: number
  /** Still to knit: quantite − Σ finished pieces, ≥ 0. */
  resteKg: number
  ligneId: number
  /** null = the métier has no usable ref_ecru_machine row / speed for it. */
  aptitude: Aptitude | null
}

/** The part of a commande line no OF covers yet. */
export interface LignePlan {
  ligneId: number
  resteKg: number
  /** date_livraison at end of day (ms), null = no délai. */
  delai: number | null
  /** Métiers set up for the line's ref, with how they knit it. */
  aptitudes: Map<number, Aptitude>
  /** Saved by a drag (planning_prod_ligne); null = automatic. */
  epingle: { idmachine: number; rang: number } | null
}

export interface Segment {
  type: 'of' | 'ligne'
  /** OF id for 'of', ligne id for 'ligne'. */
  id: number
  ligneId: number
  idmachine: number
  kg: number
  debut: number
  fin: number
  minutes: number
  actif: boolean
  /** Duration from a missing factor's stand-in (DUREE_INCONNUE_MIN). */
  approx: boolean
  /** The calendar ended before this segment did: `fin` is the calendar end. */
  horsHorizon: boolean
  /** 'ligne' only: placed by a drag rather than automatically. */
  epingle: boolean
}

/** Stand-in when a factor of the formula is missing on an OF's métier: the
 *  legacy's flat 10 days, in worked minutes — loud enough to be noticed. */
export const DUREE_INCONNUE_MIN = 10 * 8 * 60

export function dureeMinutes(kg: number, apt: Aptitude | null, rendement: number): { minutes: number; approx: boolean } {
  const t = apt ? minutesTheoriques(kg, apt.tours10kg, apt.vitesse) : null
  if (t === null) return { minutes: kg > 0 ? DUREE_INCONNUE_MIN : 0, approx: true }
  return { minutes: t / Math.max(rendement, RENDEMENT_MIN), approx: false }
}

/**
 * Lay every métier's line out on the calendar:
 *   1. the running OF (its remaining kg) from now,
 *   2. the waiting OFs in queue order (priorite),
 *   3. the commande lines without (enough) OF — the pinned ones first, in
 *      their saved order; then the automatic ones, by délai (none last), each
 *      on the compatible métier where it would END first.
 * Moving anything pushes everything behind it: dates are a pure function of
 * the queue.
 */
export function planifier(opts: {
  calendrier: Calendrier
  machines: MachinePlan[]
  ofs: OfPlan[]
  lignes: LignePlan[]
}): { segments: Segment[]; nonPlanifiables: number[] } {
  const { calendrier } = opts
  const ouvert = calendrier.ouvert
  const curseur = new Map<number, number>()
  const rendement = new Map<number, number>()
  for (const m of opts.machines) {
    curseur.set(m.id, calendrier.depuis)
    rendement.set(m.id, m.rendement)
  }
  const segments: Segment[] = []

  const poser = (
    base: Omit<Segment, 'debut' | 'fin' | 'minutes' | 'approx' | 'horsHorizon'>,
    apt: Aptitude | null,
  ): Segment => {
    const r = rendement.get(base.idmachine) ?? RENDEMENT_REPLI
    const { minutes, approx } = dureeMinutes(base.kg, apt, r)
    const depart = curseur.get(base.idmachine) ?? calendrier.depuis
    const debut = prochainOuvert(ouvert, depart) ?? calendrier.jusqua
    const fin = avancer(ouvert, debut, minutes)
    const seg: Segment = {
      ...base, debut, fin: fin ?? calendrier.jusqua, minutes: Math.round(minutes), approx, horsHorizon: fin === null,
    }
    curseur.set(base.idmachine, seg.fin)
    segments.push(seg)
    return seg
  }

  // 1 + 2 — the OF queues.
  const ofs = [...opts.ofs]
    .filter((o) => curseur.has(o.idmachine))
    .sort((a, b) => a.idmachine - b.idmachine || Number(b.actif) - Number(a.actif) || a.priorite - b.priorite || a.id - b.id)
  for (const o of ofs) {
    poser({ type: 'of', id: o.id, ligneId: o.ligneId, idmachine: o.idmachine, kg: o.resteKg, actif: o.actif, epingle: false }, o.aptitude)
  }

  // 3a — pinned lines, on their métier in saved order. A pin on a métier
  // that is no longer compatible (or archived) falls back to automatic.
  const nonPlanifiables: number[] = []
  const auto: LignePlan[] = []
  const epinglees = opts.lignes
    .filter((l) => l.epingle && l.aptitudes.has(l.epingle.idmachine) && curseur.has(l.epingle.idmachine))
    .sort((a, b) => a.epingle!.idmachine - b.epingle!.idmachine || a.epingle!.rang - b.epingle!.rang || a.ligneId - b.ligneId)
  const epingleIds = new Set(epinglees.map((l) => l.ligneId))
  for (const l of epinglees) {
    poser({ type: 'ligne', id: l.ligneId, ligneId: l.ligneId, idmachine: l.epingle!.idmachine, kg: l.resteKg, actif: false, epingle: true },
      l.aptitudes.get(l.epingle!.idmachine)!)
  }
  for (const l of opts.lignes) if (!epingleIds.has(l.ligneId)) auto.push(l)

  // 3b — automatic lines: earliest délai first, each where it ends first.
  auto.sort((a, b) => (a.delai ?? Infinity) - (b.delai ?? Infinity) || a.ligneId - b.ligneId)
  for (const l of auto) {
    let best: { idmachine: number; fin: number } | null = null
    for (const [idmachine, apt] of l.aptitudes) {
      if (!curseur.has(idmachine)) continue
      const { minutes } = dureeMinutes(l.resteKg, apt, rendement.get(idmachine) ?? RENDEMENT_REPLI)
      const debut = prochainOuvert(ouvert, curseur.get(idmachine)!) ?? calendrier.jusqua
      const fin = avancer(ouvert, debut, minutes) ?? Infinity
      if (!best || fin < best.fin || (fin === best.fin && idmachine < best.idmachine)) best = { idmachine, fin }
    }
    if (!best) { nonPlanifiables.push(l.ligneId); continue }
    poser({ type: 'ligne', id: l.ligneId, ligneId: l.ligneId, idmachine: best.idmachine, kg: l.resteKg, actif: false, epingle: false },
      l.aptitudes.get(best.idmachine)!)
  }

  return { segments, nonPlanifiables }
}

/** Below this, the part of a line its OFs leave uncovered is rounding (OF
 *  quantities are typed from piece weights) and not planned. */
export function resteAPlanifier(quantiteLigne: number, couvertKg: number): number {
  const reste = quantiteLigne - couvertKg
  const seuil = Math.max(5, quantiteLigne * 0.02)
  return reste > seuil ? reste : 0
}
