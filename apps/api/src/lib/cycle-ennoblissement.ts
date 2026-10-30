// Sous-traitants › Ennoblissement: the life cycle of a dye order and of each of
// its lots (decided with Vincent 2026-10-11, plan ~/.claude/plans/cycle-ennoblissement.md).
//
// Built from Pierre-Emmanuel's Journal (571 orders, oct. 2025 → oct. 2026), where
// he typed one code per lot: ACP (waiting for the dyer's measures; ACB at
// Bontemps), ACL (waiting for our control on the tirelle), « lot/s » (soumission
// sent to the client), « coloris validé » (the client accepted the COLORIS before the
// stenter — read as « lot validated » until LIVA #1313),
// « reprise » / lot suffixed R. On the 16 open lots of 2026-10-11 every code
// matched data ETM already holds, so the steps are COMPUTED here and nothing new
// is typed: he stops writing codes and relance dates.
//
//   Lot steps (first match wins) — since 2026-10-22 (LIVA #1304) the Suivi lots
//   screen owns the whole cycle: soumissions, the client's answers, the rapport
//   de contrôle and the validation are lot gestures there, and « Valider le
//   lot » is refused while anything below is still to do (prealablesValidation).
//   Two soumissions since LIVA #1313 (lib/soumission-lot.ts): the COLORIS one,
//   before the stenter — the lot exists before its reception then — and the
//   STABILITÉS one, on the received rolls:
//     valide              suivilot état 3 (or the legacy état 4 « expédié »)
//     en_reprise          état 2, or an open reprise (lib/reprises.ts — the dyer reworks it)
//     coloris_soumis      a coloris soumission names the lot, the client has not answered
//     reteinture          the client refused the coloris before the stenter: MATEL dyes
//                         the lot again (same number) and tells us when to submit it again
//     ok_ramer_a_envoyer  coloris accepted, not received, the « coloris validé » mail not sent
//     en_rame             « coloris validé » sent: the dyer puts the lot on the stenter and ships it
//     soumis              a stabilités soumission names the lot, no answer yet
//     refuse_client       the client refused it (or the coloris of a received lot):
//                         the only way on is « Reprendre »
//     coloris_a_soumettre a received lot whose coloris the client asks, never submitted
//     attente_mesures     the dyer's laize / poids / stabilités incomplete (ACP):
//                         shown « Contrôle ennoblisseur »
//     attente_tirelle     our tirelle laize / poids / stabilités incomplete (ACL):
//                         « Contrôle Malterre » — either control is skipped when
//                         the reference does not ask it (lib/controles-lot.ts)
//     a_soumettre         the client asks the stabilités for this reference
//                         (Clients › Gestion, designation_client.soumettre), none sent
//                         since the lot's last return from reprise
//     rc_a_envoyer        a client switched « rapport de contrôle » holds pieces of
//                         the lot not shipped yet, and has not been sent its report
//     a_valider           nothing left to do: the responsable qualité validates
//
// Every step says whose move it is and when to chase: the relance is computed
// from the step's own date, never typed. Delays below are first estimates, to be
// corrected from PE's use like the point's rules.

import { mpsPg } from './mps-pg.js'
import { consumedEcruIds } from './fini-sources.js'
import { faitsReprises } from './reprises.js'
import { clientsDesLots, cleLotLigne } from './rapport-controle-lot.js'
import { echeanceDelai, lireFaitsDelai, relanceDue, derniereRelance, historiqueDelai, type EvenementDelai, type FaitsDelai } from './delai-sst.js'
import { natureInferee, naturesDemandees, type NatureSoumission } from './soumission-lot.js'
import { CONTROLES_PAR_DEFAUT, controlesDeRef, mesuresManquantes, type ControlesRef } from './controles-lot.js'

export type EtapeLot =
  | 'coloris_soumis'
  | 'reteinture'
  | 'ok_ramer_a_envoyer'
  | 'en_rame'
  | 'coloris_a_soumettre'
  | 'attente_mesures'
  | 'attente_tirelle'
  | 'a_soumettre'
  | 'soumis'
  | 'refuse_client'
  | 'rc_a_envoyer'
  | 'a_valider'
  | 'en_reprise'
  | 'valide'

export type Main = 'teinturier' | 'nous' | 'client'

/** suivilot.idetatlot */
export const ETAT_LOT = { EN_CONTROLE: 1, EN_REPRISE: 2, VALIDE: 3, EXPEDIE: 4, ATTENTE_DECISION: 5 } as const

/** One soumission of the lot (coloris or stabilités). */
export interface SoumissionFait {
  /** The client asks it for this reference (designation_client.soumettre). */
  requise: boolean
  /** The latest one sent that still counts. 'YYYY-MM-DD' — a stabilités
   *  soumission sent before the lot's latest return from reprise, or a coloris
   *  one before its latest re-dye, was about the old lot. */
  envoyeeLe: string | null
  /** The client's answer to it, recorded on Suivi lots. null = not answered yet.
   *  `le` 'YYYY-MM-DD HH:MM:SS.mmm' (ms: an answer and a new send can share a second). */
  reponse: { accepte: boolean; commentaire: string; le: string; par?: string } | null
}

