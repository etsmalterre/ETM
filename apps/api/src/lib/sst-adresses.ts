// Default addresses of a sous-traitant for a new commande_sous_traitant.
//
// Three paths create a sst order (the sst screen's dialog → POST /, the
// knit-order helper behind Clients › Commandes, and « Ennoblir » in
// commandes-client.ts) and until 2026-09-14 only the knit helper resolved the
// addresses itself: « Ennoblir » hardcoded 0/0, and the dialog trusted the
// browser — which sent 0/0 on 20 MATEL orders between 30/07 and 02/09 for a
// reason that never showed in the code. 32 of MATEL's 88 orders since July
// had no address on the bon de commande. Every path now goes through here,
// and the POST fills whatever the client left at 0.
//
// Rule (legacy modal, reference TRM commande with adresse 777): principal =
// the `est_defaut` row, delivery = the `est_defaut_livraison` row, each
// falling back to the other and then to the first visible address.
import { query } from './hfsql-auto.js'

export interface SstAdresseRow {
  IDadresse: number
  est_defaut: number | null
  est_defaut_livraison: number | null
}

/** Pure: pick (principal, livraison) ids out of the visible rows, in
 *  `ORDER BY est_defaut DESC, IDadresse` order. 0 when the sst has none. */
export function pickDefaultAdresses(rows: SstAdresseRow[]): { principal: number; livraison: number } {
  const defaut = rows.find((a) => Number(a.est_defaut) === 1) ?? rows[0]
  const defautLiv = rows.find((a) => Number(a.est_defaut_livraison) === 1) ?? defaut
  return {
    principal: Number(defaut?.IDadresse) || 0,
    livraison: Number(defautLiv?.IDadresse) || 0,
  }
}

export async function loadSstAdresseRows(sstId: number): Promise<SstAdresseRow[]> {
  if (!(sstId > 0)) return []
  const rows = await query<SstAdresseRow>(
    `SELECT IDadresse, est_defaut, est_defaut_livraison FROM adresse
      WHERE IDsous_traitant = ${sstId} AND (est_visible IS NULL OR est_visible = 1)
      ORDER BY est_defaut DESC, IDadresse`,
  )
  return rows.map((r) => ({
    IDadresse: Number(r.IDadresse) || 0,
    est_defaut: Number(r.est_defaut) || 0,
    est_defaut_livraison: Number(r.est_defaut_livraison) || 0,
  }))
}

/** Addresses to stamp on a new sst order: the caller's explicit choice when
 *  it is a real id, the sous-traitant's defaults otherwise. */
export async function resolveSstAdresses(
  sstId: number,
  wanted?: { principal?: number | null; livraison?: number | null },
): Promise<{ principal: number; livraison: number }> {
  const p = Number(wanted?.principal) || 0
  const l = Number(wanted?.livraison) || 0
  if (p > 0 && l > 0) return { principal: p, livraison: l }
  const d = pickDefaultAdresses(await loadSstAdresseRows(sstId))
  return { principal: p > 0 ? p : d.principal, livraison: l > 0 ? l : d.livraison }
}
