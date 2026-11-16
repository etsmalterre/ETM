// A divers reference is sold in ONE unit, the one of its fiche (Divers › Références:
// Kg, Ml, pièce or m² — ref_divers.unite). An order or devis line never picks another
// (LIVA #1371, Vincent 2026-11-16): order 3942 was taken « 10 unité » of a PVC sold by
// the Kg, because the line dialog offered the four units and started on « unité ».
// The shipment already read the unit on the reference (routes/expeditions.ts), so the
// order and its BL could disagree.
//
// One exception, the rule écru and fini lines already follow: a line saved earlier in
// another unit keeps it until someone changes it — never silently re-labelled (10 Ml
// would read 10 pièces). 36 lines of 2021, and any line whose reference changes unit
// on its fiche afterwards.

import { query } from './hfsql-auto.js'

/** Line types (ligne_commande_client / ligne_devis_etm `type`): 3 = divers. */
export const TYPE_DIVERS = 3

/** The units a divers reference can carry (legacy combo): 1 Kg, 3 Ml, 4 pièce, 5 m². */
export const UNITES_DIVERS: readonly number[] = [1, 3, 4, 5]

/** The reference's unit, 0 when it has none to impose (6 archived refs carry 255). Pure. */
export function uniteDiversValide(u: unknown): number {
  const n = Number(u) || 0
  return UNITES_DIVERS.includes(n) ? n : 0
}

/** The unit to write on a divers line. Pure.
 *  - `uniteRef`: the reference's unit (0 = none: the asked unit goes through);
 *  - `demandee`: what the caller sent, undefined when it sent none;
 *  - `uniteLigne`: the unit already stored on the line, ONLY when the line keeps its
 *    article (same type, same reference) — undefined on a new line or a changed one. */
export function uniteLigneDivers(p: { uniteRef: unknown; demandee?: number; uniteLigne?: number }): number | undefined {
  const ref = uniteDiversValide(p.uniteRef)
  if (!ref) return p.demandee
  if (p.uniteLigne !== undefined) {
    // Nothing asked, or the stored unit sent back as it was: the line keeps it.
    if (p.demandee === undefined || p.demandee === p.uniteLigne) return p.uniteLigne
  }
  return ref
}

/** `ref_divers.unite` of one reference, 0 when the reference does not exist. */
export async function loadUniteRefDivers(IDref_divers: unknown): Promise<number> {
  const id = Number(IDref_divers) || 0
  if (!(id > 0)) return 0
  const rows = await query<{ unite: number | null }>(`SELECT IDref_divers, unite FROM ref_divers WHERE IDref_divers = ${id}`)
  return uniteDiversValide(rows[0]?.unite)
}
