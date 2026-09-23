// Agent « Superviseur » — the pure rules of the checks (tested in
// regles.test.ts). The readers in the sibling files only fetch rows and hand
// them here, so every threshold is visible, tested and in one place.
//
// Thresholds measured on prod 2026-09-23 (77 open ETM orders, 184 roll lines):
// ~6 lines short of rolls within 21 days, 1 fini line with écru not sent to the
// dyer, 1 yarn pair at −0,7 kg (rounding — hence the tolerance).

import type { Gravite } from '../types.js'

/** Days from `today` (local midnight) to a YYYYMMDD date; null if not a date. */
export function joursAvant(yyyymmdd: string | null | undefined, today: Date): number | null {
  const d = String(yyyymmdd ?? '')
  if (!/^\d{8}$/.test(d)) return null
  const t = new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)))
  const t0 = new Date(today)
  t0.setHours(0, 0, 0, 0)
  return Math.round((t.getTime() - t0.getTime()) / 86_400_000)
}

/** « le 30/09 (dans 7 j) » / « le 12/09 (dépassé de 11 j) » / « aujourd’hui ». */
export function delaiTexte(yyyymmdd: string, jours: number): string {
  const jj = `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}`
  if (jours === 0) return `le ${jj} (aujourd’hui)`
  return jours > 0 ? `le ${jj} (dans ${jours} j)` : `le ${jj} (dépassé de ${-jours} j)`
}

export const fmt = (v: number, d = 0) =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/\s/g, ' ')

// ── Couverture d'une ligne client (pièces à affecter / production à lancer) ──

/** Only lines due within this many days are checked (past délais included). */
export const COUVERTURE_HORIZON_J = 21
/** Due within this many days (or past) → urgent. */
export const COUVERTURE_URGENT_J = 7
/** A line counts as covered from this share of its quantity (rolls never land exactly). */
export const COUVERTURE_SEUIL = 0.9
/** A line counts as shipped from this share. */
export const EXPEDIE_SEUIL = 0.98
/** Past délais older than this are stale data (framework orders called off over
 *  months — 1 382 days on order 1982), not a pending action: left to a later check. */
export const COUVERTURE_RETARD_MAX_J = 30

export interface LigneCouverture {
  quantite: number
  /** 1 = Kg, 3 = Ml; other units are not checked. */
  unite: number
  /** Reserved in the line's unit: rolls (écru, fini) + planned knitting. */
  affecte: number
  expedie: number
  dateLivraison: string | null
}

export function evaluerCouverture(l: LigneCouverture, today: Date): { gravite: Gravite; jours: number; manque: number } | null {
  if (![1, 3].includes(l.unite) || !(l.quantite > 0)) return null
  if (l.expedie >= l.quantite * EXPEDIE_SEUIL) return null
  if (l.affecte >= l.quantite * COUVERTURE_SEUIL) return null
  const jours = joursAvant(l.dateLivraison, today)
  if (jours === null || jours > COUVERTURE_HORIZON_J || jours < -COUVERTURE_RETARD_MAX_J) return null
  return { gravite: jours <= COUVERTURE_URGENT_J ? 'urgent' : 'attention', jours, manque: l.quantite - l.affecte }
}

// ── Écru réservé à une ligne fini mais pas envoyé au teinturier ──

/** Checked when the délai is within this many days. */
export const ENNOBLISSEMENT_HORIZON_J = 30
/** Within this many days (or past) → urgent: dyeing takes weeks. */
export const ENNOBLISSEMENT_URGENT_J = 14

export function evaluerEnnoblissement(kgNonEnvoye: number, dateLivraison: string | null, today: Date): { gravite: Gravite; jours: number } | null {
  if (!(kgNonEnvoye > 0)) return null
  const jours = joursAvant(dateLivraison, today)
  if (jours === null || jours > ENNOBLISSEMENT_HORIZON_J || jours < -COUVERTURE_RETARD_MAX_J) return null
  return { gravite: jours <= ENNOBLISSEMENT_URGENT_J ? 'urgent' : 'attention', jours }
}

// ── Fil à commander ──

/** A deficit below this is rounding, not a need (−0,7 kg on 220 kg seen on prod). */
export const FIL_TOLERANCE_KG = 5
/** From this deficit → urgent. */
export const FIL_URGENT_KG = 50

/** `disponible` = en stock + commandé − besoin (lib/fil-etat.ts). */
export function evaluerFil(disponible: number): { gravite: Gravite; manque: number } | null {
  if (disponible > -FIL_TOLERANCE_KG) return null
  const manque = -disponible
  return { gravite: manque >= FIL_URGENT_KG ? 'urgent' : 'attention', manque }
}

// ── Client sans réponse ──

/** Working hours (Mon–Fri) a client waits before it is reported. */
export const REPONSE_ATTENTION_H = 24
/** From this wait → urgent. */
export const REPONSE_URGENT_H = 48

export function evaluerAttente(heuresOuvrees: number, urgence: 'basse' | 'normale' | 'haute'): Gravite {
  return heuresOuvrees >= REPONSE_URGENT_H || urgence === 'haute' ? 'urgent' : 'attention'
}

// ── Fil non affecté sur une commande Tricotage Malterre (LIVA #1159) ──

/** Days after the order date before a missing affectation is reported. */
export const FIL_AFFECTATION_DELAI_J = 1

export function evaluerAffectationFil(nbManquants: number, dateCommande: string | null, today: Date): Gravite | null {
  if (nbManquants <= 0) return null
  const age = joursAvant(dateCommande, today)
  // Order date unknown → report; otherwise give the office one day.
  if (age !== null && -age < FIL_AFFECTATION_DELAI_J) return null
  return 'attention'
}
