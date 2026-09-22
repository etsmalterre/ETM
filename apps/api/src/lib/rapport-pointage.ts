/**
 * Pure rules of the daily « Rapport de pointage » email (TRM notification
 * `notif_rapport_pointage`) — the port of the n8n workflow « pointage » that
 * mailed it from the WebDev localapi until 2026-09-22. No I/O here: the reads
 * and the sending live in lib/rapports-pointage-envoi.ts, the markup in
 * lib/rapport-pointage-email.ts.
 *
 * What changed from the n8n node « Logique » (decisions of 2026-09-22):
 *   - two populations with their own rules instead of one:
 *       · on shift = the salarié's linked bonnetier (`lst_salarie.id_mps`) has a
 *         `planning_bonnetier` row that day. Judged against that row, 20 min of
 *         pause in all;
 *       · day hours = everyone else, expected 09:00-12:00 and 14:00-18:00.
 *   - a 5 min tolerance on every arrival / departure (n8n flagged 06:01);
 *   - a clock-out missing between two clock-ins is flagged (n8n kept only the
 *     day's first start and last end, so a forgotten lunch clock-out was
 *     invisible and inflated the day);
 *   - salariés matched by id, not by first name.
 * Kept from n8n: a stamp is rounded to the minute from 31 s up; for a shift
 * worker the gap between two lines of the day counts as pause.
 */
import type { LigneHoraire } from './pointage-etat.js'

/** Minutes of slack on every expected arrival / departure. */
export const TOLERANCE_MIN = 5
/** Pause allowed to a shift worker over the whole shift. */
export const PAUSE_EQUIPE_MAX_MIN = 20
/** Expected day hours of a salarié who is not in the bonnetier planning. */
export const HORAIRE_JOURNEE = { matin: '09:00', midi: '12:00', reprise: '14:00', soir: '18:00' } as const

export interface Plage {
  /** Epoch ms. */
  debut: number
  fin: number
}

export interface SalarieRapport {
  id: number
  prenom: string
  nom: string
}

export interface LigneRapport {
  salarie: SalarieRapport
  /** 'equipe' = judged against its planning row, 'journee' = day hours. */
  regime: 'equipe' | 'journee'
  /** The planning row, for a shift worker. */
  prevu: Plage | null
  /** First clock-in / last clock-out of the day, epoch ms rounded to the minute; null = not clocked. */
  debut: number | null
  fin: number | null
  /** Pauses shown in the report, in order: clocked ones, plus for a shift worker the gaps between lines. */
  pauses: Plage[]
  pauseMin: number
  /** Day hours only: the gaps between two lines of the day, i.e. the lunch
   *  clocked out and back in. Shown apart from the pauses and never counted
   *  in `pauseMin` (it is not paid time off the machine, it is time off work). */
  repas: Plage[]
  /** What to check, in words — empty when the day is in order. */
  alertes: string[]
  /** Which cells turn red. */
  rouge: { debut: boolean; fin: boolean; pause: boolean; repas: boolean }
}

const MIN = 60_000

/** n8n's rounding: to the minute, from 31 s up. `s` in epoch seconds, 0 = none. */
export function arrondiMinute(s: number): number | null {
  if (!s) return null
  return Math.floor((s + 29) / 60) * 60 * 1000
}

/** lst_salarie stores first names in capitals (« DAUNOVAN »); the report writes
 *  them as names (« Daunovan », « Jean-Marc »). */
export function prenomAffiche(s: string): string {
  return s.toLocaleLowerCase('fr').replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toLocaleUpperCase('fr'))
}

const dureeMin = (p: Plage) => Math.max(0, Math.round((p.fin - p.debut) / MIN))

/** « HH:MM » of an epoch ms, Paris wall clock. */
export function hhmm(ms: number, tz = 'Europe/Paris'): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
}

/**
 * One salarié's day. `lignes` are that salarié's lst_horaire lines whose DATE
 * is the day (a night shift sits on its evening). `heure(hhmm)` turns an
 * expected « HH:MM » of that day into epoch ms (Paris) — injected so the rules
 * stay free of time-zone code and tests can pin it.
 */
