import { describe, it, expect } from 'vitest'
import { aggregateFactures, signed } from './rapport-factures-agg'

const facture = (ht: number, rate: number, type = 1) => {
  const tva = Math.round(ht * rate) / 100
  return { type, tva_rate: rate, total_ht: ht, total_tva: tva, total_ttc: Math.round((ht + tva) * 100) / 100 }
}

describe('signed', () => {
  it('keeps a facture positive and turns an avoir negative', () => {
    expect(signed(100, 1)).toBe(100)
    expect(signed(100, 2)).toBe(-100)
  })

  it('never yields -0 on an avoir with no TVA', () => {
    expect(Object.is(signed(0, 2), -0)).toBe(false)
    expect(signed(0, 2)).toBe(0)
  })
})

describe('aggregateFactures', () => {
  it('returns zeros on an empty set', () => {
    expect(aggregateFactures([])).toEqual({
      count: 0, nbFactures: 0, nbAvoirs: 0, ht: 0, tva: 0, ttc: 0, byRate: [],
    })
  })

  it('subtracts avoirs from every total, as the legacy grid prints them negative', () => {
    const t = aggregateFactures([
      facture(1000, 20), // 200 tva, 1200 ttc
      facture(300, 20, 2), // avoir: -60 tva, -360 ttc
    ])
    expect(t.count).toBe(2)
    expect(t.nbFactures).toBe(1)
    expect(t.nbAvoirs).toBe(1)
    expect(t.ht).toBe(700)
    expect(t.tva).toBe(140)
    expect(t.ttc).toBe(840)
  })

  it('splits by TVA rate, highest rate first, each bucket signed too', () => {
    const t = aggregateFactures([
      facture(1000, 20),
      facture(500, 0),
      facture(2000, 20),
      facture(100, 0, 2),
    ])
    expect(t.byRate.map((b) => b.rate)).toEqual([20, 0])
    expect(t.byRate[0]).toEqual({ rate: 20, count: 2, ht: 3000, tva: 600, ttc: 3600 })
    expect(t.byRate[1]).toEqual({ rate: 0, count: 2, ht: 400, tva: 0, ttc: 400 })
    // The buckets reconcile with the grand total.
    expect(t.byRate.reduce((s, b) => s + b.ht, 0)).toBe(t.ht)
    expect(t.byRate.reduce((s, b) => s + b.ttc, 0)).toBe(t.ttc)
  })

  it('settles float drift on sums of centimes', () => {
    const rows = Array.from({ length: 10 }, () => facture(0.1, 20))
    const t = aggregateFactures(rows)
    expect(t.ht).toBe(1)
    expect(t.byRate[0].ht).toBe(1)
  })
})
