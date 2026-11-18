// Rappels: a dated note a person puts on an object (Vincent 2026-11-18).
//
// The app computes what there is to do from its data. Some things are in no
// data: an agreement with a client (first case, order 3891: « we keep the
// matter 6 months and try to sell it, the client takes it back on 04/05/2027 »),
// a promise made on the phone. It used to sit in a free comment nobody read
// again. A reminder is that note with a DATE and an OBJECT (a fini lot, a yarn
// lot, a piece, an order: lib/rappels-objets.ts).
//
// From its date it is a red task in the notification centre of the person it
// is for (routes/abonnements.ts), with nothing to subscribe to, until « Fait »
// (or « Repousser », a new date). Left red more than 2 working days it also
// reaches the holder of « Tâches en retard », like every task
// (lib/taches/registre.ts). Before its date it is invisible in the centre and
// visible to everyone on the object.
//
// ⚠️ An exception tool, not a to-do list: what the app CAN compute from its
// data (a late délai, a lot to control) belongs to the lists' own red, never to
// a reminder.
//
// PG `rappel` (migration 0081). Dates are 'YYYY-MM-DD' strings throughout.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { enRetard } from './taches/registre.js'
import { lienObjet, type TypeObjet } from './rappels-objets.js'

export const OBSERVATION_MAX = 1000

export interface Rappel {
  id: number
  objet_type: TypeObjet
  objet_id: number
  objet_libelle: string
  /** 'YYYY-MM-DD'. */
  echeance: string
  observation: string
  pour_id: number
  pour: string
  /** 'YYYY-MM-DD'. */
  cree_le: string
  par_id: number
  par: string
  /** 'YYYY-MM-DD', null while open. */
  fait_le: string | null
  fait_par: string | null
  fait_comment: string | null
  lien: string
}

export interface Auteur { id: number; nom: string }

export class RappelRefuse extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

// ── Rules (pure, pinned by rappels.test.ts) ──────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/
const ymd = (iso: string) => iso.replace(/-/g, '')

/** Today in Paris, 'YYYY-MM-DD'. */
export function aujourdhuiIso(maintenant: Date = new Date()): string {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(maintenant)
}

