import { describe, expect, it } from 'vitest'
import { aggregateStockEcru } from './stock-ecru-par-reference.js'

describe('aggregateStockEcru', () => {
  it('returns zeros for an empty stock', () => {
    expect(aggregateStockEcru([])).toEqual({ pieces: 0, kg: 0, disponible: { pieces: 0, kg: 0 }, coloris: [] })
  })

  it('totals pieces and kg, overall and per coloris, with the free share apart', () => {
    const out = aggregateStockEcru([
      { IDcolori_ecru: 12, poids: 20.2, disponible: true },
      { IDcolori_ecru: 12, poids: '19.9', disponible: false },
      { IDcolori_ecru: 7, poids: 21, disponible: true },
      { IDcolori_ecru: 0, poids: null, disponible: true },
    ])
    expect(out.pieces).toBe(4)
    expect(out.kg).toBe(61.1)
    expect(out.disponible).toEqual({ pieces: 3, kg: 41.2 })
    expect(out.coloris).toEqual([
      { IDcolori_ecru: 0, pieces: 1, kg: 0, disponible: { pieces: 1, kg: 0 } },
      { IDcolori_ecru: 7, pieces: 1, kg: 21, disponible: { pieces: 1, kg: 21 } },
      { IDcolori_ecru: 12, pieces: 2, kg: 40.1, disponible: { pieces: 1, kg: 20.2 } },
    ])
  })
})
