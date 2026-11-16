// An urgency asked of a sous-traitant — a knitter or a dyer — on one of its order
// lines (Vincent 2026-11-16: the knitter first, the dyer the same day).
//
// An order goes out WITHOUT a date: the partner knows its standards
// (Sous-traitants › Gestion), gives its délai, and « date client intenable »
// (lib/urgence-commande-client.ts) speaks when that délai is too long for a
// client line. The one way to ask for a date is the urgency: « passage en
// urgence », with the date we wish. It is asked when the order is prepared or at
// any time afterwards, on a line without a délai as on one that has its délai
// (« can you go faster? »). Facts, append-only (`urgence_sst`, migrations
// 0076-0077; the API role may SELECT / INSERT):
//
//   - 'demande'  the urgency is asked, with the date wished; opens an episode;
//   - 'relance'  no answer on the day it was due: asked again;
//   - 'reponse'  the partner answered by moving the délai it had given (written by
//                the délai writers, for the Journal);
//   - 'refus'    the partner cannot: its délai stands;
//   - 'levee'    given up (a mistake, the client's date was moved);
//   - 'mail'     the mail that told the partner of one of the above was sent (to
//                whom): for the Journal only, it changes nothing to the urgency.
//
// The answer is the partner's délai: an urgency awaits its answer while the line's
// délai is still what it was when we asked (none, or the same date) and no
// 'refus' / 'levee' closed it. So a délai given EARLIER than the one in place is
// accepted while an urgency awaits (lib/report-delai-sst.ts refusAvanceDelai) —
// the only case, the engagement (`date_delai`) stays the first promise.
//
// No « réponse attendue le » to type: the partner's answer time is known
// (Tricotage Malterre: DELAI_TRM_J working day, any other partner, dyers
// included: REPONSE_URGENCE_J). Until that day whoever reads the urgency stays neutral;
// from the working day after it is ours to chase: red, « relancer ».
//
// Once answered the line stays « urgente » (the icon) until it is delivered: the
// order was pressed, everybody should see it.
//
// Dates are 'YYYY-MM-DD' here, like lib/delai-sst.ts.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { DELAI_TRM_J, ouvresEntre, plusOuvres } from './delai-sst.js'

/** Tricotage Malterre's id (lib/sst-tricotage.ts, which reads this file: not imported back). */
const TRICOTAGE_MALTERRE_ID = 1

/** Working days a partner other than Tricotage Malterre (another knitter, a dyer) gets to answer. */
export const REPONSE_URGENCE_J = 2

/** Working days the partner gets to answer an urgency. Pure. */
export function joursReponseUrgence(idsousTraitant: number): number {
  return idsousTraitant === TRICOTAGE_MALTERRE_ID ? DELAI_TRM_J : REPONSE_URGENCE_J
}

export type TypeFaitUrgence = 'demande' | 'relance' | 'reponse' | 'refus' | 'levee' | 'mail'

export interface FaitUrgence {
  type: TypeFaitUrgence
  /** 'YYYY-MM-DDTHH:MI' (Paris). */
  le: string
  /** 'YYYY-MM-DD' (Paris). */
  jour: string
  /** 'YYYY-MM-DD'; a 'demande' / 'relance' only. */
  reponseAttendue: string | null
  /** 'YYYY-MM-DD' the date asked for. */
  dateSouhaitee: string | null
  /** 'YYYY-MM-DD' the line's délai when the fact was written; null = it had none. */
  delaiAvant: string | null
  note: string | null
  par: string | null
}

/** 'attente': the answer is awaited; 'a_relancer': it did not come on its day, ours to chase;
 *  'repondue': the partner gave or moved its délai since — the line stays « urgente ». */
export type EtatUrgence = 'attente' | 'a_relancer' | 'repondue'

export interface UrgenceLigne {
  etat: EtatUrgence
  /** 'YYYY-MM-DD' the day it was asked. */
  demandeeLe: string
  /** 'YYYY-MM-DD' the answer is expected (the latest ask). */
  reponseAttendue: string
  /** How many times it was asked again. */
  relances: number
  /** Its own clock, drawn as a bar beside the knitting's (« Prochaines étapes »): working days since
   *  the latest ask, over the working days the partner got to answer it. */
  jours: number
  accordes: number
  /** 'YYYY-MM-DD' the date wished (the latest ask naming one). */
  dateSouhaitee: string | null
  /** 'YYYY-MM-DD' the délai the line had when it was asked; null = none. */
  delaiAvant: string | null
  note: string | null
  par: string | null
}

