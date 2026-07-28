import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query } from '../lib/hfsql-auto.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import {
  batchRepair,
  money,
  normalizeVariationType,
  pickKey,
  qty,
  uniteLabel,
  type VariationType,
} from './references-divers.js'

export const stockDiversRouter: RouterType = Router()

// stock_divers is the quantity on hand for a "référence diverse", one row per
// VARIATION COMBINATION. Mirrors the legacy FEN_Stock_Divers.wdw (flat list) +
// FEN_Gestion_Stock_Divers.wdw (the tiny add/edit modal, where the reference and
// both variations are locked once the row exists and only the quantity is
// editable — reproduced here).
//
//   stock_divers   IDstock_divers, IDref_divers, quantite, unite,
//                  IDVariation1, IDVariation2   ← all ASCII, no accented column
//
// The variation model, the price model and the accented-`archivé` handling all
// live in references-divers.ts — this route imports its helpers rather than
// re-deriving them, so the two Divers screens can never drift apart.
//
// HFSQL notes:
//   • ref_divers.archivé is ACCENTED — never name it in SQL (the Linux bridge
//     truncates at the accent, and an unknown column triggers a respawn storm on
//     the shared prod server). Reads go through SELECT * + pickKey(/^archiv/i).
//   • Empty FK columns store 0, never NULL — a variation id of 0 means
//     "this axis does not apply", not "missing".
//   • Every lookup is batched: one query for all refs, one for all variations,
//     one for all tarifs. Never per row.

/** Resolved unit price for one stock row. Follows the same three-case model as
 *  the Références screen: a reference with no variation axis prices through
 *  ref_divers.prix_unitaire; a reference with axes prices through tarif_divers,
 *  either per combination or via the single (0, 0) "global" row. */
function resolvePrix(
  hasAxes: boolean,
  prixUnitaire: number,
  tarifsForRef: Map<string, number> | undefined,
  v1: number,
  v2: number,
): number | null {
  if (!hasAxes) return prixUnitaire || null
  if (!tarifsForRef) return null
  const exact = tarifsForRef.get(`${v1}|${v2}`)
  if (exact != null) return exact
  const global = tarifsForRef.get('0|0')
  return global ?? null
}

interface RefContext {
  IDref_divers: number
  designation: string | null
  unite: number
  prix_unitaire: number
  observations: string | null
  archive: number
  sTypeVariation1: VariationType
  sTypeVariation2: VariationType
}

/** All ref_divers rows keyed by id, with accents repaired. `SELECT *` (never a
 *  column list) because `archivé` cannot be named. */
async function loadRefContext(): Promise<Map<number, RefContext>> {
  const raw = await query<Record<string, unknown>>(`SELECT * FROM ref_divers`)
  const shaped = raw.map((r) => ({
    IDref_divers: Number(r.IDref_divers) || 0,
    designation: (r.designation ?? null) as string | null,
    unite: Number(r.unite) || 0,
    prix_unitaire: money(r.prix_unitaire) ?? 0,
    observations: (r.observations ?? null) as string | null,
    archive: Number(pickKey(r, /^archiv/i)) ? 1 : 0,
    sTypeVariation1: normalizeVariationType(r.sTypeVariation1),
    sTypeVariation2: normalizeVariationType(r.sTypeVariation2),
  }))
  const fixed = (await batchRepair(shaped as never, 'ref_divers', 'IDref_divers', [
    'designation',
  ])) as unknown as RefContext[]
  return new Map(fixed.map((r) => [r.IDref_divers, r]))
}

/** Every variation VALUE in the catalog, id → label. Resolved globally (not per
 *  reference) so legacy rows pointing at a niveau-0 leftover still render a
 *  label instead of a bare id. */
async function loadVariationLabels(): Promise<Map<number, string>> {
  const raw = await query<Record<string, unknown>>(
    `SELECT IDref_divers_variation, designation FROM ref_divers_variation`,
  )
  const fixed = await batchRepair(raw, 'ref_divers_variation', 'IDref_divers_variation', ['designation'])
  const out = new Map<number, string>()
  for (const r of fixed) {
    const id = Number(r.IDref_divers_variation) || 0
    if (id > 0) out.set(id, ((r.designation ?? '') as string).trim())
  }
  return out
}

