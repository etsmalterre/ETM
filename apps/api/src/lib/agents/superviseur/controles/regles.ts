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

const jjmm = (yyyymmdd: string) => `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}`

/** Why evaluerCouverture() lets a line pass — what the report says when a
 *  « pièces à affecter » point closes. Same order as the rule. */
export function raisonCouverture(l: LigneCouverture, today: Date): string {
  const u = l.unite === 3 ? 'Ml' : 'kg'
  if (![1, 3].includes(l.unite) || !(l.quantite > 0)) return 'Ligne sans quantité en Kg ou Ml : plus contrôlée.'
  if (l.expedie >= l.quantite * EXPEDIE_SEUIL) return `Ligne expédiée : ${fmt(l.expedie)} ${u} sur ${fmt(l.quantite)} ${u}.`
  if (l.affecte >= l.quantite * COUVERTURE_SEUIL) return `Ligne couverte : ${fmt(l.affecte)} ${u} affectés sur ${fmt(l.quantite)} ${u} commandés.`
  const jours = joursAvant(l.dateLivraison, today)
  if (jours === null) return 'La ligne n’a plus de délai.'
  if (jours > COUVERTURE_HORIZON_J) return `Délai reporté au ${jjmm(l.dateLivraison!)}, au-delà des ${COUVERTURE_HORIZON_J} jours surveillés.`
  return `Délai dépassé depuis plus de ${COUVERTURE_RETARD_MAX_J} jours : plus suivi par ce contrôle.`
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

/** Why evaluerEnnoblissement() lets a line pass. */
export function raisonEnnoblissement(kgNonEnvoye: number, dateLivraison: string | null, today: Date): string {
  if (!(kgNonEnvoye > 0)) return 'L’écru réservé à la ligne est parti en teinture (ou n’y est plus réservé).'
  const jours = joursAvant(dateLivraison, today)
  if (jours === null) return 'La ligne n’a plus de délai.'
  if (jours > ENNOBLISSEMENT_HORIZON_J) return `Délai reporté au ${jjmm(dateLivraison!)}, au-delà des ${ENNOBLISSEMENT_HORIZON_J} jours surveillés.`
  return `Délai dépassé depuis plus de ${COUVERTURE_RETARD_MAX_J} jours : plus suivi par ce contrôle.`
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

/** Why evaluerFil() lets a yarn pass. */
export function raisonFil(e: { besoin: number; en_stock: number; commande: number }): string {
  return `Couvert : ${fmt(e.en_stock)} kg en stock et ${fmt(e.commande)} kg en commande pour ${fmt(e.besoin)} kg de besoin.`
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

// ── Client sans réponse — v2 (Isabelle's scores, 2026-09-23 → 25) ──
// v1 raised 10 mail points: 1 réussite, 5 partielles, 4 échecs. The comments
// fell in three groups, each answered here BEFORE a point is raised:
//   - not hers to see: Nicolas's technical threads without her in copy, and
//     fresh mail in her own inbox (« j'ai toujours le mail dans ma boîte »);
//   - « tu aurais dû vérifier dans ETM »: an address change already entered,
//     a credit note already emailed from ETM;
//   - settled by phone: nothing can see it — « Marquer résolu » on the report.

/** Working hours a conversation in the reader's own inbox waits before it is
 *  reported (5 working days — she reads her inbox; the report catches what
 *  slipped). WECAMECA at 6 days was still worth raising, Le Slip Français at 4
 *  and Promethee at 1 were not. */
export const BOITE_LECTRICE_DELAI_H = 5 * 24

export interface PorteeConversation {
  /** Mailboxes that received the client's last message. */
  boites: readonly string[]
  /** To + Cc of the client's last message. */
  destinataires: readonly string[]
  participants: readonly string[]
  heuresAttente: number
}

const prenom = (email: string) => email.split('@')[0]

/** Why a waiting conversation is NOT for the report, or null when it is. */
export function horsPortee(c: PorteeConversation, lectrice: string, surCopie: readonly string[]): string | null {
  const l = lectrice.toLowerCase()
  if (c.boites.length > 0 && c.boites.every((b) => surCopie.includes(b)) && !c.participants.includes(l)) {
    return `Échange dans la boîte de ${c.boites.map(prenom).join(', ')} sans ${prenom(l)} en copie : hors rapport.`
  }
  const chezElle = c.boites.includes(l) || c.destinataires.includes(l)
  if (chezElle && c.heuresAttente < BOITE_LECTRICE_DELAI_H) {
    const j = Math.floor(c.heuresAttente / 24)
    return `Dans la boîte de ${prenom(l)} depuis ${j} jour${j > 1 ? 's' : ''} ouvré${j > 1 ? 's' : ''} : signalé à partir de ${BOITE_LECTRICE_DELAI_H / 24}.`
  }
  return null
}

/** Letters and digits only, no accent — HFSQL text may carry a lost byte (U+FFFD). */
export const plier = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Is the address a client announces already among its ETM addresses? Same
 *  postcode, and a compatible town (first 3 letters) unless one side is
 *  unreadable. Pure. */
export function adresseConnue<A extends { cp: string | null; ville: string | null }>(
  cible: { cp: string; ville: string },
  adresses: readonly A[],
): A | null {
  const cp = cible.cp.replace(/\s/g, '')
  if (!/^\d{4,5}$/.test(cp)) return null
  const v = plier(cible.ville).slice(0, 3)
  return adresses.find((a) => {
    if (String(a.cp ?? '').replace(/\s/g, '') !== cp) return false
    const va = plier(a.ville ?? '')
    return !v || !va || String(a.ville ?? '').includes('�') || va.startsWith(v)
  }) ?? null
}

/** A document ETM emailed (envoi_email). */
export interface EnvoiEtm {
  /** ms */
  date: number
  adresse: string
  /** « Avoir N°9240 », « Confirmation de commande N°3837 »… */
  libelle: string
}

/** « le 18/09 (vmousnier@idylle.fr), le 21/09 (comptabilite@idylle.fr) » — one mention per day and address. */
export function listeEnvois(envois: readonly EnvoiEtm[]): string {
  const vus = new Set<string>()
  const out: string[] = []
  for (const e of [...envois].sort((a, b) => a.date - b.date)) {
    const d = new Date(e.date).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' })
    const k = `${d}|${e.adresse}`
    if (vus.has(k)) continue
    vus.add(k)
    out.push(`le ${d} (${e.adresse})`)
  }
  return out.join(', ')
}

/** Clients who agreed to receive what is available (decision Isabelle,
 *  2026-09-25, on THUASNE): a short line is still worth knowing, as « info »,
 *  never as a point to handle. IDclient → the agreement in words. */
export const ACCORDS_LIVRAISON_PARTIELLE: ReadonlyMap<number, string> = new Map([
  [52, 'accord THUASNE : livraison de ce qui est disponible'],
])