/** What an order's card reads of its lines' urgencies: one whose answer is overdue wins. `etat` may
 *  have been computed on another day: the answer day decides. Pure. */
export function urgenceDemandee(urgences: readonly Pick<UrgenceLigne, 'etat' | 'reponseAttendue'>[], aujourdhui: string): 'attente' | 'a_relancer' | null {
  const attendues = urgences.filter((u) => u.etat !== 'repondue')
  if (attendues.length === 0) return null
  return attendues.some((u) => aujourdhui > u.reponseAttendue) ? 'a_relancer' : 'attente'
}

/** True while the partner's answer is awaited or overdue (not once answered). */
export function enAttenteDeReponse(u: UrgenceLigne | null | undefined): u is UrgenceLigne {
  return !!u && u.etat !== 'repondue'
}

const jourOuVide = (v: string | null | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)

/** The urgency of a line, null without one: never asked, refused, given up. `faits` oldest first,
 *  `delaiActuel` the line's délai today ('YYYY-MM-DD' or null). Pure. */
export function urgenceLigne(faits: readonly FaitUrgence[], delaiActuel: string | null, aujourdhui: string): UrgenceLigne | null {
  // One episode per 'demande' (its relances, its answer). Read from the latest one back.
  const episodes: FaitUrgence[][] = []
  for (const f of faits) {
    if (f.type === 'demande') episodes.push([f])
    else if (episodes.length > 0) episodes[episodes.length - 1].push(f)
  }
  for (let i = episodes.length - 1; i >= 0; i--) {
    const episode = episodes[i]
    // Given up: the line is no longer « urgente », whatever was asked before.
    if (episode.some((f) => f.type === 'levee')) return null
    // This ask got a « no »: nothing awaited; an earlier ask the partner granted keeps the mark.
    if (episode.some((f) => f.type === 'refus')) continue
    const demandes = episode.filter((f) => (f.type === 'demande' || f.type === 'relance') && f.reponseAttendue)
    if (demandes.length === 0) continue
    const premiere = demandes[0]
    const derniere = demandes[demandes.length - 1]
    // Answered: a later ask followed it (one opens only once the previous is answered), a délai
    // writer said so, or the délai is no longer what it was when we asked.
    const repondue = i < episodes.length - 1
      || episode.some((f) => f.type === 'reponse')
      || jourOuVide(delaiActuel) !== jourOuVide(premiere.delaiAvant)
    return {
      // On the day itself the answer is still expected: nobody has anything to do.
      etat: repondue ? 'repondue' : aujourdhui > derniere.reponseAttendue! ? 'a_relancer' : 'attente',
      demandeeLe: premiere.jour,
      reponseAttendue: derniere.reponseAttendue!,
      relances: demandes.length - 1,
      jours: Math.max(0, ouvresEntre(derniere.jour, aujourdhui >= derniere.jour ? aujourdhui : derniere.jour)),
      accordes: Math.max(1, ouvresEntre(derniere.jour, derniere.reponseAttendue!)),
      dateSouhaitee: [...demandes].reverse().find((f) => f.dateSouhaitee)?.dateSouhaitee ?? null,
      delaiAvant: jourOuVide(premiere.delaiAvant),
      note: derniere.note,
      par: derniere.par,
    }
  }
  return null
}

/** Why a date wished is refused, null when it is fine: a real day, not past, and before the délai
 *  the partner already gave (asking for the same day or later is no urgency). Pure. */
export function refusDateSouhaitee(dateSouhaitee: string | null | undefined, delaiActuel: string | null, aujourdhui: string): string | null {
  const d = jourOuVide(dateSouhaitee)
  if (!d) return 'Indiquez la date souhaitée.'
  if (d < aujourdhui) return 'La date souhaitée ne peut pas être passée.'
  const delai = jourOuVide(delaiActuel)
  if (delai && d >= delai) {
    return `La date souhaitée doit être avant le délai déjà donné (${delai.slice(8, 10)}/${delai.slice(5, 7)}).`
  }
  return null
}

// ── Reads ────────────────────────────────────────────────

