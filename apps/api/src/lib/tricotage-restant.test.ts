import { describe, it, expect } from 'vitest'
import { resteATricoter } from './tricotage-restant.js'

describe('resteATricoter', () => {
  it('a done knitting line counts nothing (order 3885: 327 kg on line 9023, knitted and dyed)', () => {
    const r = resteATricoter([{ lcc: 13200, lsst: 9023, poids: 327 }], new Set(), new Map())
    expect(r.get(13200)).toBeUndefined()
  })

  it('an open line counts what is not knitted yet (order 3896: 600 planned, 305 knitted)', () => {
    const r = resteATricoter([{ lcc: 13234, lsst: 9073, poids: 600 }], new Set([9073]), new Map([['9073|13234', 305]]))
    expect(r.get(13234)).toBe(295)
  })

  it('never negative when more was knitted than planned', () => {
    const r = resteATricoter([{ lcc: 1, lsst: 2, poids: 100 }], new Set([2]), new Map([['2|1', 120]]))
    expect(r.get(1)).toBeUndefined()
  })

  it('pieces knitted for another client line are not deducted', () => {
    const r = resteATricoter([{ lcc: 1, lsst: 2, poids: 100 }], new Set([2]), new Map([['2|9', 80]]))
    expect(r.get(1)).toBe(100)
  })

  it('two rows of the same pair share one deduction; several knitting lines add up', () => {
    const r = resteATricoter(
      [{ lcc: 1, lsst: 2, poids: 40 }, { lcc: 1, lsst: 2, poids: 60 }, { lcc: 1, lsst: 3, poids: 50 }],
      new Set([2, 3]),
      new Map([['2|1', 70]]),
    )
    expect(r.get(1)).toBe(80)
  })
})