/** tarif_divers indexed as refId → "v1|v2" → prix. */
async function loadTarifIndex(): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>()
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDref_divers, prix, IDVariation1, IDVariation2 FROM tarif_divers`,
    )
    for (const r of rows) {
      const refId = Number(r.IDref_divers) || 0
      if (refId === 0) continue
      let bucket = out.get(refId)
      if (!bucket) {
        bucket = new Map<string, number>()
        out.set(refId, bucket)
      }
      bucket.set(`${Number(r.IDVariation1) || 0}|${Number(r.IDVariation2) || 0}`, money(r.prix) ?? 0)
    }
  } catch {
    /* pricing is a display nicety — never fail the list over it */
  }
  return out
}

interface StockRowRaw {
  IDstock_divers: number
  IDref_divers: number
  quantite: number
  unite: number
  IDVariation1: number
  IDVariation2: number
}

function readStockRow(r: Record<string, unknown>): StockRowRaw {
  return {
    IDstock_divers: Number(r.IDstock_divers) || 0,
    IDref_divers: Number(r.IDref_divers) || 0,
    quantite: qty(r.quantite),
    unite: Number(r.unite) || 0,
    IDVariation1: Number(r.IDVariation1) || 0,
    IDVariation2: Number(r.IDVariation2) || 0,
  }
}

/** Shape one stock row for the UI: joined designation, variation labels,
 *  resolved unit price and line value. */
function shapeRow(
  row: StockRowRaw,
  refs: Map<number, RefContext>,
  variationLabels: Map<number, string>,
  tarifs: Map<number, Map<string, number>>,
) {
  const ref = refs.get(row.IDref_divers)
  const hasAxes = !!ref && (ref.sTypeVariation1 !== 'Aucun' || ref.sTypeVariation2 !== 'Aucun')
  const unite = row.unite || ref?.unite || 0
  const label = (vid: number): string | null => (vid > 0 ? variationLabels.get(vid) || `#${vid}` : null)
  const prix = ref
    ? resolvePrix(hasAxes, ref.prix_unitaire, tarifs.get(row.IDref_divers), row.IDVariation1, row.IDVariation2)
    : null
  return {
    IDstock_divers: row.IDstock_divers,
    IDref_divers: row.IDref_divers,
    quantite: row.quantite,
    unite,
    unite_label: uniteLabel(unite),
    IDVariation1: row.IDVariation1,
    IDVariation2: row.IDVariation2,
    variation1_label: label(row.IDVariation1),
    variation2_label: label(row.IDVariation2),
    ref_designation: ref?.designation ?? null,
    ref_archive: ref?.archive ?? 0,
    sTypeVariation1: ref?.sTypeVariation1 ?? ('Aucun' as VariationType),
    sTypeVariation2: ref?.sTypeVariation2 ?? ('Aucun' as VariationType),
    prix: prix,
    valeur: prix == null ? null : Math.round(row.quantite * prix * 100) / 100,
  }
}

// ──────────────────────────────────────────────────────────
// LOOKUPS  (declared before /:id so "lookups" is never parsed as an id)
// ──────────────────────────────────────────────────────────