/** A real calendar day ('2027-02-30' is not). */
export function dateValide(iso: unknown): iso is string {
  if (typeof iso !== 'string' || !ISO.test(iso)) return false
  const d = new Date(`${iso}T12:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}

/** Why a date / observation is refused, or null. A reminder is for later: never a past date. */
export function refusRappel(v: { echeance?: unknown; observation?: unknown }, aujourdhui: string): { code: string; message: string } | null {
  if (v.echeance !== undefined) {
    if (!dateValide(v.echeance)) return { code: 'date_invalide', message: 'La date du rappel est obligatoire.' }
    if (v.echeance < aujourdhui) return { code: 'date_passee', message: 'La date du rappel ne peut pas être dans le passé.' }
  }
  if (v.observation !== undefined) {
    const t = typeof v.observation === 'string' ? v.observation.trim() : ''
    if (!t) return { code: 'observation_requise', message: 'L’observation est obligatoire : c’est ce qu’il faudra faire à la date du rappel.' }
    if (t.length > OBSERVATION_MAX) return { code: 'observation_longue', message: `L’observation ne peut pas dépasser ${OBSERVATION_MAX} caractères.` }
  }
  return null
}

/** Due: its date has come (the day itself counts) and nobody did it. */
export function estEchu(r: Pick<Rappel, 'echeance' | 'fait_le'>, aujourdhui: string): boolean {
  return r.fait_le === null && r.echeance <= aujourdhui
}

/** Late: due and left more than 2 working days (the register's rule, counted from its date). */
export function rappelEnRetard(r: Pick<Rappel, 'echeance' | 'fait_le'>, aujourdhui: string): boolean {
  return estEchu(r, aujourdhui) && enRetard(ymd(r.echeance), ymd(aujourdhui))
}

// ── Reads ────────────────────────────────────────────────

interface Ligne extends Omit<Rappel, 'lien'> {}

const avecLien = (r: Ligne): Rappel => ({ ...r, lien: lienObjet(r.objet_type, r.objet_id) })

const COLONNES = `id, objet_type, objet_id, objet_libelle, to_char(echeance, 'YYYY-MM-DD') AS echeance, observation,
  pour_id, pour, to_char(cree_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS cree_le, par_id, par,
  to_char(fait_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS fait_le, fait_par, fait_comment`

/** Every reminder of an object, open ones first (earliest date first), then the done ones. */
export async function rappelsDeLObjet(type: TypeObjet, id: number, sql: Sql = mpsPg()): Promise<Rappel[]> {
  const rows = await sql.unsafe<Ligne[]>(
    `SELECT ${COLONNES} FROM rappel WHERE objet_type = $1 AND objet_id = $2
      ORDER BY (fait_le IS NOT NULL), rappel.echeance, id`, [type, id])
  return rows.map(avecLien)
}

export async function lireRappel(id: number, sql: Sql = mpsPg()): Promise<Rappel | null> {
  const rows = await sql.unsafe<Ligne[]>(`SELECT ${COLONNES} FROM rappel WHERE id = $1`, [id])
  return rows[0] ? avecLien(rows[0]) : null
}

/** The reminders due for one person: their red tasks. */
export async function rappelsEchusPour(userId: number, aujourdhui: string, sql: Sql = mpsPg()): Promise<Rappel[]> {
  const rows = await sql.unsafe<Ligne[]>(
    `SELECT ${COLONNES} FROM rappel WHERE fait_le IS NULL AND pour_id = $1 AND rappel.echeance <= $2::date
      ORDER BY rappel.echeance, id`, [userId, aujourdhui])
  return rows.map(avecLien)
}

/** Every OPEN reminder that concerns one person, due or still to come, earliest date first: those
 *  that are for them, and those they put for someone else (did it get done?). The notification
 *  centre's « Mes rappels » view: a reminder put for in 6 months is otherwise invisible until its day. */
export async function rappelsOuvertsDe(userId: number, sql: Sql = mpsPg()): Promise<Rappel[]> {
  const rows = await sql.unsafe<Ligne[]>(
    `SELECT ${COLONNES} FROM rappel WHERE fait_le IS NULL AND (pour_id = $1 OR par_id = $1)
      ORDER BY rappel.echeance, id`, [userId])
  return rows.map(avecLien)
}

/** How many of them: the count on the « Mes rappels » button. */
export async function nombreRappelsOuvertsDe(userId: number, sql: Sql = mpsPg()): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rappel WHERE fait_le IS NULL AND (pour_id = ${userId} OR par_id = ${userId})`
  return Number(r?.n) || 0
}

/** Every reminder due and left more than 2 working days, whoever it is for (« Tâches en retard »). */
export async function rappelsEnRetard(aujourdhui: string, sql: Sql = mpsPg()): Promise<Rappel[]> {
  const rows = await sql.unsafe<Ligne[]>(
    `SELECT ${COLONNES} FROM rappel WHERE fait_le IS NULL AND rappel.echeance <= $1::date ORDER BY rappel.echeance, id`, [aujourdhui])
  return rows.map(avecLien).filter((r) => rappelEnRetard(r, aujourdhui))
}

/** How many reminders are still open on each object of a type (the dot on the « Rappel » button). */
export async function rappelsOuvertsParObjet(type: TypeObjet, ids: readonly number[], sql: Sql = mpsPg()): Promise<Map<number, number>> {
  const u = [...new Set(ids.filter((x) => x > 0))]
  if (u.length === 0) return new Map()
  const rows = await sql<{ id: number; n: number }[]>`
    SELECT objet_id AS id, count(*)::int AS n FROM rappel
     WHERE objet_type = ${type} AND objet_id = ANY(${u}) AND fait_le IS NULL GROUP BY objet_id`
  return new Map(rows.map((r) => [Number(r.id), Number(r.n)]))
}

// ── Gestures ─────────────────────────────────────────────

export interface NouveauRappel {
  objet_type: TypeObjet
  objet_id: number
  /** Read from the object by the route (lib/rappels-objets.ts lireObjet), frozen here. */
  objet_libelle: string
  echeance: string
  observation: string
  pour: Auteur
  par: Auteur
}

export async function creerRappel(n: NouveauRappel, sql: Sql = mpsPg()): Promise<Rappel> {
  const refus = refusRappel(n, aujourdhuiIso())
  if (refus) throw new RappelRefuse(refus.code, refus.message)
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO rappel (objet_type, objet_id, objet_libelle, echeance, observation, pour_id, pour, par_id, par)
    VALUES (${n.objet_type}, ${n.objet_id}, ${n.objet_libelle}, ${n.echeance}::date, ${n.observation.trim()},
            ${n.pour.id}, ${n.pour.nom}, ${n.par.id}, ${n.par.nom})
    RETURNING id`
  return (await lireRappel(Number(r.id), sql))!
}

async function ouvert(id: number, sql: Sql): Promise<Rappel> {
  const r = await lireRappel(id, sql)
  if (!r) throw new RappelRefuse('introuvable', 'Ce rappel n’existe plus.', 404)
  if (r.fait_le !== null) throw new RappelRefuse('deja_fait', 'Ce rappel est déjà fait.', 409)
  return r
}

/** « Repousser » (a new date) or a correction of the note / of who it is for. Open reminders only. */
export async function modifierRappel(id: number, v: { echeance?: string; observation?: string; pour?: Auteur }, sql: Sql = mpsPg()): Promise<Rappel> {
  const r = await ouvert(id, sql)
  const refus = refusRappel(v, aujourdhuiIso())
  if (refus) throw new RappelRefuse(refus.code, refus.message)
  await sql`
    UPDATE rappel SET echeance = ${v.echeance ?? r.echeance}::date,
                      observation = ${v.observation?.trim() ?? r.observation},
                      pour_id = ${v.pour?.id ?? r.pour_id}, pour = ${v.pour?.nom ?? r.pour}
     WHERE id = ${id}`
  return (await lireRappel(id, sql))!
}

/** « Fait »: closes it, with who and an optional word on how it ended. */
export async function marquerFait(id: number, par: Auteur, commentaire: string | null, sql: Sql = mpsPg()): Promise<Rappel> {
  await ouvert(id, sql)
  const c = (commentaire ?? '').trim().slice(0, OBSERVATION_MAX) || null
  await sql`UPDATE rappel SET fait_le = now(), fait_par_id = ${par.id}, fait_par = ${par.nom}, fait_comment = ${c} WHERE id = ${id}`
  return (await lireRappel(id, sql))!
}

/** Delete a reminder put by mistake: open ones only (a done reminder is the trace of what was agreed). */
export async function supprimerRappel(id: number, sql: Sql = mpsPg()): Promise<void> {
  await ouvert(id, sql)
  await sql`DELETE FROM rappel WHERE id = ${id}`
}

// ── Journal ──────────────────────────────────────────────

/** What a reminder adds to its object's Journal tab (lot, sst order): the day it was put, the day
 *  it was done. Read here, where the facts live, never copied into journal_lot. */
export interface EntreeRappel { le: string; titre: string; detail: string | null; par: string | null }

export async function journalRappels(type: TypeObjet, id: number, sql: Sql = mpsPg()): Promise<EntreeRappel[]> {
  const rows = await sql<{ echeance: string; observation: string; pour: string; cree_le: Date; par: string; fait_le: Date | null; fait_par: string | null; fait_comment: string | null }[]>`
    SELECT to_char(echeance, 'DD/MM/YYYY') AS echeance, observation, pour, cree_le, par, fait_le, fait_par, fait_comment
      FROM rappel WHERE objet_type = ${type} AND objet_id = ${id}`
  const out: EntreeRappel[] = []
  for (const r of rows) {
    out.push({
      le: new Date(r.cree_le).toISOString(),
      titre: `Rappel posé pour le ${r.echeance}`,
      detail: [r.observation, r.pour && r.pour !== r.par ? `pour ${r.pour}` : null].filter(Boolean).join(' · ') || null,
      par: r.par || null,
    })
    if (r.fait_le) {
      out.push({
        le: new Date(r.fait_le).toISOString(),
        titre: `Rappel du ${r.echeance} fait`,
        detail: r.fait_comment || r.observation,
        par: r.fait_par,
      })
    }
  }
  return out
}
