/**
 * The pointeuse's rules, pure — no database, no clock — so the routes, the
 * write module (lib/pointage-ecritures.ts) and the tests share ONE table.
 *
 * Port of FEN_PointageSalarié, the WinDev pointeuse (bytecode decoded
 * 2026-09-15, design in ~/.claude/plans/pointage-pwa.md). The two buttons are
 * driven by the salarié's OPEN line of `lst_horaire` (fin = 0, is_deleted = 0):
 *
 *   open line               button 1              button 2
 *   none                    Début du travail      —
 *   debut_pause1 = 0        Début de la pause     Fin du travail
 *   fin_pause1   = 0        Fin de la pause       Fin de la pause et fin du travail
 *   debut_pause2 = 0        Début de la pause     Fin du travail
 *   fin_pause2   = 0        Fin de la pause       Fin de la pause et fin du travail
 *   both pauses done        —                     Fin du travail
 *
 * One deliberate delta (Vincent, 2026-09-15): a line left open for more than
 * POSTE_OUVERT_MAX_S is NOT continued. The legacy would happily close
 * yesterday's forgotten shift with today's clock; here the tablet warns
 * (« poste du … encore ouvert ») and offers « Commencer aujourd'hui », which
 * opens a NEW line and leaves the old one to Admin Pointage.
 *
 * Times: `lst_horaire` holds epoch SECONDS (UTC); `lst_pointage` and
 * `mps.pointage` hold Europe/Paris wall-clock DATETIMEs. Everything here
 * converts through Europe/Paris explicitly, never the server's own zone.
 */

export const COLONNES_HEURE = ['debut', 'debut_pause1', 'fin_pause1', 'debut_pause2', 'fin_pause2', 'fin'] as const
export type ColonneHeure = (typeof COLONNES_HEURE)[number]

export type ActionPointage = 'debut_travail' | 'debut_pause' | 'fin_pause' | 'fin_travail' | 'fin_pause_fin_travail'
export const ACTIONS_POINTAGE: readonly ActionPointage[] = [
  'debut_travail', 'debut_pause', 'fin_pause', 'fin_travail', 'fin_pause_fin_travail',
]

/** A `lst_horaire` row; the six time columns in epoch seconds, 0 = empty. */
export type LigneHoraire = { id: number; idSalarie: number; jour: string } & Record<ColonneHeure, number>

export interface ActionPossible {
  action: ActionPointage
  libelle: string
  /** The `lst_horaire` / `lst_pointage` columns this action stamps. */
  colonnes: ColonneHeure[]
  /** The `mps.pointage.en_poste` value it logs: back at work = 1. */
  enPoste: 0 | 1
}

export type StatutPointage = 'hors_poste' | 'au_travail' | 'en_pause'

export interface EtatPointage {
  statut: StatutPointage
  /** The line the actions apply to; null when the next action opens a new one. */
  ligne: LigneHoraire | null
  /** An open line too old to continue (see header), shown as a warning. */
  nonFermee: LigneHoraire | null
  actions: ActionPossible[]
}

/** Longest a line may stay open and still be continued: a night shift (21 h →
 *  5 h) plus a generous overrun, well short of « the next day's shift ». */
export const POSTE_OUVERT_MAX_S = 14 * 3600

const act = (action: ActionPointage, libelle: string, colonnes: ColonneHeure[], enPoste: 0 | 1): ActionPossible => ({
  action,
  libelle,
  colonnes,
  enPoste,
})

const FIN_TRAVAIL = act('fin_travail', 'Fin du travail', ['fin'], 0)

export function etatPointage(ouverte: LigneHoraire | null, maintenantS: number): EtatPointage {
  if (!ouverte) {
    return { statut: 'hors_poste', ligne: null, nonFermee: null, actions: [act('debut_travail', 'Début du travail', ['debut'], 1)] }
  }
  if (maintenantS - ouverte.debut > POSTE_OUVERT_MAX_S) {
    return {
      statut: 'hors_poste',
      ligne: null,
      nonFermee: ouverte,
      actions: [act('debut_travail', 'Commencer aujourd’hui', ['debut'], 1)],
    }
  }
  const l = ouverte
  const au = (actions: ActionPossible[]): EtatPointage => ({ statut: 'au_travail', ligne: l, nonFermee: null, actions })
  const pause = (actions: ActionPossible[]): EtatPointage => ({ statut: 'en_pause', ligne: l, nonFermee: null, actions })
  if (l.debut_pause1 === 0) return au([act('debut_pause', 'Début de la pause', ['debut_pause1'], 0), FIN_TRAVAIL])
  if (l.fin_pause1 === 0) {
    return pause([
      act('fin_pause', 'Fin de la pause', ['fin_pause1'], 1),
      act('fin_pause_fin_travail', 'Fin de la pause et fin du travail', ['fin_pause1', 'fin'], 0),
    ])
  }
  if (l.debut_pause2 === 0) return au([act('debut_pause', 'Début de la pause', ['debut_pause2'], 0), FIN_TRAVAIL])
  if (l.fin_pause2 === 0) {
    return pause([
      act('fin_pause', 'Fin de la pause', ['fin_pause2'], 1),
      act('fin_pause_fin_travail', 'Fin de la pause et fin du travail', ['fin_pause2', 'fin'], 0),
    ])
  }
  return au([FIN_TRAVAIL])
}

