// An urgency asked of a sous-traitant on one of its order lines (Vincent 2026-11-16).
//
// A client line whose date can no longer be held (« date client intenable »,
// lib/urgence-commande-client.ts) had one way out: move the client's date. Before
// that, the person asks the partner to go faster than its standard, and then there
// is nothing to do at Malterre until the partner answers. So the asking is a fact,
// with the day the answer is expected:
//
//   - 'demande'  the urgency is asked (a mail, a call), answer expected on a date;
//   - 'relance'  no answer on that date: asked again, a new date;
//   - 'levee'    given up (the client's date was moved, a mistake).
//
// It is OPEN from its 'demande' until the partner gives its délai on the line
// (read on the line, never written here) or a 'levee'. While open and the answer
// is awaited, whoever reads it stays neutral; from the working day after
// `reponseAttendue` it is ours to chase: red, « relancer ».
//
// First used on knitting lines (a tricoteur's order line without a délai): the
// step « Tricotage (estimé) » of a client line's earliest date. A line that
// already has a délai has no urgency to ask here: an earlier délai is refused
// (lib/report-delai-sst.ts refusAvanceDelai), the early delivery is read on the
// reception.
//
// `urgence_sst` (migration 0076) is append-only: the API role may SELECT / INSERT.
// Dates are 'YYYY-MM-DD' here, like lib/delai-sst.ts.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { ouvresEntre, plusOuvres } from './delai-sst.js'

/** sous_traitant.idtype_sst of a knitter (lib/sst-tricotage.ts TYPE_SST_TRICOTEUR, which reads this
 *  file: not imported back). */
const TYPE_SST_TRICOTEUR = 1

/** Working days the partner gets to answer, proposed by the dialog. */
export const REPONSE_URGENCE_J = 2
/** …and the most a person may give: an urgency that waits a week is no urgency,
 *  and every day waited is a day the client is not told. */
export const REPONSE_URGENCE_MAX_J = 5

export type TypeFaitUrgence = 'demande' | 'relance' | 'levee'

export interface FaitUrgence {
  type: TypeFaitUrgence
  /** 'YYYY-MM-DDTHH:MI' (Paris). */
  le: string
  /** 'YYYY-MM-DD' (Paris). */
  jour: string
  /** 'YYYY-MM-DD'; null on a 'levee'. */
  reponseAttendue: string | null
  /** 'YYYY-MM-DD' the date asked for, when one was named. */
  dateSouhaitee: string | null
  note: string | null
  par: string | null
}

export interface UrgenceOuverte {
  /** 'YYYY-MM-DD' the day it was first asked. */
  demandeeLe: string
  /** 'YYYY-MM-DD' the answer is expected (the latest ask). */
  reponseAttendue: string
  /** How many times it was asked again. */
  relances: number
  dateSouhaitee: string | null
  note: string | null
  par: string | null
  /** The answer did not come on the day it was expected: ours to chase. */
  aRelancer: boolean
}

/** The urgency open on a line, null when there is none: never asked, given up, or
 *  answered (the line has its délai). `faits` oldest first. Pure. */
export function urgenceOuverte(faits: readonly FaitUrgence[], aUnDelai: boolean, aujourdhui: string): UrgenceOuverte | null {
  if (aUnDelai) return null
  const depuis = faits.map((f) => f.type).lastIndexOf('levee')
  const episode = faits.slice(depuis + 1).filter((f) => f.reponseAttendue)
  if (episode.length === 0) return null
  const premiere = episode[0]
  const derniere = episode[episode.length - 1]
  return {
    demandeeLe: premiere.jour,
    reponseAttendue: derniere.reponseAttendue!,
    relances: episode.length - 1,
    dateSouhaitee: [...episode].reverse().find((f) => f.dateSouhaitee)?.dateSouhaitee ?? null,
    note: derniere.note,
    par: derniere.par,
    // On the day itself the answer is still expected: nobody has anything to do.
    aRelancer: aujourdhui > derniere.reponseAttendue!,
  }
}

