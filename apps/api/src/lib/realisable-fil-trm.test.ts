import { describe, it, expect } from 'vitest'
import { realisableSurLots } from './realisable-fil-trm.js'

// LIVA #1147 — OF 3574 on 2026-09-11: lot 10546 (380 Kg) at 90 %, lot 10521
// (422,48 Kg) at 10 %. The pair sum of COTON PEIGNE Z écru was 2 226,75 Kg.
const OF_3574 = [
  { IDstock_fil: 10546, lot_stock: 380, pourcentage: 90 },
  { IDstock_fil: 10521, lot_stock: 422.48, pourcentage: 10 },
]

describe('realisableSurLots', () => {
  it('is bounded by the chosen lot, not the pair', () => {
    expect(realisableSurLots(OF_3574)).toBeCloseTo(380 / 0.9, 2)
  })
  it('takes the minimum over components (a blend stops with its first empty lot)', () => {
    expect(realisableSurLots([
      { IDstock_fil: 1, lot_stock: 1000, pourcentage: 90 },
      { IDstock_fil: 2, lot_stock: 5, pourcentage: 10 },
    ])).toBeCloseTo(50, 6)
  })
  it('two feeding positions on one lot draw on it together', () => {
    expect(realisableSurLots([
      { IDstock_fil: 7, lot_stock: 100, pourcentage: 50 },
      { IDstock_fil: 7, lot_stock: 100, pourcentage: 50 },
    ])).toBeCloseTo(100, 6)
  })
  it('ignores rows without a lot or share, null when nothing is left to count', () => {
    expect(realisableSurLots([{ IDstock_fil: 0, lot_stock: 500, pourcentage: 100 }])).toBeNull()
    expect(realisableSurLots([{ IDstock_fil: 3, lot_stock: 500, pourcentage: 0 }])).toBeNull()
    expect(realisableSurLots([])).toBeNull()
    expect(realisableSurLots([
      { IDstock_fil: 0, lot_stock: 500, pourcentage: 50 },
      { IDstock_fil: 3, lot_stock: 20, pourcentage: 50 },
    ])).toBeCloseTo(40, 6)
  })
  it('an over-drawn lot counts as empty, never negative', () => {
    expect(realisableSurLots([{ IDstock_fil: 3, lot_stock: -12, pourcentage: 100 }])).toBe(0)
  })
})
