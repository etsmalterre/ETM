import { describe, it, expect } from 'vitest'
import { ecruDuFil, partsDepuisFil } from './parts-tricotage.js'

// 029: 94 % 1/60 bio (5:317), 6 % élasthanne (8:338).
const paires = [{ refFil: 5, coloriFil: 317, pourcentage: 94 }, { refFil: 8, coloriFil: 338, pourcentage: 6 }]
const r = (lcc: number, refFil: number, coloriFil: number, kg: number) => ({ lcc, refFil, coloriFil, kg })

describe('ecruDuFil', () => {
  it('the scarcest yarn of the recipe decides, after the freinte', () => {
    expect(ecruDuFil(paires, 0, new Map([['5:317', 94], ['8:338', 6]]))).toBeCloseTo(100, 5)
    expect(ecruDuFil(paires, 0, new Map([['5:317', 94], ['8:338', 3]]))).toBeCloseTo(50, 5)
    expect(ecruDuFil(paires, 0.1, new Map([['5:317', 94], ['8:338', 6]]))).toBeCloseTo(90, 5)
  })
  it('a yarn of the recipe missing: no écru', () => {
    expect(ecruDuFil(paires, 0, new Map([['5:317', 500]]))).toBe(0)
  })
})

describe('partsDepuisFil', () => {
  it("a line's share is the écru its yarn makes; the rest of the order is for the stock", () => {
    const { parts, couvreTout } = partsDepuisFil({ quantite: 1000, freinte: 0, paires, reservations: [r(1, 5, 317, 188), r(1, 8, 338, 12)] })
    expect(parts).toEqual([{ lcc: 1, poids: 200, toute: false }])
    expect(couvreTout).toBe(false)
  })

  it('the cotton without the élasthanne is no share yet: it stays the line reserved yarn', () => {
    const { parts, excedents } = partsDepuisFil({ quantite: 1000, freinte: 0, paires, reservations: [r(1, 5, 317, 188)] })
    expect(parts).toEqual([])
    expect(excedents.get(1)?.get('5:317')).toBe(188)
  })

  it('more cotton than the élasthanne allows: the surplus is still the line reserved yarn', () => {
    const { parts, excedents } = partsDepuisFil({ quantite: 1000, freinte: 0, paires, reservations: [r(1, 5, 317, 188), r(1, 8, 338, 6)] })
    expect(parts[0].poids).toBe(100)
    expect(excedents.get(1)?.get('5:317')).toBe(94)
    expect(excedents.get(1)?.has('8:338')).toBe(false)
  })

  it('the lines carry their 5 % margin to the knitter: shares scaled to the order, nothing for the stock', () => {
    const { parts, couvreTout } = partsDepuisFil({
      quantite: 300, freinte: 0, paires,
      reservations: [r(1, 5, 317, 98.7), r(1, 8, 338, 6.3), r(2, 5, 317, 197.4), r(2, 8, 338, 12.6)],
    })
    expect(parts.map((p) => p.poids)).toEqual([100, 200])
    expect(couvreTout).toBe(true)
  })
})
