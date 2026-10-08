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

// ── Ligne en retard : couverte mais pas expédiée ──
// A late line NOT covered is couverture's (« dépassé de X j : pièces à
// affecter ») — never two points on one line. Same 30-day limit: older délais
// are stale data (framework orders whose délai was never moved).

/** Late from this many days past the délai → urgent. */
export const RETARD_URGENT_J = 7

/** A late line with what can leave today: pieces ready to ship (a Validé fini
 *  roll, an écru piece in stock) reserved to it and not shipped, in its unit.
 *  `affecte` alone is not « ready »: the gauge also counts écru still at the
 *  dyer and planned knitting (replay 2026-10-07: « 3 582 Ml affectés sur
 *  1 430 » on a line with nothing to ship). */
export interface LigneRetard extends LigneCouverture {
  pret: number
  piecesPretes: number
}

export function evaluerRetard(l: LigneRetard, today: Date): { gravite: Gravite; joursRetard: number; pret: boolean } | null {
  if (![1, 3].includes(l.unite) || !(l.quantite > 0)) return null
  if (l.expedie >= l.quantite * EXPEDIE_SEUIL) return null
  if (l.affecte < l.quantite * COUVERTURE_SEUIL) return null
  const jours = joursAvant(l.dateLivraison, today)
  if (jours === null || jours >= 0 || jours < -COUVERTURE_RETARD_MAX_J) return null
  // Nothing ready and nothing in the pipe beyond what already left: a short
  // delivery (AGAPE N°3792: 208 Ml assigned, 208 shipped, 214 ordered).
  if (l.piecesPretes === 0 && l.expedie >= l.affecte * EXPEDIE_SEUIL) return null
  return { gravite: -jours >= RETARD_URGENT_J ? 'urgent' : 'attention', joursRetard: -jours, pret: l.piecesPretes > 0 }
}

export function raisonRetard(l: LigneRetard, today: Date): string {
  const u = l.unite === 3 ? 'Ml' : 'kg'
  if (![1, 3].includes(l.unite) || !(l.quantite > 0)) return 'Ligne sans quantité en Kg ou Ml : plus contrôlée.'
  if (l.expedie >= l.quantite * EXPEDIE_SEUIL) return `Ligne expédiée : ${fmt(l.expedie)} ${u} sur ${fmt(l.quantite)} ${u}.`
  if (l.affecte < l.quantite * COUVERTURE_SEUIL) return 'Ligne pas encore couverte : suivie par « Pièces à affecter / production à lancer ».'
  const jours = joursAvant(l.dateLivraison, today)
  if (jours === null) return 'La ligne n’a plus de délai.'
  if (jours >= 0) return `Délai au ${jjmm(l.dateLivraison!)} : pas encore dépassé.`
  if (jours < -COUVERTURE_RETARD_MAX_J) return `Délai dépassé depuis plus de ${COUVERTURE_RETARD_MAX_J} jours : plus suivi par ce contrôle.`
  return `Tout ce qui était affecté est parti (${fmt(l.expedie)} ${u} sur ${fmt(l.quantite)} ${u}) : reliquat sans pièce.`
}

/** The point's sentence after the délai. */
export function messageRetard(l: LigneRetard, pret: boolean): string {
  const u = l.unite === 3 ? 'Ml' : 'kg'
  const exp = l.expedie > 0 ? `${fmt(l.expedie)} ${u} déjà expédiés sur ${fmt(l.quantite)} ${u}` : `rien d’expédié sur ${fmt(l.quantite)} ${u}`
  return pret
    ? `${exp} ; ${fmt(l.pret)} ${u} prêts (${l.piecesPretes} pièce${l.piecesPretes > 1 ? 's' : ''}) à expédier, ou prévenir le client.`
    : `${exp} ; rien de prêt : la ligne attend la production ou la teinture : prévenir le client et reporter le délai.`
}

// ── Confirmation de commande jamais envoyée ──

/** Orders before this date were confirmed from WinDev — not checked. */
export const CONFIRMATION_DEPUIS = '20260929'
/** Working days after the order date before the point is raised; urgent from the second value. */
export const CONFIRMATION_ATTENTION_JO = 2
export const CONFIRMATION_URGENT_JO = 5

/** Monday–Friday days from a YYYYMMDD date (excluded) to `today` (included). */
export function joursOuvresDepuis(yyyymmdd: string | null | undefined, today: Date): number | null {
  const avant = joursAvant(yyyymmdd, today)
  if (avant === null) return null
  let n = 0
  for (let k = avant + 1; k <= 0; k++) {
    const d = new Date(today)
    d.setDate(d.getDate() + k)
    if (d.getDay() !== 0 && d.getDay() !== 6) n++
  }
  return n
}

