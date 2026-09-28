// RH menu — shared types and helpers for RH › Employés and RH › Charge de
// travail. The rules behind the workload figures live server-side in
// apps/api/src/lib/rh-charge.ts; this file only types and formats them.

import { API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'

export interface Employe {
  id: number
  prenom: string
  nom: string
  poste: string
  email: string
  /** YYYY-MM-DD */
  dateEmbauche: string | null
  dateNaissance: string | null
  idutilisateur: number | null
  heuresContrat: number
  photoMaj: string | null
}

export type Automatisable = 'oui' | 'partiel' | 'non' | 'inconnu'
export type Categorie = 'tache' | 'improductivite_structurelle'

export interface TacheCharge {
  nom: string
  description: string
  methode: string
  heures: number
  automatisable: Automatisable
  automatise: boolean
  categorie: Categorie
  indicateur: string | null
  minutesParUnite: number | null
  /** Estimated task: units per week, typed. */
  volumeSaisi: number | null
  /** Estimated task: its unit, singular. */
  unite: string
}

export interface TotauxCharge {
  /** Every row, the margin included. */
  taches: number
  aAutomatiser: number
  automatise: number
}

export interface TacheActuelle extends TacheCharge {
  /** The figure shown: the measure for a measured task on the latest relevé. */
  heuresActuelles: number
  /** Units per week (last 4 complete weeks) for a measured task, else null. */
  volumeHebdo: number | null
}

export interface ChargeResponse {
  versions: Array<{ id: number; dateReleve: string; note: string; creePar: string }>
  version: {
    id: number
    dateReleve: string
    /** false = an older relevé, shown as typed. */
    actuelle: boolean
    taches: TacheActuelle[]
    totaux: TotauxCharge
  } | null
}

export interface PointMensuel extends TotauxCharge {
  /** YYYY-MM */
  mois: string
  releves: string[]
  enCours: boolean
  avantPremierReleve: boolean
}

export interface EvolutionResponse {
  points: PointMensuel[]
  releves: Array<{ id: number; dateReleve: string }>
}

export interface Indicateur {
  cle: string
  label: string
  unite: string
}

// ── Suivi (append-only record, apps/api/src/lib/rh-suivi.ts) ──

export const TYPES_EVENEMENT = [
  { cle: 'entretien', label: 'Entretien' },
  { cle: 'information', label: 'Information / annonce' },
  { cle: 'avertissement', label: 'Avertissement / sanction' },
  { cle: 'formation', label: 'Formation' },
  { cle: 'medical', label: 'Visite médicale' },
  { cle: 'courrier', label: 'Courrier / email' },
  { cle: 'note', label: 'Note' },
  { cle: 'rectificatif', label: 'Rectificatif' },
] as const

export type TypeEvenement = (typeof TYPES_EVENEMENT)[number]['cle']

export function libelleType(cle: string): string {
  return TYPES_EVENEMENT.find((t) => t.cle === cle)?.label ?? cle
}

export interface PieceJointe {
  id: number
  nom: string
  typeMime: string
  taille: number
  sha256: string
}

export interface Evenement {
  id: number
  idemploye: number
  /** YYYY-MM-DD — when it happened */
  dateEvenement: string
  type: string
  titre: string
  presents: string
  contenu: string
  rectifie: number | null
  rectifiePar: number[]
  /** ISO, server time — when it was recorded */
  creeLe: string
  creePar: string
  hash: string
  pieces: PieceJointe[]
}

export function pieceUrl(idemploye: number, e: Pick<Evenement, 'id'>, p: Pick<PieceJointe, 'id'>): string {
  return `${API_URL}/rh/employes/${idemploye}/evenements/${e.id}/pieces/${p.id}`
}

export function nomComplet(e: Pick<Employe, 'prenom' | 'nom'>): string {
  return [e.prenom, e.nom].filter(Boolean).join(' ')
}

export function initiales(e: Pick<Employe, 'prenom' | 'nom'>): string {
  return `${e.prenom.charAt(0)}${e.nom.charAt(0)}`.toUpperCase()
}

export function photoUrl(e: Pick<Employe, 'id' | 'photoMaj'>): string | undefined {
  return e.photoMaj ? `${API_URL}/rh/employes/${e.id}/photo?v=${encodeURIComponent(e.photoMaj)}` : undefined
}

// ── Dates ────────────────────────────────────────────────

function parseIso(d: string): { y: number; m: number; j: number } {
  return { y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)), j: Number(d.slice(8, 10)) }
}

