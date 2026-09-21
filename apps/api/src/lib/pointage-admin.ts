/**
 * Pure rules of Admin Pointage — the office's corrections of the time clock
 * (TRM menu « Pointage », plan ~/.claude/plans/admin-pointage.md § 7).
 * No I/O here: the reads live in lib/pointage.ts, the writes in
 * lib/pointage-ecritures.ts (shifts) and lib/pointage-admin-ecritures.ts
 * (salariés, messages).
 *
 * The legacy typed every hour as « HH:MM » against the row's date and turned
 * it into epoch seconds with ONE rule (FEN_Horaires, the six `Sortie de
 * COL_*`, and FEN_Nouvel_horaire.BTN_Valider — same code in both):
 *   - `debut` is always on the row's date, and cannot be emptied;
 *   - any other hour STRICTLY later than the start (compared as text) is on
 *     the same day, otherwise on the NEXT day — a 21:00 → 05:00 night shift
 *     keeps `date` = the evening;
 *   - an emptied cell writes 0.
 * The legacy checked nothing else: a pause 1 ending before it started, or a
 * `fin` before a pause, was stored as typed. The port refuses those — a shift
 * whose stamps are out of order breaks the pauses / présence sums and the TRS
 * presence journal — and says which hour is wrong (assumed delta).
 */
import { COLONNES_HEURE, msHeureParis, type ColonneHeure, type LigneHoraire } from './pointage-etat.js'

/** `HH:MM`, 24 h, zero-padded — what the screens send and what the legacy compared as text. */
export const HEURE_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** A typed correction the rules refuse — the route answers 400 with the message. */
export class SaisieInvalide extends Error {
  readonly code = 'saisie_invalide'
}

export type SaisieHeures = Partial<Record<ColonneHeure, string | null>>

const LIBELLES: Record<ColonneHeure, string> = {
  debut: 'le début',
  debut_pause1: 'le début de la pause 1',
  fin_pause1: 'la fin de la pause 1',
  debut_pause2: 'le début de la pause 2',
  fin_pause2: 'la fin de la pause 2',
  fin: 'la fin',
}

function parties(jour: string): { y: number; mo: number; d: number } {
  if (!/^\d{8}$/.test(jour)) throw new SaisieInvalide(`Date invalide : ${jour}`)
  return { y: +jour.slice(0, 4), mo: +jour.slice(4, 6), d: +jour.slice(6, 8) }
}

function heureParts(heure: string, colonne: ColonneHeure): { h: number; mi: number } {
  const m = HEURE_RE.exec(heure.trim())
  if (!m) throw new SaisieInvalide(`Heure invalide pour ${LIBELLES[colonne]} : « ${heure} » (attendu HH:MM).`)
  return { h: +m[1], mi: +m[2] }
}

/** Epoch seconds of `heure` on `jour` — or on the day after, when the hour is
 *  not strictly later than the start's « HH:MM » (the legacy's `MoiMême >
 *  COL_Debut` string comparison). `debutHeure` is the start as « HH:MM ». */
export function epochDepuisHeure(jour: string, heure: string, colonne: ColonneHeure, debutHeure: string | null): number {
  const { y, mo, d } = parties(jour)
  const { h, mi } = heureParts(heure, colonne)
  const memeJour = colonne === 'debut' || debutHeure === null || heure.trim() > debutHeure.trim()
  return Math.floor(msHeureParis(y, mo, d + (memeJour ? 0 : 1), h, mi, 0) / 1000)
}

/** The stamps of a shift after a correction: the current line's epochs with
 *  `saisie` applied (an absent key keeps the stamp, null clears it), each hour
 *  placed by the after-midnight rule against the (possibly new) start, then
 *  checked for order. Returns the six columns in epoch seconds. */