/** Why an answer date is refused, null when it is fine: today at the earliest,
 *  REPONSE_URGENCE_MAX_J working days at the latest. Pure. */
export function refusReponseAttendue(reponseAttendue: string, aujourdhui: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reponseAttendue)) return 'Indiquez le jour où la réponse est attendue.'
  if (reponseAttendue < aujourdhui) return 'La réponse ne peut pas être attendue dans le passé.'
  if (ouvresEntre(aujourdhui, reponseAttendue) > REPONSE_URGENCE_MAX_J) {
    return `Une urgence attend sa réponse ${REPONSE_URGENCE_MAX_J} jours ouvrés au plus : au-delà, relancez ou prévenez le client.`
  }
  return null
}

/** The answer date the dialog proposes. Pure. */
export function reponseProposee(aujourdhui: string): string {
  return plusOuvres(aujourdhui, REPONSE_URGENCE_J)
}

// ── Reads ────────────────────────────────────────────────

/** The urgency facts of each line, oldest first. */
export async function lireFaitsUrgence(ligneIds: readonly number[], sql: Sql = mpsPg()): Promise<Map<number, FaitUrgence[]>> {
  const out = new Map<number, FaitUrgence[]>()
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  if (ids.length === 0) return out
  const rows = await sql<{ ligne: number; type: string; le: string; jour: string; reponse: string | null; souhaitee: string | null; note: string | null; par: string | null }[]>`
    SELECT idligne_commande_sous_traitant AS ligne, type,
           to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS le,
           to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour,
           to_char(reponse_attendue, 'YYYY-MM-DD') AS reponse, to_char(date_souhaitee, 'YYYY-MM-DD') AS souhaitee,
           note, par
      FROM urgence_sst WHERE idligne_commande_sous_traitant = ANY(${ids}) ORDER BY le, id`
  for (const r of rows) {
    const lid = Number(r.ligne)
    out.set(lid, [...(out.get(lid) ?? []), {
      type: r.type as TypeFaitUrgence, le: r.le, jour: r.jour, reponseAttendue: r.reponse, dateSouhaitee: r.souhaitee, note: r.note, par: r.par,
    }])
  }
  return out
}

/** The urgency open on each line that has one. `lignes`: the line and whether it
 *  has its délai (a line with a délai has no open urgency). */
export async function urgencesOuvertes(
  lignes: readonly { id: number; aUnDelai: boolean }[], aujourdhui: string, sql: Sql = mpsPg(),
): Promise<Map<number, UrgenceOuverte>> {
  const out = new Map<number, UrgenceOuverte>()
  const sansDelai = lignes.filter((l) => l.id > 0 && !l.aUnDelai)
  if (sansDelai.length === 0) return out
  const faits = await lireFaitsUrgence(sansDelai.map((l) => l.id), sql)
  for (const l of sansDelai) {
    const u = urgenceOuverte(faits.get(l.id) ?? [], false, aujourdhui)
    if (u) out.set(l.id, u)
  }
  return out
}

// ── Gestures ─────────────────────────────────────────────

export interface AuteurUrgence { id: number; nom: string }

export class UrgenceRefusee extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message) }
}

interface LigneUrgence { cmd: number; aUnDelai: boolean; terminee: boolean; tricoteur: boolean }

async function ligneDe(sql: Sql, idligne: number): Promise<LigneUrgence | null> {
  const [l] = await sql<{ cmd: number; delai: string | null; sstatut: string | null; type_sst: number | null }[]>`
    SELECT l.idcommande_sous_traitant AS cmd, to_char(l.date_livraison, 'YYYYMMDD') AS delai, l.sstatut::text AS sstatut,
           st.idtype_sst AS type_sst
      FROM ligne_commande_sous_traitant l
      LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
      LEFT JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
     WHERE l.idligne_commande_sous_traitant = ${idligne}`
  if (!l) return null
  return {
    cmd: Number(l.cmd),
    aUnDelai: /^\d{8}$/.test(l.delai ?? ''),
    terminee: (l.sstatut ?? '').trim().startsWith('Termin'),
    tricoteur: Number(l.type_sst) === TYPE_SST_TRICOTEUR,
  }
}