/** The urgency facts of each line, oldest first. */
export async function lireFaitsUrgence(ligneIds: readonly number[], sql: Sql = mpsPg()): Promise<Map<number, FaitUrgence[]>> {
  const out = new Map<number, FaitUrgence[]>()
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  if (ids.length === 0) return out
  const rows = await sql<{ ligne: number; type: string; le: string; jour: string; reponse: string | null; souhaitee: string | null; avant: string | null; note: string | null; par: string | null }[]>`
    SELECT idligne_commande_sous_traitant AS ligne, type,
           to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS le,
           to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour,
           to_char(reponse_attendue, 'YYYY-MM-DD') AS reponse, to_char(date_souhaitee, 'YYYY-MM-DD') AS souhaitee,
           to_char(delai_avant, 'YYYY-MM-DD') AS avant, note, par
      FROM urgence_sst WHERE idligne_commande_sous_traitant = ANY(${ids}) ORDER BY le, id`
  for (const r of rows) {
    const lid = Number(r.ligne)
    out.set(lid, [...(out.get(lid) ?? []), {
      type: r.type as TypeFaitUrgence, le: r.le, jour: r.jour, reponseAttendue: r.reponse, dateSouhaitee: r.souhaitee,
      delaiAvant: r.avant, note: r.note, par: r.par,
    }])
  }
  return out
}

/** The urgency of each line that has one. `lignes`: the line and its délai today ('YYYY-MM-DD',
 *  'YYYYMMDD', or empty). */
export async function urgencesLignes(
  lignes: readonly { id: number; delai: string | null | undefined }[], aujourdhui: string, sql: Sql = mpsPg(),
): Promise<Map<number, UrgenceLigne>> {
  const out = new Map<number, UrgenceLigne>()
  const ok = lignes.filter((l) => l.id > 0)
  if (ok.length === 0) return out
  const faits = await lireFaitsUrgence(ok.map((l) => l.id), sql)
  for (const l of ok) {
    const f = faits.get(l.id)
    if (!f) continue
    const u = urgenceLigne(f, isoDe(l.delai), aujourdhui)
    if (u) out.set(l.id, u)
  }
  return out
}

/** 'YYYYMMDD' or 'YYYY-MM-DD' → 'YYYY-MM-DD'; anything else → null. */
export function isoDe(v: unknown): string | null {
  const s = typeof v === 'string' ? v.replace(/-/g, '').slice(0, 8) : ''
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null
}

/** True while an urgency awaits the partner's answer on the line: the one case where a délai may
 *  be given earlier than the one in place (lib/report-delai-sst.ts). */
export async function urgenceEnAttente(idligne: number, delaiActuel: unknown, sql: Sql = mpsPg()): Promise<boolean> {
  const faits = (await lireFaitsUrgence([idligne], sql)).get(idligne)
  if (!faits) return false
  // The day does not matter here: awaited or overdue, the answer is still owed.
  return enAttenteDeReponse(urgenceLigne(faits, isoDe(delaiActuel), '0000-00-00'))
}

// ── Gestures ─────────────────────────────────────────────

export interface AuteurUrgence { id: number; nom: string | null }

export class UrgenceRefusee extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message) }
}

interface LigneUrgence { cmd: number; sst: number; delai: string | null; terminee: boolean }

async function ligneDe(sql: Sql, idligne: number): Promise<LigneUrgence | null> {
  const [l] = await sql<{ cmd: number; sst: number | null; delai: string | null; sstatut: string | null }[]>`
    SELECT l.idcommande_sous_traitant AS cmd, c.idsous_traitant AS sst, to_char(l.date_livraison, 'YYYY-MM-DD') AS delai,
           l.sstatut::text AS sstatut
      FROM ligne_commande_sous_traitant l
      LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
     WHERE l.idligne_commande_sous_traitant = ${idligne}`
  if (!l) return null
  return {
    cmd: Number(l.cmd),
    sst: Number(l.sst) || 0,
    delai: jourOuVide(l.delai),
    terminee: (l.sstatut ?? '').trim().startsWith('Termin'),
  }
}

async function ligneOuverte(sql: Sql, idcommande: number | null, idligne: number): Promise<LigneUrgence> {
  const l = await ligneDe(sql, idligne)
  if (!l || (idcommande !== null && l.cmd !== idcommande)) throw new UrgenceRefusee('ligne_inconnue', 'Ligne introuvable sur cette commande.', 404)
  return l
}

async function urgenceDe(sql: Sql, idligne: number, delai: string | null, aujourdhui: string): Promise<UrgenceLigne | null> {
  return urgenceLigne((await lireFaitsUrgence([idligne], sql)).get(idligne) ?? [], delai, aujourdhui)
}

/** « Passer en urgence » / « Relancer »: the partner is asked to deliver on `dateSouhaitee`. Its
 *  answer is due after its own answer time (joursReponseUrgence), never typed. The first ask opens
 *  the urgency, the next ones while it awaits are relances; asked again once answered, it opens a
 *  new one on the délai now in place. A relance may leave the date out: it keeps the one asked
 *  (even once that day has passed — the question still stands until the knitter answers).
 *  `idcommande` null = the line alone names its order. */
