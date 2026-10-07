import { describe, expect, it } from 'vitest'
import { simulerRayon } from './stock-rayon'

describe('simulerRayon', () => {
  it('730 PES/CU: 750 kg on the shelf, 800 kg promised in 13 weeks — arrives in time', () => {
    const r = simulerRayon({ enStock: 750, rate: 26.4, livraisons: [{ id: 651, kg: 800, arriveeW: 13 }], horizon: 104, marge: 4 })
    const v = r.verdicts[0]
    expect(v.ruptureW).toBeNull()
    expect(v.stockAvantKg).toBeCloseTo(750 - 26.4 * 13, 6) // 406.8 kg ≈ 15 weeks left
    expect(v.tone).toBe('ok')
    // step up at the delivery
    expect(r.points).toContainEqual([13, v.stockAvantKg + 800])
    // then runs out after (406.8 + 800) / 26.4 more weeks
    expect(r.ruptureFinaleW).toBeCloseTo(13 + (750 - 26.4 * 13 + 800) / 26.4, 6)
  })

  it('flags a delivery that lands after the shelf ran empty', () => {
    const r = simulerRayon({ enStock: 100, rate: 10, livraisons: [{ id: 1, kg: 500, arriveeW: 14 }], horizon: 52, marge: 4 })
    expect(r.verdicts[0]).toMatchObject({ ruptureW: 10, stockAvantKg: 0, tone: 'danger' })
    expect(r.points.slice(0, 4)).toEqual([[0, 100], [10, 0], [14, 0], [14, 500]])
  })

  it('warns when it arrives with less than the margin left on the shelf', () => {
    const r = simulerRayon({ enStock: 100, rate: 10, livraisons: [{ id: 1, kg: 500, arriveeW: 8 }], horizon: 52, marge: 4 })
    expect(r.verdicts[0]).toMatchObject({ ruptureW: null, tone: 'warning' }) // 20 kg = 2 weeks
    expect(r.verdicts[0].stockAvantKg).toBeCloseTo(20, 6)
  })

  it('takes several deliveries in date order, each judged on its own', () => {
    const r = simulerRayon({
      enStock: 50, rate: 10,
      livraisons: [{ id: 2, kg: 100, arriveeW: 20 }, { id: 1, kg: 100, arriveeW: 2 }],
      horizon: 52, marge: 4,
    })
    expect(r.verdicts.map((v) => v.id)).toEqual([1, 2])
    expect(r.verdicts[0].tone).toBe('warning') // 30 kg left = 3 weeks, under the 4-week margin
    expect(r.verdicts[1]).toMatchObject({ ruptureW: 15, tone: 'danger' }) // 130 kg at week 2 → empty at 15
  })

  it('stays flat without consumption', () => {
    const r = simulerRayon({ enStock: 40, rate: 0, livraisons: [], horizon: 26, marge: 4 })
    expect(r.points).toEqual([[0, 40], [26, 40]])
    expect(r.ruptureFinaleW).toBeNull()
  })
})
