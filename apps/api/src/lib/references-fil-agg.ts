/**
 * The two aggregates behind the Fils › Références sidebar (« Stock actuel » and
 * « En commande »), as pure functions so their edge cases can be pinned without
 * a database. Both were wrong in production until ticket #1090.
 */
import { pickVal } from './accented-keys.js'

export interface StockAggregate {
  totalKg: number
  lots: number
  /** IDcolori_fil → per-variant total. Lots with IDcolori_fil = 0 are counted
   *  in the totals above but have no variant to hang off. */
  perVariante: Map<number, { total_kg: number; lots: number }>
}

/**
 * « Stock actuel »: sum the lots that are still in progress.
 *
 * ⚠️ The `terminé` flag MUST be read by prefix — the Linux bridge mangles the
 * key (see lib/accented-keys.ts). Reading it as `row.termin` left the flag at 0
 * for every row in production, so the card summed every lot since 2020,
 * exhausted and negative ones included: 113 of the 130 stocked references
 * showed a wrong total and 4 showed a NEGATIVE stock (#1090).
 */
export function aggregateStockFilRows(rows: Record<string, unknown>[]): StockAggregate {
  const perVariante = new Map<number, { total_kg: number; lots: number }>()
  let totalKg = 0
  let lots = 0
  for (const row of rows) {
    if (Number(pickVal(row, /^termin/i)) !== 0) continue
    const kg = Number(row.stock) || 0
    totalKg += kg
    lots += 1
    const coloriId = Number(row.IDcolori_fil) || 0
    if (coloriId > 0) {
      const cur = perVariante.get(coloriId) ?? { total_kg: 0, lots: 0 }
      cur.total_kg += kg
      cur.lots += 1
      perVariante.set(coloriId, cur)
    }
  }
  return { totalKg, lots, perVariante }
}

export interface CommandeLine {
  IDref_fil_commande: number
  quantite: number
  /** ref_fil_commande.etat */
  etat_ligne: number
  /** commande_fil.etat */
  etat: number
}

/**
 * « En commande »: what is still EXPECTED from suppliers.
 *
 * Same rule as Rapports › Commandes fils (`qte_restante`), deliberately — the
 * two surfaces answer the same question and must never drift: open lines of
 * open commandes, minus what already landed. A line that over-delivered
 * contributes 0, never a negative that would mask a genuine shortfall
 * elsewhere.
 *
 * ⚠️ `recuByLine` must be keyed on the LINE and built WITHOUT scoping the
 * stock_fil query to this référence: 12 live lots hang off a line whose
 * `IDref_fil` differs from their own, and scoping by ref under-counts their
 * reception — which would overstate what is still awaited.
 *
 * Before #1090 this figure was the whole purchase history instead, closed
 * commandes included: 792 t announced as "en commande" across the catalog
 * against 28 t genuinely awaited, a factor of 28.
 */
export function resteALivrer(
  lines: CommandeLine[],
  recuByLine: Map<number, number>,
): { kg: number; lignes: number } {
  let kg = 0
  let lignes = 0
  for (const l of lines) {
    if (l.etat_ligne === 1 || l.etat === 1) continue
    const reste = (Number(l.quantite) || 0) - (recuByLine.get(l.IDref_fil_commande) ?? 0)
    if (reste <= 0) continue
    kg += reste
    lignes += 1
  }
  return { kg, lignes }
}
