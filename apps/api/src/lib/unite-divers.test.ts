import { describe, expect, it } from 'vitest'
import { uniteDiversValide, uniteLigneDivers } from './unite-divers.js'

describe('uniteLigneDivers', () => {
  it('order 3942 (LIVA #1371): « unité » asked on a PVC sold by the Kg is written Kg', () => {
    expect(uniteLigneDivers({ uniteRef: 1, demandee: 4 })).toBe(1)
  })
  it('a new line that sends no unit takes the reference’s', () => {
    expect(uniteLigneDivers({ uniteRef: 5 })).toBe(5)
  })
  it('a line saved earlier in another unit keeps it while nobody changes it', () => {
    // 2021: 28 lines in Ml on references sold by the piece
    expect(uniteLigneDivers({ uniteRef: 4, demandee: 3, uniteLigne: 3 })).toBe(3)
    expect(uniteLigneDivers({ uniteRef: 4, uniteLigne: 3 })).toBe(3)
  })
  it('any other unit asked on that line goes to the reference’s, never to a third one', () => {
    expect(uniteLigneDivers({ uniteRef: 4, demandee: 1, uniteLigne: 3 })).toBe(4)
    expect(uniteLigneDivers({ uniteRef: 4, demandee: 4, uniteLigne: 3 })).toBe(4)
  })
  it('a line whose reference changes loses its old unit (uniteLigne not passed)', () => {
    expect(uniteLigneDivers({ uniteRef: 1, demandee: 4 })).toBe(1)
    expect(uniteLigneDivers({ uniteRef: 1 })).toBe(1)
  })
  it('a reference without a unit (255 on 6 archived refs) imposes nothing', () => {
    expect(uniteLigneDivers({ uniteRef: 255, demandee: 4 })).toBe(4)
    expect(uniteLigneDivers({ uniteRef: 0 })).toBeUndefined()
    expect(uniteLigneDivers({ uniteRef: null, demandee: 3, uniteLigne: 1 })).toBe(3)
  })
})

describe('uniteDiversValide', () => {
  it('keeps Kg / Ml / pièce / m², drops the rest', () => {
    expect([1, 3, 4, 5].map(uniteDiversValide)).toEqual([1, 3, 4, 5])
    expect([0, 2, 255, null, undefined, 'x'].map(uniteDiversValide)).toEqual([0, 0, 0, 0, 0, 0])
  })
})