export async function demanderUrgence(d: {
  idcommande: number | null; idligne: number; dateSouhaitee?: string | null; note?: string
  par: AuteurUrgence; aujourdhui: string
}, sql: Sql = mpsPg()): Promise<void> {
  const l = await ligneOuverte(sql, d.idcommande, d.idligne)
  if (l.terminee) throw new UrgenceRefusee('ligne_terminee', 'Cette ligne est terminée.')
  const actuelle = await urgenceDe(sql, d.idligne, l.delai, d.aujourdhui)
  const enCours = enAttenteDeReponse(actuelle)
  const garde = enCours && (!d.dateSouhaitee || d.dateSouhaitee === actuelle.dateSouhaitee) ? actuelle.dateSouhaitee : null
  const dateSouhaitee = garde ?? d.dateSouhaitee ?? null
  if (!garde) {
    const refus = refusDateSouhaitee(dateSouhaitee, l.delai, d.aujourdhui)
    if (refus) throw new UrgenceRefusee('date_souhaitee_invalide', refus, 400)
  }
  const reponseAttendue = plusOuvres(d.aujourdhui, joursReponseUrgence(l.sst))
  await sql`
    INSERT INTO urgence_sst (idcommande_sous_traitant, idligne_commande_sous_traitant, type, reponse_attendue, date_souhaitee, delai_avant, note, par_id, par)
    VALUES (${l.cmd}, ${d.idligne}, ${enCours ? 'relance' : 'demande'}, ${reponseAttendue}::date, ${dateSouhaitee}::date,
            ${l.delai}::date, ${(d.note ?? '').trim() || null}, ${d.par.id}, ${d.par.nom})`
}

async function clore(type: 'refus' | 'levee', d: { idcommande: number | null; idligne: number; note?: string; par: AuteurUrgence; aujourdhui: string }, sql: Sql): Promise<void> {
  const l = await ligneOuverte(sql, d.idcommande, d.idligne)
  const u = await urgenceDe(sql, d.idligne, l.delai, d.aujourdhui)
  // A refusal answers an ask still awaited; a levée also takes the « urgente » mark off an answered one.
  if (!u || (type === 'refus' && !enAttenteDeReponse(u))) {
    throw new UrgenceRefusee('pas_d_urgence', type === 'refus' ? 'Aucune urgence n’attend de réponse sur cette ligne.' : 'Aucune urgence sur cette ligne.')
  }
  await sql`
    INSERT INTO urgence_sst (idcommande_sous_traitant, idligne_commande_sous_traitant, type, delai_avant, note, par_id, par)
    VALUES (${l.cmd}, ${d.idligne}, ${type}, ${l.delai}::date, ${(d.note ?? '').trim() || null}, ${d.par.id}, ${d.par.nom})`
}

/** « Le tricoteur ne peut pas »: its délai stands (or stays to give), the urgency is over. */
export async function refuserUrgence(d: { idcommande: number | null; idligne: number; note?: string; par: AuteurUrgence; aujourdhui: string }, sql: Sql = mpsPg()): Promise<void> {
  await clore('refus', d, sql)
}

/** « Annuler l'urgence »: given up on our side. */
export async function leverUrgence(d: { idcommande: number | null; idligne: number; note?: string; par: AuteurUrgence; aujourdhui: string }, sql: Sql = mpsPg()): Promise<void> {
  await clore('levee', d, sql)
}

// ── The mail to the partner ──────────────────────────────

/** Which message: the urgency asked, asked again, or given up. */
export const GESTES_MAIL = ['demande', 'relance', 'levee'] as const
export type GesteMail = (typeof GESTES_MAIL)[number]

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** The pre-filled mail of a gesture: short, like the bon de commande's. `dateSouhaitee` / `delai` /
 *  `demandeeLe` 'YYYY-MM-DD' or null; `article` « REF - coloris ». Pure. */
