import { query, fixEncoding } from './hfsql-auto.js'

/**
 * The ennoblissement treatment catalog (`traitement`) and the per-reference
 * junction (`traitement_ref_fini`) — shared by Finis › Références (the real
 * datasheet, LIVA #1136) and Finis › Tarifs (the simulator, whose own junction
 * `asso_traitement_tarif` may repeat a treatment; this one is a strict set).
 *
 * Every column involved is ASCII-named, so plain named INSERT / DELETE apply.
 */

export interface TraitementCatalogRow {
  IDtraitement: number
  designation: string | null
  ordre: number
}

export interface RefTraitementRow {
  IDtraitement: number
  designation: string | null
}

/** Catalog rows in display order, soft-deleted ones excluded. */
export async function loadTraitementCatalog(): Promise<TraitementCatalogRow[]> {
  const rows = await query<{ IDtraitement: number; designation: string | null; ordre: number; is_deleted: number }>(
    `SELECT IDtraitement, designation, ordre, is_deleted FROM traitement ORDER BY ordre`,
  )
  const fixed = (await fixEncoding(rows as any[], 'traitement', 'IDtraitement', [
    'designation',
  ])) as Array<{ IDtraitement: number; designation: string | null; ordre: number; is_deleted: number }>
  return fixed
    .filter((t) => Number(t.is_deleted) !== 1)
    .map((t) => ({
      IDtraitement: Number(t.IDtraitement),
      designation: t.designation ?? null,
      ordre: Number(t.ordre) || 0,
    }))
}

/** Treatments attached to one `ref_fini`, in catalog order. */
export async function loadRefFiniTraitements(IDref_fini: number): Promise<RefTraitementRow[]> {
  const tr = await query<{ IDtraitement: number; designation: string | null; ordre: number | null }>(
    `SELECT t.IDtraitement, t.designation, t.ordre
       FROM traitement_ref_fini trf
       JOIN traitement t ON trf.IDtraitement = t.IDtraitement
      WHERE trf.IDref_fini = ${IDref_fini}
      ORDER BY t.ordre`,
  )
  const fixed = (await fixEncoding(tr as any[], 'traitement', 'IDtraitement', ['designation'])) as any[]
  return fixed.map((t) => ({ IDtraitement: Number(t.IDtraitement), designation: t.designation ?? null }))
}

export type AttachResult = 'ok' | 'ref_not_found' | 'traitement_not_found' | 'deja_associe'

/**
 * Attach a treatment to a reference. The junction is a set (1 570 legacy rows,
 * zero duplicate pairs on 2026-09-08), so a second attach of the same treatment
 * is refused rather than inserted.
 */
export async function attachTraitement(IDref_fini: number, IDtraitement: number): Promise<AttachResult> {
  const ref = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ref_fini WHERE IDref_fini = ${IDref_fini}`)
  if (Number(ref[0]?.n ?? 0) === 0) return 'ref_not_found'
  const trt = await query<{ is_deleted: number }>(
    `SELECT is_deleted FROM traitement WHERE IDtraitement = ${IDtraitement}`,
  )
  if (trt.length === 0 || Number(trt[0].is_deleted) === 1) return 'traitement_not_found'
  const dup = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM traitement_ref_fini
      WHERE IDref_fini = ${IDref_fini} AND IDtraitement = ${IDtraitement}`,
  )
  if (Number(dup[0]?.n ?? 0) > 0) return 'deja_associe'
  await query(
    `INSERT INTO traitement_ref_fini (IDref_fini, IDtraitement) VALUES (${IDref_fini}, ${IDtraitement})`,
  )
  return 'ok'
}

/** Detach a treatment from a reference. Idempotent. */
export async function detachTraitement(IDref_fini: number, IDtraitement: number): Promise<void> {
  await query(
    `DELETE FROM traitement_ref_fini WHERE IDref_fini = ${IDref_fini} AND IDtraitement = ${IDtraitement}`,
  )
}
