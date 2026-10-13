// Fils › Commandes — « réglée » on a yarn supplier's invoice (LIVA #1292).
//
// A supplier invoice is a `ged` document of type 1 (facture fil) attached to a
// commande_fil (`IDreference = IDcommande_fil`). Paying it is a fact ETM did
// not record anywhere (the weekly Sage import only carries account balances),
// so a person ticks it on the document card: `ged.regle_le` / `regle_par_id` /
// `regle_par` (migration 0020). NULL `regle_le` = à régler.
//
// The organic certificate asked in the same ticket is NOT a tick: a GOTS
// transaction certificate attached to the order (type 5) already says it came
// in (decision Vincent, 2026-10-13).

import { mpsPg } from './mps-pg.js'

export const TYPE_DOC_FACTURE_FIL = 1

export interface ReglementFacture {
  /** ISO local date-time (Europe/Paris), null = à régler. */
  regle_le: string | null
  regle_par: string | null
  /** Ticked by the 0020 backfill (invoices filed before 2026-10-13), not by a
   *  person: the date is the go-live, not a payment date. */
  reprise: boolean
}

/** Payment state of the given ged rows, keyed by IDged. Rows other than a
 *  facture fil are absent from the map. */
export async function reglementsDeDocs(idgeds: number[]): Promise<Map<number, ReglementFacture>> {
  const out = new Map<number, ReglementFacture>()
  if (idgeds.length === 0) return out
  const rows = await mpsPg()<{ idged: number; regle_le: string | null; regle_par: string | null; reprise: boolean }[]>`
    SELECT idged,
           to_char(regle_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS regle_le,
           regle_par,
           (regle_le IS NOT NULL AND regle_par_id IS NULL) AS reprise
    FROM ged
    WHERE idged = ANY(${idgeds}) AND idtype_doc = ${TYPE_DOC_FACTURE_FIL}`
  for (const r of rows) out.set(r.idged, { regle_le: r.regle_le, regle_par: r.regle_par, reprise: r.reprise })
  return out
}

/** Number of unpaid invoices per commande_fil, for the left-list marker.
 *  Same scope as the documents tab (IDreference + type), so the marker never
 *  counts an invoice the tab does not show. */
export async function facturesARegler(commandeIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (commandeIds.length === 0) return out
  const rows = await mpsPg()<{ idreference: number; n: number }[]>`
    SELECT idreference, count(*)::int AS n
    FROM ged
    WHERE idreference = ANY(${commandeIds})
      AND idtype_doc = ${TYPE_DOC_FACTURE_FIL}
      AND regle_le IS NULL
    GROUP BY idreference`
  for (const r of rows) out.set(r.idreference, r.n)
  return out
}

/** Tick (or untick) an invoice. Returns false when the document is not a
 *  facture fil of this commande. */
export async function marquerReglement(
  commandeId: number,
  idged: number,
  regle: boolean,
  par: { id: number; nom: string },
): Promise<boolean> {
  const rows = regle
    ? await mpsPg()`
        UPDATE ged SET regle_le = now(), regle_par_id = ${par.id}, regle_par = ${par.nom}
        WHERE idged = ${idged} AND idreference = ${commandeId} AND idtype_doc = ${TYPE_DOC_FACTURE_FIL}
        RETURNING idged`
    : await mpsPg()`
        UPDATE ged SET regle_le = NULL, regle_par_id = NULL, regle_par = NULL
        WHERE idged = ${idged} AND idreference = ${commandeId} AND idtype_doc = ${TYPE_DOC_FACTURE_FIL}
        RETURNING idged`
  return rows.length > 0
}
