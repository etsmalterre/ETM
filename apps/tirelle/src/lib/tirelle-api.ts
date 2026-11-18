// The lab's calls to the MPS API (routes/tirelle.ts). Shapes mirror
// lib/tirelle-labo.ts on the API side.
import { apiFetch, type ApiError } from '@/lib/api'

export type EtapeLabo = 'a_jeter' | 'avant_lavage' | 'apres_lavage'
export type VerdictColoris = 'conforme' | 'ecart'

export interface Appareil {
  id: number
  libelle: string
}

export interface MesuresTirelle {
  laize: number
  poids: number
  /** null = not measured, 0 is a measure (#1358). */
  stabh: number | null
  stabl: number | null
  vrillage: number | null
  /** Allongement H / L in % (10 cm strip, 2026-11-10): null = not measured, 0 is a measure. */
  allongementh: number | null
  allongementl: number | null
  coloris: VerdictColoris | null
}

export interface Tolerances {
  laize: { min: number; max: number }
  poids: { min: number; max: number }
  stabh: number | null
  stabl: number | null
  vrillageMax: number
  /** The fiche's « Allongement H / L » min · max; 0 = no bound. */
  allongementh: { min: number; max: number }
  allongementl: { min: number; max: number }
}

/** The lab's window: 5 working days from the reception (API delaiControle). */
export interface DelaiControle {
  echeance: string
  joursDepuis: number
  restants: number
  rouge: boolean
}

export interface LotLabo {
  idsuivilot: number
  lot: string
  reception: string | null
  sous_traitant: string
  reference: string
  coloris: string
  etape: EtapeLabo
  demandes: { rond: string[]; carre: string[] }
  manque: string[]
  mesures: MesuresTirelle
  tolerances: Tolerances
  hors: Record<'laize' | 'poids' | 'stabh' | 'stabl' | 'vrillage' | 'allongementh' | 'allongementl' | 'coloris', boolean | null>
  rond0: { lot: string; date: string | null; estCeLot: boolean } | null
  emplacement: string
  /** The lot's observations — the same field as Qualité › Suivi lots in ETM. */
  observations: string
  /** Who the lot is for, by name (empty = stock). */
  clients: string[]
  /** The lab's window (null before the reception, or for a bin run). */
  delai: DelaiControle | null
  a_jeter: { depuis: string; motif: string; casier: string } | null
}

export interface LotsLabo {
  etapes: Array<{ etape: EtapeLabo; libelle: string }>
  lots: LotLabo[]
}

export async function fetchAppareil(): Promise<Appareil | null> {
  try {
    return await apiFetch<Appareil>('/tirelle/appareil/moi')
  } catch (e) {
    // 401 = not enrolled (or revoked): an answer, not an error.
    if ((e as ApiError).status === 401) return null
    throw e
  }
}

export const fetchEnrolementEnAttente = () => apiFetch<{ enAttente: boolean }>('/tirelle/appareil/enrolement-en-attente')

export const enrolerAppareil = (code: string) =>
  apiFetch<Appareil>('/tirelle/appareil/enroler', { method: 'POST', body: JSON.stringify({ code }) })

export const fetchLots = () => apiFetch<LotsLabo>('/tirelle/lots')

const post = <T = { ok: true }>(path: string, body?: unknown) =>
  apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const enregistrerAvantLavage = (id: number, b: { laize: string; poids: string; allongementh: string; allongementl: string; coloris: VerdictColoris | null; observations: string }) =>
  post<{ lot: LotLabo | null }>(`/tirelle/lots/${id}/avant-lavage`, b)
export const terminerApresLavage = (id: number, b: { stabh: string; stabl: string; vrillage: string; casier: string; observations: string }) =>
  post(`/tirelle/lots/${id}/apres-lavage`, b)
export const marquerJete = (id: number) => post(`/tirelle/lots/${id}/jete`)

// ── The shelf: find a stored tirelle, empty a box (LIVA #1380) ──

export interface TirelleTrouvee {
  idsuivilot: number
  lot: string
  reception: string | null
  reference: string
  coloris: string
  sous_traitant: string
  clients: string[]
  /** The box holding square + tirelle (« B3 »). Only stored tirelles are returned. */
  boite: string
  /** After a reprise: still in its box, to be thrown. */
  a_jeter: boolean
}

export interface Recherche {
  lots: TirelleTrouvee[]
  /** How many matched; `lots` is capped. */
  total: number
}

export interface EtatBoite {
  boite: string
  n: number
  /** Reception of its oldest and of its most recent lot (ISO). */
  du: string | null
  au: string | null
}

export interface Boites {
  boites: EtatBoite[]
  /** Reception (ISO) of the oldest lot still in a box: how far back the archives go. */
  depuis: string | null
}

export const chercherTirelles = (q: string) => apiFetch<Recherche>(`/tirelle/recherche?q=${encodeURIComponent(q)}`)
export const fetchContenuBoite = (boite: string) => apiFetch<Recherche>(`/tirelle/recherche?boite=${encodeURIComponent(boite)}`)
export const fetchBoites = () => apiFetch<Boites>('/tirelle/boites')
export const viderBoite = (boite: string) => post<{ boite: string; lots: string[] }>(`/tirelle/boites/${encodeURIComponent(boite)}/vider`)
