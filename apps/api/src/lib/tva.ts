// TVA rate resolution for client-facing documents (confirmation de commande,
// devis, facture proforma).
//
// The rate is a property of the CLIENT, not of the company: `client.IDtva`
// points at a `tva` row, and every société has an "Exonération" row (valeur 0)
// used for export customers (Maroc, hors UE…) who must never be charged VAT.
// Reading the société-1 `est_defaut` row instead — which is what the commande
// and devis PDFs used to do — silently taxed those clients at 20 %.
//
// Resolution order: the client's own `tva` row → the ETM default row → 0.
// `client.IDtva = 0` means "never set", so it falls through to the default;
// an explicit exonération row resolves to 0 and must NOT fall through.
//
// factures.ts does not use these helpers: a facture stores its own `IDtva`
// (copied from the client at creation, then editable), so the rate is read
// from the facture row — an old invoice keeps the rate it was issued with.

import { query } from './hfsql-auto.js'

/** ETM's own société id (1 = ETM, 2 = TRM, 3 = Confection). */
const ID_SOCIETE_ETM = 1

/** ETM's default TVA rate (%) — the `est_defaut` row for IDsociete = 1 (≈ 20). */
export async function loadDefaultTvaRate(): Promise<number> {
  try {
    const rows = await query<{ valeur: number | null }>(
      `SELECT valeur FROM tva WHERE IDsociete = ${ID_SOCIETE_ETM} AND est_defaut = 1`,
    )
    return Number(rows[0]?.valeur) || 0
  } catch { return 0 }
}

/** The TVA rate (%) to apply to a document issued to this client. Returns 0
 *  for a client flagged "Exonération" in Clients › Gestion. */
export async function loadClientTvaRate(IDclient: number): Promise<number> {
  const id = Number(IDclient) || 0
  if (id > 0) {
    try {
      const cli = await query<{ IDtva: number | null }>(
        `SELECT IDtva FROM client WHERE IDclient = ${id}`,
      )
      const IDtva = Number(cli[0]?.IDtva) || 0
      if (IDtva > 0) {
        const tv = await query<{ valeur: number | null }>(
          `SELECT valeur FROM tva WHERE IDtva = ${IDtva}`,
        )
        // A matched row wins even when its valeur is 0 (exonération).
        if (tv.length > 0) return Number(tv[0].valeur) || 0
      }
    } catch { /* fall through to the default rate */ }
  }
  return loadDefaultTvaRate()
}
