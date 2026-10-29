// Clients › Commandes: moving a line's date D after it was given (doctrine des délais §8, Vincent
// 2026-10-28). The first D is our engagement (ligne_commande_client.delai_annonce, frozen by the API);
// every later change of D is a « report » with its why and who it is due to — Malterre, the client
// (he moves his own date convenue) or a partner (dyer, knitter, spinner late) — so the QS can tell our
// delays from the others'. Append-only (migration 0041), like the launch-date journal.

import { mpsPg } from './mps-pg.js'
import { versDatePg } from './lancement-ligne.js'

export const IMPUTABLES = ['malterre', 'client', 'partenaire'] as const
export type Imputable = (typeof IMPUTABLES)[number]

export interface ReportLigne {
  id: number
  /** YYYYMMDD, null = none */
  ancienne: string | null
  nouvelle: string | null
  motif: string
  imputable: Imputable
  saisi_le: Date
  saisi_par: string | null
}

/** True when changing D from `avant` to `apres` is a report: a date was already given and it moves. */
export function estUnReport(avant: string, apres: string): boolean {
  return !!avant && avant !== apres
}

export async function enregistrerReport(p: { ligneId: number; ancienne: string; nouvelle: string; motif: string; imputable: Imputable; parId: number; par: string | null }): Promise<void> {
  await mpsPg()`
    INSERT INTO report_ligne_client (idligne_commande_client, ancienne_date, nouvelle_date, motif, imputable, saisi_par_id, saisi_par)
    VALUES (${p.ligneId}, ${versDatePg(p.ancienne)}::date, ${versDatePg(p.nouvelle)}::date, ${p.motif}, ${p.imputable}, ${p.parId}, ${p.par})`
}

/** Every report of a line, newest first. */
export async function reportsLigne(ligneId: number): Promise<ReportLigne[]> {
  const rows = await mpsPg()<{ id: number; a: string | null; n: string | null; motif: string; imputable: Imputable; saisi_le: Date; saisi_par: string | null }[]>`
    SELECT id, to_char(ancienne_date, 'YYYYMMDD') AS a, to_char(nouvelle_date, 'YYYYMMDD') AS n, motif, imputable, saisi_le, saisi_par
      FROM report_ligne_client WHERE idligne_commande_client = ${ligneId}
     ORDER BY saisi_le DESC, id DESC`
  return rows.map((r) => ({ id: Number(r.id), ancienne: r.a, nouvelle: r.n, motif: r.motif, imputable: r.imputable, saisi_le: r.saisi_le, saisi_par: r.saisi_par }))
}