export function texteMailUrgence(p: {
  geste: GesteMail; numero: number; article: string | null; dateSouhaitee: string | null; delai: string | null; demandeeLe: string | null
}): { subject: string; body: string } {
  const cmd = `commande N°${p.numero}${p.article ? ` (${p.article})` : ''}`
  const souhaite = p.dateSouhaitee ? jjmmaaaa(p.dateSouhaitee) : null
  if (p.geste === 'levee') {
    return {
      subject: `Commande N°${p.numero} : demande d’urgence annulée — ETS Malterre`,
      body: 'Bonjour,\n\n'
        + `Nous annulons notre demande d’urgence sur notre ${cmd}.\n\n`
        + (p.delai ? `Votre délai du ${jjmmaaaa(p.delai)} reste inchangé.` : 'Merci de nous indiquer votre délai habituel.')
        + '\n\nMerci pour votre compréhension.\n\nCordialement,',
    }
  }
  const sujet = `URGENT — Commande N°${p.numero}${souhaite ? ` : livraison souhaitée le ${souhaite}` : ''} — ETS Malterre`
  if (p.geste === 'relance') {
    return {
      subject: `Relance — ${sujet}`,
      body: 'Bonjour,\n\n'
        + `Nous revenons vers vous au sujet de notre demande d’urgence${p.demandeeLe ? ` du ${jjmmaaaa(p.demandeeLe)}` : ''} sur notre ${cmd}`
        + (souhaite ? ` : nous souhaitons la recevoir le ${souhaite}.` : '.')
        + '\n\nPouvez-vous nous répondre aujourd’hui : cette date est-elle possible, et sinon laquelle ?\n\nMerci d’avance.\n\nCordialement,',
    }
  }
  return {
    subject: sujet,
    body: 'Bonjour,\n\n'
      + `Nous avons besoin de passer en urgence notre ${cmd}.\n\n`
      + (souhaite ? `Date souhaitée : ${souhaite}.\n` : '')
      + (p.delai ? `Délai que vous nous avez donné : ${jjmmaaaa(p.delai)}.\n` : '')
      + '\nPouvez-vous nous confirmer cette date, ou nous indiquer au plus vite ce qui est possible ?\n\nMerci d’avance.\n\nCordialement,',
  }
}

/** What the mail of a gesture is written from: the line's délai and the latest ask (read from the
 *  facts, so it works once the urgency is given up too). Null when the line is unknown. */
export async function contexteMailUrgence(idcommande: number, idligne: number, sql: Sql = mpsPg()): Promise<{ delai: string | null; dateSouhaitee: string | null; demandeeLe: string | null } | null> {
  const l = await ligneDe(sql, idligne)
  if (!l || l.cmd !== idcommande) return null
  const faits = (await lireFaitsUrgence([idligne], sql)).get(idligne) ?? []
  const demandes = faits.filter((f) => f.type === 'demande' || f.type === 'relance')
  return {
    delai: l.delai,
    dateSouhaitee: [...demandes].reverse().find((f) => f.dateSouhaitee)?.dateSouhaitee ?? null,
    demandeeLe: [...faits].reverse().find((f) => f.type === 'demande')?.jour ?? null,
  }
}

/** The mail was sent: a fact for the Journal. */
export async function noterMailUrgence(d: { idcommande: number; idligne: number; geste: GesteMail; destinataires: readonly string[]; par: AuteurUrgence }, sql: Sql = mpsPg()): Promise<void> {
  await sql`
    INSERT INTO urgence_sst (idcommande_sous_traitant, idligne_commande_sous_traitant, type, geste, destinataires, par_id, par)
    VALUES (${d.idcommande}, ${d.idligne}, 'mail', ${d.geste}, ${d.destinataires.join(', ').slice(0, 2000)}, ${d.par.id}, ${d.par.nom})`
}

/** Called by every writer of a line's délai, AFTER the write: when an urgency was awaiting and the
 *  partner moved the délai it had given, the answer is a fact of its own (the Journal tells « délai
 *  avancé du … au … »). A FIRST délai needs nothing here: « délai reçu » already tells it, and the
 *  urgency reads as answered by itself. Never throws: the délai is written. */
export async function noterReponseUrgence(idligne: number, avant: unknown, apres: unknown, par: AuteurUrgence | null, sql: Sql = mpsPg()): Promise<void> {
  try {
    const a = isoDe(avant)
    const b = isoDe(apres)
    if (!a || !b || a === b) return
    if (!(await urgenceEnAttente(idligne, a, sql))) return
    const l = await ligneDe(sql, idligne)
    if (!l) return
    await sql`
      INSERT INTO urgence_sst (idcommande_sous_traitant, idligne_commande_sous_traitant, type, delai_avant, delai_donne, par_id, par)
      VALUES (${l.cmd}, ${idligne}, 'reponse', ${a}::date, ${b}::date, ${par?.id ?? 0}, ${par?.nom ?? null})`
  } catch (err) {
    console.error('[urgence-sst] réponse non notée pour la ligne', idligne, err)
  }
}