// GET /api/stock-divers/lookups/references
// Feeds the "Nouvelle ligne de stock" dialog: every non-archived reference with
// its two axes, its unit, and the values available on each axis.
stockDiversRouter.get('/lookups/references', async (_req: Request, res: Response) => {
  try {
    const refs = await loadRefContext()
    const active = [...refs.values()].filter((r) => r.archive === 0)
    if (active.length === 0) {
      res.json([])
      return
    }

    const rawVars = await query<Record<string, unknown>>(
      `SELECT IDref_divers_variation, IDref_divers, designation, niveau FROM ref_divers_variation ORDER BY niveau, designation`,
    )
    const fixedVars = await batchRepair(rawVars, 'ref_divers_variation', 'IDref_divers_variation', [
      'designation',
    ])
    const byRef = new Map<number, { id: number; designation: string; niveau: number }[]>()
    for (const v of fixedVars) {
      const refId = Number(v.IDref_divers) || 0
      const arr = byRef.get(refId) ?? []
      arr.push({
        id: Number(v.IDref_divers_variation) || 0,
        designation: ((v.designation ?? '') as string).trim(),
        niveau: Number(v.niveau) || 0,
      })
      byRef.set(refId, arr)
    }

    const out = active
      .map((r) => {
        const values = byRef.get(r.IDref_divers) ?? []
        return {
          IDref_divers: r.IDref_divers,
          designation: r.designation,
          unite: r.unite,
          unite_label: uniteLabel(r.unite),
          sTypeVariation1: r.sTypeVariation1,
          sTypeVariation2: r.sTypeVariation2,
          variations1: values.filter((v) => v.niveau === 1),
          variations2: values.filter((v) => v.niveau === 2),
        }
      })
      .sort((a, b) => (a.designation ?? '').localeCompare(b.designation ?? '', 'fr'))
    res.json(out)
  } catch (err) {
    console.error('Error fetching stock_divers reference lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// LIST
// ──────────────────────────────────────────────────────────

// GET /api/stock-divers
// The whole table (a few hundred rows) — search, sorting and the zero/archived
// filters are client-side, same as the other table-centric stock screens.
stockDiversRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const rawRows = await query<Record<string, unknown>>(
      `SELECT IDstock_divers, IDref_divers, quantite, unite, IDVariation1, IDVariation2
       FROM stock_divers ORDER BY IDstock_divers DESC`,
    )
    if (rawRows.length === 0) {
      res.json([])
      return
    }
    const [refs, variationLabels, tarifs] = await Promise.all([
      loadRefContext(),
      loadVariationLabels(),
      loadTarifIndex(),
    ])
    res.json(rawRows.map((r) => shapeRow(readStockRow(r), refs, variationLabels, tarifs)))
  } catch (err) {
    console.error('Error fetching stock_divers list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// DETAIL
// ──────────────────────────────────────────────────────────

// GET /api/stock-divers/:id — the row plus reference-level context the drawer
// shows alongside it (observations, how much of this reference is in stock, and
// how many combinations it is spread over).
stockDiversRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<Record<string, unknown>>(
      `SELECT IDstock_divers, IDref_divers, quantite, unite, IDVariation1, IDVariation2
       FROM stock_divers WHERE IDstock_divers = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Stock divers not found' }); return }
    const row = readStockRow(rows[0])

    const [refs, variationLabels, tarifs] = await Promise.all([
      loadRefContext(),
      loadVariationLabels(),
      loadTarifIndex(),
    ])
    const shaped = shapeRow(row, refs, variationLabels, tarifs)
    const ref = refs.get(row.IDref_divers)

    let refStockTotal = 0
    let refCombinaisons = 0
    try {
      const agg = await query<{ n: number; q: number }>(
        `SELECT COUNT(*) AS n, SUM(quantite) AS q FROM stock_divers WHERE IDref_divers = ${row.IDref_divers}`,
      )
      refCombinaisons = Number(agg[0]?.n ?? 0)
      refStockTotal = qty(agg[0]?.q)
    } catch { /* tolerate */ }

    res.json({
      ...shaped,
      ref_observations: ref?.observations ?? null,
      ref_unite_label: uniteLabel(ref?.unite ?? 0),
      ref_stock_total: refStockTotal,
      ref_combinaisons: refCombinaisons,
    })
  } catch (err) {
    console.error('Error fetching stock_divers detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ──────────────────────────────────────────────────────────
// WRITES
// ──────────────────────────────────────────────────────────

const createBody = z.object({
  IDref_divers: z.number().int().positive(),
  IDVariation1: z.number().int().nonnegative().optional(),
  IDVariation2: z.number().int().nonnegative().optional(),
  quantite: z.number().finite().optional(),
})

/** A variation id must belong to the reference it is being attached to,
 *  otherwise the combination is meaningless and the label lookup would resolve
 *  to another reference's value. */
async function variationBelongsToRef(vid: number, refId: number): Promise<boolean> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ref_divers_variation WHERE IDref_divers_variation = ${vid} AND IDref_divers = ${refId}`,
  )
  return Number(r[0]?.n ?? 0) > 0
}

// POST /api/stock-divers — legacy "Ajouter" in FEN_Stock_Divers.
stockDiversRouter.post('/', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'create_stock_divers')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: create_stock_divers' })
      return
    }

    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data

    const refs = await loadRefContext()
    const ref = refs.get(b.IDref_divers)
    if (!ref) { res.status(404).json({ error: 'Référence introuvable.' }); return }
    if (ref.archive === 1) {
      res.status(409).json({ error: 'Cette référence est archivée : désarchivez-la avant d’y ajouter du stock.' })
      return
    }

    // An axis set to "Aucun" carries no value: force the id to 0 rather than
    // trusting the client. An active axis requires a value that belongs to the
    // reference.
    const v1 = ref.sTypeVariation1 === 'Aucun' ? 0 : (b.IDVariation1 ?? 0)
    const v2 = ref.sTypeVariation2 === 'Aucun' ? 0 : (b.IDVariation2 ?? 0)
    for (const [niveau, vid, axis] of [
      [1, v1, ref.sTypeVariation1],
      [2, v2, ref.sTypeVariation2],
    ] as const) {
      if (axis === 'Aucun') continue
      if (vid <= 0) {
        res.status(400).json({ error: `Sélectionnez une valeur pour la variation ${niveau}.` })
        return
      }
      if (!(await variationBelongsToRef(vid, b.IDref_divers))) {
        res.status(400).json({ error: `Cette valeur de variation n’appartient pas à la référence.` })
        return
      }
    }

    // One row per combination — a duplicate would silently double the totals on
    // the Références screen, which sums them.
    const dup = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_divers
       WHERE IDref_divers = ${b.IDref_divers} AND IDVariation1 = ${v1} AND IDVariation2 = ${v2}`,
    )
    if (Number(dup[0]?.n ?? 0) > 0) {
      res.status(409).json({
        error: 'Cette combinaison est déjà en stock : modifiez la ligne existante.',
      })
      return
    }

    const quantite = qty(b.quantite ?? 0)
    await query(
      `INSERT INTO stock_divers (IDref_divers, quantite, unite, IDVariation1, IDVariation2)
       VALUES (${b.IDref_divers}, ${quantite}, ${ref.unite || 0}, ${v1}, ${v2})`,
    )
    const created = await query<{ IDstock_divers: number }>(
      `SELECT IDstock_divers FROM stock_divers WHERE IDref_divers = ${b.IDref_divers}
       AND IDVariation1 = ${v1} AND IDVariation2 = ${v2} ORDER BY IDstock_divers DESC LIMIT 1`,
    )
    res.status(201).json({ IDstock_divers: created[0]?.IDstock_divers ?? null })
  } catch (err) {
    console.error('Error creating stock_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/stock-divers/:id — quantity only. The legacy "Gestion Stock Divers"
// modal greys out the reference and both variation combos once the row exists:
// changing them would move the stock to a different combination, which is a
// delete + create, not an edit.
stockDiversRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_stock_divers')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: edit_stock_divers' })
      return
    }

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = z.object({ quantite: z.number().finite() }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }

    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_divers WHERE IDstock_divers = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Stock divers not found' }); return }

    await query(`UPDATE stock_divers SET quantite = ${qty(parsed.data.quantite)} WHERE IDstock_divers = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating stock_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/stock-divers/:id — nothing references a stock_divers row (order,
// devis and expédition lines point at ref_divers + the variation ids, never at
// the stock row), so there is no guard to run.
stockDiversRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'not authenticated' })
      return
    }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_stock_divers')
    if (!allowed) {
      res.status(403).json({ error: 'permission denied: edit_stock_divers' })
      return
    }

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const scope = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_divers WHERE IDstock_divers = ${id}`,
    )
    if (Number(scope[0]?.n ?? 0) === 0) { res.status(404).json({ error: 'Stock divers not found' }); return }

    await query(`DELETE FROM stock_divers WHERE IDstock_divers = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting stock_divers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