export const SANS_SOUMISSION: SoumissionFait = { requise: false, envoyeeLe: null, reponse: null }

export interface LotFait {
  lot: string
  idsuivilot: number
  /** Its dye line (suivilot.idligne_commande_sous_traitant); 0 = known only from a soumission mail. */
  idligne?: number
  etat: number
  /** suivilot.date: the day the lot was received (BL). 'YYYY-MM-DD'. null =
   *  not received yet: the lot exists through its coloris soumission. */
  reception: string | null
  /** The dyer's control is done: laize, poids and stabilités given (*_sst), or
   *  the reference does not ask it (lib/controles-lot.ts). */
  mesuresTeinturier: boolean
  /** Our control of the tirelle is done (*_tirelle), or not asked. */
  tirelleMesuree: boolean
  /** The measures still missing of each control asked (for the reasons shown). */
  manqueTeinturier?: string[]
  manqueMalterre?: string[]
  /** What the lot's reference asks. Absent = both controls. */
  controles?: ControlesRef
  coloris: SoumissionFait
  stabilites: SoumissionFait
  /** The « coloris validé » mail, sent after the client accepted the coloris. 'YYYY-MM-DD' */
  okRamerLe?: string | null
  /** Clients still owed a rapport de contrôle for this lot (names). */
  rcAEnvoyer?: string[]
  /** A reprise of the lot is open at the dyer (lib/reprises.ts). */
  repriseOuverte?: boolean
  /** …its nature: back on the stenter or re-dyed (LIVA #1313). */
  repriseNature?: 'rame' | 'teinture' | null
  /** How many reprises the lot went through (« repris ×N »). */
  reprises?: number
}

/** Working days the other side gets before we chase. Estimates (2026-10-11). */
export const RELANCE_J = {
  /** The dyer's measures come in Perrine's answer to the next point. */
  attente_mesures: 1,
  /** The client answers a soumission. */
  soumis: 5,
  /** The dyer rames the lot and ships it after the « coloris validé » (estimate 2026-10-22). */
  en_rame: 3,
  /** Our own steps: flagged once they wait this long. */
  nous: 1,
} as const

export interface EtatLot {
  lot: string
  idsuivilot: number
  etape: EtapeLot
  main: Main | null
  /** When to chase whoever has the move. 'YYYY-MM-DD', null = nothing to chase. */
  relance: string | null
  /** Reprises the lot went through (0 = never reworked). */
  reprises: number
}

const DAY = 86_400_000
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10)

