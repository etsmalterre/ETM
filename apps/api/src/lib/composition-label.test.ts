import { describe, expect, it } from 'vitest'
import { formatCompositionLabel, pickCompositionRows, type CompositionEcruRow } from './composition-label.js'

// Prod composition_ecru of écru 329 (IDref_ecru 442, behind the wash-only
// fini 329D of LIVA #1157/#1158): the same two yarns repeated per coloris
// variant, plus an unscoped pair.
const ecru329: CompositionEcruRow[] = [
  { IDref_ecru: 442, IDcolori_ecru: 0, IDref_fil: 5, pourcentage: 66 },
  { IDref_ecru: 442, IDcolori_ecru: 0, IDref_fil: 10, pourcentage: 34 },
  { IDref_ecru: 442, IDcolori_ecru: 1551, IDref_fil: 5, pourcentage: 66 },
  { IDref_ecru: 442, IDcolori_ecru: 1551, IDref_fil: 10, pourcentage: 34 },
  { IDref_ecru: 442, IDcolori_ecru: 1599, IDref_fil: 5, pourcentage: 66 },
  { IDref_ecru: 442, IDcolori_ecru: 1599, IDref_fil: 10, pourcentage: 34 },
]
const names = new Map<number, string>([[5, '1/60 COTON PEIGNE BIO Z'], [10, '1/28 COTON PEIGNE BIO Z'], [7, '280/48/1 PES HT']])
const name = (id: number) => names.get(id)

describe('pickCompositionRows', () => {
  it('prefers the rows scoped to the line coloris', () => {
    expect(pickCompositionRows(ecru329, 1551).every((r) => r.IDcolori_ecru === 1551)).toBe(true)
    expect(pickCompositionRows(ecru329, 1551)).toHaveLength(2)
  })
  it('falls back to the unscoped rows when the coloris has none, never the union', () => {
    expect(pickCompositionRows(ecru329, 9999)).toHaveLength(2)
    expect(pickCompositionRows(ecru329, 0).every((r) => r.IDcolori_ecru === 0)).toBe(true)
  })
  it('falls back to the first coloris variant when nothing is unscoped', () => {
    const scopedOnly = ecru329.filter((r) => r.IDcolori_ecru > 0)
    const picked = pickCompositionRows(scopedOnly, 0)
    expect(picked).toHaveLength(2)
    expect(picked.every((r) => r.IDcolori_ecru === 1551)).toBe(true)
  })
  it('drops rows without a yarn or a share', () => {
    expect(pickCompositionRows([{ IDref_ecru: 1, IDcolori_ecru: 0, IDref_fil: 0, pourcentage: 50 }], 0)).toEqual([])
    expect(pickCompositionRows([{ IDref_ecru: 1, IDcolori_ecru: 0, IDref_fil: 5, pourcentage: 0 }], 0)).toEqual([])
  })
})

describe('formatCompositionLabel', () => {
  it('reads « 66 % 1/60 COTON PEIGNE BIO Z · 34 % 1/28 COTON PEIGNE BIO Z » for 329D ecru/ecru', () => {
    expect(formatCompositionLabel(ecru329, 1551, name)).toBe('66 % 1/60 COTON PEIGNE BIO Z · 34 % 1/28 COTON PEIGNE BIO Z')
  })
  it('folds feeding positions sharing one yarn (ref 119: 71 + 14,5 + 14,5)', () => {
    const rows: CompositionEcruRow[] = [
      { IDref_ecru: 119, IDcolori_ecru: 0, IDref_fil: 7, pourcentage: 71 },
      { IDref_ecru: 119, IDcolori_ecru: 0, IDref_fil: 7, pourcentage: 14.5 },
      { IDref_ecru: 119, IDcolori_ecru: 0, IDref_fil: 7, pourcentage: 14.5 },
    ]
    expect(formatCompositionLabel(rows, 0, name)).toBe('100 % 280/48/1 PES HT')
  })
  it('keeps a decimal share readable in French', () => {
    const rows: CompositionEcruRow[] = [
      { IDref_ecru: 1, IDcolori_ecru: 0, IDref_fil: 5, pourcentage: 92.5 },
      { IDref_ecru: 1, IDcolori_ecru: 0, IDref_fil: 7, pourcentage: 7.5 },
    ]
    expect(formatCompositionLabel(rows, 0, name)).toBe('92,5 % 1/60 COTON PEIGNE BIO Z · 7,5 % 280/48/1 PES HT')
  })
  it('returns null with no rows or no resolvable yarn name', () => {
    expect(formatCompositionLabel([], 0, name)).toBeNull()
    expect(formatCompositionLabel([{ IDref_ecru: 1, IDcolori_ecru: 0, IDref_fil: 99, pourcentage: 100 }], 0, name)).toBeNull()
  })
})