async function ligneOuverte(sql: Sql, idcommande: number, idligne: number): Promise<LigneUrgence> {
  const l = await ligneDe(sql, idligne)
  if (!l || l.cmd !== idcommande) throw new UrgenceRefusee('ligne_inconnue', 'Ligne introuvable sur cette commande.', 404)
  return l
}

/** « Demander une urgence » / « Relancer »: the partner was asked to go faster,
 *  its answer is expected on `reponseAttendue`. The first ask opens the urgency,
 *  the next ones are relances. A date asked for is written on the line too
 *  (`date_demandee`, the « Demandé pour le » the bon de commande prints). */
export async function demanderUrgence(d: {
  idcommande: number; idligne: number; reponseAttendue: string; dateSouhaitee: string | null; note: string
  par: AuteurUrgence; aujourdhui: string
}): Promise<void> {
  const sql = mpsPg()
  const l = await ligneOuverte(sql, d.idcommande, d.idligne)
  if (!l.tricoteur) throw new UrgenceRefusee('pas_tricotage', 'L’urgence se demande sur une commande de tricotage.')
  if (l.terminee) throw new UrgenceRefusee('ligne_terminee', 'Cette ligne est terminée.')
  if (l.aUnDelai) throw new UrgenceRefusee('delai_deja_donne', 'Le tricoteur a déjà donné son délai sur cette ligne.')
  const refus = refusReponseAttendue(d.reponseAttendue, d.aujourdhui)
  if (refus) throw new UrgenceRefusee('reponse_attendue_invalide', refus, 400)
  const souhaitee = d.dateSouhaitee && /^\d{4}-\d{2}-\d{2}$/.test(d.dateSouhaitee) ? d.dateSouhaitee : null
  if (souhaitee && souhaitee < d.aujourdhui) throw new UrgenceRefusee('date_souhaitee_passee', 'La date souhaitée ne peut pas être passée.', 400)
  const ouverte = urgenceOuverte((await lireFaitsUrgence([d.idligne], sql)).get(d.idligne) ?? [], false, d.aujourdhui)
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`
      INSERT INTO urgence_sst (idcommande_sous_traitant, idligne_commande_sous_traitant, type, reponse_attendue, date_souhaitee, note, par_id, par)
      VALUES (${d.idcommande}, ${d.idligne}, ${ouverte ? 'relance' : 'demande'}, ${d.reponseAttendue}::date, ${souhaitee}::date,
              ${d.note.trim() || null}, ${d.par.id}, ${d.par.nom})`
    if (souhaitee) {
      await tx`UPDATE ligne_commande_sous_traitant SET date_demandee = ${souhaitee}::date WHERE idligne_commande_sous_traitant = ${d.idligne}`
    }
  })
}

/** « Lever l'urgence »: given up before the partner answered. */
export async function leverUrgence(d: { idcommande: number; idligne: number; note: string; par: AuteurUrgence; aujourdhui: string }): Promise<void> {
  const sql = mpsPg()
  const l = await ligneOuverte(sql, d.idcommande, d.idligne)
  const ouverte = urgenceOuverte((await lireFaitsUrgence([d.idligne], sql)).get(d.idligne) ?? [], l.aUnDelai, d.aujourdhui)
  if (!ouverte) throw new UrgenceRefusee('pas_d_urgence', 'Aucune urgence n’est en attente sur cette ligne.')
  await sql`
    INSERT INTO urgence_sst (idcommande_sous_traitant, idligne_commande_sous_traitant, type, note, par_id, par)
    VALUES (${d.idcommande}, ${d.idligne}, 'levee', ${d.note.trim() || null}, ${d.par.id}, ${d.par.nom})`
}
