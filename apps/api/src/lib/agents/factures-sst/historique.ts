// The history of one dyer's invoice (Sous-traitants › Factures, « Historique »
// tab — decision Vincent 2026-10-05): what Tricobot found, what each person
// decided on a line, how the invoice was closed, the réclamation email that
// was sent and how the dispute ended. Append-only: a row is never edited, an
// undo is a new row. Table facture_sst_historique (mps-schema 0009).

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import type { Auteur } from '../store.js'

export type TypeEvenement =
  | 'recue'              // read and checked by Tricobot
  | 'ligne'              // a person decided (or undid) a line
  | 'validee'            // closed as validated
  | 'reclamee'           // claimed from the dyer (details.email when sent by email)
  | 'reclamation_close'  // the dispute ended (how: resume)
  | 'rouverte'           // put back « à traiter »

export interface Evenement {
  id: number
  le: string
  type: TypeEvenement
  par_nom: string | null
  resume: string
  details: Record<string, unknown>
}

export async function noter(
  sql: Sql,
  e: { idFacture: number; type: TypeEvenement; par?: Auteur | null; resume: string; details?: Record<string, unknown> },
): Promise<void> {
  await sql`
    INSERT INTO facture_sst_historique (idfacture_sst, type, par, par_nom, resume, details)
    VALUES (${e.idFacture}, ${e.type}, ${e.par?.id ?? null}, ${e.par?.nom ?? null}, ${e.resume}, ${sql.json((e.details ?? {}) as never)})`
}

/** The invoice's history, oldest first. An invoice stored before the table
 *  existed gets its « reçue » row rebuilt from facture_sst. */
export async function lireHistorique(idFacture: number): Promise<Evenement[]> {
  const sql = mpsPg()
  const rows = await sql<{ id: number; le: Date; type: TypeEvenement; par_nom: string | null; resume: string; details: Record<string, unknown> }[]>`
    SELECT idhistorique AS id, le, type, par_nom, resume, details FROM facture_sst_historique
    WHERE idfacture_sst = ${idFacture} ORDER BY le, idhistorique`
  const out: Evenement[] = rows.map((r) => ({ ...r, id: Number(r.id), le: new Date(r.le).toISOString() }))
  if (!out.some((e) => e.type === 'recue')) {
    const [f] = await sql<{ cree_le: Date; statut: string; nb: number }[]>`
      SELECT f.cree_le, f.statut,
             (SELECT COUNT(*)::int FROM ligne_facture_sst l WHERE l.idfacture_sst = f.idfacture_sst AND l.verdict = 'ecart') AS nb
      FROM facture_sst f WHERE f.idfacture_sst = ${idFacture}`
    if (f) out.unshift({ id: 0, le: new Date(f.cree_le).toISOString(), type: 'recue', par_nom: null, resume: resumeRecue(f.statut, Number(f.nb)), details: {} })
  }
  return out
}

export function resumeRecue(statut: string, nbEcarts: number): string {
  return statut === 'conforme' || nbEcarts === 0
    ? 'Reçue et contrôlée par Tricobot : aucun écart.'
    : `Reçue et contrôlée par Tricobot : ${nbEcarts} écart${nbEcarts > 1 ? 's' : ''}.`
}
