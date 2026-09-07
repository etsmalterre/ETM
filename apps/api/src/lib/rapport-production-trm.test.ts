import { describe, expect, it } from 'vitest'
import { aggregateRapportProduction, dtLocalToHfsql, toLignes } from './rapport-production-trm.js'

describe('dtLocalToHfsql', () => {
  it('turns a datetime-local value into the 14-char literal', () => {
    expect(dtLocalToHfsql('2026-03-25T10:08', false)).toBe('20260325100800')
  })
  it('pads the end bound to the last second of the minute (inclusive « au »)', () => {
    expect(dtLocalToHfsql('2026-03-25T10:08', true)).toBe('20260325100859')
  })
  it('keeps explicit seconds', () => {
    expect(dtLocalToHfsql('2026-03-25T10:08:30', true)).toBe('20260325100830')
  })
  it('rejects anything else', () => {
    expect(dtLocalToHfsql('2026-03-25', false)).toBeNull()
    expect(dtLocalToHfsql('25/03/2026 10:08', false)).toBeNull()
    expect(dtLocalToHfsql('', false)).toBeNull()
  })
})

const rows = [
  { IDordre_fabrication: 10, IDref_ecru: 1, poids: 20.4, second_choix: 0 },
  { IDordre_fabrication: 10, IDref_ecru: 1, poids: 20, second_choix: 1 },
  { IDordre_fabrication: 11, IDref_ecru: 2, poids: 10.1, second_choix: 0 },
  { IDordre_fabrication: 12, IDref_ecru: 1, poids: 19.5, second_choix: 0 },
]
// OF 10 and 12 on métier 3, OF 11 on métier 5.
const machineOf = new Map([[10, 3], [11, 5], [12, 3]])

describe('aggregateRapportProduction', () => {
  it('sums everything with no filter and splits by métier and by reference', () => {
    const a = aggregateRapportProduction(rows, machineOf, { machine: 0, ref: 0 })
    expect(a.total_kg).toBe(70)
    expect(a.rouleaux).toBe(4)
    expect(a.second_choix_kg).toBe(20)
    expect(a.second_choix_rouleaux).toBe(1)
    expect(a.par_machine.get(3)).toEqual({ kg: 59.9, rouleaux: 3 })
    expect(a.par_machine.get(5)).toEqual({ kg: 10.1, rouleaux: 1 })
    expect(a.par_reference.get(1)).toEqual({ kg: 59.9, rouleaux: 3 })
    expect(a.par_reference.get(2)).toEqual({ kg: 10.1, rouleaux: 1 })
  })

  it('a métier filter narrows both splits to that métier', () => {
    const a = aggregateRapportProduction(rows, machineOf, { machine: 3, ref: 0 })
    expect(a.total_kg).toBe(59.9)
    expect(a.par_machine.size).toBe(1)
    expect(a.par_reference.get(1)).toEqual({ kg: 59.9, rouleaux: 3 })
    expect(a.par_reference.has(2)).toBe(false)
  })

  it('the two filters compose', () => {
    const a = aggregateRapportProduction(rows, machineOf, { machine: 3, ref: 2 })
    expect(a.total_kg).toBe(0)
    expect(a.rouleaux).toBe(0)
    expect(a.par_machine.size).toBe(0)
  })

  it('an OF without a métier lands in bucket 0 rather than being dropped', () => {
    const a = aggregateRapportProduction(rows, new Map(), { machine: 0, ref: 0 })
    expect(a.par_machine.get(0)).toEqual({ kg: 70, rouleaux: 4 })
  })

  it('rounds sums to the centigram, as the legacy field displayed', () => {
    const a = aggregateRapportProduction(
      [{ IDordre_fabrication: 1, IDref_ecru: 1, poids: 20.399999618530273, second_choix: 0 },
       { IDordre_fabrication: 1, IDref_ecru: 1, poids: 20.299999237060547, second_choix: 0 }],
      new Map([[1, 1]]), { machine: 0, ref: 0 },
    )
    expect(a.total_kg).toBe(40.7)
  })
})

describe('toLignes', () => {
  it('orders heaviest first, then by label', () => {
    const a = aggregateRapportProduction(rows, machineOf, { machine: 0, ref: 0 })
    const names = new Map([[3, '3B'], [5, '1A']])
    expect(toLignes(a.par_machine, names)).toEqual([
      { id: 3, label: '3B', kg: 59.9, rouleaux: 3 },
      { id: 5, label: '1A', kg: 10.1, rouleaux: 1 },
    ])
  })
  it('falls back to #id when a name is missing', () => {
    expect(toLignes(new Map([[7, { kg: 1, rouleaux: 1 }]]), new Map())[0].label).toBe('#7')
  })
})
