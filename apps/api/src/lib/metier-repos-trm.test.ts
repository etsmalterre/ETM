import { describe, it, expect } from 'vitest'
import { dernierOfParMetier, prochainOfParMetier, finDeOf } from './metier-repos-trm.js'

describe('dernierOfParMetier — the highest finished id per métier', () => {
  it('keeps the highest id of each métier and ignores junk rows', () => {
    const out = dernierOfParMetier([
      { id: 3419, machineId: 2 },
      { id: 3300, machineId: 2 },
      { id: 3353, machineId: 3 },
      { id: 0, machineId: 3 },
      { id: 9999, machineId: 0 },
    ])
    expect(out.get(2)).toBe(3419)
    expect(out.get(3)).toBe(3353)
    expect(out.size).toBe(2)
  })
  it('is empty on no rows', () => {
    expect(dernierOfParMetier([]).size).toBe(0)
  })
})

describe('prochainOfParMetier — the queue head, as rerankQueue orders it', () => {
  it('takes the lowest priorite, ties on the lowest id', () => {
    const out = prochainOfParMetier([
      { id: 3457, machineId: 2, priorite: 1 },
      { id: 3456, machineId: 2, priorite: 2 },
      { id: 3460, machineId: 5, priorite: 1 },
      { id: 3459, machineId: 5, priorite: 1 },
    ])
    expect(out.get(2)?.id).toBe(3457)
    expect(out.get(5)?.id).toBe(3459)
  })
  it('ranks an unranked row (priorite 0) after every ranked one', () => {
    const out = prochainOfParMetier([
      { id: 3400, machineId: 2, priorite: 0 },
      { id: 3457, machineId: 2, priorite: 3 },
    ])
    expect(out.get(2)?.id).toBe(3457)
  })
  it('falls back to the lowest id when nothing is ranked', () => {
    const out = prochainOfParMetier([
      { id: 3402, machineId: 2, priorite: 0 },
      { id: 3401, machineId: 2, priorite: 0 },
    ])
    expect(out.get(2)?.id).toBe(3401)
  })
})

describe('finDeOf — arret_prod first, the last piece as the legacy fallback', () => {
  it('prefers arret_prod', () => {
    expect(finDeOf(100, 200)).toBe(100)
  })
  it('falls back to the last piece end, then to unknown', () => {
    expect(finDeOf(null, 200)).toBe(200)
    expect(finDeOf(null, null)).toBeNull()
  })
})