/** 2025-11-25 → 25/11/2025 */
export function formatDateFr(d: string | null | undefined): string {
  if (!d) return ''
  const { y, m, j } = parseIso(d)
  return `${String(j).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

/** Whole years and months between a date and `today`, e.g. { ans: 3, mois: 4 }. */
export function ecart(d: string, today = new Date()): { ans: number; mois: number } {
  const { y, m, j } = parseIso(d)
  let mois = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m)
  if (today.getDate() < j) mois -= 1
  mois = Math.max(0, mois)
  return { ans: Math.floor(mois / 12), mois: mois % 12 }
}

/** « 3 ans et 4 mois », « 7 mois », « moins d’un mois ». */
export function formatAnciennete(d: string | null, today = new Date()): string {
  if (!d) return ''
  const { ans, mois } = ecart(d, today)
  const a = ans > 0 ? `${ans} an${ans > 1 ? 's' : ''}` : ''
  const m = mois > 0 ? `${mois} mois` : ''
  if (a && m) return `${a} et ${m}`
  return a || m || 'moins d’un mois'
}

export function age(d: string | null, today = new Date()): number | null {
  return d ? ecart(d, today).ans : null
}

/** Days until the next birthday (0 = today). A 29 February falls on 1 March. */
export function joursAvantAnniversaire(d: string | null, today = new Date()): number | null {
  if (!d) return null
  const { m, j } = parseIso(d)
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let next = new Date(t0.getFullYear(), m - 1, j)
  if (next < t0) next = new Date(t0.getFullYear() + 1, m - 1, j)
  return Math.round((next.getTime() - t0.getTime()) / 86_400_000)
}

export function todayIso(today = new Date()): string {
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const j = String(today.getDate()).padStart(2, '0')
  return `${y}-${m}-${j}`
}

// ── Workload display ─────────────────────────────────────

/** « 2,3 h » — hours always with one decimal, French comma. */
export function fmtHeures(h: number): string {
  return `${fmtNum(h, h % 1 === 0 ? 0 : h * 10 % 1 === 0 ? 1 : 2)} h`
}

export function pctContrat(h: number, contrat: number): string {
  return contrat > 0 ? `${fmtNum((h / contrat) * 100, 0)} %` : ''
}

// ── The three automation states ─────────────────────────
// À automatiser = automatisable 'oui'; 'partiel' / 'inconnu' (kept from the
// spreadsheet) count as « the rest ». Colours validated with the dataviz
// validator (#3B7DC9, #C2410C, #17915B: every check passes on white).

export type EtatAuto = 'aAutomatiser' | 'automatise' | null

export function etatAuto(t: Pick<TacheCharge, 'automatise' | 'automatisable'>): EtatAuto {
  if (t.automatise) return 'automatise'
  return t.automatisable === 'oui' ? 'aAutomatiser' : null
}

export const COULEURS = {
  taches: '#3B7DC9',
  aAutomatiser: '#C2410C',
  automatise: '#17915B',
  nonAttribue: '#E4E4E7',
} as const

// ── The task's figures: min / unité × unités / sem. ─────

export interface KpiTache {
  /** Minutes per unit. */
  minutes: number
  /** Unit, singular. */
  unite: string
  /** Units per week. */
  volume: number
  /** etm = measured now (4 last weeks), estime = typed, releve = implied by an old relevé's hours. */
  source: 'etm' | 'estime' | 'releve'
  minutesSemaine: number
}

/** A forfait (hours only) has no figures: null. */
export function kpiTache(
  t: TacheActuelle,
  indicateurs: Indicateur[],
  actuelle: boolean,
): KpiTache | null {
  const minutes = t.minutesParUnite
  if (!minutes || minutes <= 0) return null
  if (t.indicateur) {
    const unite = indicateurs.find((i) => i.cle === t.indicateur)?.unite ?? 'unité'
    const mesure = actuelle && t.volumeHebdo != null
    const volume = mesure ? t.volumeHebdo! : (t.heures * 60) / minutes
    return { minutes, unite, volume, source: mesure ? 'etm' : 'releve', minutesSemaine: minutes * volume }
  }
  if (t.volumeSaisi == null) return null
  return { minutes, unite: t.unite || 'unité', volume: t.volumeSaisi, source: 'estime', minutesSemaine: minutes * t.volumeSaisi }
}

/** 10 → « 10 min », 0,5 → « 30 s ». */
export function fmtMinutes(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`
  return `${fmtNum(m, m % 1 ? 1 : 0)} min`
}

/** 8 → « 8 », 8,33 → « 8,3 », 0,25 → « 0,25 ». */
export function fmtVolume(v: number): string {
  const r = Math.round(v * 100) / 100
  return fmtNum(r, r % 1 === 0 ? 0 : r < 1 ? 2 : 1)
}

/** « commande » → « commandes », « mise à jour » → « mises à jour ». */
export function pluriel(unite: string, n: number): string {
  if (n < 2) return unite
  const [premier, ...reste] = unite.split(' ')
  return [/[sxz]$/.test(premier) ? premier : `${premier}s`, ...reste].join(' ')
}

/** 140 → « 2 h 20 », 45 → « 45 min ». */
export function fmtDuree(minutes: number): string {
  const m = Math.round(minutes)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`
}

/** One free-text note per task: the spreadsheet's description and method. */
export function noteDe(t: Pick<TacheCharge, 'description' | 'methode'>): string {
  return [t.description.trim(), t.methode.trim()].filter(Boolean).join('\n\n')
}

const MOIS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
export const MOIS_COURT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

/** 2025-11 → « novembre 2025 » */
export function moisLong(m: string): string {
  return `${MOIS_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
}