export function evaluerConfirmation(dateCommande: string | null, today: Date): { gravite: Gravite; jours: number } | null {
  const j = joursOuvresDepuis(dateCommande, today)
  if (j === null || j < CONFIRMATION_ATTENTION_JO) return null
  return { gravite: j >= CONFIRMATION_URGENT_JO ? 'urgent' : 'attention', jours: j }
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
// ── Palier suivant (commande à arrondir au rouleau) ──

/** A line is checked while its order is this fresh (days since the order
 *  date): later the order is confirmed and in production — too late to offer
 *  more. Measured on prod 2026-10-07: ~1 line a month within reach of the
 *  next band. */
export const PALIER_FENETRE_J = 7

/** Below this drop of the unit price the call is not worth it (611 Ml at
 *  8,75 € vs 612 Ml at 8,68 € — a rounding, not a sale). */
export const PALIER_BAISSE_MIN = 0.03

/** One order line, priced by calcLignePriceClient (pricing-ligne-client.ts) —
 *  the SAME engine as Tricobot's « À proposer au client ? » in the line form,
 *  so the check fires exactly where the screen showed the nudge (15 %). */
export interface LignePalier {
  quantite: number
  /** € per unit typed on the line (0 when empty). */
  prixSaisi: number
  prix: number | null
  nearNextTranche: boolean
  nextTrancheRolls: number
  nextTrancheQty: number
  nextTrancheGapQty: number
  nextTranchePrix: number | null
}

export interface PalierAProposer {
  /** The unit price the client pays today (typed, else the grid). */
  prixActuel: number
  /** −x % on the unit price at the next band, 0..1. */
  baisse: number
  totalActuel: number
  totalPalier: number
}

/** Should the client have been offered the next band? Null when the line is
 *  not near it, or already priced at (or under) that band's price — the
 *  employee gave it anyway (common before ETM: 611 Ml at the 612 Ml price). */
export function evaluerPalierSuivant(l: LignePalier): PalierAProposer | null {
  if (!l.nearNextTranche || l.nextTranchePrix == null || !(l.nextTrancheGapQty > 0)) return null
  const prixActuel = l.prixSaisi > 0 ? l.prixSaisi : l.prix ?? 0
  if (!(prixActuel > l.nextTranchePrix)) return null
  const baisse = (prixActuel - l.nextTranchePrix) / prixActuel
  if (baisse < PALIER_BAISSE_MIN) return null
  return {
    prixActuel,
    baisse,
    totalActuel: Math.round(l.quantite * prixActuel * 100) / 100,
    totalPalier: Math.round(l.nextTrancheQty * l.nextTranchePrix * 100) / 100,
  }
}

/** Why a fresh line is not reported (what a closing point says). */
export function raisonPalierSuivant(l: LignePalier, u: string): string {
  if (l.nextTranchePrix == null || !(l.nextTrancheGapQty > 0)) return 'Quantité au palier, ou plus de palier moins cher au-dessus.'
  if (!l.nearNextTranche) return `Palier suivant (${l.nextTrancheRolls} rouleaux) à ${fmt(l.nextTrancheGapQty)} ${u} de plus : trop loin pour le proposer.`
  const actuel = l.prixSaisi > 0 ? l.prixSaisi : l.prix ?? 0
  if (actuel <= l.nextTranchePrix) return `Prix déjà au tarif du palier ${l.nextTrancheRolls} rouleaux (${fmt(l.nextTranchePrix, 2)} €).`
  return `Palier ${l.nextTrancheRolls} rouleaux à ${fmt(l.nextTranchePrix, 2)} € : moins de ${fmt(PALIER_BAISSE_MIN * 100)} % de baisse, pas la peine de le proposer.`
}

// ── Écru fait pour un client, resté sans emploi (« pièces orphelines ») ──
// Real case 2026-10-08: sst 8904 asked TRM for 10 pieces where order 3816
// needed 6, on an oral agreement; the 4 extra pieces sat unassigned in ETM
// stock for 2.5 months and nobody knew why they existed. Measured on prod the
// same day: 145 such pieces (2.5 t) from 30 sst orders since 2021, about one
// new source order a month. Pieces knitted for stock (an sst order with no
// client) are expected to wait and are never reported; fini rolls are left
// out (a few leftover rolls after a delivery is the dyer's yield: 432 rolls,
// mostly noise).

/** Source orders before this date (YYYYMMDD) are the backlog, sorted once
 *  outside the widget (claude_doc/screen_notes.md § 13). */
export const ORPHELIN_DEPUIS = '20260701'
/** Days since the newest piece was knitted before the order is reported. */
export const ORPHELIN_JOURS = 30

export interface OrphelinsCommande {
  /** sst order date, YYYYMMDD. */
  dateCommande: string
  /** Days since the newest unused piece was knitted. */
  ageJours: number
  /** The sst order's journal, plain text. */
  journal: string
}

/** Report a source order's unused pieces? `null` = no, with why in raisonOrphelins(). */
export function evaluerOrphelins(c: OrphelinsCommande): { gravite: Gravite } | null {
  if (c.dateCommande < ORPHELIN_DEPUIS) return null
  if (c.ageJours < ORPHELIN_JOURS) return null
  if (c.journal.trim()) return null
  return { gravite: 'attention' }
}

export function raisonOrphelins(c: OrphelinsCommande): string {
  if (c.journal.trim()) return `Expliqué au journal de la commande : « ${c.journal.trim().replace(/\s+/g, ' ').slice(0, 160)} ».`
  if (c.dateCommande < ORPHELIN_DEPUIS) return 'Commande d’avant le 01/07/2026 : reprise une fois, hors du tableau de bord.'
  return `Pièces tricotées il y a ${c.ageJours} j : on attend ${ORPHELIN_JOURS} j avant de demander pourquoi.`
}