export function analyserJournee(
  salarie: SalarieRapport,
  lignes: readonly LigneHoraire[],
  prevu: Plage | null,
  heure: (hhmm: string) => number,
): LigneRapport {
  const tri = [...lignes].sort((a, b) => a.debut - b.debut)
  const regime = prevu ? 'equipe' : 'journee'
  const alertes: string[] = []
  const rouge = { debut: false, fin: false, pause: false, repas: false }

  const debut = tri.length ? arrondiMinute(tri[0].debut) : null
  const fin = tri.length ? arrondiMinute(tri[tri.length - 1].fin) : null

  // Clocked pauses (an unfinished one has no end and is not counted, like cumulPausesMin).
  const pauses: Plage[] = []
  for (const l of tri) {
    for (const [d, f] of [[l.debut_pause1, l.fin_pause1], [l.debut_pause2, l.fin_pause2]] as const) {
      const pd = arrondiMinute(d), pf = arrondiMinute(f)
      if (pd !== null && pf !== null && pf > pd) pauses.push({ debut: pd, fin: pf })
    }
  }
  // Between two lines: a forgotten clock-out, or a pause (shift worker) / the lunch (day hours).
  const repas: Plage[] = []
  for (let i = 0; i < tri.length - 1; i++) {
    const f = arrondiMinute(tri[i].fin), d = arrondiMinute(tri[i + 1].debut)
    if (f === null) {
      alertes.push(`sortie non pointée entre ${hhmm(arrondiMinute(tri[i].debut)!)} et ${d !== null ? hhmm(d) : '?'}`)
    } else if (d !== null && d > f) {
      ;(regime === 'equipe' ? pauses : repas).push({ debut: f, fin: d })
    }
  }
  pauses.sort((a, b) => a.debut - b.debut)
  const pauseMin = pauses.reduce((t, p) => t + dureeMin(p), 0)

  if (debut === null) { alertes.push('aucun pointage'); rouge.debut = true }
  if (debut !== null && fin === null) { alertes.push('fin de poste non pointée'); rouge.fin = true }

  const tol = TOLERANCE_MIN * MIN
  const retard = (reel: number, attendu: number) => `${Math.round((reel - attendu) / MIN)} min`

  if (prevu) {
    if (debut !== null && debut > prevu.debut + tol) {
      alertes.push(`arrivée ${hhmm(debut)} au lieu de ${hhmm(prevu.debut)} (${retard(debut, prevu.debut)} de retard)`)
      rouge.debut = true
    }
    if (fin !== null && fin < prevu.fin - tol) {
      alertes.push(`départ ${hhmm(fin)} au lieu de ${hhmm(prevu.fin)} (${retard(prevu.fin, fin)} plus tôt)`)
      rouge.fin = true
    }
    if (pauseMin > PAUSE_EQUIPE_MAX_MIN) {
      alertes.push(`${pauseMin} min de pause pour ${PAUSE_EQUIPE_MAX_MIN} prévues`)
      rouge.pause = true
    }
  } else if (debut !== null) {
    const matin = heure(HORAIRE_JOURNEE.matin), midi = heure(HORAIRE_JOURNEE.midi)
    const reprise = heure(HORAIRE_JOURNEE.reprise), soir = heure(HORAIRE_JOURNEE.soir)
    if (debut > matin + tol) {
      alertes.push(`arrivée ${hhmm(debut)} au lieu de ${HORAIRE_JOURNEE.matin} (${retard(debut, matin)} de retard)`)
      rouge.debut = true
    }
    // The lunch: one uninterrupted line across 12:00-14:00 means it was never clocked.
    const traverse = tri.find((l) => {
      const d = arrondiMinute(l.debut), f = arrondiMinute(l.fin)
      return d !== null && f !== null && d < midi && f > reprise
    })
    if (traverse) alertes.push('pause de midi non pointée')
    // Back from lunch: the first line that starts after noon, when the morning was worked.
    const apresMidi = tri.find((l) => arrondiMinute(l.debut)! >= midi)
    if (apresMidi && debut < midi) {
      const d = arrondiMinute(apresMidi.debut)!
      if (d > reprise + tol) {
        alertes.push(`reprise ${hhmm(d)} au lieu de ${HORAIRE_JOURNEE.reprise} (${retard(d, reprise)} de retard)`)
        rouge.repas = true
      }
    }
    if (fin !== null && fin < soir - tol) {
      alertes.push(`départ ${hhmm(fin)} au lieu de ${HORAIRE_JOURNEE.soir} (${retard(soir, fin)} plus tôt)`)
      rouge.fin = true
    }
  }

  return { salarie, regime, prevu, debut, fin, pauses, pauseMin, repas, alertes, rouge }
}

/** Order of the report: by first clock-in, never-clocked (planned) salariés last. */
export function ordreRapport(a: LigneRapport, b: LigneRapport): number {
  return (a.debut ?? Infinity) - (b.debut ?? Infinity) || a.salarie.prenom.localeCompare(b.salarie.prenom, 'fr')
}

/**
 * The days a report sent on `jour` (YYYYMMDD, Paris) covers: the day before,
 * and on a Monday the whole weekend with Friday (n8n skipped Saturday and
 * Sunday). `jourSemaine` is 1 = Monday … 7 = Sunday.
 */
export function joursCouverts(jour: string, jourSemaine: number): string[] {
  const d = new Date(Date.UTC(+jour.slice(0, 4), +jour.slice(4, 6) - 1, +jour.slice(6, 8)))
  const n = jourSemaine === 1 ? 3 : 1
  const out: string[] = []
  for (let i = n; i >= 1; i--) {
    const t = new Date(d.getTime() - i * 86_400_000)
    out.push(`${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`)
  }
  return out
}