/** Minutes of FINISHED pauses on a line — FEN_Pointage's `cumul_pause`
 *  (`CASE fin_pauseN WHEN 0 THEN 0 ELSE fin_pauseN - debut_pauseN END`, both
 *  summed, `ROUND(… / 60)`). A pause still running does not count until it ends. */
export function cumulPausesMin(l: LigneHoraire): number {
  const une = (debut: number, fin: number) => (fin > 0 ? fin - debut : 0)
  return Math.round((une(l.debut_pause1, l.fin_pause1) + une(l.debut_pause2, l.fin_pause2)) / 60)
}

// ── Europe/Paris wall clock ──

const PARIS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

interface Parties { y: number; mo: number; d: number; h: number; mi: number; s: number }

export function partiesParis(ms: number): Parties {
  const v: Record<string, string> = {}
  for (const p of PARIS.formatToParts(new Date(ms))) v[p.type] = p.value
  return { y: Number(v.year), mo: Number(v.month), d: Number(v.day), h: Number(v.hour), mi: Number(v.minute), s: Number(v.second) }
}

const p2 = (x: number) => String(x).padStart(2, '0')

/** `YYYYMMDD` — the HFSQL DATE literal of the Paris day. */
export function jourParis(ms: number): string {
  const p = partiesParis(ms)
  return `${p.y}${p2(p.mo)}${p2(p.d)}`
}

/** `YYYYMMDDHHMMSS` — the HFSQL DATETIME literal of the Paris wall clock
 *  (same compact shape as production-trm.ts nowDt, accepted by both drivers). */
export function dtParis(ms: number): string {
  const p = partiesParis(ms)
  return `${p.y}${p2(p.mo)}${p2(p.d)}${p2(p.h)}${p2(p.mi)}${p2(p.s)}`
}

/** Epoch ms of a Paris wall-clock time (two passes settle the DST offset). */
export function msHeureParis(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const voulu = Date.UTC(y, mo - 1, d, h, mi, s)
  let t = voulu
  for (let i = 0; i < 2; i++) {
    const p = partiesParis(t)
    t -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - voulu
  }
  return t
}

/** A DATETIME read back in either driver shape ('YYYY-MM-DD HH:MM:SS.mmm' on
 *  Windows, 'YYYYMMDDHHMMSS' on the Linux bridge), taken as Paris time. */
export function parseDtParisMs(v: unknown): number | null {
  const s = String(v ?? '').trim()
  if (!s || /^0+$/.test(s.replace(/\D/g, ''))) return null
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})/.exec(s)
  if (!m) return null
  return msHeureParis(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])
}

/** The day before a `YYYYMMDD`. */
export function jourPrecedent(jour: string): string {
  const t = new Date(Date.UTC(+jour.slice(0, 4), +jour.slice(4, 6) - 1, +jour.slice(6, 8)) - 86_400_000)
  return `${t.getUTCFullYear()}${p2(t.getUTCMonth() + 1)}${p2(t.getUTCDate())}`
}

/** ISO-8601 week of the Paris day — the numbering of lst_lissage / lst_prev
 *  (2026 runs to week 53 there, which only the ISO rule gives). */
export function semaineIso(ms: number): { annee: number; numero: number } {
  const p = partiesParis(ms)
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d))
  const jourSemaine = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - jourSemaine)
  const annee = d.getUTCFullYear()
  const numero = Math.ceil(((d.getTime() - Date.UTC(annee, 0, 1)) / 86_400_000 + 1) / 7)
  return { annee, numero }
}

/** `lst_message.message` is HTML written by Admin Pointage's editor
 *  (`<BODY bgColor=…><P><FONT …>`). The tablet shows text, never that markup. */
export function texteMessage(html: string | null | undefined): string {
  const entites: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)))
    .replace(/&([a-z]+);/gi, (x, e: string) => entites[e.toLowerCase()] ?? x)
    .split('\n')
    .map((l) => l.replace(/[ \t\r ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}