/** `iso` + n working days (Sat/Sun skipped, bank holidays not considered). */
export function plusJoursOuvres(iso: string, n: number): string {
  let t = ms(iso)
  let added = 0
  while (added < n) {
    t += DAY
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return isoOf(t)
}

const enAttente = (s: SoumissionFait) => !!s.envoyeeLe && !s.reponse
const refusee = (s: SoumissionFait) => !!s.envoyeeLe && !!s.reponse && !s.reponse.accepte

export function etapeLot(l: LotFait): EtapeLot {
  if (l.etat === ETAT_LOT.VALIDE || l.etat === ETAT_LOT.EXPEDIE) return 'valide'
  if (l.etat === ETAT_LOT.EN_REPRISE || l.repriseOuverte) return 'en_reprise'
  const { coloris: c, stabilites: s } = l
  const recu = !!l.reception
  // The coloris first: it is decided before the stenter, while the lot is at the dyer.
  if (enAttente(c)) return 'coloris_soumis'
  if (refusee(c)) return recu ? 'refuse_client' : 'reteinture'
  if (!recu) return c.reponse?.accepte ? (l.okRamerLe ? 'en_rame' : 'ok_ramer_a_envoyer') : 'attente_mesures'
  // A stabilités soumission already out waits on the client whatever else is missing.
  if (enAttente(s)) return 'soumis'
  if (refusee(s)) return 'refuse_client'
  if (c.requise && !c.envoyeeLe) return 'coloris_a_soumettre'
  if (!l.mesuresTeinturier) return 'attente_mesures'
  if (!l.tirelleMesuree) return 'attente_tirelle'
  if (s.requise && !s.envoyeeLe) return 'a_soumettre'
  if ((l.rcAEnvoyer?.length ?? 0) > 0) return 'rc_a_envoyer'
  return 'a_valider'
}

/** What still stands between the lot and « Valider le lot », in the order the
 *  work is done. Empty = the responsable qualité may validate. Text shown as is
 *  on Suivi lots (the button's reason) and returned by the 409. */
export function prealablesValidation(l: LotFait): string[] {
  if (l.etat === ETAT_LOT.VALIDE || l.etat === ETAT_LOT.EXPEDIE) return ['Lot déjà validé.']
  const out: string[] = []
  const recu = !!l.reception
  const { coloris: c, stabilites: s } = l
  if (l.etat === ETAT_LOT.EN_REPRISE || l.repriseOuverte) out.push('Le lot est en reprise chez l’ennoblisseur.')
  if (enAttente(c)) out.push('Réponse du client à la soumission coloris attendue.')
  else if (refusee(c)) out.push(recu ? 'Coloris refusé par le client : le lot est à reprendre.' : 'Coloris refusé par le client : le lot repart en teinture.')
  else if (c.requise && !c.envoyeeLe) out.push('Soumission coloris à envoyer.')
  else if (!recu && c.reponse?.accepte && !l.okRamerLe) out.push('Validation du coloris à transmettre à l’ennoblisseur.')
  if (!recu) {
    out.push('Lot pas encore réceptionné.')
    return out
  }
  if (!l.mesuresTeinturier) out.push(`Contrôle ennoblisseur incomplet (${(l.manqueTeinturier?.length ? l.manqueTeinturier : ['laize', 'poids', 'stabilités']).join(', ')} de l’ennoblisseur).`)
  if (!l.tirelleMesuree) out.push(`Contrôle Malterre incomplet (${(l.manqueMalterre?.length ? l.manqueMalterre : ['laize', 'poids', 'stabilités']).join(', ')} de la tirelle).`)
  if (enAttente(s)) out.push('Réponse du client à la soumission des stabilités attendue.')
  else if (refusee(s)) out.push('Stabilités refusées par le client : le lot est à reprendre.')
  else if (s.requise && !s.envoyeeLe) out.push('Soumission des stabilités à envoyer.')
  for (const nom of l.rcAEnvoyer ?? []) out.push(`Rapport de contrôle à envoyer à ${nom}.`)
  return out
}

const MAIN: Record<EtapeLot, Main | null> = {
  coloris_soumis: 'client',
  reteinture: 'teinturier',
  ok_ramer_a_envoyer: 'nous',
  en_rame: 'teinturier',
  coloris_a_soumettre: 'nous',
  attente_mesures: 'teinturier',
  attente_tirelle: 'nous',
  a_soumettre: 'nous',
  soumis: 'client',
  refuse_client: 'nous',
  rc_a_envoyer: 'nous',
  a_valider: 'nous',
  en_reprise: 'teinturier',
  valide: null,
}

/** Our steps on a received lot: chased from the reception. */
const NOTRE_MAIN_RECU: EtapeLot[] = ['attente_tirelle', 'coloris_a_soumettre', 'a_soumettre', 'refuse_client', 'rc_a_envoyer', 'a_valider']

export function etatLot(l: LotFait): EtatLot {
  const etape = etapeLot(l)
  const r = l.reception
  let relance: string | null = null
  if (etape === 'attente_mesures' && r) relance = plusJoursOuvres(r, RELANCE_J.attente_mesures)
  else if (etape === 'coloris_soumis' && l.coloris.envoyeeLe) relance = plusJoursOuvres(l.coloris.envoyeeLe, RELANCE_J.soumis)
  else if (etape === 'soumis' && l.stabilites.envoyeeLe) relance = plusJoursOuvres(l.stabilites.envoyeeLe, RELANCE_J.soumis)
  else if (etape === 'ok_ramer_a_envoyer' && l.coloris.reponse) relance = plusJoursOuvres(l.coloris.reponse.le.slice(0, 10), RELANCE_J.nous)
  else if (etape === 'en_rame' && l.okRamerLe) relance = plusJoursOuvres(l.okRamerLe, RELANCE_J.en_rame)
  else if (NOTRE_MAIN_RECU.includes(etape) && r) relance = plusJoursOuvres(r, RELANCE_J.nous)
  // en_reprise / reteinture: the dyer gives the date back in the point, nothing to compute.
  return { lot: l.lot, idsuivilot: l.idsuivilot, etape, main: MAIN[etape], relance, reprises: l.reprises ?? 0 }
}

// ── The order ─────────────────────────────────────────────

/** Order steps, replacing the old phases on Sous-traitants › Ennoblissement. « En réception » only while
 *  pieces are still at the dyer; everything back and lots still open = « En contrôle » (Vincent
 *  2026-10-30, 9090: all received, the lot waits for the client's answer on its stabilités). */
export type EtapeCommande = 'non_envoye' | 'attente_delai' | 'en_teinture' | 'en_reception' | 'en_controle' | 'a_cloturer' | 'terminee'

/** The step as every screen prints it (Sous-traitants › Ennoblissement, a client line's Ennoblissement tab). */
export const LIBELLE_ETAPE_COMMANDE: Record<EtapeCommande, string> = {
  non_envoye: 'À envoyer',
  attente_delai: 'Attente délai',
  en_teinture: 'En traitement',
  en_reception: 'En réception',
  en_controle: 'En contrôle',
  a_cloturer: 'À clôturer',
  terminee: 'Terminée',
}

export interface CommandeFait {
  est_soldee: boolean
  /** Max line status rank: 0 Non_Envoye, 1 Attente_Delai, 2 anything later. */
  rangStatut: 0 | 1 | 2
  /** The délai question: asked, relances, reports (lib/delai-sst.ts). */
  delaiFaits?: FaitsDelai
  /** Earliest délai of a line not delivered yet, 'YYYY-MM-DD'. */
  delai: string | null
  lots: LotFait[]
  /** Écru pieces still at the dyer (handed over, not back dyed): the « solde ». */
  ecruChezTeinturier: number
}

export interface EtatCommande {
  etape: EtapeCommande
  main: Main | null
  relance: string | null
  /** Lots received and still open (not validated / shipped), with their step. */
  lots: EtatLot[]
  /** Pieces still at the dyer while lots came back. */
  solde: boolean
  /** attente_delai only: the délai question (lib/delai-sst.ts). */
  delai?: EtatDelai
}

export interface EtatDelai {
  /** From when the délai is due (the Point asks from that day), 'YYYY-MM-DD'. */
  echeance: string | null
  /** Latest relance: day and channel. */
  derniereRelance: { jour: string; canal: string } | null
  historique: EvenementDelai[]
}

export function etatCommande(c: CommandeFait): EtatCommande {
  const tous = c.lots.map(etatLot)
  const ouverts = tous.filter((l) => l.etape !== 'valide')
  const solde = c.lots.length > 0 && c.ecruChezTeinturier > 0
  if (c.est_soldee) return { etape: 'terminee', main: null, relance: null, lots: ouverts, solde: false }
  if (c.lots.length === 0) {
    if (c.rangStatut === 0) return { etape: 'non_envoye', main: 'nous', relance: null, lots: [], solde: false }
    if (c.rangStatut === 1) {
      // Red = due and nobody chased since (LIVA #1314): a relance pushes it back.
      const f = c.delaiFaits ?? { demandeLe: null, dateNotif: null, relances: [], reports: [], reponduLe: null }
      const r = derniereRelance(f)
      return {
        etape: 'attente_delai', main: 'teinturier', relance: relanceDue(f), lots: [], solde: false,
        delai: { echeance: echeanceDelai(f), derniereRelance: r ? { jour: r.jour, canal: r.canal } : null, historique: historiqueDelai(f) },
      }
    }
    return { etape: 'en_teinture', main: 'teinturier', relance: c.delai, lots: [], solde: false }
  }
  // Received: the earliest chase among the open lots, else the délai of what is
  // still at the dyer. Still pieces at the dyer = « en réception », all back = « en contrôle ».
  const recue: EtapeCommande = solde ? 'en_reception' : 'en_controle'
  const datees = ouverts.filter((l) => l.relance).sort((a, b) => a.relance!.localeCompare(b.relance!))
  if (datees.length > 0) {
    return { etape: recue, main: datees[0].main, relance: datees[0].relance, lots: ouverts, solde }
  }
  const enReprise = ouverts.find((l) => l.etape === 'en_reprise')
  if (enReprise) return { etape: recue, main: 'teinturier', relance: null, lots: ouverts, solde }
  if (solde) return { etape: 'en_reception', main: 'teinturier', relance: c.delai, lots: ouverts, solde }
  // Every lot validated, nothing left at the dyer: ours to close (8565).
  return { etape: 'a_cloturer', main: 'nous', relance: null, lots: ouverts, solde }
}

/** Red when the chase date is today or past, amber on the last working day before. */
export function urgenceCommande(e: EtatCommande, today: string): 'late' | 'soon' | null {
  if (!e.relance || e.etape === 'terminee') return null
  if (e.relance <= today) return 'late'
  if (e.relance <= plusJoursOuvres(today, 1)) return 'soon'
  return null
}

/** A lot's card colour on Qualité › Suivi lots (mps_designer §41). */
export interface UrgenceLot {
  niveau: 'rouge' | 'ambre'
  /** Printed under the card, in the colour: who to chase, since when. */
  raison: string
}

/** The lot's own chase date read like the order's (urgenceCommande): red from the
 *  relance day, amber the working day before — so a lot is red on Suivi lots
 *  exactly when it turns its order red on Sous-traitants › Ennoblissement. A
 *  validated lot still owing a rapport de contrôle is our move, like the step
 *  rc_a_envoyer. */
export function urgenceLot(l: LotFait, today: string): UrgenceLot | null {
  const e = etatLot(l)
  let { relance, main } = e
  if (e.etape === 'valide') {
    if ((l.rcAEnvoyer?.length ?? 0) === 0 || !l.reception) return null
    relance = plusJoursOuvres(l.reception, RELANCE_J.nous)
    main = 'nous'
  }
  if (!relance) return null
  const niveau = relance <= today ? 'rouge' : relance <= plusJoursOuvres(today, 1) ? 'ambre' : null
  if (!niveau) return null
  const jour = relance === today ? 'aujourd’hui' : `le ${relance.slice(8, 10)}/${relance.slice(5, 7)}`
  const quoi = main === 'teinturier' ? 'Relancer l’ennoblisseur' : main === 'client' ? 'Relancer le client' : 'À traiter'
  return { niveau, raison: niveau === 'rouge' && relance < today ? `${quoi} depuis ${jour}` : `${quoi} ${jour}` }
}

/** « MA109331 », « 109331/s », « MA109102R » (an old reprise suffix): the digits
 *  name the lot. A reprise is data now (lib/reprises.ts): a soumission sent
 *  before the lot came back from reprise no longer counts, by date. */
export function cleLot(s: string): string {
  const m = /(\d{5,})/.exec(s)
  return m ? m[1] : s.trim().toUpperCase()
}

// ── Reading the facts (native PostgreSQL) ────────────────

const TYPE_DOC_SOUMISSION = 15

function rang(sstatut: string | null): 0 | 1 | 2 {
  const s = (sstatut ?? '').trim()
  if (s === 'Non_Envoye') return 0
  if (s === 'Attente_Delai') return 1
  return 2
}

/** One soumission sent, as the reader assembles it. `ts` 'YYYY-MM-DD HH:MM:SS.mmm'. */
export interface EnvoiSoumission { nature: NatureSoumission; jour: string; ts: string }
/** One answer of the client, its nature resolved. */
export interface ReponseSoumission { nature: NatureSoumission; accepte: boolean; commentaire: string; ts: string; par: string }

const plusRecent = <T extends { ts: string }>(xs: T[]): T | null =>
  xs.reduce<T | null>((m, x) => (!m || x.ts > m.ts ? x : m), null)

/** The lot's soumission of one nature, from its sends and the client's
 *  answers: the latest send still valid (not before `invalideAvant`, the day
 *  the lot came back reworked), and the latest answer given after it. Pure. */
export function faitSoumission(
  nature: NatureSoumission,
  requise: boolean,
  envois: EnvoiSoumission[],
  reponses: ReponseSoumission[],
  invalideAvant: string | null,
): SoumissionFait {
  const dernier = plusRecent(envois.filter((e) => e.nature === nature && (!invalideAvant || e.jour >= invalideAvant)))
  if (!dernier) return { requise, envoyeeLe: null, reponse: null }
  const rep = plusRecent(reponses.filter((r) => r.nature === nature && r.ts >= dernier.ts))
  return {
    requise,
    envoyeeLe: dernier.jour,
    reponse: rep ? { accepte: rep.accepte, commentaire: rep.commentaire, le: rep.ts, par: rep.par } : null,
  }
}

/** The facts of each dye order, in a few flat reads. */
export async function lireCommandesEnnoblissement(ids: number[]): Promise<Map<number, CommandeFait>> {
  const out = new Map<number, CommandeFait>()
  const cmdIds = [...new Set(ids.filter((x) => x > 0))]
  if (cmdIds.length === 0) return out
  const sql = mpsPg()

  const faitsDelaiP = lireFaitsDelai(cmdIds, sql)
  const [entetes, lignes, envoisMail, envoisNature, reponses, oksRamer] = await Promise.all([
    sql<{ id: number; est_soldee: number; idcommande_client: number }[]>`
      SELECT idcommande_sous_traitant AS id, est_soldee,
             COALESCE(idcommande_client, 0) AS idcommande_client
      FROM commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ id: number; cmd: number; type: number; sstatut: string | null; delai: string | null; idref_fini: number }[]>`
      SELECT idligne_commande_sous_traitant AS id, idcommande_sous_traitant AS cmd, type, sstatut::text AS sstatut,
             to_char(date_livraison, 'YYYY-MM-DD') AS delai, COALESCE(idreference, 0) AS idref_fini
      FROM ligne_commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    // The mail log: one row per recipient — one send per (order, lot, day).
    sql<{ cmd: number; notes: string | null; jour: string; ts: string }[]>`
      SELECT idreference AS cmd, notes::text AS notes, to_char(date, 'YYYY-MM-DD') AS jour,
             to_char(max(date), 'YYYY-MM-DD HH24:MI:SS.MS') AS ts FROM envoi_email
      WHERE idtype_doc = ${TYPE_DOC_SOUMISSION} AND idreference = ANY(${cmdIds}) AND COALESCE(invalide, 0) = 0
      GROUP BY idreference, notes, to_char(date, 'YYYY-MM-DD')`,
    // What each send was, since LIVA #1313 (lib/soumission-lot.ts).
    sql<{ cmd: number; lot: string; nature: NatureSoumission; jour: string; ts: string }[]>`
      SELECT idcommande_sous_traitant AS cmd, lot, nature,
             to_char(envoyee_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour,
             to_char(envoyee_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI:SS.MS') AS ts
      FROM soumission_lot WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    // The client's answers, recorded on Suivi lots (LIVA #1304; nature since #1313).
    sql<{ cmd: number; lot: string | null; nature: NatureSoumission | null; reponse: number; commentaire: string | null; ts: string; par: string | null }[]>`
      SELECT idcommande_sous_traitant AS cmd, lot::text AS lot, nature, COALESCE(reponse, 0)::int AS reponse, commentaire,
             to_char(COALESCE(saisi_le AT TIME ZONE 'Europe/Paris', date::timestamp), 'YYYY-MM-DD HH24:MI:SS.MS') AS ts,
             saisi_par AS par
      FROM reponse_soumission WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ cmd: number; lot: string; ts: string }[]>`
      SELECT idcommande_sous_traitant AS cmd, lot,
             to_char(envoye_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI:SS.MS') AS ts
      FROM ok_a_ramer_envoi WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
  ])

  const faitsDelai = await faitsDelaiP
  const lineIds = lignes.map((l) => Number(l.id))
  const [lots, ecru, clientsPieces] = lineIds.length === 0 ? [[], [], []] : await Promise.all([
    sql<{
      idsuivilot: number; ligne: number; lot: string | null; etat: number; reception: string | null; idref_fini: number
      laize_sst: number; poids_sst: number; stabh_sst: number; stabl_sst: number
      laize_tirelle: number; poids_tirelle: number; stabh_tirelle: number; stabl_tirelle: number
    }[]>`
      SELECT idsuivilot, idligne_commande_sous_traitant AS ligne, lot::text AS lot, COALESCE(idetatlot, 0)::int AS etat,
             to_char(date, 'YYYY-MM-DD') AS reception, COALESCE(idref_fini, 0) AS idref_fini,
             COALESCE(laize_sst, 0) AS laize_sst, COALESCE(poids_sst, 0) AS poids_sst,
             COALESCE(stabh_sst, 0) AS stabh_sst, COALESCE(stabl_sst, 0) AS stabl_sst,
             COALESCE(laize_tirelle, 0) AS laize_tirelle, COALESCE(poids_tirelle, 0) AS poids_tirelle,
             COALESCE(stabh_tirelle, 0) AS stabh_tirelle, COALESCE(stabl_tirelle, 0) AS stabl_tirelle
      FROM suivilot WHERE idligne_commande_sous_traitant = ANY(${lineIds})`,
    sql<{ ligne: number; idecru: number }[]>`
      SELECT idref_commande_affectation AS ligne, idstock_ecru AS idecru
      FROM stock_ecru WHERE idref_commande_affectation = ANY(${lineIds})`,
    // The client of a line: through the pieces (the order header is often 0, #1249).
    sql<{ ligne: number; idclient: number }[]>`
      SELECT DISTINCT se.idref_commande_affectation AS ligne, cc.idclient
      FROM stock_ecru se
      JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = se.idligne_commande_client
      JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
      WHERE se.idref_commande_affectation = ANY(${lineIds}) AND se.idligne_commande_client > 0`,
  ])

  const enteteClient = await (async () => {
    const ccIds = [...new Set(entetes.map((e) => Number(e.idcommande_client)).filter((x) => x > 0))]
    if (ccIds.length === 0) return new Map<number, number>()
    const rows = await sql<{ id: number; idclient: number }[]>`
      SELECT idcommande_client AS id, idclient FROM commande_client WHERE idcommande_client = ANY(${ccIds})`
    return new Map(rows.map((r) => [Number(r.id), Number(r.idclient)]))
  })()

  // Soumissions asked per (client, ref fini): Clients › Gestion, a bit set.
  const clientsParLigne = new Map<number, Set<number>>()
  const ajouter = (ligne: number, client: number) => {
    if (!(client > 0)) return
    const set = clientsParLigne.get(ligne) ?? new Set<number>()
    set.add(client)
    clientsParLigne.set(ligne, set)
  }
  const cmdParId = new Map(entetes.map((e) => [Number(e.id), e]))
  for (const l of lignes) ajouter(Number(l.id), enteteClient.get(Number(cmdParId.get(Number(l.cmd))?.idcommande_client)) ?? 0)
  for (const r of clientsPieces) ajouter(Number(r.ligne), Number(r.idclient))
  const tousClients = [...new Set([...clientsParLigne.values()].flatMap((s) => [...s]))]
  const refs = [...new Set(lignes.map((l) => Number(l.idref_fini)).filter((x) => x > 0))]
  const demandes = new Map<string, NatureSoumission[]>()
  if (tousClients.length > 0 && refs.length > 0) {
    const rows = await sql<{ idclient: number; idref_fini: number; soumettre: number }[]>`
      SELECT idclient, idref_fini, COALESCE(soumettre, 0)::int AS soumettre FROM designation_client
      WHERE idclient = ANY(${tousClients}) AND idref_fini = ANY(${refs})
        AND COALESCE(soumettre, 0) > 0 AND COALESCE(archive, 0) = 0`
    for (const r of rows) {
      const k = `${r.idclient}:${r.idref_fini}`
      demandes.set(k, [...new Set([...(demandes.get(k) ?? []), ...naturesDemandees(r.soumettre)])])
    }
  }
  const naturesLigne = (ligne: number): NatureSoumission[] => {
    const l = lignes.find((x) => Number(x.id) === ligne)
    if (!l) return []
    return [...new Set([...(clientsParLigne.get(ligne) ?? [])].flatMap((c) => demandes.get(`${c}:${Number(l.idref_fini)}`) ?? []))]
  }

  // The controls each reference asks (lib/controles-lot.ts): the lot's own
  // ref first (suivilot.idref_fini), else its dye line's.
  const refsLots = [...new Set([...refs, ...lots.map((s) => Number(s.idref_fini))].filter((x) => x > 0))]
  const controlesParRef = new Map<number, ControlesRef>()
  if (refsLots.length > 0) {
    const rows = await sql<{ id: number; controle_ennoblisseur: number; controle_malterre: number }[]>`
      SELECT idref_fini AS id, controle_ennoblisseur, controle_malterre FROM ref_fini WHERE idref_fini = ANY(${refsLots})`
    for (const r of rows) controlesParRef.set(Number(r.id), controlesDeRef(r))
  }
  /** The control facts of one suivilot row. */
  const controlesDuLot = (s: (typeof lots)[number]) => {
    const ref = Number(s.idref_fini) > 0 ? Number(s.idref_fini) : Number(ligneParId.get(Number(s.ligne))?.idref_fini)
    const controles = controlesParRef.get(ref) ?? CONTROLES_PAR_DEFAUT
    const manqueTeinturier = controles.ennoblisseur
      ? mesuresManquantes({ laize: s.laize_sst, poids: s.poids_sst, stabH: s.stabh_sst, stabL: s.stabl_sst }) : []
    const manqueMalterre = controles.malterre
      ? mesuresManquantes({ laize: s.laize_tirelle, poids: s.poids_tirelle, stabH: s.stabh_tirelle, stabL: s.stabl_tirelle }) : []
    return {
      mesuresTeinturier: manqueTeinturier.length === 0,
      tirelleMesuree: manqueMalterre.length === 0,
      manqueTeinturier,
      manqueMalterre,
      controles,
    }
  }

  // The « solde »: écru handed over and not back dyed (own fini or merged component).
  const [revenus, reprises] = await Promise.all([consumedEcruIds(ecru.map((r) => Number(r.idecru))), faitsReprises(lineIds)])
  const chezTeinturier = new Map<number, number>()
  for (const r of ecru) if (!revenus.has(Number(r.idecru))) chezTeinturier.set(Number(r.ligne), (chezTeinturier.get(Number(r.ligne)) ?? 0) + 1)

  // Each lot by `${cmd}:${digits}`: its line and its reception (the history is
  // classified against it).
  const ligneParId = new Map(lignes.map((l) => [Number(l.id), l]))
  const aDesChiffres = (s: string) => /\d{5,}/.test(s)
  const lotParCle = new Map<string, { ligne: number; reception: string | null }>()
  for (const s of lots) {
    const lot = String(s.lot ?? '').trim()
    const cmd = Number(ligneParId.get(Number(s.ligne))?.cmd)
    if (!lot || !cmd) continue
    const k = `${cmd}:${cleLot(lot)}`
    const prev = lotParCle.get(k)
    if (!prev || (s.reception && (!prev.reception || s.reception < prev.reception))) lotParCle.set(k, { ligne: Number(s.ligne), reception: s.reception })
  }

  // The sends: what soumission_lot says, else inferred from the date.
  const envoisParCle = new Map<string, EnvoiSoumission[]>()
  const pousser = (k: string, e: EnvoiSoumission) => envoisParCle.set(k, [...(envoisParCle.get(k) ?? []), e])
  const connusDuJour = new Set<string>()
  for (const e of envoisNature) {
    if (!aDesChiffres(e.lot)) continue
    const k = `${e.cmd}:${cleLot(e.lot)}`
    connusDuJour.add(`${k}:${e.jour}`)
    pousser(k, { nature: e.nature, jour: e.jour, ts: e.ts })
  }
  for (const e of envoisMail) {
    const notes = e.notes ?? ''
    if (!aDesChiffres(notes)) continue // an étude coloris send shares type 15 (no lot in notes)
    const k = `${e.cmd}:${cleLot(notes)}`
    if (connusDuJour.has(`${k}:${e.jour}`)) continue
    const lot = lotParCle.get(k)
    pousser(k, { nature: natureInferee(e.jour, lot?.reception ?? null, lot ? naturesLigne(lot.ligne) : []), jour: e.jour, ts: e.ts })
  }
  // The answers; one typed before #1313 answered the send it followed.
  const reponsesParCle = new Map<string, ReponseSoumission[]>()
  for (const r of reponses) {
    const k = `${r.cmd}:${cleLot(r.lot ?? '')}`
    const nature = r.nature ?? plusRecent((envoisParCle.get(k) ?? []).filter((e) => e.ts <= r.ts))?.nature ?? 'stabilites'
    reponsesParCle.set(k, [...(reponsesParCle.get(k) ?? []), {
      nature, accepte: Number(r.reponse) === 1, commentaire: (r.commentaire ?? '').trim(), ts: r.ts, par: (r.par ?? '').trim(),
    }])
  }
  const okParCle = new Map<string, string>()
  for (const o of oksRamer) {
    const k = `${o.cmd}:${cleLot(o.lot)}`
    if ((okParCle.get(k) ?? '') < o.ts) okParCle.set(k, o.ts)
  }
  const rcParLot = await clientsDesLots(lots.map((s) => ({ ligne: Number(s.ligne), lot: String(s.lot ?? '') })))

  /** The soumission facts of one lot. */
  const soumissionsDuLot = (k: string, natures: NatureSoumission[], rep: { dernierRetour: string | null; dernierRetourTeinture: string | null } | undefined) => {
    const envois = envoisParCle.get(k) ?? []
    const reps = reponsesParCle.get(k) ?? []
    const coloris = faitSoumission('coloris', natures.includes('coloris'), envois, reps, rep?.dernierRetourTeinture ?? null)
    const stabilites = faitSoumission('stabilites', natures.includes('stabilites'), envois, reps, rep?.dernierRetour ?? null)
    const ok = okParCle.get(k)
    const okRamerLe = coloris.reponse?.accepte && ok && ok >= coloris.reponse.le ? ok.slice(0, 10) : null
    return { coloris, stabilites, okRamerLe }
  }

  for (const e of entetes) {
    const id = Number(e.id)
    const sesLignes = lignes.filter((l) => Number(l.cmd) === id)
    const sesLots: LotFait[] = lots
      .filter((s) => Number(ligneParId.get(Number(s.ligne))?.cmd) === id && String(s.lot ?? '').trim())
      .map((s) => {
        const rep = reprises.get(`${Number(s.ligne)}:${String(s.lot).trim()}`)
        const k = `${id}:${cleLot(String(s.lot))}`
        return {
          lot: String(s.lot).trim(),
          idsuivilot: Number(s.idsuivilot),
          idligne: Number(s.ligne),
          etat: Number(s.etat),
          reception: s.reception,
          ...controlesDuLot(s),
          ...soumissionsDuLot(k, naturesLigne(Number(s.ligne)), rep),
          rcAEnvoyer: (rcParLot.get(cleLotLigne(Number(s.ligne), String(s.lot))) ?? []).filter((c) => c.du).map((c) => c.nom),
          repriseOuverte: rep?.ouverte ?? false,
          repriseNature: rep?.natureOuverte ?? null,
          reprises: rep?.nombre ?? 0,
        }
      })
    // A soumission sent before 2026-10-22 for a lot not received yet (9023 /
    // 9037) has no suivilot row: the lot exists only in the email. Since
    // LIVA #1313 the coloris soumission creates the row.
    const connus = new Set(sesLots.map((l) => cleLot(l.lot)))
    for (const k of envoisParCle.keys()) {
      const [cmd, cle] = k.split(':')
      if (Number(cmd) !== id || connus.has(cle)) continue
      sesLots.push({
        lot: `MA${cle}`, idsuivilot: 0, idligne: 0, etat: 0, reception: null, mesuresTeinturier: false, tirelleMesuree: false,
        ...soumissionsDuLot(k, [], undefined),
      })
    }
    const delais = sesLignes.filter((l) => !String(l.sstatut ?? '').startsWith('Termin')).map((l) => l.delai).filter((d): d is string => !!d).sort()
    out.set(id, {
      est_soldee: Number(e.est_soldee) === 1,
      rangStatut: Math.max(0, ...sesLignes.map((l) => rang(l.sstatut))) as 0 | 1 | 2,
      delaiFaits: faitsDelai.get(id),
      delai: delais[0] ?? null,
      lots: sesLots,
      ecruChezTeinturier: sesLignes.reduce((n, l) => n + (chezTeinturier.get(Number(l.id)) ?? 0), 0),
    })
  }
  return out
}
