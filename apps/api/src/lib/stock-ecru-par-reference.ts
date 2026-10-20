// What one écru reference has in stock right now, in total and per coloris,
// for the sidebar and the Coloris tab of Tombé Métier › Références.
//
// « In stock » is NOT the same fact for the two companies (see the header of
// routes/stock-ecru-trm.ts): ETM's population is filtered in stock-ecru.ts,
// TRM's in stock-ecru-trm.ts, each with its own « disponible » rule. Both
// routes feed their rows to this one aggregator, so the shape the screen reads
// is identical while the population stays each company's own.

export interface StockEcruPieceRow {
  IDcolori_ecru: unknown
  poids: unknown
  /** True when the piece is free (ETM: not affected to a dyer line; TRM: not
   *  reserved to a client line). */
  disponible: boolean
}

export interface StockQuantite {
  pieces: number
  kg: number
}

export interface StockEcruParReference extends StockQuantite {
  disponible: StockQuantite
  coloris: Array<StockQuantite & { IDcolori_ecru: number; disponible: StockQuantite }>
}

const round1 = (n: number) => Math.round(n * 10) / 10

export function aggregateStockEcru(rows: StockEcruPieceRow[]): StockEcruParReference {
  const total = { pieces: 0, kg: 0 }
  const dispo = { pieces: 0, kg: 0 }
  const byColoris = new Map<number, { pieces: number; kg: number; dPieces: number; dKg: number }>()
  for (const r of rows) {
    const kg = Number(r.poids) || 0
    const id = Number(r.IDcolori_ecru) || 0
    total.pieces++
    total.kg += kg
    const c = byColoris.get(id) ?? { pieces: 0, kg: 0, dPieces: 0, dKg: 0 }
    c.pieces++
    c.kg += kg
    if (r.disponible) {
      dispo.pieces++
      dispo.kg += kg
      c.dPieces++
      c.dKg += kg
    }
    byColoris.set(id, c)
  }
  return {
    pieces: total.pieces,
    kg: round1(total.kg),
    disponible: { pieces: dispo.pieces, kg: round1(dispo.kg) },
    coloris: [...byColoris.entries()]
      .sort(([a], [b]) => a - b)
      .map(([IDcolori_ecru, c]) => ({
        IDcolori_ecru,
        pieces: c.pieces,
        kg: round1(c.kg),
        disponible: { pieces: c.dPieces, kg: round1(c.dKg) },
      })),
  }
}
