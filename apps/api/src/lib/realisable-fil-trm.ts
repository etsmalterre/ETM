/**
 * « Réalisable (stock de fil) » of a TRM OF — the fabric the chosen lots still
 * allow, in Kg.
 *
 * The unit is the LOT, not the (fil, coloris) pair: an OF reserves a lot
 * (`asso_fil_of.IDstock_fil`), the visitage decrements that lot, and a lot is
 * one customer's yarn (TRM knits à façon — `stock_fil.IDclient` is the owner).
 * Until LIVA #1147 (2026-09-11) the detail route summed every lot of the pair,
 * so the « Stock » column read 2 226 Kg against a 380 Kg lot and « Réalisable »
 * was inflated the same way, while the edit picker and « Finir le fil » already
 * counted the lot. This is the one rule for all of them; the web keeps a
 * verbatim copy (`apps/web/src/lib/realisable-fil.ts`) whose test imports this
 * file.
 *
 * Per lot: stock ÷ (Σ % of the rows it feeds) — two feeding positions on one
 * lot draw on it together — then the minimum over lots (a blend only knits
 * while every component lasts). Rows without a lot or without a share are
 * ignored; `null` when nothing is left to estimate from.
 */
export interface LotShare {
  IDstock_fil: number
  /** Stock of the chosen lot, in Kg. */
  lot_stock: number
  pourcentage: number
}

export function realisableSurLots(rows: LotShare[]): number | null {
  const byLot = new Map<number, { stock: number; pct: number }>()
  for (const c of rows) {
    if (c.IDstock_fil <= 0 || !(c.pourcentage > 0)) continue
    const cur = byLot.get(c.IDstock_fil) ?? { stock: c.lot_stock, pct: 0 }
    cur.pct += c.pourcentage
    byLot.set(c.IDstock_fil, cur)
  }
  if (byLot.size === 0) return null
  let min = Infinity
  for (const { stock, pct } of byLot.values()) min = Math.min(min, Math.max(0, stock) / (pct / 100))
  return Number.isFinite(min) ? min : null
}
