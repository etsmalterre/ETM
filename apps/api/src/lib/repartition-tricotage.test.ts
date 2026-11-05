import { describe, it, expect } from 'vitest'
import { repartir, type AllocationRepartition, type PieceRepartition } from './repartition-tricotage.js'

const a = (lcc: number, poids: number, delai = '', toute = false): AllocationRepartition => ({ lcc, poids, toute, delai })
const p = (id: number, poids: number, lcc = 0): PieceRepartition => ({ id, poids, lcc })

// Order 9126 (LIVA #1350): 217 kg for line 13273 of order 3905, 7 pieces knitted (228,6 kg), 3611/1 reserved by hand.
const pieces9126 = [p(58472, 32.6, 13273), p(58473, 32.6), p(58474, 32.6), p(58475, 32.7), p(58476, 32.6), p(58525, 32.8), p(58526, 32.7)]

describe('repartir', () => {
  it('quantité exacte: the line takes pieces until it holds its kg, the last one may go past (order 9126)', () => {
    const { attribution, tenu } = repartir([a(13273, 217)], pieces9126)
    expect([...attribution.values()].every((l) => l === 13273)).toBe(true)
    expect(attribution.size).toBe(6)
    expect(tenu.get(13273)).toBeCloseTo(228.6, 1)
  })

  it('quantité exacte: pieces after the line is full go to stock', () => {
    const { attribution, tenu } = repartir([a(1, 60)], [p(1, 30), p(2, 30), p(3, 30)])
    expect([...attribution.keys()]).toEqual([1, 2])
    expect(tenu.get(1)).toBe(60)
  })

  it('toute la commande: every piece goes to the line, whatever the kg', () => {
    const { attribution } = repartir([a(1, 60, '', true)], [p(1, 30), p(2, 30), p(3, 30)])
    expect(attribution.size).toBe(3)
  })

  it('several lines: earliest délai first, each up to its kg; the shortfall falls on the latest délai', () => {
    const { attribution, tenu } = repartir(
      [a(2, 60, '20261220'), a(1, 60, '20261120')],
      [p(10, 30), p(11, 30), p(12, 30)],
    )
    expect(attribution.get(10)).toBe(1)
    expect(attribution.get(11)).toBe(1)
    expect(attribution.get(12)).toBe(2)
    expect(tenu.get(1)).toBe(60)
    expect(tenu.get(2)).toBe(30)
  })

  it('« tout le reste »: the exact lines are served first, the rest line takes every piece left, surplus included', () => {
    const { attribution, tenu } = repartir(
      [a(1, 30, '20261101', true), a(2, 30, '20261201')],
      [p(1, 30), p(2, 30), p(3, 30), p(4, 30)],
    )
    expect(attribution.get(1)).toBe(2)
    expect([2, 3, 4].map((id) => attribution.get(id))).toEqual([1, 1, 1])
    expect(tenu.get(1)).toBe(90)
  })

  it('« tout le reste » short: the exact lines still get theirs first', () => {
    const { attribution } = repartir([a(1, 60, '20261101', true), a(2, 30, '20261201')], [p(1, 30)])
    expect(attribution.get(1)).toBe(2)
  })

  it('a line without délai comes last', () => {
    const { attribution } = repartir([a(1, 30, ''), a(2, 30, '20261201')], [p(1, 30)])
    expect(attribution.get(1)).toBe(2)
  })

  it('a piece already reserved counts for its line and is never moved; a reserved piece of another line counts for nobody', () => {
    const { attribution, tenu } = repartir([a(1, 60)], [p(1, 30, 1), p(2, 30, 99), p(3, 30), p(4, 30)])
    expect(attribution.has(1)).toBe(false)
    expect(attribution.has(2)).toBe(false)
    expect([...attribution.keys()]).toEqual([3])
    expect(tenu.get(1)).toBe(60)
  })

  it('a free piece that may not be reserved (dyed, at a dyer…) is never handed out', () => {
    const { attribution } = repartir([a(1, 60)], [p(1, 30), p(2, 30)], new Set([2]))
    expect([...attribution.keys()]).toEqual([2])
  })

  it('two rows of the same client line add up', () => {
    const { tenu, attribution } = repartir([a(1, 30), a(1, 30)], [p(1, 30), p(2, 30), p(3, 30)])
    expect(attribution.size).toBe(2)
    expect(tenu.get(1)).toBe(60)
  })
})
