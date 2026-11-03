// Qualité › Actions judged PER LOT (decision Vincent 2026-11-03).
//
// An action's mention applies to sst lines (lib/actions-qualite.ts
// mentionsForLine); on a DYE line the verdict is given on each of its lots in
// Suivi lots › Actions, by a person: Conforme or Non conforme. No row = « à
// juger », and an open action « à juger » on a received lot blocks « Valider le
// lot » (lib/actions-lot.ts). Never computed (the « vérifiée par le vrillage »
// option was removed the same day).
//
// Table conformite_lot (migration 0056), native PostgreSQL. The legacy
// conformite_action (one verdict per line) stays only for the KNITTING lines,
// which have no lot yet: how to judge them is to be decided.

import { mpsPg } from './mps-pg.js'

export type VerdictLot = 'conforme' | 'non_conforme'

export interface VerdictLotRow {
  idsuivilot: number
  idmention: number
  conformite: VerdictLot
  par: string
  le: string
}

/** The verdicts of these lots (every mention). */
export async function verdictsDesLots(idsuivilots: number[]): Promise<VerdictLotRow[]> {
  const ids = [...new Set(idsuivilots.filter((x) => x > 0))]
  if (ids.length === 0) return []
  const rows = await mpsPg()<{ idsuivilot: string; idmention: string; conformite: VerdictLot; par: string; le: string }[]>`
    SELECT idsuivilot, idmention_qualite AS idmention, conformite, par, to_char(le, 'YYYY-MM-DD"T"HH24:MI') AS le
    FROM conformite_lot WHERE idsuivilot = ANY(${ids})`
  return rows.map((r) => ({ ...r, idsuivilot: Number(r.idsuivilot), idmention: Number(r.idmention) }))
}

/** Clé `${idsuivilot}:${idmention}` → verdict. */
export function indexVerdicts(rows: VerdictLotRow[]): Map<string, VerdictLotRow> {
  return new Map(rows.map((r) => [`${r.idsuivilot}:${r.idmention}`, r]))
}

/** Give a verdict, or take it back (null) after a wrong click. */
export async function ecrireVerdictLot(
  idsuivilot: number,
  idmention: number,
  conformite: VerdictLot | null,
  par: { id: number; nom: string },
): Promise<void> {
  const sql = mpsPg()
  if (conformite === null) {
    await sql`DELETE FROM conformite_lot WHERE idsuivilot = ${idsuivilot} AND idmention_qualite = ${idmention}`
    return
  }
  await sql`
    INSERT INTO conformite_lot (idsuivilot, idmention_qualite, conformite, par_id, par, le)
    VALUES (${idsuivilot}, ${idmention}, ${conformite}, ${par.id}, ${par.nom}, now())
    ON CONFLICT (idsuivilot, idmention_qualite)
    DO UPDATE SET conformite = EXCLUDED.conformite, par_id = EXCLUDED.par_id, par = EXCLUDED.par, le = now()`
}

export interface LotDeLigne {
  idsuivilot: number
  ligne: number
  lot: string
  /** suivilot.date, 'YYYY-MM-DD' (the BL); null = not received yet. */
  reception: string | null
}

/** The lots of these sst lines, oldest first. */
export async function lotsDesLignes(ligneIds: number[]): Promise<LotDeLigne[]> {
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  if (ids.length === 0) return []
  const rows = await mpsPg()<{ idsuivilot: string; ligne: string; lot: string | null; reception: string | null }[]>`
    SELECT idsuivilot, idligne_commande_sous_traitant AS ligne, trim(COALESCE(lot::text, '')) AS lot,
           to_char(date, 'YYYY-MM-DD') AS reception
    FROM suivilot WHERE idligne_commande_sous_traitant = ANY(${ids})
    ORDER BY date NULLS LAST, idsuivilot`
  return rows.map((r) => ({ idsuivilot: Number(r.idsuivilot), ligne: Number(r.ligne), lot: r.lot ?? '', reception: r.reception }))
}
