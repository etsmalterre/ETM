// The launch date of a client line's next step (doctrine des délais §5, decision Vincent 2026-10-28).
//
// Why: a line « à lancer » is red (lib/urgence-commande-client.ts), there is always something to do
// now. The one exception is a decision to wait: the yarn is bought later, the knitting starts after
// another order, the dyer gets the écru on a given week. That decision is a FACT on the line, never
// an absence of reservation: ligne_commande_client.date_lancement. Before it the line is neutral,
// from it red. It only acts on a line « à lancer »: once something is launched, the status moves on
// and the date no longer means anything.
//
// The step that waits (etape_lancement) is where « Planifier » was clicked — the Fil, Tricotage or
// Ennoblissement tab of the line drawer — so no free-text why is asked (Vincent, same day): the red
// reason names the action, « 1 ligne à ennoblir · prévu 16/11 ». Still ONE date per line: planning
// from another tab replaces the date and its step.
//
// The wait ends when the step goes: an order of that step created from the line removes the date
// (leverAuLancement, Vincent same day), journaled as « lancée » so the history tells a launch from a
// date removed by hand — and a deleted order never brings an old date back.
//
// The date is typed by hand for now; the doctrine's own computation (jalonnement, plafonds per
// partner) will write the same columns later. Every change is kept in lancement_ligne_client
// (append-only, migrations 0039/0040), the columns hold the latest one for the list's colour.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

export const ETAPES_LANCEMENT = ['fil', 'tricotage', 'ennoblissement'] as const
export type EtapeLancement = (typeof ETAPES_LANCEMENT)[number]

export interface Lancement {
  /** YYYYMMDD */
  date: string
  etape: EtapeLancement | null
}

export interface ChangementLancement {
  id: number
  /** YYYYMMDD, null = date removed */
  date: string | null
  etape: EtapeLancement | null
  saisi_le: Date
  saisi_par: string | null
  /** the date ended because the step was launched from the line (not removed by hand) */
  lancee: boolean
}

/** lancement_ligne_client.motif of a row written by leverAuLancement (the 0039 column, else unused). */
const MOTIF_LANCEE = 'lancee'

const YMD = /^\d{8}$/
const etapeDe = (v: unknown): EtapeLancement | null => (ETAPES_LANCEMENT as readonly string[]).includes(String(v)) ? (v as EtapeLancement) : null

/** YYYYMMDD → YYYY-MM-DD for PostgreSQL, null when not a real calendar date. */
export function versDatePg(ymd: string | null | undefined): string | null {
  if (!ymd || !YMD.test(ymd)) return null
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

/** The current launch date (and its step) of each line; lines without one are absent. */
export async function datesLancement(ligneIds: readonly number[]): Promise<Map<number, Lancement>> {
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  const out = new Map<number, Lancement>()
  if (ids.length === 0) return out
  const rows = await mpsPg().unsafe<{ id: number; d: string; etape: string | null }[]>(
    `SELECT idligne_commande_client AS id, to_char(date_lancement, 'YYYYMMDD') AS d, etape_lancement AS etape
       FROM ligne_commande_client
      WHERE idligne_commande_client = ANY($1::bigint[]) AND date_lancement IS NOT NULL`, [ids as any])
  for (const r of rows) out.set(Number(r.id), { date: r.d, etape: etapeDe(r.etape) })
  return out
}

/** Every change of a line's launch date, newest first. */
export async function historiqueLancement(ligneId: number): Promise<ChangementLancement[]> {
  const rows = await mpsPg()<{ id: number; d: string | null; etape: string | null; saisi_le: Date; saisi_par: string | null; motif: string | null }[]>`
    SELECT id, to_char(date_lancement, 'YYYYMMDD') AS d, etape, saisi_le, saisi_par, motif
      FROM lancement_ligne_client WHERE idligne_commande_client = ${ligneId}
     ORDER BY saisi_le DESC, id DESC`
  return rows.map((r) => ({ id: Number(r.id), date: r.d, etape: etapeDe(r.etape), saisi_le: r.saisi_le, saisi_par: r.saisi_par, lancee: r.motif === MOTIF_LANCEE }))
}

/** Sets (or removes, date null) the launch date and its step: the columns and their journal row, together. */
export async function fixerDateLancement(p: { ligneId: number; date: string | null; etape: EtapeLancement | null; parId: number; par: string | null }): Promise<void> {
  const datePg = p.date === null ? null : versDatePg(p.date)
  if (p.date !== null && !datePg) throw new Error('date de lancement invalide')
  const etape = datePg ? p.etape : null
  await mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`UPDATE ligne_commande_client SET date_lancement = ${datePg}::date, etape_lancement = ${etape}
              WHERE idligne_commande_client = ${p.ligneId}`
    await tx`
      INSERT INTO lancement_ligne_client (idligne_commande_client, date_lancement, etape, saisi_par_id, saisi_par)
      VALUES (${p.ligneId}, ${datePg}::date, ${etape}, ${p.parId}, ${p.par})`
  })
}

/** An order of `etape` was just created from the line: the wait for that step is over, its date goes
 *  (journaled « lancée »). A date held by another step stays; a date without a step (before 0040) goes. */
export async function leverAuLancement(p: { ligneId: number; etape: EtapeLancement; parId: number; par: string | null }): Promise<void> {
  await mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    const [row] = await tx<{ etape: string | null }[]>`
      SELECT etape_lancement AS etape FROM ligne_commande_client
       WHERE idligne_commande_client = ${p.ligneId} AND date_lancement IS NOT NULL FOR UPDATE`
    if (!row || (row.etape !== null && row.etape !== p.etape)) return
    await tx`UPDATE ligne_commande_client SET date_lancement = NULL, etape_lancement = NULL
              WHERE idligne_commande_client = ${p.ligneId}`
    await tx`
      INSERT INTO lancement_ligne_client (idligne_commande_client, date_lancement, etape, motif, saisi_par_id, saisi_par)
      VALUES (${p.ligneId}, NULL, ${p.etape}, ${MOTIF_LANCEE}, ${p.parId}, ${p.par})`
  })
}
