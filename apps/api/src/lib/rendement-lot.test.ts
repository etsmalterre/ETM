import { describe, expect, it } from 'vitest'
import { bornesRendement, rendementConforme, rendementPiece } from './rendement-lot.js'

describe('rendement of a lot’s rolls', () => {
  const ref = { poidsMin: 145, poidsMax: 155, laizeMin: 150, laizeMax: 160, freinte: 0.1, rendement: 4 }
  it('the band runs from the heaviest, widest fabric to the lightest, narrowest', () => {
    const b = bornesRendement(4, ref)!
    expect(b.mini).toBeCloseTo(0.9 / ((155 * 160) / 100000), 6)
    expect(b.maxi).toBeCloseTo(0.9 / ((145 * 150) / 100000), 6)
    expect(b.mini).toBeLessThan(b.maxi)
  })
  it('without the reference’s figures the band is the rendement asked; nothing asked, no band', () => {
    expect(bornesRendement(4.2, { ...ref, rendement: 0 })).toEqual({ mini: 4.2, maxi: 4.2 })
    expect(bornesRendement(0, { ...ref, rendement: 0 })).toBeNull()
  })
  it('a roll is judged by its metres per kilo, bounds included', () => {
    const b = { mini: 3.6, maxi: 4.1 }
    expect(rendementPiece(100, 25)).toBe(4)
    expect(rendementPiece(100, 0)).toBeNull()
    expect(rendementConforme(3.6, b)).toBe(true)
    expect(rendementConforme(4.2, b)).toBe(false)
    expect(rendementConforme(null, b)).toBeNull()
    expect(rendementConforme(4, null)).toBeNull()
  })
})
