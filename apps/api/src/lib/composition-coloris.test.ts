import { describe, expect, it } from 'vitest'
import { compositionEcart, planColorisComposition, totalOk } from './composition-coloris.js'

// Prod rows of ref_ecru 540 « ech 55 » on 2026-09-24, before the repair: the
// reference's recipe had been edited (PA66 30 / Lyocell 64 / Elasthanne 6)
// while the coloris « ecru » still carried 029's (coton 94 / elasthanne 6).
const ech55Base = [
  { IDref_fil: 1, pourcentage: 30 },
  { IDref_fil: 124, pourcentage: 64 },
  { IDref_fil: 8, pourcentage: 6 },
]
const ech55Ecru = [
  { IDcomposition_ecru: 4984, IDref_fil: 5, IDcolori_fil: 317, pourcentage: 94 },
  { IDcomposition_ecru: 4985, IDref_fil: 8, IDcolori_fil: 338, pourcentage: 6 },
]

describe('compositionEcart', () => {
  it('flags the ech 55 coloris that kept 029 yarns', () => {
    expect(compositionEcart(ech55Base, ech55Ecru)).toBe(true)
  })
  it('ignores yarn colours and row order', () => {
    expect(compositionEcart(
      [{ IDref_fil: 5, pourcentage: 94 }, { IDref_fil: 8, pourcentage: 6 }],
      [{ IDref_fil: 8, pourcentage: 6 }, { IDref_fil: 5, pourcentage: 94 }],
    )).toBe(false)
  })
  it('sums positions sharing a yarn (ref 119: 71 + 14,5 + 14,5)', () => {
    expect(compositionEcart(
      [{ IDref_fil: 3, pourcentage: 71 }, { IDref_fil: 7, pourcentage: 29 }],
      [{ IDref_fil: 3, pourcentage: 71 }, { IDref_fil: 7, pourcentage: 14.5 }, { IDref_fil: 7, pourcentage: 14.5 }],
    )).toBe(false)
  })
  it('flags a different share of the same yarns', () => {
    expect(compositionEcart(
      [{ IDref_fil: 5, pourcentage: 94 }, { IDref_fil: 8, pourcentage: 6 }],
      [{ IDref_fil: 5, pourcentage: 95 }, { IDref_fil: 8, pourcentage: 5 }],
    )).toBe(true)
  })
  it('says nothing when either side is empty', () => {
    expect(compositionEcart([], ech55Ecru)).toBe(false)
    expect(compositionEcart(ech55Base, [])).toBe(false)
  })
})

describe('planColorisComposition', () => {
  it('reuses row ids in order, inserts the extra line', () => {
    const plan = planColorisComposition(ech55Ecru, [
      { IDref_fil: 124, IDcolori_fil: 989, pourcentage: 64 },
      { IDref_fil: 8, IDcolori_fil: 338, pourcentage: 6 },
      { IDref_fil: 1, IDcolori_fil: 305, pourcentage: 30 },
    ])
    expect(plan).toEqual([
      { kind: 'update', IDcomposition_ecru: 4984, line: { IDref_fil: 124, IDcolori_fil: 989, pourcentage: 64 } },
      { kind: 'insert', line: { IDref_fil: 1, IDcolori_fil: 305, pourcentage: 30 } },
    ])
  })
  it('deletes the surplus, and everything when emptied', () => {
    expect(planColorisComposition(ech55Ecru, [{ IDref_fil: 5, IDcolori_fil: 317, pourcentage: 100 }])).toEqual([
      { kind: 'update', IDcomposition_ecru: 4984, line: { IDref_fil: 5, IDcolori_fil: 317, pourcentage: 100 } },
      { kind: 'delete', IDcomposition_ecru: 4985 },
    ])
    expect(planColorisComposition(ech55Ecru, [])).toEqual([
      { kind: 'delete', IDcomposition_ecru: 4984 },
      { kind: 'delete', IDcomposition_ecru: 4985 },
    ])
  })
  it('writes nothing when unchanged', () => {
    expect(planColorisComposition(ech55Ecru, [
      { IDref_fil: 5, IDcolori_fil: 317, pourcentage: 94 },
      { IDref_fil: 8, IDcolori_fil: 338, pourcentage: 6 },
    ])).toEqual([])
  })
})

describe('totalOk', () => {
  it('accepts empty or 100 %', () => {
    expect(totalOk([])).toBe(true)
    expect(totalOk([{ pourcentage: 30 }, { pourcentage: 64 }, { pourcentage: 6 }])).toBe(true)
    expect(totalOk([{ pourcentage: 94 }])).toBe(false)
  })
})
