// ETM affectation gate on OF launch — LIVA #1159 (2026-09-14).
//
// Choosing which yarn goes on a tricotage order is Pierrot's decision, made
// in ETM on the sst's « Stock fil » tab (asso_fil_lignecmdsst). The TRM OF
// dialog never depended on it — it picked its lots on its own — and on prod
// on 2026-09-14, 9 of the 16 (line, fil) pairs being knitted on open
// Tricotage Malterre orders had no affectation at all. The rule now (user
// decision, same day): an OF on the mirror of an ETM sst line cannot be
// launched, nor have its composition rewritten, with a fil (ref + coloris)
// that has no affectation on that ETM line. The lot itself is not enforced —
// the affected lot is the dialog's default, but a lot swap within the same
// fil (a lot running out mid-order) stays a régleur's call.
//
// A TRM-native line (no `IDligne_commande_ETM`) has no affectation concept:
// `suivi = false`, nothing is checked.

import { query } from './hfsql-auto.js'

export interface AffectedLot {
  IDstock_fil: number
  IDref_fil: number
  IDcolori_fil: number
  lot: string
  /** kg of this lot affected to the ETM line. */
  quantite: number
}

export interface EtmAffectation {
  /** false = TRM-native line, no ETM mirror — nothing to check. */
  suivi: boolean
  /** The ETM sst line (`ligne_commande_client.IDligne_commande_ETM`), 0 when unsuivi. */
  ligne_etm: number
  /** The sst number the user sees (« N° 9032 »), 0 when unsuivi. */
  sst_numero: number
  lots: AffectedLot[]
}

export interface FilPair {
  IDref_fil: number
  IDcolori_fil: number
}

const UNSUIVI: EtmAffectation = { suivi: false, ligne_etm: 0, sst_numero: 0, lots: [] }

/** The ETM affectation behind a TRM commande line. */
export async function loadEtmAffectation(trmLigneId: number): Promise<EtmAffectation> {
  if (!(trmLigneId > 0)) return UNSUIVI
  const mirror = await query<{ IDligne_commande_ETM: number | null }>(
    `SELECT IDligne_commande_ETM FROM ligne_commande_client WHERE IDligne_commande_client = ${trmLigneId}`,
  )
  const ligneEtm = Number(mirror[0]?.IDligne_commande_ETM) || 0
  if (ligneEtm <= 0) return UNSUIVI
  const sst = await query<{ IDcommande_sous_traitant: number | null }>(
    `SELECT IDcommande_sous_traitant FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${ligneEtm}`,
  )
  // All-ASCII columns, lots are ASCII — the JOIN is bridge-safe (same shape
  // as the État des stocks de fil widget's Besoin query).
  const rows = await query<{ IDstock_fil: number; IDref_fil: number; IDcolori_fil: number; lot: string | null; quantite: number | null }>(
    `SELECT a.IDstock_fil, sf.IDref_fil, sf.IDcolori_fil, sf.lot, a.quantite
     FROM asso_fil_lignecmdsst a
     JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
     WHERE a.IDligne_commande_sous_traitant = ${ligneEtm}
     ORDER BY a.IDasso_fil_ligneCmdSST`,
  )
  return {
    suivi: true,
    ligne_etm: ligneEtm,
    sst_numero: Number(sst[0]?.IDcommande_sous_traitant) || 0,
    lots: rows.map((r) => ({
      IDstock_fil: Number(r.IDstock_fil) || 0,
      IDref_fil: Number(r.IDref_fil) || 0,
      IDcolori_fil: Number(r.IDcolori_fil) || 0,
      lot: (r.lot ?? '').toString().trim(),
      quantite: Number(r.quantite) || 0,
    })),
  }
}

/** Does an affected lot feed this pair? A composition row with coloris 0
 *  (older refs) accepts any coloris of the fil. */
export function isPairAffected(pair: FilPair, lots: AffectedLot[]): boolean {
  return lots.some((l) =>
    l.IDref_fil === pair.IDref_fil && (pair.IDcolori_fil === 0 || l.IDcolori_fil === pair.IDcolori_fil))
}

/** The distinct (ref, coloris) pairs of a composition that no affected lot
 *  covers — empty means the OF may be launched. Order of first appearance. */
export function missingAffectations(composition: FilPair[], lots: AffectedLot[]): FilPair[] {
  const out: FilPair[] = []
  const seen = new Set<string>()
  for (const c of composition) {
    const key = `${c.IDref_fil}:${c.IDcolori_fil}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!isPairAffected(c, lots)) out.push({ IDref_fil: c.IDref_fil, IDcolori_fil: c.IDcolori_fil })
  }
  return out
}