export function appliquerSaisie(
  jour: string,
  actuelle: Pick<LigneHoraire, ColonneHeure> | null,
  saisie: SaisieHeures,
): Record<ColonneHeure, number> {
  const debutHeure = saisie.debut !== undefined ? saisie.debut : actuelle ? heureDe(actuelle.debut) : null
  if (!debutHeure || !debutHeure.trim()) throw new SaisieInvalide('Vous ne pouvez pas mettre l’heure de début à vide.')
  const out = {} as Record<ColonneHeure, number>
  for (const c of COLONNES_HEURE) {
    const v = saisie[c]
    if (v === undefined) {
      // untouched: keep the stamp, but a start that moved re-places nothing —
      // the other stamps are absolute instants already
      out[c] = actuelle ? actuelle[c] : 0
    } else if (v === null || v.trim() === '') {
      if (c === 'debut') throw new SaisieInvalide('Vous ne pouvez pas mettre l’heure de début à vide.')
      out[c] = 0
    } else {
      out[c] = epochDepuisHeure(jour, v, c, c === 'debut' ? null : debutHeure)
    }
  }
  verifierOrdre(out)
  return out
}

/** Stamps must be non-decreasing in the legacy's column order, and a pause
 *  cannot end without having started. */
export function verifierOrdre(h: Record<ColonneHeure, number>): void {
  if (h.debut <= 0) throw new SaisieInvalide('Vous ne pouvez pas mettre l’heure de début à vide.')
  if (h.fin_pause1 > 0 && h.debut_pause1 === 0) throw new SaisieInvalide('La pause 1 a une fin mais pas de début.')
  if (h.fin_pause2 > 0 && h.debut_pause2 === 0) throw new SaisieInvalide('La pause 2 a une fin mais pas de début.')
  if (h.debut_pause2 > 0 && h.fin_pause1 === 0) throw new SaisieInvalide('La pause 2 commence alors que la pause 1 n’est pas finie.')
  let prev: { c: ColonneHeure; s: number } = { c: 'debut', s: h.debut }
  for (const c of COLONNES_HEURE.slice(1)) {
    const s = h[c]
    if (s === 0) continue
    if (s < prev.s) {
      throw new SaisieInvalide(`${majuscule(LIBELLES[c])} (${heureDe(s)}) est avant ${LIBELLES[prev.c]} (${heureDe(prev.s)}).`)
    }
    prev = { c, s }
  }
}

const majuscule = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const HM = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** « 08:02 » of an epoch second in Paris, '' for 0. */
export function heureDe(s: number): string {
  return s > 0 ? HM.format(new Date(s * 1000)) : ''
}

/** Gross presence in minutes, `fin − debut`, pauses NOT deducted — the legacy
 *  grid's `cumul_presence` (FEN_Horaires_1$Requête). null while the shift is open. */
export function presenceMin(l: Pick<LigneHoraire, 'debut' | 'fin'>): number | null {
  return l.fin > 0 && l.debut > 0 ? Math.floor((l.fin - l.debut) / 60) : null
}

/** A shift open for longer than this is one the office has to close: the
 *  tablet no longer continues it (lib/pointage-etat.ts POSTE_OUVERT_MAX_S). */
export { POSTE_OUVERT_MAX_S } from './pointage-etat.js'

/** Which presence-journal rows (`mps.pointage.en_poste`) a stamp corresponds
 *  to: back at work (1) or leaving (0). */
export const EN_POSTE_PAR_COLONNE: Record<ColonneHeure, 0 | 1> = {
  debut: 1,
  debut_pause1: 0,
  fin_pause1: 1,
  debut_pause2: 0,
  fin_pause2: 1,
  fin: 0,
}

/** `YYYYMMDD` bounds of a period, checked. */
export function periodeValide(du: unknown, au: unknown): { du: string; au: string } {
  const d = String(du ?? '')
  const a = String(au ?? '')
  if (!/^\d{8}$/.test(d) || !/^\d{8}$/.test(a)) throw new SaisieInvalide('Période invalide (attendu du=YYYYMMDD&au=YYYYMMDD).')
  if (a < d) throw new SaisieInvalide('La fin de la période est avant son début.')
  return { du: d, au: a }
}

/** The 3-character login of a salarié, as the legacy stored it (upper-cased, trimmed). */
export function loginNormalise(login: string): string {
  const v = login.trim().toUpperCase()
  if (!/^[A-Z0-9]{1,3}$/.test(v)) throw new SaisieInvalide('Le login fait 1 à 3 lettres ou chiffres.')
  return v
}
